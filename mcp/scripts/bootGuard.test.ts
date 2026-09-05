/**
 * scripts/bootGuard.test.ts — PH-12 slice 12.2d (dovadă comportamentală boot-guard MCP).
 *
 * MCP nu are un `bootstrap.ts` lansat de `tsx` (entry-point-ul e `next start`); boot-guard-ul e `register()` din
 * `instrumentation.ts`, pe care Next îl cheamă O DATĂ la pornire, înainte de a servi, în runtime-ul Node. Testul
 * REPRODUCE ce face Next: într-un PROCES SEPARAT, ASINCRON, IZOLAT (`cwd` temp gol, env EXACT, `tsx` LOCAL fără npx),
 * un mic HARNESS importă `instrumentation.ts` REAL (după calea absolută) și `await register()`, apoi ar continua să
 * servească (marker POST-register + rămâne viu). Cazuri:
 *   - env INVALID + `NEXT_RUNTIME=nodejs` → `register()` face `process.exit(1)` → iese non-zero ÎNAINTE ca harness-ul
 *     să ajungă la markerul POST-register (serverul NU ar servi); diagnostic FAIL cu câmpul lipsă, fără valori.
 *   - env cu WARNINGS + `nodejs` → `register()` întoarce controlul → marker POST-register PREZENT + proces RĂMÂNE VIU
 *     până la oprirea DELIBERATĂ de test (o ieșire spontană ar pica). `validateMcpEnv` e PUR → netGuard dovedește ZERO
 *     apel extern (contract 12.2d: fără ping Redis/RPC/Supabase).
 *   - env INVALID dar `NEXT_RUNTIME=edge` → `register()` NU validează / NU oprește (guard-ul e DOAR pentru serverul
 *     Node) → marker POST-register PREZENT, niciun diagnostic FAIL. Dovada că poarta `NEXT_RUNTIME==="nodejs"` e corectă.
 *
 * Source-guard: `instrumentation.ts` la RĂDĂCINA mcp (unde Next îl caută), exportă `register`, poartă `nodejs`, cheamă
 * `validateMcpEnv`, iar pe `!ok` face `process.exit(1)` TEXTUAL înainte de calea de continuare; `package.json` `start`
 * lansează `next start` (Next invocă instrumentarea) și `dev` `next dev`; `test:boot` cablat în lanțul `test`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as path from "node:path";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const mcpDir = process.cwd();
const instrumentationAbs = path.join(mcpDir, "instrumentation.ts");
const tsxBin = path.join(mcpDir, "..", "node_modules", ".bin", "tsx");
const POST_REGISTER_MARKER = "[HARNESS] register() a întors controlul";
const BOOT_OK_MARKER = "env valid — serverul poate porni";

if (!existsSync(tsxBin)) {
  console.error(`[test:boot] tsx local negăsit la ${tsxBin} — rulează \`npm install\` la rădăcina monorepo-ului (fără npx).`);
  process.exit(1);
}
if (!existsSync(instrumentationAbs)) {
  console.error(`[test:boot] instrumentation.ts negăsit la ${instrumentationAbs} — hook-ul de boot Next lipsește.`);
  process.exit(1);
}

// netGuard: dacă boot-guard-ul ar atinge rețeaua (ping Supabase/RPC), interceptăm și marcăm LEAK. `validateMcpEnv` e
// pur → nu trebuie să apară niciun leak. (ioredis ar folosi TCP, nu fetch, dar calea de validare nu construiește
// niciun client Redis — e pură; netGuard-ul acoperă orice fetch HTTP.)
const NETGUARD_SRC = `
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) ? input.url : String(input);
  console.error("[NETGUARD] LEAK — boot-guard a încercat un apel extern (nu ar trebui, validarea e pură): " + url);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
console.error("[NETGUARD] activ — orice fetch în calea de boot e un LEAK");
`;

const HARNESS_SRC = (instrAbs: string) => `
// Imită Next: env-ul e deja în process.env (aici prin env-ul de spawn); rulează register() la pornire; apoi ar servi.
async function main() {
  const mod = await import(${JSON.stringify(pathToFileURL(instrAbs).href)});
  await mod.register();
  console.log(${JSON.stringify(POST_REGISTER_MARKER)} + " — Next AR continua să servească");
  setInterval(() => {}, 1000); // rămâne viu până la kill-ul deliberat al testului
}
main().catch((e) => { console.error("[HARNESS] register() a ARUNCAT:", e); process.exit(7); });
`;

interface RunResult { status: number | null; signal: string | null; out: string; spawnError: Error | null; killRequested: boolean; hardKilled: boolean; }

/**
 * `killRequested` devine true DOAR când testul TRIMITE efectiv SIGTERM (după markerul POST-register + un delay), NU la
 * simpla detectare. `hardKilled` = a fost nevoie de SIGKILL (deadline depășit → a atârnat). Distinge: oprire solicitată
 * de test (ok) vs. ieșire spontană (crash) vs. atârnare.
 */
