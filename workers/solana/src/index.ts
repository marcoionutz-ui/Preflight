/**
 * workers/solana/src/index.ts
 * Entry point indexer-solana.
 * 8.0c: cursor logic real + logsSubscribe shadow discovery (Raydium + pump.fun).
 */

import { getSolanaRpcUrl, getSolanaWsUrl, getSlot, getVersion, getConnection } from "./infra/rpc";
import { getRedis }                 from "./infra/redis";
import { readCursor, advanceCursor }  from "./infra/cursor";
import { buildHealth, writeHealth } from "./infra/health";
import { startLogSubscriptions }    from "./discovery/logSubscriber";
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
      const cursorSlot = await readCursor();

      // 8.0c: cursorul e avansat de discovery loop (onLogs callback).
      // healthLoop il citeste si calculeaza behindSlots real.
      // La primul start (cursorSlot === null) -> status STARTING.
      const health = buildHealth(latestSlot, cursorSlot, nodeVersion);
      await writeHealth(health);

      const behind = cursorSlot !== null ? latestSlot - cursorSlot : "?";
      console.log(
        "[SOLANA] latest:" + latestSlot
        + " | cursor:" + (cursorSlot ?? "null")
        + " | behind:" + behind
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
  console.log("[SOLANA] ws=" + getSolanaWsUrl().slice(0, 50) + "...");
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

  // Discovery: logsSubscribe shadow mode
  // Primim evenimente in real-time; cursorul avanseaza la slot-ul fiecarui log.
  const connection = getConnection();
  startLogSubscriptions(connection, (event) => {
    console.log(
      "[SOLANA][DISCOVERY] program=" + event.program
      + " slot=" + event.slot
      + " sig=" + event.signature.slice(0, 8) + "...",
    );
    // TODO 8.0d: parse event.logs pentru pool init events + scrie in Redis
    advanceCursor(event.slot).catch((err: Error) => {
      console.error("[SOLANA][DISCOVERY] writeCursor error:", err.message);
    });
  });

  // Health loop: HTTP polling
  await healthLoop(nodeVersion);
}

main().catch((err) => {
  console.error("[SOLANA] fatal:", err);
  process.exit(1);
});
