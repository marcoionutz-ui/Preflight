/**
 * lib/mcp/toolCallLog.test.ts — lot OAuth staging §9 S2 / §10: linia `[MCP TOOL] name=… isError=… structured=…`.
 *
 * (a) formatul exact pe rezultatele reale ale helperelor (`mcpResponse` → ok, `mcpErr` → absent + isError=true);
 * (b) clasificarea `structuredContent` (absent / ok / invalid) pe forme limită; (c) nimic din argumente/conținut nu
 * ajunge în linie, numele nu poate injecta câmpuri; (d) guard de sursă: middleware-ul loghează pe toate căile.
 * cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";
import { formatToolCallLog, classifyStructuredContent, resultIsError, sanitizeToolName } from "./toolCallLog";
import { mcpResponse, mcpErr, ERR } from "./errors";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("Lot OAuth staging §9 S2 — toolCallLog (formatter pur)");

// ── (a) format exact pe helperele reale ──
const okRes  = mcpResponse({ text: "SECRET_CONTENT_TEXT", data: { pair: "0xabc" } });
const errRes = mcpErr(ERR.REDIS_DOWN, "Redis not connected");
check("1. ⭐⭐⭐ succes (mcpResponse) → linia exactă isError=false structured=ok",
  formatToolCallLog("tp_situation_report", okRes) === "[MCP TOOL] name=tp_situation_report isError=false structured=ok");
check("2. ⭐⭐⭐ eroare (mcpErr) → isError=true structured=absent",
  formatToolCallLog("tp_situation_report", errRes) === "[MCP TOOL] name=tp_situation_report isError=true structured=absent");
check("3. ⭐⭐ regex de format (cum îl citește proba S2)",
  /^\[MCP TOOL\] name=[A-Za-z0-9_.?-]+ isError=(true|false) structured=(ok|absent|invalid)$/.test(formatToolCallLog("tp_x", okRes)));

// ── (b) clasificare ──
check("4. ⭐⭐⭐ structuredContent obiect cu ok:false → invalid", classifyStructuredContent({ structuredContent: { ok: false } }) === "invalid");
check("5. ⭐⭐ structuredContent obiect fără ok / ok:'true' (string) → invalid",
  classifyStructuredContent({ structuredContent: {} }) === "invalid"
  && classifyStructuredContent({ structuredContent: { ok: "true" } }) === "invalid");
check("6. ⭐⭐ structuredContent array / primitiv → invalid",
  classifyStructuredContent({ structuredContent: [{ ok: true }] }) === "invalid"
  && classifyStructuredContent({ structuredContent: "x" }) === "invalid"
  && classifyStructuredContent({ structuredContent: 1 }) === "invalid");
check("7. ⭐⭐ structuredContent lipsă / undefined / null → absent",
  classifyStructuredContent({ content: [] }) === "absent"
  && classifyStructuredContent({ structuredContent: undefined }) === "absent"
  && classifyStructuredContent({ structuredContent: null }) === "absent");
check("8. ⭐ rezultat non-obiect (undefined/null/string) → absent, isError=false",
  [undefined, null, "x"].every(r => classifyStructuredContent(r) === "absent" && resultIsError(r) === false));
check("9. ⭐⭐ isError strict: doar `true` boolean", resultIsError({ isError: true }) && !resultIsError({ isError: "true" })
  && !resultIsError({ isError: 1 }) && !resultIsError({ isError: false }) && !resultIsError({}));
check("10. ⭐⭐ isError=true CU structuredContent ok → ambele raportate (nu ascundem incoerența)",
  formatToolCallLog("t", { isError: true, structuredContent: { ok: true } }) === "[MCP TOOL] name=t isError=true structured=ok");

// ── (c) fără conținut, nume sigur ──
check("11. ⭐⭐⭐ conținutul/textul/data NU apar în linie",
  !formatToolCallLog("tp_situation_report", okRes).includes("SECRET_CONTENT_TEXT")
  && !formatToolCallLog("tp_situation_report", okRes).includes("0xabc")
  && !formatToolCallLog("tp_situation_report", errRes).includes("Redis not connected"));
check("12. ⭐⭐⭐ numele nu poate injecta câmpuri/linii (spațiu, =, newline → ?)", (() => {
  const l = formatToolCallLog("evil name=x isError=false\nstructured=ok", errRes);
  return !l.includes("\n") && (l.match(/isError=/g) ?? []).length === 1 && l.endsWith("isError=true structured=absent");
})());
check("13. ⭐ nume gol / non-string → '?'; nume lung → max 64", sanitizeToolName("") === "?" && sanitizeToolName(undefined) === "?"
  && sanitizeToolName("a".repeat(100)).length === 64);

// ── (d) guard de sursă: middleware ──
{
  const mw = readFileSync("lib/mcp/middleware.ts", "utf8");
  check("14. ⭐⭐⭐ middleware importă formatToolCallLog din ./toolCallLog",
    /import \{ formatToolCallLog \}\s+from "\.\/toolCallLog"/.test(mw));
  check("15. ⭐⭐⭐ wrapper-ul înregistrat loghează rezultatul FIECĂREI căi (runInstrumented → log → return)",
    /const instrumentedHandler = async[\s\S]{0,200}result = await runInstrumented\(args\)[\s\S]{0,200}console\.log\(formatToolCallLog\(name, result\)\);\s*return result;/.test(mw));
  check("16. ⭐⭐ excepție scăpată → linie isError=true, apoi rethrow",
    /catch \(e\) \{\s*console\.log\(formatToolCallLog\(name, \{ isError: true \}\)\);\s*throw e;/.test(mw));
  check("17. ⭐⭐⭐ la SDK se înregistrează wrapper-ul cu log (instrumentedHandler), nu runInstrumented",
    /originalRegisterTool\(\s*name,[\s\S]{0,120}instrumentedHandler as Parameters/.test(mw) && !/runInstrumented as Parameters/.test(mw));
  check("18. ⭐⭐ formatter-ul primește doar (name, result) — fără args/ctx în linie",
    !/formatToolCallLog\([^)]*args/.test(mw) && !/formatToolCallLog\([^)]*ctx/.test(mw));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
