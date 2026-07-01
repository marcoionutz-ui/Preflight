/**
 * workers/solana/src/index.ts
 * Entry point indexer-solana.
 * 8.0f: Token metadata enrichment async după pool insert.
 * 8.0g-a6: CLMM pool discovery live — CreatePool + CreateCustomizablePool → Redis.
 * 8.0g-b1: pump.fun shadow diagnostics — observa instructiuni + account layouts.
 */

import { getSolanaRpcUrl, getSolanaWsUrl, getSlot, getVersion, getConnection } from "./infra/rpc";
import { getRedis }                 from "./infra/redis";
import { readCursor, advanceCursor } from "./infra/cursor";
import { buildHealth, writeHealth } from "./infra/health";
import { startLogSubscriptions }    from "./discovery/logSubscriber";
import { isCpmmInitLog, fetchCpmmInit } from "./discovery/txFetcher";
import { buildSolanaPool, writeSolanaPool, enrichSolanaPool } from "./discovery/pairWriter";
import { runCpmmBackfill }          from "./discovery/backfillCpmm";
import { handleClmmShadow, logClmmStats } from "./discovery/clmmShadow";
import { isClmmCreateLog, fetchClmmCreate } from "./discovery/clmmFetcher";
import { handlePumpfunShadow, logPumpfunStats } from "./discovery/pumpfunShadow";
import { resolveTokenMeta }         from "./infra/tokenMetadata";
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

function isDuplicate(key: string): boolean {
  if (seenKeys.has(key)) return true;
  if (seenKeys.size >= MAX_SEEN) seenKeys.clear();
  seenKeys.add(key);
  return false;
}

// ── Stats ────────────────────────────────────────────────────────────────────
const stats = { events: 0, cpmmTotal: 0, clmmTotal: 0, pumpfunTotal: 0, deduped: 0, candidates: 0, fetched: 0, inserted: 0, errors: 0 };

function logStats(): void {
  console.log(
    "[SOLANA][STATS]"
    + " events=" + stats.events
    + " deduped=" + stats.deduped
    + " candidates=" + stats.candidates
    + " fetched=" + stats.fetched
    + " inserted=" + stats.inserted
    + " cpmmTotal=" + stats.cpmmTotal
    + " clmmTotal=" + stats.clmmTotal
    + " pumpfunTotal=" + stats.pumpfunTotal
    + " errors=" + stats.errors,
  );
  logClmmStats();
  logPumpfunStats();
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
          + " base=" + pool.baseMint.slice(0, 8) + "..."
          + " quote=" + pool.quoteMint.slice(0, 8) + "..."
          + " quoteType=" + pool.quoteType
          + " slot=" + slot,
        );
        // Enrichment async — non-blocking, nu întârzie discovery pipeline
        Promise.all([
          resolveTokenMeta(pool.baseMint),
          resolveTokenMeta(pool.quoteMint),
        ]).then(([baseMeta, quoteMeta]) => {
          console.log(
            "[SOLANA][META] enriched"
            + " pool=" + result.poolAddress.slice(0, 8) + "..."
            + " base=" + baseMeta.symbol + "(" + baseMeta.source + ")"
            + " quote=" + quoteMeta.symbol + "(" + quoteMeta.source + ")",
          );
          return enrichSolanaPool(pool, baseMeta, quoteMeta);
        }).catch((err: Error) => {
          console.error("[SOLANA][META] enrichment error:", err.message);
        });
      } else if (outcome === "error") {
        stats.errors++;
      }
    })
    .catch((err: Error) => {
      stats.errors++;
      console.error("[SOLANA][CPMM] pipeline error:", err.message);
    });
}

