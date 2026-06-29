/**
 * workers/solana/src/index.ts
 * Entry point indexer-solana.
 * 8.0b: Alchemy/Helius RPC + getSlot health loop + cursor slot in Redis.
 */

import { getSolanaRpcUrl, getSlot, getVersion } from "./infra/rpc";
import { getRedis }       from "./infra/redis";
import { writeCursor }    from "./infra/cursor";
import { buildHealth, writeHealth } from "./infra/health";
import {
  CHAIN, INDEXER_VERSION, POLL_INTERVAL_MS, KEY_PAIRS,
} from "./config/constants";
import {
  RAYDIUM_AMM_V4, RAYDIUM_CLMM, RAYDIUM_CPMM, PUMPFUN_PROGRAM,
} from "./config/programs";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function healthLoop(nodeVersion: string): Promise<void> {
  while (true) {
    try {
      const latestSlot = await getSlot();

      // Cursor avanseaza la latestSlot la fiecare heartbeat (8.0b: no discovery yet)
      // La 8.0c cursorul va avansa doar dupa ce procesam un batch real
      await writeCursor(latestSlot);

      const health = buildHealth(latestSlot, latestSlot, nodeVersion);
      await writeHealth(health);

      console.log(
        "[SOLANA] latest:" + latestSlot
        + " | behind:0"
        + " | status:" + health.status,
      );
    } catch (err) {
      console.error("[SOLANA] health loop error:", (err as Error).message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function main(): Promise<void> {
  console.log("[SOLANA] indexer-solana " + INDEXER_VERSION + " starting");
  console.log("[SOLANA] chain=" + CHAIN);
  console.log("[SOLANA] rpc=" + getSolanaRpcUrl().slice(0, 50) + "...");
  console.log(
    "[SOLANA] programs:"
    + " raydium_amm=" + RAYDIUM_AMM_V4.slice(0, 8) + "..."
    + " clmm=" + RAYDIUM_CLMM.slice(0, 8) + "..."
    + " cpmm=" + RAYDIUM_CPMM.slice(0, 8) + "..."
    + " pumpfun=" + PUMPFUN_PROGRAM.slice(0, 8) + "...",
  );

  const redis = getRedis();
  const pairsCount = await redis.zcard(KEY_PAIRS);
  console.log("[SOLANA] redis OK | indexed_pairs=" + pairsCount);

  let nodeVersion = "unknown";
  try {
    nodeVersion = await getVersion();
    console.log("[SOLANA] node version: " + nodeVersion);
  } catch (_err) {
    console.warn("[SOLANA] getVersion() failed -- continuing");
  }

  await healthLoop(nodeVersion);
}

main().catch((err) => {
  console.error("[SOLANA] fatal:", err);
  process.exit(1);
});
