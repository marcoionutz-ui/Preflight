/**
 * workers/solana/src/index.ts
 * Entry point indexer-solana.
 * 8.0d: CPMM pool discovery -> Redis. Filter + dedupe + fetch + write.
 */

import { getSolanaRpcUrl, getSolanaWsUrl, getSlot, getVersion, getConnection } from "./infra/rpc";
import { getRedis }                 from "./infra/redis";
import { readCursor, advanceCursor } from "./infra/cursor";
import { buildHealth, writeHealth } from "./infra/health";
import { startLogSubscriptions }    from "./discovery/logSubscriber";
import { isCpmmInitLog, fetchCpmmInit } from "./discovery/txFetcher";
import { buildSolanaPool, writeSolanaPool } from "./discovery/pairWriter";
import {
  CHAIN, INDEXER_VERSION, POLL_INTERVAL_MS, KEY_PAIRS,
} from "./config/constants";
import {
  RAYDIUM_AMM_V4, RAYDIUM_CLMM, RAYDIUM_CPMM, PUMPFUN_PROGRAM,
} from "./config/programs";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Dedupe ───────────────────────────────────────────────────────────────────
// Key = "{program}:{signature}" — dedupam per-program, nu global.
// Previne situatia in care aceeasi tx vine intai pe alt subscription si e
// marcata "vazuta" inainte sa ajunga pe subscriptionul relevant (CPMM).
const seenKeys = new Set<string>();
const MAX_SEEN = 10_000;

// Debug sampler — primele 10 CPMM tx-uri, pentru calibrare log pattern (TODO: remove dupa 8.0d)
let cpmmDebugSamples = 0;

function isDuplicate(key: string): boolean {
  if (seenKeys.has(key)) return true;
  if (seenKeys.size >= MAX_SEEN) seenKeys.clear();
  seenKeys.add(key);
  return false;
}

// ── Stats ────────────────────────────────────────────────────────────────────
const stats = { events: 0, cpmmTotal: 0, deduped: 0, candidates: 0, fetched: 0, inserted: 0, errors: 0 };

function logStats(): void {
  console.log(
    "[SOLANA][STATS]"
    + " events=" + stats.events
    + " deduped=" + stats.deduped
    + " candidates=" + stats.candidates
    + " fetched=" + stats.fetched
    + " inserted=" + stats.inserted
    + " cpmmTotal=" + stats.cpmmTotal
    + " errors=" + stats.errors,
  );
}

// ── Health loop ──────────────────────────────────────────────────────────────
async function healthLoop(nodeVersion: string): Promise<void> {
  let statsTick = 0;
  while (true) {
    try {
      const latestSlot = await getSlot();
      const cursorSlot = await readCursor();
      const health = buildHealth(latestSlot, cursorSlot, nodeVersion);
      await writeHealth(health);

      const behind = cursorSlot !== null ? Math.max(0, latestSlot - cursorSlot) : "?";
      console.log(
        "[SOLANA] latest:" + latestSlot
        + " | cursor:" + (cursorSlot ?? "null")
        + " | behind:" + behind
        + " | status:" + health.status,
      );

      if (++statsTick % 6 === 0) logStats();
    } catch (err) {
      console.error("[SOLANA] health loop error:", (err as Error).message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// ── CPMM init pipeline ───────────────────────────────────────────────────────
function handleCpmmCandidate(
  connection: ReturnType<typeof getConnection>,
  signature:  string,
  slot:       number,
): void {
  stats.candidates++;
  fetchCpmmInit(connection, signature)
    .then(async (result) => {
      stats.fetched++;
      if (!result) return;

      const pool = buildSolanaPool(
        result.poolAddress,
        result.mint0,
        result.mint1,
        slot,
        signature,
        "raydium_cpmm",
      );

      const outcome = await writeSolanaPool(pool);
      if (outcome === "inserted") {
        stats.inserted++;
        console.log(
          "[SOLANA][POOL] raydium_cpmm inserted"
          + " pool=" + result.poolAddress.slice(0, 8) + "..."
          + " mint0=" + result.mint0.slice(0, 8) + "..."
          + " mint1=" + result.mint1.slice(0, 8) + "..."
          + " slot=" + slot,
        );
      } else if (outcome === "error") {
        stats.errors++;
      }
    })
    .catch((err: Error) => {
      stats.errors++;
      console.error("[SOLANA][CPMM] pipeline error:", err.message);
    });
}

// ── Main ─────────────────────────────────────────────────────────────────────
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

  const connection = getConnection();

  startLogSubscriptions(connection, (event) => {
    stats.events++;

    // Avanseaza cursorul pentru orice event (independent de program)
    advanceCursor(event.slot).catch((err: Error) => {
      console.error("[SOLANA][DISCOVERY] advanceCursor error:", err.message);
    });

    // Filter intai, dedupe dupa — evita ca un event ne-relevant pe alta
    // subscription sa "consume" dedup-ul pentru eventul CPMM valid.
    if (event.program === "raydium_cpmm") {
      stats.cpmmTotal++;
      if (cpmmDebugSamples < 10) {
        cpmmDebugSamples++;
        console.log(
          "[SOLANA][CPMM DEBUG] slot=" + event.slot
          + " sig=" + event.signature.slice(0, 8)
          + " logs=" + JSON.stringify(event.logs.slice(0, 8)),
        );
      }
    }
    if (event.program !== "raydium_cpmm" || !isCpmmInitLog(event.logs)) return;

    if (isDuplicate("raydium_cpmm:" + event.signature)) {
      stats.deduped++;
      return;
    }

    handleCpmmCandidate(connection, event.signature, event.slot);
    // TODO 8.0e: pump.fun Create + Raydium CLMM CreatePool
  });

  await healthLoop(nodeVersion);
}

main().catch((err) => {
  console.error("[SOLANA] fatal:", err);
  process.exit(1);
});