// ── CLMM init pipeline ───────────────────────────────────────────────────────
function handleClmmCandidate(
  connection: ReturnType<typeof getConnection>,
  signature:  string,
  slot:       number,
): void {
  stats.candidates++;
  fetchClmmCreate(connection, signature)
    .then(async (result) => {
      stats.fetched++;
      if (!result) return;

      const pool = buildSolanaPool(
        result.poolAddress,
        result.mint0,
        result.mint1,
        slot,
        signature,
        "raydium_clmm",
      );

      const outcome = await writeSolanaPool(pool);
      if (outcome === "inserted") {
        stats.inserted++;
        console.log(
          "[SOLANA][POOL] raydium_clmm inserted"
          + " pool=" + result.poolAddress.slice(0, 8) + "..."
          + " base=" + pool.baseMint.slice(0, 8) + "..."
          + " quote=" + pool.quoteMint.slice(0, 8) + "..."
          + " quoteType=" + pool.quoteType
          + " slot=" + slot,
        );
        // Enrichment async — non-blocking
        Promise.all([
          resolveTokenMeta(pool.baseMint),
          resolveTokenMeta(pool.quoteMint),
        ]).then(([baseMeta, quoteMeta]) => {
          console.log(
            "[SOLANA][META] enriched"
            + " pool=" + result.poolAddress.slice(0, 8) + "..."
            + " base=" + baseMeta.symbol + "(" + baseMeta.source + ")"
            + " quote=" + quoteMeta.symbol + "(" + quoteMeta.source + ")",
          );
          return enrichSolanaPool(pool, baseMeta, quoteMeta);
        }).catch((err: Error) => {
          console.error("[SOLANA][META] enrichment error:", err.message);
        });
      } else if (outcome === "error") {
        stats.errors++;
      }
    })
    .catch((err: Error) => {
      stats.errors++;
      console.error("[SOLANA][CLMM] pipeline error:", err.message);
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

  // Smoke test metadata — validează Jupiter API la fiecare startup
  // wSOL (KNOWN) + JTO (Jupiter path) — confirmare rapidă fără să așteptăm un pool nou
  // JTO (Jito) ales intenționat: nu e în KNOWN_MINTS, deci testează Jupiter API end-to-end
  resolveTokenMeta("So11111111111111111111111111111111111111112").then(m =>
    console.log("[SOLANA][META] smoke wSOL: symbol=" + m.symbol + " decimals=" + m.decimals + " source=" + m.source),
  ).catch(() => {});
  resolveTokenMeta("jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL").then(m =>
    console.log("[SOLANA][META] smoke JTO: symbol=" + m.symbol + " decimals=" + m.decimals + " source=" + m.source),
  ).catch(() => {});

  // Backfill snapshot — rulează înainte de WS subscription
  // Activat cu SOLANA_BACKFILL_ENABLED=1
  await runCpmmBackfill(connection);

  startLogSubscriptions(connection, (event) => {
    stats.events++;

    // Avanseaza cursorul pentru orice event (independent de program)
    advanceCursor(event.slot).catch((err: Error) => {
      console.error("[SOLANA][DISCOVERY] advanceCursor error:", err.message);
    });

    // ── pump.fun pipeline (8.0g-b1 shadow) ──────────────────────────────────
    if (event.program === "pumpfun") {
      stats.pumpfunTotal++;
      handlePumpfunShadow(connection, event.signature, event.slot, event.logs);
      return;
    }

    // ── CLMM pipeline (8.0g-a6) ──────────────────────────────────────────────
    if (event.program === "raydium_clmm") {
      stats.clmmTotal++;
      // Shadow mereu — stats + sample tx logging
      handleClmmShadow(connection, event.signature, event.slot, event.logs);

      // Pipeline real — doar pentru pool creation events
      if (!isClmmCreateLog(event.logs)) return;
      if (isDuplicate("raydium_clmm:" + event.signature)) {
        stats.deduped++;
        return;
      }
      handleClmmCandidate(connection, event.signature, event.slot);
      return;
    }

    // ── CPMM pipeline ─────────────────────────────────────────────────────────
    if (event.program === "raydium_cpmm") stats.cpmmTotal++;
    if (event.program !== "raydium_cpmm" || !isCpmmInitLog(event.logs)) return;

    if (isDuplicate("raydium_cpmm:" + event.signature)) {
      stats.deduped++;
      return;
    }

    handleCpmmCandidate(connection, event.signature, event.slot);
  });

  await healthLoop(nodeVersion);
}

main().catch((err) => {
  console.error("[SOLANA] fatal:", err);
  process.exit(1);
});
