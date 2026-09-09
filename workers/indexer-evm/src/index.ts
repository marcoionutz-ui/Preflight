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
import {
  getTotalPairsCount, getFreshPairs24h, repriceRecentPairs, drainEnrichQueue, repairEnrichQueue,
} from "./discovery/pairRegistry";
import { intEnv } from "./config/env";
import { getRedis } from "./infra/redis";
import { startServiceHeartbeat } from "@preflight/schema";

const INDEXER_VERSION  = "0.2.0";
const LOOP_INTERVAL_MS = 10_000;

// C3: pasaj periodic de re-pricing per chain (gated pe interval, doar LIVE).
const REPRICE_INTERVAL_MS = intEnv("INDEXER_REPRICE_INTERVAL_MS", 30_000);
const lastRepriceAt   = new Map<ChainId, number>();
const repriceInFlight = new Set<ChainId>();

/**
 * Programează re-pricing-ul C3 în BACKGROUND (fire-and-forget) — NU-l await-uim în syncChain.
 * Altfel un RPC lent (o pereche V3/V4 = mai multe eth_call timeout-guarded) ar bloca discovery-ul
 * celorlalte chain-uri și ar lăsa health key-ul (TTL 60s) să expire → workerul vede indexerul
 * MISSING și cade inutil pe Gecko. Guard per-chain (un singur pasaj activ/chain) + interval.
 * `lastRepriceAt` se setează la FINAL (în finally) → cadența se măsoară de la terminare, fără overlap.
 */
function maybeScheduleReprice(chain: ChainId): void {
  if (DRY_RUN || repriceInFlight.has(chain)) return;
  const last = lastRepriceAt.get(chain) ?? 0;
  if (Date.now() - last < REPRICE_INTERVAL_MS) return;

  repriceInFlight.add(chain);
  void repriceRecentPairs(chain)
    .then(({ repriced, scanned }) => {
      if (repriced > 0) {
        console.log(`[INDEXER][${chain.toUpperCase()}] re-priced ${repriced} perechi (top-${scanned})`);
      }
    })
    .catch(err => {
      console.error(`[REPRICE][${chain.toUpperCase()}] unhandled:`, (err as Error).message);
    })
    .finally(() => {
      lastRepriceAt.set(chain, Date.now());
      repriceInFlight.delete(chain);
    });
}

// C2: drenează coada de enrichment în BACKGROUND (guard per-chain + interval). Coada AMÂNĂ enrichment-ul
// când s-a atins limita de concurență / a eșuat, ca perechile să nu rămână permanent necitite.
const ENRICH_DRAIN_INTERVAL_MS = intEnv("INDEXER_ENRICH_DRAIN_INTERVAL_MS", 15_000);
const lastEnrichDrainAt   = new Map<ChainId, number>();
const enrichDrainInFlight = new Set<ChainId>();

function maybeScheduleEnrichDrain(chain: ChainId): void {
  if (DRY_RUN || enrichDrainInFlight.has(chain)) return;
  const last = lastEnrichDrainAt.get(chain) ?? 0;
  if (Date.now() - last < ENRICH_DRAIN_INTERVAL_MS) return;

  enrichDrainInFlight.add(chain);
  void drainEnrichQueue(chain)
    .then(({ enriched, retry, dead }) => {
      if (enriched > 0 || dead > 0) {
        console.log(`[INDEXER][${chain.toUpperCase()}] enrich-queue: +${enriched} enriched, ${retry} retry, ${dead} dead`);
      }
    })
    .catch(err => {
      console.error(`[ENRICH-QUEUE][${chain.toUpperCase()}] unhandled:`, (err as Error).message);
    })
    .finally(() => {
      lastEnrichDrainAt.set(chain, Date.now());
      enrichDrainInFlight.delete(chain);
    });
}

// C2: reparație pe CADENȚĂ PROPRIE (nu depinde de coadă goală → nu poate fi starvation-uit). Paginat
// prin registry ca să prindă perechile rămase neenrichuite (skip pre-C2 / enqueue eșuat la write).
const ENRICH_REPAIR_INTERVAL_MS = intEnv("INDEXER_ENRICH_REPAIR_INTERVAL_MS", 90_000);
const lastRepairAt   = new Map<ChainId, number>();
const repairInFlight = new Set<ChainId>();

