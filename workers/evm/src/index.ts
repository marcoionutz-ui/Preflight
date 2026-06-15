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
import { connectChainWebSocket } from "./ws/manager";
import { loadMemoryFromRedis, saveMemoryToRedis } from "./state/memory";
import { refreshEthPrice } from "./infra/ethPrice";
import { scan, runFollowRefresh, runDsBoostedRefresh } from "./pipeline/scan";
import { verticalCandidatesLoop } from "./pipeline/loops/vertical";
import { lateCandidatesLoop } from "./pipeline/loops/late";
import { fomoCandidatesLoop } from "./pipeline/loops/fomo";
import { hotCandidatesLoop } from "./pipeline/loops/hot";

console.log(`Preflight Worker ${WORKER_VERSION} starting...`);
console.log(`Chains: ${CHAINS.map(c => c.id).join(", ")}`);
console.log(`Mode: ${MODE} | scan:${BUDGET.scanIntervalMs}ms | maxWatch:${BUDGET.maxActiveWatch} | ws:${BUDGET.wsEnabled}`);

// Conectează WS pentru fiecare chain (doar dacă mode permite)
if (BUDGET.wsEnabled) {
  CHAINS.forEach(c => connectChainWebSocket(c));
} else {
  console.log(`[MODE] WS disabled for mode ${MODE} — scan-only`);
}

let scanning = false;

async function safeScan(): Promise<void> {
  if (scanning) {
    console.log("[SCAN SKIP] previous scan still running");
    return;
  }
  scanning = true;
  try {
    await scan();
  } catch (err) {
    console.error("[SCAN ERROR]", err);
  } finally {
    scanning = false;
  }
}

(async () => {
  await refreshEthPrice();
  await loadMemoryFromRedis();

  setInterval(refreshEthPrice,    60 * 60_000);
  setInterval(saveMemoryToRedis,  60_000);

  safeScan();
  setInterval(safeScan, BUDGET.scanIntervalMs);
  setInterval(() => { hotCandidatesLoop().catch(err => console.error("[HOT LOOP ERROR]", err)); },     3_000);
  setInterval(() => { verticalCandidatesLoop().catch(err => console.error("[VERTICAL LOOP ERROR]", err)); }, 15_000);
  setInterval(() => { lateCandidatesLoop().catch(err => console.error("[LATE LOOP ERROR]", err)); },   30_000);
  setInterval(() => { fomoCandidatesLoop().catch(err => console.error("[FOMO LOOP ERROR]", err)); },   30_000);
  setInterval(() => { runFollowRefresh().catch(err => console.error("[FOLLOW REFRESH ERROR]", err)); }, BUDGET.followRefreshMs);
  setInterval(() => { runDsBoostedRefresh().catch(err => console.error("[DS BOOSTED ERROR]", err)); }, 60_000);
})();
