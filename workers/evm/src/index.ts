/**
 * workers/evm/src/index.ts
 * Preflight EVM Worker — Base + Arbitrum
 *
 * Orchestration only. Business logic lives in modules.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { CHAINS } from "./config/chains";
import { WORKER_VERSION, SCAN_INTERVAL, FOLLOW_REFRESH_MS } from "./config/constants";
import { connectChainWebSocket } from "./ws/manager";
import { loadMemoryFromRedis, saveMemoryToRedis } from "./state/memory";
import { refreshEthPrice } from "./infra/ethPrice";
import { scan, runFollowRefresh } from "./pipeline/scan";
import { verticalCandidatesLoop } from "./pipeline/loops/vertical";
import { lateCandidatesLoop } from "./pipeline/loops/late";
import { fomoCandidatesLoop } from "./pipeline/loops/fomo";
import { hotCandidatesLoop } from "./pipeline/loops/hot";

console.log(`Preflight Worker ${WORKER_VERSION} starting...`);
console.log(`Chains: ${CHAINS.map(c => c.id).join(", ")}`);

// Conectează WS pentru fiecare chain
CHAINS.forEach(c => connectChainWebSocket(c));

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
  setInterval(safeScan, SCAN_INTERVAL);

  setInterval(() => { hotCandidatesLoop().catch(err => console.error("[HOT LOOP ERROR]", err)); },     3_000);
  setInterval(() => { verticalCandidatesLoop().catch(err => console.error("[VERTICAL LOOP ERROR]", err)); }, 15_000);
  setInterval(() => { lateCandidatesLoop().catch(err => console.error("[LATE LOOP ERROR]", err)); },   30_000);
  setInterval(() => { fomoCandidatesLoop().catch(err => console.error("[FOMO LOOP ERROR]", err)); },   30_000);
  setInterval(() => { runFollowRefresh().catch(err => console.error("[FOLLOW REFRESH ERROR]", err)); }, FOLLOW_REFRESH_MS);
});
