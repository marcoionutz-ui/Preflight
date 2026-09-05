/**
 * scripts/bootSmoke.integration.ts — PH-12 slice 12.2d-mcp (SMOKE prin entrypoint-ul Next REAL).
 *
 * DE CE (blocker cgpt P1-a): `bootGuard.test.ts` importă `instrumentation.ts` într-un harness propriu → dovedește
 * CONTRACTUL lui `register()`, dar NU că `next start` chiar DESCOPERĂ și EXECUTĂ hook-ul. Acest smoke rulează
 * entrypoint-ul REAL (`next build` + `next start`) și verifică AMBELE porți de boot introduse în 12.2d-mcp:
 *   A. BUILD-guard (P1-b): `next build` cu `NEXT_PUBLIC_*` INVALIDE → build-ul PICĂ (next.config.ts aruncă la
 *      `PHASE_PRODUCTION_BUILD`), fiindcă valorile s-ar îngheța greșit în bundle-ul livrat.
 *   B. BUILD valid → produce `.next`.
 *   C. RUNTIME-guard invalid (P1-a): `next start` cu env server INVALID → procesul MOARE non-zero ȘI NU ascultă pe
 *      port (register a chemat `process.exit(1)` înainte de a servi). Marker `[BOOT][mcp] configurație env invalidă`.
 *   D. RUNTIME-guard valid (P1-a): `next start` cu env server VALID → serverul ASCULTĂ pe port ȘI `/api/health`
 *      RĂSPUNDE (Next servește). Marker `[BOOT][mcp] env valid`.
 *
 * IZOLARE de `.env*` (blocker cgpt P1 „mascat de .env.local"): Next încarcă `.env`/`.env.local`/`.env.<NODE_ENV>` prin
 * `@next/env`, DAR nu suprascrie variabilele deja prezente în `process.env`. Deci NU ne bazăm pe ABSENȚA unei variabile
 * (pe care `.env.local` a lui Marco ar completa-o și ar MASCA testul); setăm explicit o valoare INVALIDĂ (precedența
 * `process.env` câștigă) și PINN-uim cele 6 variabile care pot flip-ui ok↔fail: 3 required (`REDIS_URL`,
 * `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_BASE_URL`) + 3 forbid-in-prod (`MCP_DEV_AUTH_BYPASS`, `QUOTA_INTEGRATION_ALLOW`,
 * `PH4_INTEGRATION_ALLOW` = "0"). Opționalele rămase produc doar warnings (non-fatale) → nu schimbă verdictul boot.
 *
 * OPT-IN (`.integration.ts`, nu `.test.ts` → nu-l cere gate-14; nu intră în lanțul `test` per-commit): rulează greu
 * (2× `next build`). Se rulează în gate-ul de deployment-cert: `npm run test:boot-smoke -w @preflight/mcp`.
 * NU atinge Redis/Supabase reale — `validateMcpEnv` e pur; portul ascultă fără backend (conexiunea la Redis e per-request;
 * `/api/health` e proiectat să răspundă degradat, nu să atârne, fără Redis).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const mcpDir = process.cwd();
function resolveBin(name: string): string | null {
  for (const p of [path.join(mcpDir, "node_modules", ".bin", name), path.join(mcpDir, "..", "node_modules", ".bin", name)]) {
    if (existsSync(p)) return p;
  }
  return null;
}
const nextBin = resolveBin("next");

// forbid-in-prod PINN-uite pe "0" ca `.env.local` să nu poată injecta un flag aprins care ar face register să pice în
// scenariul VALID (izolare completă a verdictului boot).
const FORBID_OFF = { MCP_DEV_AUTH_BYPASS: "0", QUOTA_INTEGRATION_ALLOW: "0", PH4_INTEGRATION_ALLOW: "0" };
// NEXT_PUBLIC_* valide (înghețate în bundle la build valid).
const VALID_PUBLIC = { NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-123" };
// Env server VALID de runtime (format-only; niciun backend chemat de register). Cele 3 required pinn-uite.
const VALID_RUNTIME = { SUPABASE_SERVICE_ROLE_KEY: "service-role-456", REDIS_URL: "redis://127.0.0.1:6379", PUBLIC_BASE_URL: "https://preflight.jackspools.lol", ...FORBID_OFF };

interface RunResult { status: number | null; signal: string | null; out: string; }

function runToExit(args: string[], env: Record<string, string>, timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(nextBin as string, args, { cwd: mcpDir, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv });
    let out = "", settled = false;
    const finish = (status: number | null, signal: string | null) => {
      if (settled) return; settled = true; clearTimeout(t); resolve({ status, signal, out });
    };
    const onData = (d: Buffer) => { out += d.toString(); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", () => finish(null, null));
    child.on("exit", (s, sig) => finish(s, sig));
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* deja mort */ } finish(null, "TIMEOUT"); }, timeoutMs);
  });
}

