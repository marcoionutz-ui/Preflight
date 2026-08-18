/**
 * workers/evm/src/index.ts
 * Preflight EVM Worker — Base + Arbitrum
 *
 * Orchestration only. Business logic lives in modules.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { CHAINS } from "./config/chains";
import { WORKER_VERSION } from "./config/constants";
import { MODE, BUDGET } from "./config/mode";
import { connectChainWebSocket, closeAllWebSockets } from "./ws/manager";
import { loadMemoryFromRedis, saveMemoryToRedis, saveMemoryToRedisStrict } from "./state/memory";
import { refreshEthPrice } from "./infra/ethPrice";
import { closeRedis } from "./infra/redis";
import { scan, runFollowRefresh, runDsBoostedRefresh } from "./pipeline/scan";
import { verticalCandidatesLoop } from "./pipeline/loops/vertical";
import { lateCandidatesLoop } from "./pipeline/loops/late";
import { fomoCandidatesLoop } from "./pipeline/loops/fomo";
import { hotCandidatesLoop } from "./pipeline/loops/hot";
import { installGracefulShutdown } from "./lib/shutdown";
import {
  isShuttingDown, markShuttingDown, trackInterval, clearAllIntervals,
  beginJob, activeJobCount, waitForDrain, runShutdownSequence,
} from "./lib/lifecycle";

console.log(`Preflight Worker ${WORKER_VERSION} starting...`);
console.log(`Chains: ${CHAINS.map(c => c.id).join(", ")}`);
console.log(`Mode: ${MODE} | scan:${BUDGET.scanIntervalMs}ms | maxWatch:${BUDGET.maxActiveWatch} | ws:${BUDGET.wsEnabled}`);

// Conectează WS pentru fiecare chain (doar dacă mode permite)
if (BUDGET.wsEnabled) {
  CHAINS.forEach(c => connectChainWebSocket(c));
} else {
  console.log(`[MODE] WS disabled for mode ${MODE} — scan-only`);
}

/**
 * PH-13 (cgpt #3): rulează un job care MUTĂ starea (scan / loop) contorizat pentru drain-ul de shutdown, cu guard
 * de shutdown. Dacă am intrat deja în shutdown, NU pornim munca nouă (flag-ul e ridicat înainte de drain, deci un
 * interval care mai apucă să se declanșeze o dată nu re-populează memoria după persistare). `beginJob`/`done`
 * asigură că drain-ul așteaptă job-ul curent înainte de a salva.
 */
async function runTracked(label: string, fn: () => Promise<void>): Promise<void> {
  if (isShuttingDown()) return;
  const done = beginJob();
  try {
    await fn();
  } catch (err) {
    console.error(`[${label} ERROR]`, err);
  } finally {
    done();
  }
}

let scanning = false;
async function safeScan(): Promise<void> {
  if (scanning) { console.log("[SCAN SKIP] previous scan still running"); return; }
  scanning = true;
  try { await runTracked("SCAN", scan); }
  finally { scanning = false; }
}

let fomoRunning = false;
async function safeFomoLoop(): Promise<void> {
  if (fomoRunning) { console.warn("[FOMO LOOP SKIP] previous run still active"); return; }
  fomoRunning = true;
  try { await runTracked("FOMO LOOP", fomoCandidatesLoop); }
  finally { fomoRunning = false; }
}

let followRefreshRunning = false;
async function safeFollowRefresh(): Promise<void> {
  if (followRefreshRunning) { console.warn("[FOLLOW REFRESH SKIP] previous run still active"); return; }
  followRefreshRunning = true;
  try { await runTracked("FOLLOW REFRESH", runFollowRefresh); }
  finally { followRefreshRunning = false; }
}

(async () => {
  // PH-13 (cgpt #3): startup-ul asincron MUTĂ memoria (loadMemoryFromRedis restaurează starea) → e urmărit prin
  // lifecycle, ca un shutdown sosit în timpul boot-ului să aștepte terminarea restore-ului înainte de snapshot
  // (altfel am persista o memorie pe jumătate încărcată). Guard: dacă suntem deja în shutdown, nu mai pornim loop-uri.
  const startupJob = beginJob();
  try {
    await refreshEthPrice();
    await loadMemoryFromRedis();
  } finally {
    startupJob();
  }
  if (isShuttingDown()) { console.log("[BOOT] shutdown în timpul startup-ului — nu pornesc loop-urile."); return; }

  // PH-13: TOATE intervalele sunt înregistrate (trackInterval) ca shutdown-ul să le poată opri pe toate → niciun
  // scan/loop/periodic-save nu mai pornește după primul semnal. `refreshEthPrice` și save-ul periodic (care ating
  // starea/Redis) rulează prin `runTracked` → drain-ul le așteaptă. Save-ul periodic rămâne best-effort (nu dărâmă
  // worker-ul între snapshot-uri); persistarea FINALĂ la shutdown e strictă.
  trackInterval(setInterval(() => { void runTracked("ETH PRICE",     refreshEthPrice); },   5 * 60_000)); // E25: 5 min
  trackInterval(setInterval(() => { void runTracked("PERIODIC SAVE", saveMemoryToRedis); }, 60_000));

  safeScan();
  trackInterval(setInterval(safeScan, BUDGET.scanIntervalMs));
  trackInterval(setInterval(() => { void runTracked("HOT LOOP",      hotCandidatesLoop); },      3_000));
  trackInterval(setInterval(() => { void runTracked("VERTICAL LOOP", verticalCandidatesLoop); }, 15_000));
  trackInterval(setInterval(() => { void runTracked("LATE LOOP",     lateCandidatesLoop); },     30_000));
  trackInterval(setInterval(safeFomoLoop, 30_000));
  trackInterval(setInterval(safeFollowRefresh, BUDGET.followRefreshMs));
  trackInterval(setInterval(() => { void runTracked("DS BOOSTED",    runDsBoostedRefresh); },    60_000));
})();

// PH-13 (cgpt #3): shutdown REALMENTE graceful. La SIGTERM/SIGINT (redeploy Railway, scale-down, Ctrl-C) rulăm
// secvența ordonată: ridicăm flag-ul global (blochează scan-uri noi + gate-ază reconnect-ul WS) → oprim toate
// intervalele → închidem socket-urile WS → așteptăm job-urile în zbor (drain ≤5s) → persistăm memoria STRICT →
// închidem Redis. Ieșim 0 DOAR dacă persistarea a reușit; persist eșuat → exit 1 (nu succes fals). Deadline-ul dur
// (10s) din installGracefulShutdown rămâne autoritatea finală dacă un pas atârnă, iar al doilea semnal → exit forțat.
installGracefulShutdown({
  timeoutMs: 10_000,
  onShutdown: () => runShutdownSequence({
    markShuttingDown,
    clearIntervals:  () => clearAllIntervals(),
    closeWebSockets: () => closeAllWebSockets(),   // async + bounded (awaited de secvență, cgpt #4)
    drain:           () => waitForDrain({
      deadlineMs: 5_000,
      count:      activeJobCount,
      now:        () => Date.now(),
      sleep:      (ms) => new Promise<void>(res => setTimeout(res, ms)),
    }),
    saveStrict: () => saveMemoryToRedisStrict(),
    closeRedis: () => closeRedis(),
    log:        (msg) => console.log(msg),
  }),
  on:           (signal, handler) => { process.on(signal as NodeJS.Signals, handler); },
  exit:         (code) => process.exit(code),
  setTimeout:   (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  log:          (msg) => console.log(msg),
});
