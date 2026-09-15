/**
 * runGate2Live.mjs — PH-12 12.5c-3b LIVE runner (opt-in, reproductibil; rulează cu tsx, worker spawnat real).
 *
 * Rulează Gate 2 Base-canary REAL pe stack-ul local: pornește Worker Base TEMPORAR (ENABLED_CHAINS=base, PREFLIGHT_MODE=
 * LIVE, ALCHEMY_BASE_WS, REDIS_URL loopback) în process group DETACHED, apoi `runGate2` face poll până strict-health Base
 * + `tp_worker_snapshot` cu date reale + `tp_health_check` cu WS subscriptions sunt TOATE verzi, apoi oprește worker-ul
 * (SIGTERM pe grup → grace 13s > deadline PH-13 10s → SIGKILL) confirmând că ÎNTREGUL grup a dispărut (niciun consumator
 * Alchemy orfan). Compune piesele COMISE: `canaryGate2` (orchestrator pur 12.5c-2) + `canaryGate2Steps` (adaptoare reale
 * 12.5c-3b) + `canaryWorkerProcess` (lifecycle 12.5c-3a).
 *
 * Gate 2 NU face OAuth (decizie Marco): primește `accessToken` ca INPUT (`GATE2_ACCESS_TOKEN`). Tokenul TREBUIE să
 * aparțină unui cont cu plan `starter` (scope read:all) — altfel `tp_worker_snapshot`/`tp_health_check` → FORBIDDEN.
 * 12.5c-4 va COMPUNE Gate 1 (fixture starter → token) → Gate 2 (îl consumă). Aici tokenul e furnizat din afară.
 *
 * ANTI-LEAK (regula Marco): tokenul e strippat din env-ul worker-ului (`buildWorkerBaseEnv` scoate `GATE2_*`); logăm
 * DOAR din ținte VETATE (origine curată, Redis loopback) — niciodată `ORIGIN`/`REDIS_URL` bruți; mesajele de eroare
 * sunt STATICE (fără `e.message`, care poate purta un URL cu secret).
 *
 * PREREQUISITE (aceeași fereastră `base-canary`, cost-aware):
 *   - MCP dev rulează pe ORIGIN cu `HEALTH_EXPECTED_CHAINS=base` + `HEALTH_EXPECT_INDEXER_EVM=0` + `HEALTH_EXPECT_SOLANA_WORKER=0`.
 *   - Redis loopback pornit (împărțit de worker + MCP).
 *   - `ALCHEMY_BASE_WS` setat în env (cost RPC real — de asta e opt-in și temporar).
 *
 * E .mjs INTENȚIONAT: NU intră în `tsc`/`eslint`/`test` per-commit. Logica testabilă (adaptoare + orchestrator + backstop)
 * e în `.ts` comise + testate hermetic (`test:ph12-canary`) + integration (`test:ph12-canary-worker`). Aici doar cablaj.
 *
 * Rulează (stack local sus): `set -a; . .env.local; set +a; GATE2_ACCESS_TOKEN=<AT starter> npx tsx runGate2Live.mjs`
 * din ~/preflight/mcp. `GATE2_DEBUG=1` (byte-exact) → stderr worker redactat (URL→origine).
 */

import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runGate2, vetGate2Targets } from "./lib/mcp/canaryGate2.ts";
import { makeGate2Steps, sweepBackstop, DEFAULT_STOP_TIMING } from "./lib/mcp/canaryGate2Steps.ts";
import { stopManagedProcess, realStopTimers } from "./lib/mcp/canaryWorkerProcess.ts";

const ORIGIN       = process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3000";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const REDIS_URL    = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const ACCESS_TOKEN = process.env.GATE2_ACCESS_TOKEN || "";
const ALCHEMY_WS   = process.env.ALCHEMY_BASE_WS || "";
const DEBUG_ON     = process.env.GATE2_DEBUG === "1"; // byte-exact: `GATE2_DEBUG=0` NU activează (doctrina exactFlag)

