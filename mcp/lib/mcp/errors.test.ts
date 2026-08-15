/**
 * lib/mcp/errors.test.ts — PH-7 (tool responses nu scurg detalii interne prin mcpErr).
 *
 * Catch-ul fiecărui tool + middleware-ul central delegau `mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e))`
 * → excepția BRUTĂ (hostname Redis, detalii Supabase, stack) ajungea în răspunsul MCP către client. `sanitizeToolError`
 * întoarce un mesaj GENERIC stabil și logează eroarea reală DOAR server-side. Leaf pur (`log` injectat) → tsx standalone.
 *
 * Include un GUARD DE SURSĂ: citește middleware.ts + toate cele 14 tool-uri și cade dacă vreunul REGRESEAZĂ la a pasa
 * `e.message`/`String(e)` brut lui `mcpErr(ERR.INTERNAL, ...)` — testul behavioral rămâne verde chiar dacă un call-site
 * scapă, deci guard-ul e ce prinde regresia. Analog guard-ului NF4 din clientLookup.test.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { sanitizeToolError, GENERIC_TOOL_ERROR } from "./errors";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const SENTINEL = "redis://user:s3cr3t@internal-host:6379/0 ECONNREFUSED at query getPipeline";

function main(): void {
console.log("PH-7 — sanitizeToolError (mesaj generic la client, eroarea reală doar în log)");

// Logger fals care captează ce s-a logat.
const logged: Array<{ label: string; detail: unknown }> = [];
const fakeLog = (label: string, detail: unknown) => { logged.push({ label, detail }); };

// 1–4: eroare Error cu mesaj-sentinel.
const realErr = new Error(SENTINEL);
const out = sanitizeToolError(realErr, fakeLog);
check("1. ⭐ valoarea returnată clientului NU conține mesajul-sentinel", !out.includes(SENTINEL) && !out.includes("s3cr3t") && !out.includes("internal-host"));
check("2. valoarea returnată === mesajul generic", out === GENERIC_TOOL_ERROR);
check("3. ⭐ eroarea REALĂ e logată server-side (stack sau message conține sentinel)", logged.length === 1 && String(logged[0].detail).includes(SENTINEL));
check("4. logul folosește un label prefix [MCP TOOL ERROR]", logged[0].label === "[MCP TOOL ERROR]");

// 5–6: err non-Error (string, obiect) — nu trebuie reflectat nici el.
logged.length = 0;
const strErr = "leak-me: DB_PASSWORD=hunter2";
const outStr = sanitizeToolError(strErr, fakeLog);
check("5. ⭐ err non-Error (string) → return tot generic, nu-l reflectă", outStr === GENERIC_TOOL_ERROR && !outStr.includes("hunter2"));
check("5b. err non-Error tot logat (valoarea brută)", logged.length === 1 && logged[0].detail === strErr);

const outObj = sanitizeToolError({ secret: "abc", host: "10.0.0.5" }, fakeLog);
check("6. ⭐ err obiect cu câmpuri sensibile → return generic, fără reflectare", outObj === GENERIC_TOOL_ERROR);

// 7: stabilitatea mesajului generic (nu variază cu inputul → nu e un canal de leak).
check("7. mesajul generic e stabil (același pt. inputuri diferite)",
  sanitizeToolError(new Error("a"), fakeLog) === sanitizeToolError(new Error("b"), fakeLog));
check("8. mesajul generic e propoziția fixă așteptată", GENERIC_TOOL_ERROR === "An internal error occurred while processing the request.");

// 9: default log = console.error (nu aruncă când nu injectăm logger).
check("9. fără logger injectat nu aruncă și tot întoarce generic", sanitizeToolError(new Error("x")) === GENERIC_TOOL_ERROR);

// ── GUARD DE SURSĂ — NICIUN traseu spre client (MCP sau demo public) nu scurge eroarea brută ──
// cwd = pachetul mcp (npm rulează scriptul din dir-ul pachetului), deci căile sunt relative la mcp.
// Leak-ul are DOUĂ forme, ambele acoperite:
//   (a) DIRECT: `mcpErr(<code>, e instanceof Error ? e.message : String(e))` — catch-ul unui tool/middleware.
//   (b) SPĂLAT prin report: un builder (`lib/reports/*`) prinde excepția și stochează `e.message` în
//       `errorMessage`, iar consumatorul (tp_pair_context → mcpErr, SAU demo-ul public → HTML) o redă. Catch-ul
//       sanitizat din middleware NU se execută, fiindcă excepția e prinsă ÎN report. (regresie prinsă de cgpt/varu)
// Idiomul brut = `<id> instanceof Error ? <id>.message : String(<id>)` sau `.message` / `String(x)` direct.
const RAW_EXPR = "(?:[\\w$]+\\s+instanceof\\s+Error|String\\(\\s*[\\w$]+\\s*\\)|[\\w$]+\\.message\\b)";
const RAW_MCPERR  = new RegExp("mcpErr\\([^,]*,\\s*" + RAW_EXPR);          // (a) mesaj brut pasat direct în mcpErr
const RAW_ERRFIELD = new RegExp("errorMessage:\\s*" + RAW_EXPR);           // (b) mesaj brut stocat în errorMessage
const USES_SANITIZER = /mcpErr\(\s*ERR\.INTERNAL\s*,\s*sanitizeToolError\(/;

const middlewareSrc = readFileSync("lib/mcp/middleware.ts", "utf8");
check("10. ⭐ middleware.ts folosește sanitizeToolError în catch-ul central", USES_SANITIZER.test(middlewareSrc));
check("11. ⭐ middleware.ts NU pasează eroarea brută în mcpErr", !RAW_MCPERR.test(middlewareSrc));
check("12. ⭐ middleware.ts importă sanitizeToolError", /import\s*\{[^}]*sanitizeToolError[^}]*\}\s*from\s*"\.\/errors"/.test(middlewareSrc));

// (a) Scanează TOATE tool-urile din lib/mcp/tools/*.ts (exclude .test.ts). Prinde și tool-uri viitoare care regresează.
const toolFiles = readdirSync("lib/mcp/tools").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const toolsWithRawLeak: string[] = [];
let toolsUsingSanitizer = 0;
let registeredTools = 0;
for (const f of toolFiles) {
  const src = readFileSync("lib/mcp/tools/" + f, "utf8");
  if (/registerTool\(/.test(src)) registeredTools++;
  if (RAW_MCPERR.test(src) || RAW_ERRFIELD.test(src)) toolsWithRawLeak.push(f);
  if (USES_SANITIZER.test(src)) {
    toolsUsingSanitizer++;
    // fiecare tool care sanitizează direct trebuie să și importe helper-ul
    if (!/import\s*\{[^}]*sanitizeToolError[^}]*\}\s*from\s*"\.\.\/errors"/.test(src)) toolsWithRawLeak.push(f + " (uz fără import)");
  }
}
check("13. ⭐⭐ NICIUN tool nu scurge eroarea brută (direct sau prin errorMessage) — leak-uri: " + (toolsWithRawLeak.join(", ") || "niciunul"), toolsWithRawLeak.length === 0);
check("14. ⭐ toate cele 15 tool-uri înregistrate sunt scanate (găsite: " + registeredTools + ")", registeredTools === 15);
check("15. ⭐ ≥14 tool-uri emit ERR.INTERNAL prin sanitizeToolError direct (restul spală prin report, ex. tp_pair_context) — găsite: " + toolsUsingSanitizer, toolsUsingSanitizer >= 14);

// (b) Scanează TOATE report-builderele din lib/reports/*.ts — sursa scurgerii spălate. Aici e traseul pe care
// guard-ul vechi (doar `mcpErr(ERR.INTERNAL, ...)` literal) îl RATA: tp_pair_context/tp_market_overview + demo public.
const reportFiles = readdirSync("lib/reports").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const reportsWithRawLeak: string[] = [];
const reportsWithInternalCatch: string[] = [];
for (const f of reportFiles) {
  const src = readFileSync("lib/reports/" + f, "utf8");
  if (RAW_ERRFIELD.test(src)) reportsWithRawLeak.push(f);
  // un report care emite errorCode "INTERNAL" (catch general) TREBUIE să sanitizeze errorMessage
  if (/errorCode:\s*"INTERNAL"/.test(src)) {
    reportsWithInternalCatch.push(f);
    const sanitizedInternal = /errorCode:\s*"INTERNAL",\s*errorMessage:\s*sanitizeToolError\(/.test(src)
      || /errorMessage:\s*sanitizeToolError\([\s\S]{0,40}errorCode:\s*"INTERNAL"/.test(src);
    if (!sanitizedInternal) reportsWithRawLeak.push(f + " (INTERNAL fără sanitizeToolError)");
  }
}
check("16. ⭐⭐ NICIUN report nu stochează eroarea brută în errorMessage — leak-uri: " + (reportsWithRawLeak.join(", ") || "niciunul"), reportsWithRawLeak.length === 0);
check("17. ⭐ report-urile cu catch INTERNAL au fost găsite și verificate (≥2: pair-context + market-overview) — " + reportsWithInternalCatch.join(", "), reportsWithInternalCatch.length >= 2);

// Traseul concret raportat de varu — pair-context-report alimentează ȘI MCP (tp_pair_context) ȘI demo-ul public.
const pairReport = readFileSync("lib/reports/pair-context-report.ts", "utf8");
check("18. ⭐⭐ pair-context-report: catch INTERNAL sanitizează (nu mai scurge în tp_pair_context / demo)", /errorCode:\s*"INTERNAL",\s*errorMessage:\s*sanitizeToolError\(/.test(pairReport) && /import\s*\{[^}]*sanitizeToolError[^}]*\}\s*from\s*"\.\.\/mcp\/errors"/.test(pairReport));
const marketReport = readFileSync("lib/reports/market-overview-report.ts", "utf8");
check("19. ⭐⭐ market-overview-report: catch INTERNAL sanitizează (nu mai scurge în demo-ul public app/demo/page.tsx)", /errorCode:\s*"INTERNAL",\s*errorMessage:\s*sanitizeToolError\(/.test(marketReport) && /import\s*\{[^}]*sanitizeToolError[^}]*\}\s*from\s*"\.\.\/mcp\/errors"/.test(marketReport));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
