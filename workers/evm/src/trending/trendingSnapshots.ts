/**
 * trending/trendingSnapshots.ts
 * 6.10 — Pasul 1: shadow price history per pool.
 *
 * Scrie LPUSH preflight:trending:snapshot:{chain}:{pair} la fiecare 5 minute.
 * 288 entries = 24h la 5 minute interval.
 * Fără scoring, fără ranking — doar memorie de preț.
 */

import type { Redis } from "ioredis";
import type { PairStateSnapshot } from "../state/pairStates";
import { REDIS_KEYS } from "@preflight/schema";

export interface TrendingSnapshotEntry {
  ts:           number;
  chain:        string;
  pairAddress:  string;
  tokenAddress: string | null;
  symbol:       string;
  dexType:      string;
  priceUsd:     number;
  reserveUsd:   number;
}

const SNAPSHOT_INTERVAL_MS = 5 * 60_000;   // scrie la fiecare 5 minute
const MAX_ENTRIES          = 288;           // 288 × 5min = 24h
const EXPIRE_SEC           = 172_800;       // 48h TTL — supraviețuiește un restart

let lastWrittenAt = 0;

export async function writeTrendingSnapshots(
  r:      Redis,
  states: Record<string, PairStateSnapshot>,
): Promise<void> {
  const now = Date.now();
  if (now - lastWrittenAt < SNAPSHOT_INTERVAL_MS) return;

  const eligible = Object.values(states).filter(
    s => s.currentPrice > 0 && s.reserveUsd >= 1_000 && s.chain && s.pairAddress,
  );

  if (!eligible.length) return;

  const pipeline = r.pipeline();

  for (const s of eligible) {
    const entry: TrendingSnapshotEntry = {
      ts:           now,
      chain:        s.chain,
      pairAddress:  s.pairAddress,
      tokenAddress: s.tokenAddress ?? null,
      symbol:       s.symbol,
      dexType:      s.dexType,
      priceUsd:     s.currentPrice,
      reserveUsd:   s.reserveUsd,
    };
    const key = REDIS_KEYS.trendingSnapshot(s.chain, s.pairAddress);
    const val = JSON.stringify(entry);
    pipeline.lpush(key, val);
    pipeline.ltrim(key, 0, MAX_ENTRIES - 1);
    pipeline.expire(key, EXPIRE_SEC);
  }

  await pipeline.exec();
  lastWrittenAt = now;
  console.log(`[TRENDING] Wrote snapshots for ${eligible.length} pools`);
}