const log   = (...a) => console.log("[gate2-live]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!ACCESS_TOKEN) { console.error("GATE2_ACCESS_TOKEN lipsă — Gate 2 primește tokenul ca input (cont plan 'starter', read:all)."); process.exit(2); }
if (!ALCHEMY_WS)   { console.error("ALCHEMY_BASE_WS lipsă — LIVE ar rula base scan-only (fără date/WS). Ai făcut `set -a; . .env.local; set +a`?"); process.exit(2); }

// cwd-ul worker-ului: ~/preflight/workers/evm (relativ la ~/preflight/mcp). `npx tsx src/bootstrap.ts` = boot-guard → import ./index.
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const WORKER_CWD = path.resolve(__dirname, "../workers/evm");

// Backstop anti-orfan: registru de procese spawnate + latch din `teardownConfirmed` (via onStopResult). `sweepBackstop`
// (comis + testat) RErulează lifecycle-ul CONFIRMAT din 3a (`stopManagedProcess`, bounded) pe procesele neconfirmate.
const registry = [];
const onSpawn = (proc) => { registry.push({ proc, confirmed: false }); log("worker spawnat pid", proc.pid); };
const onStopResult = (r) => { const e = registry[registry.length - 1]; if (e) e.confirmed = r.teardownConfirmed; };

async function main() {
  const cfg = { mcpBaseUrl: ORIGIN, supabaseUrl: SUPABASE_URL, redisUrl: REDIS_URL, accessToken: ACCESS_TOKEN };

  // POARTA TARE ÎNTÂI (fix cgpt P1): vet-uim ÎNAINTE de a loga orice — plasa anti-prod + origine curată + Redis loopback +
  // token prezent. Logăm EXCLUSIV din țintele vetate (origine curată; NICIODATĂ `ORIGIN`/`REDIS_URL` bruți, care pot
  // purta userinfo/secrete). `runGate2` re-vetează idempotent din același cfg.
  const vet = vetGate2Targets(cfg);
  if (!vet.ok) { console.error("izolare/țintă respinsă de plasa anti-prod (fail-closed)"); process.exit(2); }
  const targets = vet.targets;
  log("izolat OK → MCP", targets.mcpOrigin, "| Redis loopback OK | worker cwd", WORKER_CWD);

  const launch = {
    command: "npx",
    args: ["tsx", "src/bootstrap.ts"],
    cwd: WORKER_CWD,
    baseEnv: { ...process.env }, // worker moștenește env-ul; buildWorkerBaseEnv suprascrie cheile de control + STRIPUIEȘTE GATE2_* (tokenul)
    alchemyBaseWs: ALCHEMY_WS,
    ...(DEBUG_ON ? { onDebugLine: (line) => console.error("[worker]", line) } : {}),
  };

  const makeSteps = (t) => makeGate2Steps({ launch, onSpawn, onStopResult }, t);
  const clock = { now: () => performance.now(), sleep };

  log("spawn worker Base (temporar) → poll strict-health + tp_worker_snapshot + tp_health_check …");

  let report, threw = false;
  try {
    report = await runGate2(cfg, makeSteps, clock, {
      // Timing real: warm-up 180s (indexarea primelor perechi Base + WS subs), global 300s. Teardown = DEFAULT_STOP_TIMING
      // (grace 13s) în adaptor; stopTimeoutMs 20s (bugetul orchestratorului pe stop, peste grace-ul intern).
      warmupMs: 180_000, globalMs: 300_000, stopTimeoutMs: 20_000, graceMs: 5_000,
    });
  } catch {
    threw = true; // mesaj STATIC (fără e.message — poate purta un URL cu secret)
  }

  // Backstop CONFIRMAT: chiar dacă `runGate2` a apelat stop în finally, re-rulăm lifecycle-ul 3a (bounded, confirmă grup
  // dispărut + lider reap-uit) pe orice proc rămas neconfirmat. `stillAlive` real = orfan → ATENȚIE.
  const sweep = await sweepBackstop(registry, (proc) => stopManagedProcess(proc, DEFAULT_STOP_TIMING, realStopTimers));
  if (sweep.swept > 0) log("backstop:", JSON.stringify(sweep));

  if (threw) {
    console.error("❌ runGate2 a aruncat neașteptat (vezi log-urile de pas pentru context).");
    if (sweep.orphan > 0) console.error("⚠️ ATENȚIE: un grup de worker POSIBIL ORFAN după backstop — verifică manual (consumator Alchemy).");
    process.exit(1);
  }
  if (!report.ok) {
    console.error("❌ GATE 2 FAIL @", report.stage + (report.probe ? `/${report.probe}` : ""), "—", report.reason);
    if (sweep.orphan > 0) console.error("⚠️ ATENȚIE: un grup de worker POSIBIL ORFAN după backstop — verifică manual (consumator Alchemy).");
    process.exit(1);
  }
  if (sweep.orphan > 0) {
    console.error("❌ Gate 2 verde DAR backstop a găsit un grup neconfirmat — teardown incomplet:", JSON.stringify(sweep));
    process.exit(1);
  }
  log("✅ GATE 2 VERDE:", report.stages.join(" → "), "—", report.note);
  process.exit(0);
}

main().catch(() => {
  // Mesaj STATIC (fără e.message — anti-leak). Contextul e în log-urile de pas.
  console.error("❌ runner: eroare internă (vezi log-urile de pas pentru context).");
  process.exit(1);
});