function runHarness(env: Record<string, string>, opts: { killAfterMarker?: string; markerDelayMs?: number; timeoutMs: number }): Promise<RunResult> {
  const tmp = mkdtempSync(path.join(tmpdir(), "bootguard-mcp-"));
  const netGuardPath = path.join(tmp, "netGuard.mjs");
  const harnessPath = path.join(tmp, "harness.ts");
  writeFileSync(netGuardPath, NETGUARD_SRC);
  writeFileSync(harnessPath, HARNESS_SRC(instrumentationAbs));
  return new Promise<RunResult>((resolve) => {
    const child = spawn(tsxBin, [harnessPath], {
      cwd: tmp,
      // cast dublu: tsconfig-ul MCP trage `next/types/global.d.ts` care tipează `NODE_ENV` ca uniune literală OBLIGATORIE
      // pe ProcessEnv — un env de spawn construit dinamic (record de string-uri) nu o poate satisface. La runtime e un
      // simplu map. (Workerii n-au augmentarea Next, deci acolo același pattern nu cere cast.)
      env: { PATH: process.env.PATH ?? "", ...env, NODE_OPTIONS: `--import ${pathToFileURL(netGuardPath).href}` } as unknown as NodeJS.ProcessEnv,
    });
    let out = "", killRequested = false, hardKilled = false, killScheduled = false, settled = false;
    const finish = (status: number | null, signal: string | null, spawnError: Error | null) => {
      if (settled) return; settled = true;
      clearTimeout(hardTimer);
      rmSync(tmp, { recursive: true, force: true });
      resolve({ status, signal, out, spawnError, killRequested, hardKilled });
    };
    const onData = (d: Buffer) => {
      out += d.toString();
      if (opts.killAfterMarker && out.includes(opts.killAfterMarker) && !killScheduled) {
        killScheduled = true;
        setTimeout(() => { killRequested = true; child.kill("SIGTERM"); }, opts.markerDelayMs ?? 800);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => finish(null, null, err));
    child.on("exit", (status, signal) => finish(status, signal, null));
    const hardTimer = setTimeout(() => { hardKilled = true; child.kill("SIGKILL"); }, opts.timeoutMs);
  });
}

async function main(): Promise<void> {
console.log("PH-12 12.2d — boot-guard MCP (dovadă comportamentală, register() în proces separat izolat)");

// valorile de bază VALIDE de RUNTIME. Instrumentation validează DOAR env-ul de runtime — FĂRĂ `NEXT_PUBLIC_*` (acelea-s
// build-frozen, validate în `next.config.ts`). Că register() trece fără `NEXT_PUBLIC_*` în env dovedește separarea.
const validBase = {
  SUPABASE_SERVICE_ROLE_KEY: "service_demo_key",
  REDIS_URL: "redis://127.0.0.1:6379",
};

// ── env INVALID (prod, fără cheile obligatorii) + nodejs → register() face exit(1) înainte de a servi ──
const bad = await runHarness({ NODE_ENV: "production", NEXT_RUNTIME: "nodejs" }, { timeoutMs: 20_000 });
check("1. ⭐⭐⭐ env invalid + nodejs → IESE cu cod NON-ZERO (register a chemat process.exit)", bad.status !== 0 && bad.status !== null);
check("2. ⭐⭐⭐ env invalid → fără eroare de spawn", bad.spawnError === null);
check("3. ⭐⭐⭐ env invalid → diagnostic FAIL cu câmp obligatoriu lipsă (REDIS_URL)", /FAIL/.test(bad.out) && /REDIS_URL/.test(bad.out));
check("4. ⭐⭐⭐ env invalid → serverul NU ar servi (marker POST-register ABSENT — register a oprit ÎNAINTE)", !bad.out.includes(POST_REGISTER_MARKER));
check("5. ⭐⭐ env invalid → mesaj explicit de oprire, fără valori", /configurație env invalidă/.test(bad.out) && /serverul NU pornește/.test(bad.out));

// ── env cu WARNINGS (valid + surplus ALCHEMY_* → warning) + nodejs → register() continuă, harness rămâne viu ──
const warn = await runHarness(
  { NODE_ENV: "development", NEXT_RUNTIME: "nodejs", ...validBase, ALCHEMY_ETH_RPC: "https://eth.example" },
  { killAfterMarker: POST_REGISTER_MARKER, markerDelayMs: 1200, timeoutMs: 15_000 },
);
check("6. ⭐⭐⭐ env cu warnings → boot-guard continuă (marker `env valid` prezent)", warn.out.includes(BOOT_OK_MARKER));
check("7. ⭐⭐⭐ env cu warnings → surplusul e vizibil ca warning (ALCHEMY_)", /ALCHEMY_/.test(warn.out));
check("8. ⭐⭐⭐ env cu warnings → register() A ÎNTORS CONTROLUL (marker POST-register prezent → Next ar servi)", warn.out.includes(POST_REGISTER_MARKER));
const warnKilledBySignal = warn.signal !== null || (warn.status !== null && warn.status >= 128);
check("9. ⭐⭐⭐ env cu warnings → procesul a RĂMAS VIU până la oprirea SOLICITATĂ de test (NU ieșire spontană)",
  warn.killRequested === true && warn.hardKilled === false && warnKilledBySignal);
check("10. ⭐⭐⭐ env cu warnings → fără throw / eroare de spawn (register nu a aruncat)",
  warn.spawnError === null && !/register\(\) a ARUNCAT/.test(warn.out));
check("10b. ⭐⭐⭐ izolare rețea: netGuard activ ȘI ZERO leak (validarea e pură, fără ping Redis/RPC/Supabase)",
  /\[NETGUARD\] activ/.test(warn.out) && !/\[NETGUARD\] LEAK/.test(warn.out));

// ── env INVALID dar NEXT_RUNTIME=edge → register() NU validează / NU oprește (guard doar pe serverul Node) ──
const edge = await runHarness(
  { NODE_ENV: "production", NEXT_RUNTIME: "edge" },
  { killAfterMarker: POST_REGISTER_MARKER, markerDelayMs: 800, timeoutMs: 12_000 },
);
check("11. ⭐⭐⭐ poartă runtime: env invalid dar NEXT_RUNTIME=edge → register() NO-OP (marker POST-register PREZENT)",
  edge.out.includes(POST_REGISTER_MARKER));
check("12. ⭐⭐⭐ poartă runtime: edge → NICIUN diagnostic FAIL (nu s-a validat/oprit în afara serverului Node)",
  !/FAIL/.test(edge.out) && edge.killRequested === true);

// ── source-guard ──────────────────────────────────────────────────────────────────
const instr = readFileSync(instrumentationAbs, "utf8");
check("13. ⭐⭐⭐ instrumentation.ts exportă `register` (hook-ul pe care Next îl invocă la pornire)",
  /export\s+(async\s+)?function\s+register\s*\(/.test(instr));
check("14. ⭐⭐⭐ instrumentation.ts poartă pe NEXT_RUNTIME==='nodejs' (guard doar în serverul Node)",
  /NEXT_RUNTIME\s*!==\s*["']nodejs["']/.test(instr));
check("15. ⭐⭐⭐ instrumentation.ts cheamă validateMcpEnv ȘI face process.exit(1) pe !ok, ÎNAINTE de calea de continuare", (() => {
  const vIdx = instr.indexOf("validateMcpEnv(process.env)");      // apelul REAL (comentariul zice doar `validateMcpEnv`, fără `(process.env)`)
  const eIdx = vIdx === -1 ? -1 : instr.indexOf("process.exit(1)", vIdx); // caută DUPĂ apel (comentariul de sus conține și el `process.exit(1)`)
  const okIdx = eIdx === -1 ? -1 : instr.indexOf("env valid — serverul poate porni", eIdx);
  return vIdx !== -1 && eIdx !== -1 && okIdx !== -1 && vIdx < eIdx && eIdx < okIdx;
})());

const pkg = JSON.parse(readFileSync(path.join(mcpDir, "package.json"), "utf8")) as { scripts: Record<string, string> };
check("16. ⭐⭐⭐ package.json `start` lansează `next start` (Next invocă instrumentation.register la pornire)", /next start/.test(pkg.scripts.start));
check("17. ⭐⭐⭐ package.json `dev` lansează `next dev` (același hook la dev)", /next dev/.test(pkg.scripts.dev));
check("18. ⭐⭐⭐ package.json: `test:boot` cablat în lanțul agregat `test` (gate CI PH-5 check 14)",
  /tsx scripts\/bootGuard\.test\.ts/.test(pkg.scripts["test:boot"] ?? "") && /test:boot/.test(pkg.scripts.test));

// ── source-guard: separarea build-env vs runtime-env (blocker cgpt P1) ──────────────
const nextCfg = readFileSync(path.join(mcpDir, "next.config.ts"), "utf8");
check("19. ⭐⭐⭐ next.config.ts validează BUILD-env (`validateBuildEnv`) gated pe `PHASE_PRODUCTION_BUILD` și ARUNCĂ pe !ok", (() => {
  const pIdx = nextCfg.indexOf("PHASE_PRODUCTION_BUILD");
  const vIdx = nextCfg.indexOf("validateBuildEnv(process.env)");
  const tIdx = nextCfg.indexOf("throw");
  return pIdx !== -1 && vIdx !== -1 && tIdx !== -1 && pIdx < vIdx && vIdx < tIdx;
})());
check("19b. ⭐⭐⭐ next.config.ts NU IMPORTĂ @preflight/* (transpilerul de config Next nu rezolvă workspace → build-ul ar pica)",
  !/from\s+["']@preflight\//.test(nextCfg) && /\.\/lib\/config\/buildEnvCheck/.test(nextCfg));
check("19c. ⭐⭐⭐ buildEnvCheck.ts e AUTONOM (fără import de valori din @preflight/*)", (() => {
  const bec = readFileSync(path.join(mcpDir, "lib", "config", "buildEnvCheck.ts"), "utf8");
  return !/from ["']@preflight\//.test(bec) && /NEXT_PUBLIC_SUPABASE_URL/.test(bec);
})());
check("20. ⭐⭐⭐ instrumentation.ts CHEAMĂ validateMcpEnv (runtime) — NU CHEAMĂ validatorul de build (separare clară)",
  /validateMcpEnv\(process\.env\)/.test(instr) && !/validateBuildEnv\s*\(/.test(instr));
check("21. ⭐⭐⭐ schema RUNTIME NU mai conține NEXT_PUBLIC_* (mutate în buildEnvCheck)", (() => {
  const schema = readFileSync(path.join(mcpDir, "lib", "config", "envSchema.ts"), "utf8");
  // NEXT_PUBLIC_ nu apare ca nume de câmp în MCP_ENV_FIELDS (runtime). (Poate apărea în comentariul de referință.)
  return !/name:\s*["']NEXT_PUBLIC_/.test(schema);
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

void main();