function maybeScheduleRepair(chain: ChainId): void {
  if (DRY_RUN || repairInFlight.has(chain)) return;
  const last = lastRepairAt.get(chain) ?? 0;
  if (Date.now() - last < ENRICH_REPAIR_INTERVAL_MS) return;

  repairInFlight.add(chain);
  void repairEnrichQueue(chain)
    .catch(err => {
      console.error(`[ENRICH-QUEUE][${chain.toUpperCase()}] repair unhandled:`, (err as Error).message);
    })
    .finally(() => {
      lastRepairAt.set(chain, Date.now());
      repairInFlight.delete(chain);
    });
}

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

  // ── Cursor (fail-closed, C4) ──────────────────────────────────────────────
  // O eroare Redis / cursor corupt NU trebuie tratat ca first-run (ar reseta cursorul la
  // latest-lookback și ar sări blocuri silențios). La {ok:false}: skip iterația, health DEGRADED.
  const cursorRead = await readCursor(chain);
  if (!cursorRead.ok) {
    console.error(
      `[INDEXER][${chain.toUpperCase()}] readCursor fail-closed — skip iterație (Redis error / cursor corupt)`,
    );
    await writeIndexerHealth(
      chain,
      buildDegradedHealth({
        lastErrorAt: now,
        reason:      "readCursor: Redis error sau cursor corupt (fail-closed)",
      }),
    );
    return;
  }
  const savedBlock  = cursorRead.value;
  const cursorState = computeCursorState(savedBlock, latestBlock, chain);

  // Persist cursor on first run (init startBlock) or explicit SKIP_TO_LATEST
  const shouldPersist =
    savedBlock === null ||
    (process.env.INDEXER_SKIP_TO_LATEST === "true" && cursorState.lastBlock !== savedBlock);

  if (shouldPersist) {
    const persisted = await writeCursor(chain, cursorState.lastBlock);
    if (!persisted) {
      console.error(
        `[INDEXER][${chain.toUpperCase()}] writeCursor(init) a eșuat — skip iterație (DEGRADED)`,
      );
      await writeIndexerHealth(
        chain,
        buildDegradedHealth({
          lastErrorAt: now,
          reason:      "writeCursor(init) a eșuat — cursor neinițializat în Redis",
        }),
      );
      return;
    }
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
        reason:       `discovery: ${discovery.error}`,
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

  // ── Re-pricing periodic (C3) — BACKGROUND, non-blocant (vezi maybeScheduleReprice) ──
  // Prețul e altfel calculat DOAR la discovery → îngheață → momentum fals (NO_MOMENTUM, movers 0%).
  maybeScheduleReprice(chain);

  // ── Enrichment queue drain (C2) — BACKGROUND, non-blocant ──────────────────
  maybeScheduleEnrichDrain(chain);

  // ── Enrichment repair (C2) — cadență proprie, migrare perechi neenrichuite ──
  maybeScheduleRepair(chain);
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

// ── PH-12 12.4 leaf 3: heartbeat de liveness de SERVICIU (proces viu) ───────────────────────────────────
// Scrie „proces viu" în Redis la fiecare 30s (TTL 300s) prin primitiva PARTAJATĂ `startServiceHeartbeat` — reader-ul
// (mcp health) îl clasifică ok/stale/missing. INDEPENDENT de sync: un RPC blocat NU falsifică liveness-ul procesului
// (health-ul per-chain, TTL 60s, acoperă progresul indexării). `getRedis()` null (REDIS_URL absent) → NU pornim (nu
// putem scrie; reader-ul vede corect `missing`). Fără shutdown graceful aici → intervalul moare odată cu procesul.
const heartbeatRedis = getRedis();
if (heartbeatRedis) {
  startServiceHeartbeat({
    role:           "indexer-evm",
    writeHeartbeat: (w) => heartbeatRedis.set(w.key, w.value, "EX", w.ttlSec),
    now:            () => Date.now(),
    setInterval:    (fn, ms) => setInterval(fn, ms),
    clearInterval:  (h) => clearInterval(h),
    onError:        (e) => console.error("[INDEXER][HEARTBEAT]", e instanceof Error ? e.message : String(e)),
  });
} else {
  console.warn("[INDEXER][HEARTBEAT] REDIS_URL absent — heartbeat de serviciu dezactivat");
}

mainLoop().catch(err => {
  console.error("[INDEXER] Fatal error:", err);
  process.exit(1);
});
