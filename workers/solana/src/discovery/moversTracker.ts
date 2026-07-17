/**
 * discovery/moversTracker.ts
 * 8.0h-b5: Calculeaza top movers din sampled price history.
 * 8.0k-a2: Batch recheck knownPool vs registry la fiecare compute + write-back stale snapshots.
 *
 * ZSET index evita KEYS scan in prod:
 *   ZRANGEBYSCORE preflight:solana:price:pools now-7200000 now
 *
 * findClosestSample cu tolerante:
 *   5m target: ±2m  (120_000ms) — null daca nu gaseste
 *   1h target: ±15m (900_000ms) — null daca nu gaseste
 *
 * historyStatus:
 *   READY        — sampleCount >= 2, oldest >= 55m, currentAge <= 10m
 *   PARTIAL      — sampleCount >= 2, dar oldest < 55m (nu avem inca 1h)
 *   INSUFFICIENT — sampleCount < 2
 *   STALE        — ultimul sample mai vechi de 10m
 *
 * Scrie in preflight:trending:movers:solana (TTL 5m, namespace comun cu EVM).
 * Apelat din priceTracker.ts (throttled la 60s).
 */

import { getRedis }        from "../infra/redis";
import {
  KEY_PAIR,
  KEY_PRICE_SNAPSHOT,
  KEY_PRICE_HISTORY,
  KEY_PRICE_POOLS,
  KEY_TRENDING_MOVERS,
}                          from "../config/constants";
import type { PriceSnapshot } from "./priceTracker";
import type {
  PreflightSolanaMover, PreflightSolanaMoversSnapshot, PreflightSolanaPricePoint,
  PreflightSolanaHistoryStatus,
} from "@preflight/schema";

// ── Tipuri ────────────────────────────────────────────────────────────────────

type HistoryEntry = PreflightSolanaPricePoint;

export type PriceMover = PreflightSolanaMover;

export type MoversSnapshot = PreflightSolanaMoversSnapshot;

// ── Constante ─────────────────────────────────────────────────────────────────

const CALC_INTERVAL_MS  = 60_000;
const MOVERS_TTL_SEC    = 5 * 60;
const INDEX_LOOKBACK_MS = 2 * 60 * 60 * 1000; // 2h — pooluri active
const TOP_N             = 20;

// Tolerante findClosestSample
const TARGET_5M_MS = 5  * 60 * 1000;
const TARGET_1H_MS = 60 * 60 * 1000;
const TOLERANCE_5M = 2  * 60 * 1000;  // ±2m
const TOLERANCE_1H = 15 * 60 * 1000;  // ±15m

let lastCalcAt = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function findClosestSample(
  history:       HistoryEntry[],
  targetTs:      number,
  maxDistanceMs: number,
): HistoryEntry | null {
  let best:     HistoryEntry | null = null;
  let bestDist  = Infinity;

  for (const entry of history) {
    const dist = Math.abs(entry.ts - targetTs);
    if (dist <= maxDistanceMs && dist < bestDist) {
      bestDist = dist;
      best     = entry;
    }
  }

  return best;
}

