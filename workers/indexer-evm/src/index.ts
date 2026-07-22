/**
 * workers/indexer-evm/src/index.ts
 * Preflight Indexer EVM — Faza 6.1 + 6.2
 *
 * Faza 6.0: infrastructură (cursor, health, RPC)
 * Faza 6.1: discovery — eth_getLogs → decode → sanity check
 * Faza 6.2: pair registry — Redis NX write, ZSET by block + timestamp
 *
 * INDEXER_DRY_RUN=true  (default) → decode + log only
 * INDEXER_DRY_RUN=false           → write pair registry în Redis
 *
 * Nu atinge MCP tools, scan.ts, flow engine, WS subscriptions.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { getEnabledChains, getEnabledFactories } from "./config/factories";
import type { ChainId } from "./config/factories";
import { readCursor, writeCursor, computeCursorState, MAX_CATCHUP_BLOCKS, safeHead, confirmationDepth } from "./infra/cursor";
import type { CursorState } from "./infra/cursor";
import { getBlockNumber, getRpcUrl, getRpcEnvName } from "./infra/rpc";
import {
  writeIndexerHealth,
  buildHealthFromCursor,
  buildDegradedHealth,
} from "./infra/health";
import { runDiscovery, DRY_RUN } from "./discovery/discoveryLoop";
import { getTotalPairsCount, getFreshPairs24h } from "./discovery/pairRegistry";

const INDEXER_VERSION  = "0.2.0";
const LOOP_INTERVAL_MS = 10_000;

const activeChains = getEnabledChains();

console.log(`[INDEXER] Preflight Indexer EVM v${INDEXER_VERSION} starting`);
console.log(`[INDEXER] Active chains: ${activeChains.join(", ") || "none"}`);
console.log(
  `[INDEXER] Factories enabled: ${activeChains.flatMap(c => getEnabledFactories(c)).length} total`,
);
console.log(
  `[INDEXER] DRY_RUN: ${DRY_RUN} ` +
  (DRY_RUN
    ? "(set INDEXER_DRY_RUN=false to write pair registry)"
    : "(LIVE — writing to Redis)"),
);

if (activeChains.length === 0) {
  console.warn(
    "[INDEXER] No chains enabled. Set enabled:true in factories.ts for at least one chain.",
  );
}

/** Un loop de sync pentru un singur chain. */
async function syncChain(chain: ChainId): Promise<void> {
  const now        = Date.now();
  const rpcUrl     = getRpcUrl(chain);
  const rpcEnvName = getRpcEnvName(chain);
  const factories  = getEnabledFactories(chain);

  // ── Missing RPC URL → DEGRADED ────────────────────────────────────────────
  if (!rpcUrl) {
    console.warn(
      `[INDEXER][${chain.toUpperCase()}] No RPC URL — set ${rpcEnvName} in env`,
    );
    await writeIndexerHealth(
      chain,
      buildDegradedHealth({
        lastErrorAt: now,
        reason:      `Missing ${rpcEnvName} env var`,
      }),
    );
    return;
  }

  // ── eth_blockNumber ────────────────────────────────────────────────────────
  let rawHead: number;
  try {
    rawHead = await getBlockNumber(rpcUrl);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[INDEXER][${chain.toUpperCase()}] eth_blockNumber failed: ${msg}`);
    await writeIndexerHealth(
      chain,
      buildDegradedHealth({
        lastErrorAt: now,
        reason:      `eth_blockNumber failed: ${msg}`,
      }),
    );
    return;
  }

  // Confirmation depth (C5) — indexăm DOAR până la head-ul confirmat, ca un pair dintr-un
  // bloc reorganizat să nu ajungă permanent în registry (write-uri SET NX, ireversibile).
  // safeHead curge în TOT ce urmează: cursor, discovery și health blocksBehind.
  const depth       = confirmationDepth(chain);
  const latestBlock = safeHead(chain, rawHead);

  // ── Cursor ────────────────────────────────────────────────────────────────
  const savedBlock  = await readCursor(chain);
  const cursorState = computeCursorState(savedBlock, latestBlock, chain);

  // Persist cursor on first run (init startBlock) or explicit SKIP_TO_LATEST
  const shouldPersist =
    savedBlock === null ||
    (process.env.INDEXER_SKIP_TO_LATEST === "true" && cursorState.lastBlock !== savedBlock);

  if (shouldPersist) {
    await writeCursor(chain, cursorState.lastBlock);
    console.log(
      `[INDEXER][${chain.toUpperCase()}] Cursor ${savedBlock === null ? "inițializat" : "skipped"} la block ${cursorState.lastBlock}`,
    );
  }

  console.log(
    `[INDEXER][${chain.toUpperCase()}] ` +
    `head:${rawHead} confirmed:${latestBlock} (depth ${depth}) | cursor:${cursorState.lastBlock} | ` +
    `behind:${cursorState.blocksBehind} | status:${cursorState.status} | ` +
    `factories:${factories.map(f => f.dexId).join(",")}`,
  );

  // ── Discovery (Faza 6.1) ──────────────────────────────────────────────────
  const discovery = await runDiscovery(chain, cursorState, latestBlock);

  if (discovery.batchesProcessed > 0) {
    console.log(
      `[INDEXER][${chain.toUpperCase()}] discovery done: ` +
      `${discovery.pairsFound} new | ${discovery.batchesProcessed} batches | ` +
      `cursor→${discovery.lastProcessedBlock}`,
    );
  }

  // Discovery RPC failure → DEGRADED health, skip normal write
  if (discovery.error) {
    console.error(
      `[INDEXER][${chain.toUpperCase()}] discovery error: ${discovery.error}`,
    );
    await writeIndexerHealth(
      chain,
      buildDegradedHealth({
        lastErrorAt:  now,
        blocksBehind: Math.max(0, latestBlock - discovery.lastProcessedBlock),
        reason:       `eth_getLogs: ${discovery.error}`,
      }),
    );
    return;
  }

  // ── Pair counts for health (Faza 6.2) ─────────────────────────────────────
  // In DRY_RUN these will be 0 (nothing written to registry)
  const pairsDiscovered = await getTotalPairsCount(chain);
  const freshPairs24h   = await getFreshPairs24h(chain);

  // ── Write health ──────────────────────────────────────────────────────────
  // Use post-discovery cursor position for health (lastProcessedBlock = original if DRY_RUN + no advance)
  const finalBlock   = discovery.lastProcessedBlock;
  const blocksBehind = Math.max(0, latestBlock - finalBlock);
  const healthCursor: CursorState = {
    lastBlock:    finalBlock,
    blocksBehind,
    status:
      blocksBehind === 0
        ? "OK"
        : blocksBehind > MAX_CATCHUP_BLOCKS
          ? "DEGRADED"
          : "CATCHING_UP",
  };

  await writeIndexerHealth(
    chain,
    buildHealthFromCursor({
      cursorState:     healthCursor,
      lastSuccessAt:   now,
      lastErrorAt:     null,
      pairsDiscovered,
      freshPairs24h,
    }),
  );
}

/** Loop principal — chains secvențial (evită rate limiting RPC). */
async function mainLoop(): Promise<void> {
  while (true) {
    for (const chain of activeChains) {
      await syncChain(chain);
    }
    await sleep(LOOP_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

mainLoop().catch(err => {
  console.error("[INDEXER] Fatal error:", err);
  process.exit(1);
});