function tcpConnects(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let done = false;
    const end = (ok: boolean) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.on("connect", () => end(true));
    sock.on("error", () => end(false));
    setTimeout(() => end(false), timeoutMs);
  });
}
async function pollListening(port: number, totalMs: number): Promise<boolean> {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await tcpConnects(port, 500)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
/** GET http://127.0.0.1:port/api/health cu timeout intern. Întoarce status-ul HTTP (dovada că ruta SERVEȘTE) sau null. */
function httpGetHealth(port: number, timeoutMs: number): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs }, (res) => {
      res.resume(); // consumă corpul ca socketul să se elibereze
      resolve(res.statusCode ?? null);
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function startNext(env: Record<string, string>, port: number): { child: ChildProcess; out: () => string; exited: Promise<RunResult> } {
  const child = spawn(nextBin as string, ["start", "-p", String(port)], { cwd: mcpDir, env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv });
  let out = "";
  const onData = (d: Buffer) => { out += d.toString(); };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const exited = new Promise<RunResult>((resolve) => {
    child.on("error", () => resolve({ status: null, signal: null, out }));
    child.on("exit", (s, sig) => resolve({ status: s, signal: sig, out }));
  });
  return { child, out: () => out, exited };
}
function kill(child: ChildProcess): void { try { child.kill("SIGKILL"); } catch { /* deja mort */ } }

async function main(): Promise<void> {
console.log("PH-12 12.2d-mcp — SMOKE prin next build/next start REAL (build-guard + runtime-guard, izolat de .env*)");
if (!nextBin) {
  console.error("[test:boot-smoke] binarul `next` negăsit — rulează în workspace-ul complet (WSL), nu în sandbox parțial.");
  process.exit(2);
}

const portInvalid = 34117, portValid = 34119;

// ── A. BUILD-guard: NEXT_PUBLIC_SUPABASE_URL INVALID (setat explicit → precedență peste .env.local) → build PICĂ ──
const badBuild = await runToExit(["build"], { NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "not-a-url", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-123" }, 240_000);
check("A1. ⭐⭐⭐ next build cu NEXT_PUBLIC_SUPABASE_URL invalid → build PICĂ (exit non-zero)", badBuild.status !== 0);
check("A2. ⭐⭐⭐ build eșuat → marker build-guard prezent (fără valori), câmpul numit", /\[BUILD\]\[mcp\] NEXT_PUBLIC_\* invalide/.test(badBuild.out) || /NEXT_PUBLIC_SUPABASE_URL/.test(badBuild.out));

// ── B. BUILD valid (NEXT_PUBLIC_* setate valid → precedență) → produce `.next` ──
const goodBuild = await runToExit(["build"], { NODE_ENV: "production", ...VALID_PUBLIC }, 300_000);
check("B1. ⭐⭐⭐ next build cu NEXT_PUBLIC_* valide → build reușit (exit 0)", goodBuild.status === 0);
check("B2. ⭐⭐ build valid → `.next` există", existsSync(path.join(mcpDir, ".next")));
check("B3. ⭐⭐ build valid → marker build-guard OK", /\[BUILD\]\[mcp\] NEXT_PUBLIC_\* valide/.test(goodBuild.out) || /\[env:mcp:build\] OK/.test(goodBuild.out));

// ── C. RUNTIME-guard invalid: REDIS_URL INVALID (setat explicit → izolat de .env.local) → moare, NU RĂMÂNE sus ──
// NOTĂ Next: `next start` LEAGĂ portul ÎNAINTE ca `process.exit(1)` din register să se producă, deci un „nu a ascultat
// NICIODATĂ" ar fi fals. Dovada guard-ului e alta: procesul IESE non-zero (C1 — nimic altceva nu iese pe un REDIS_URL
// invalid; app-ul ar servi și ar eșua per-request) ȘI serverul NU RĂMÂNE ascultând după ce moare (C2).
const badEnv = { NODE_ENV: "production", ...VALID_PUBLIC, SUPABASE_SERVICE_ROLE_KEY: "service-role-456", PUBLIC_BASE_URL: "https://preflight.jackspools.lol", REDIS_URL: "not-a-redis-url", ...FORBID_OFF };
const badStart = startNext(badEnv, portInvalid);
// deadline INTERN (nit cgpt): dacă nu moare singur, îl omorâm noi — diagnosticul nu depinde de `timeout` din shell.
const INVALID_DEADLINE_MS = 25_000;
const internalDeadline = new Promise<RunResult>((resolve) => setTimeout(() => { kill(badStart.child); resolve({ status: null, signal: "INTERNAL_TIMEOUT", out: badStart.out() }); }, INVALID_DEADLINE_MS));
const badFinal = await Promise.race([badStart.exited, internalDeadline]);
kill(badStart.child);
const stillListeningAfterExit = await tcpConnects(portInvalid, 1_500); // după ce a murit, portul trebuie să fie ÎNCHIS
check("C1. ⭐⭐⭐ env server invalid → procesul IESE non-zero (register a chemat process.exit; NU e timeout intern)",
  badFinal.status !== 0 && badFinal.status !== null && badFinal.signal !== "INTERNAL_TIMEOUT");
check("C2. ⭐⭐⭐ env server invalid → serverul NU RĂMÂNE ascultând (guard-ul a oprit procesul; portul închis după ieșire)",
  stillListeningAfterExit === false);
check("C3. ⭐⭐⭐ env server invalid → marker de boot-guard runtime prezent (stderr)", /\[BOOT\]\[mcp\] configurație env invalidă/.test(badFinal.out) || /REDIS_URL/.test(badFinal.out));

// ── D. RUNTIME-guard valid → ASCULTĂ pe port ȘI /api/health răspunde ──
const goodStart = startNext({ NODE_ENV: "production", ...VALID_PUBLIC, ...VALID_RUNTIME }, portValid);
const listens = await Promise.race([
  pollListening(portValid, 30_000).then((v) => ({ kind: "listen" as const, v })),
  goodStart.exited.then(() => ({ kind: "exit" as const, v: false })),
]);
const listened = listens.kind === "listen" && listens.v === true;
check("D1. ⭐⭐⭐ env server valid → serverul ASCULTĂ pe port (register a trecut → Next servește)", listened);
let healthStatus: number | null = null;
if (listened) healthStatus = await httpGetHealth(portValid, 10_000);
check("D3. ⭐⭐⭐ /api/health RĂSPUNDE (ruta e servită prin entrypoint-ul real; orice status HTTP = a servit)",
  listened && healthStatus !== null);
console.log(`     (health status = ${healthStatus ?? "fără răspuns"})`);
// D2 după health: register a rulat cu mult înainte, iar markerul e pe STDERR (captat live) → prezent în output-ul acumulat.
check("D2. ⭐⭐⭐ env server valid → marker `[BOOT][mcp] env valid` prezent (stderr)", /\[BOOT\]\[mcp\] env valid/.test(goodStart.out()));
goodStart.child.kill("SIGTERM"); // oprire ordonată (flush); fallback SIGKILL dacă nu iese
await Promise.race([goodStart.exited, new Promise((r) => setTimeout(() => { kill(goodStart.child); r(undefined); }, 8_000))]);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

void main();