function getHistoryStatus(
  sampleCount:        number,
  oldestSampleAgeSec: number,
  currentAgeSec:      number,
): PreflightSolanaHistoryStatus {
  if (currentAgeSec > 10 * 60)        return "STALE";
  if (sampleCount < 2)                return "INSUFFICIENT";
  if (oldestSampleAgeSec < 55 * 60)   return "PARTIAL";
  return "READY";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Calculeaza movers daca a trecut cel putin 60s de la ultima calculatie.
 * Non-blocking — erori prinse intern.
 */
export async function maybeCalculateMovers(): Promise<void> {
  const now = Date.now();
  if (now - lastCalcAt < CALC_INTERVAL_MS) return;
  lastCalcAt = now;

  try {
    await calculateAndWriteMovers(now);
  } catch (err) {
    console.warn("[SOLANA][MOVERS] calculate error:", (err as Error).message);
  }
}

async function calculateAndWriteMovers(now: number): Promise<void> {
  const redis = getRedis();

  // Pooluri active in ultimele 2h — ZSET index, fara KEYS scan
  const poolAddresses = await redis.zrangebyscore(
    KEY_PRICE_POOLS,
    now - INDEX_LOOKBACK_MS,
    now,
  );

  if (poolAddresses.length === 0) return;

  // Fetch snapshots + history + registry — trei batch-uri, nu N round-trips
  const snapshotKeys = poolAddresses.map(p => KEY_PRICE_SNAPSHOT(p));
  const historyKeys  = poolAddresses.map(p => KEY_PRICE_HISTORY(p));
  const registryKeys = poolAddresses.map(p => KEY_PAIR(p));

  const [snapshotRaws, registryRaws, historyArrays] = await Promise.all([
    redis.mget(snapshotKeys),
    redis.mget(registryKeys),
    Promise.all(historyKeys.map(k => redis.lrange(k, 0, -1))),
  ]);

  // 8.0k-a2: write-back batch pentru snapshots stale (knownPool false dar pool exista in registry)
  const writebackPipeline = redis.pipeline();
  let writebackCount = 0;

  const movers: PriceMover[] = [];

  for (let i = 0; i < poolAddresses.length; i++) {
    const snapshotRaw = snapshotRaws[i];
    if (!snapshotRaw) continue;

    const snap: PriceSnapshot        = JSON.parse(snapshotRaw);
    const historyRaw: string[]        = historyArrays[i] ?? [];
    const history: HistoryEntry[]     = historyRaw.map(r => JSON.parse(r) as HistoryEntry);

    // 8.0k-a2: re-check knownPool vs registry (corectare stale data)
    const isRegistered = Boolean(registryRaws[i]);
    if (isRegistered && !snap.knownPool) {
      snap.knownPool = true;
      (writebackPipeline as any).set(snapshotKeys[i], JSON.stringify(snap), "KEEPTTL");
      writebackCount++;
    }

    const sampleCount      = history.length;
    const currentAgeSec    = (now - snap.lastUpdatedAt) / 1000;
    const oldestTs         = history.length > 0
      ? history.reduce((min, h) => h.ts < min ? h.ts : min, history[0].ts)
      : now;
    const oldestSampleAgeSec = (now - oldestTs) / 1000;

    const sample5m = findClosestSample(history, now - TARGET_5M_MS, TOLERANCE_5M);
    const sample1h = findClosestSample(history, now - TARGET_1H_MS, TOLERANCE_1H);

    const priceChange5mPct = (sample5m && sample5m.p !== 0)
      ? (snap.priceInQuote - sample5m.p) / sample5m.p * 100
      : null;

    const priceChange1hPct = (sample1h && sample1h.p !== 0)
      ? (snap.priceInQuote - sample1h.p) / sample1h.p * 100
      : null;

    movers.push({
      chain:              "solana",
      poolAddress:        snap.poolAddress,
      program:            snap.program,
      baseMint:           snap.baseMint,
      quoteMint:          snap.quoteMint,
      baseSymbol:         snap.baseSymbol,
      quoteSymbol:        snap.quoteSymbol,
      priceInQuote:       snap.priceInQuote,
      priceUsd:           snap.priceUsd,
      priceChange5mPct,
      priceChange1hPct,
      sampleCount,
      currentAgeSec:      Math.round(currentAgeSec),
      oldestSampleAgeSec: Math.round(oldestSampleAgeSec),
      historyStatus:      getHistoryStatus(sampleCount, oldestSampleAgeSec, currentAgeSec),
      coverage:           "SAMPLED",
      source:             "SWAP_VAULT_DELTA",
      knownPool:          snap.knownPool,
      lastUpdatedAt:      snap.lastUpdatedAt,
      computedAt:         now,
    });
  }

  // 8.0k-a2: flush write-backs (corectare snapshot-uri stale, o singura data per pool)
  if (writebackCount > 0) {
    await writebackPipeline.exec();
    console.log("[SOLANA][MOVERS] knownPool write-back count=" + writebackCount);
  }

  // Sort: abs(priceChange5mPct) desc, null la coada
  movers.sort((a, b) => {
    const aAbs = a.priceChange5mPct !== null ? Math.abs(a.priceChange5mPct) : -1;
    const bAbs = b.priceChange5mPct !== null ? Math.abs(b.priceChange5mPct) : -1;
    return bAbs - aAbs;
  });

  const result: MoversSnapshot = {
    chain:        "solana",
    computedAt:   now,
    windowMs:     INDEX_LOOKBACK_MS,
    totalTracked: poolAddresses.length,
    movers:       movers.slice(0, TOP_N),
  };

  await redis.set(KEY_TRENDING_MOVERS, JSON.stringify(result), "EX", MOVERS_TTL_SEC);

  const top = movers[0];
  console.log(
    "[SOLANA][MOVERS] computed"
    + " tracked=" + poolAddresses.length
    + " withChange5m=" + movers.filter(m => m.priceChange5mPct !== null).length
    + (top
      ? " top=" + top.baseSymbol
        + " " + (top.priceChange5mPct !== null ? top.priceChange5mPct.toFixed(2) + "%" : "null")
      : ""),
  );
}
