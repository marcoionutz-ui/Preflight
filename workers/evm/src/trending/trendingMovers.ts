/**
 * trending/trendingMovers.ts
 * 6.10 — Pasul 2: calculează priceChange5m/1h/24h din snapshot history.
 * Scrie preflight:trending:movers:{chain} ca JSON top-N movers per chain (nu ZSET).
 */

import type { Redis } from "ioredis";
import type { PairStateSnapshot } from "../state/pairStates";
import { REDIS_KEYS } from "@preflight/schema";
import { BLOCKED_SYMBOLS } from "../config/constants";

// Indici în lista snapshot (LPUSH = newest first, index 0 = cel mai nou)
const IDX_5M  = 1;    // 1 × 5min în urmă
const IDX_1H  = 12;   // 12 × 5min = 1h în urmă
const IDX_24H = 287;  // 287 × 5min ≈ 24h în urmă

const MOVERS_INTERVAL_MS = 5 * 60_000;
const MOVERS_EXPIRE_SEC  = 600;   // 10 min — re-scris la fiecare ciclu
const TOP_N_PER_CHAIN    = 50;
const MIN_RESERVE_USD    = 1_000;

export interface MoverEntry {
  chain:          string;
  pairAddress:    string;
  tokenAddress:   string | null;
  symbol:         string;
  dexType:        string;
  priceUsd:       number;
  reserveUsd:     number;
  priceChange5m:  number | null;  // null dacă nu există snapshot la 5m
  priceChange1h:  number | null;  // null dacă nu există snapshot la 1h
  priceChange24h: number | null;  // null până la 24h de history
  direction:      "UP" | "DOWN" | "FLAT";
  historyStatus:  "WARMING_UP" | "PARTIAL" | "READY";
  snapshotCount:  number;
  ts:             number;
}

function calcChange(current: number, historical: number | undefined): number | null {
  if (!historical || historical <= 0) return null;
  return Number(((current - historical) / historical * 100).toFixed(4));
}

function parseSnap(raw: unknown): { priceUsd: number } | null {
  if (!raw || typeof raw !== "string") return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.priceUsd === "number" && p.priceUsd > 0) {
      return { priceUsd: p.priceUsd };
    }
    return null;
  } catch { return null; }
}

function deriveDirection(priceChange5m: number | null): "UP" | "DOWN" | "FLAT" {
  if (priceChange5m === null || priceChange5m === 0) return "FLAT";
  return priceChange5m > 0 ? "UP" : "DOWN";
}

function deriveHistoryStatus(snapshotCount: number): "WARMING_UP" | "PARTIAL" | "READY" {
  if (snapshotCount >= 288) return "READY";
  if (snapshotCount >= 12)  return "PARTIAL";
  return "WARMING_UP";
}

let lastMoversAt = 0;

export async function calculateMovers(
  r:      Redis,
  states: Record<string, PairStateSnapshot>,
): Promise<void> {
  const now = Date.now();
  if (now - lastMoversAt < MOVERS_INTERVAL_MS) return;

  const eligible = Object.values(states).filter(
    s =>
      s.currentPrice > 0 &&
      s.reserveUsd >= MIN_RESERVE_USD &&
      s.chain &&
      s.pairAddress &&
      !BLOCKED_SYMBOLS.has((s.symbol ?? "").toLowerCase()),
  );
  if (!eligible.length) {
    lastMoversAt = now;
    return;
  }

  // ── Batch LINDEX reads: 5 comenzi per pool ─────────────────────────────────
  const readPipeline = r.pipeline();
  for (const s of eligible) {
    const key = REDIS_KEYS.trendingSnapshot(s.chain, s.pairAddress);
    readPipeline.lindex(key, 0);       // current (newest)
    readPipeline.lindex(key, IDX_5M);  // 5m ago
    readPipeline.lindex(key, IDX_1H);  // 1h ago
    readPipeline.lindex(key, IDX_24H); // 24h ago
    readPipeline.llen(key);            // câte snapshots există
  }
  const results = await readPipeline.exec();
  if (!results) return;

  // ── Calcul movers per chain ─────────────────────────────────────────────────
  const moversByChain: Record<string, MoverEntry[]> = {};

  for (let i = 0; i < eligible.length; i++) {
    const s   = eligible[i];
    const off = i * 5;

    const snapNow   = parseSnap(results[off]?.[1]);
    const snap5m    = parseSnap(results[off + 1]?.[1]);
    const snap1h    = parseSnap(results[off + 2]?.[1]);
    const snap24h   = parseSnap(results[off + 3]?.[1]);
    const snapCount = (results[off + 4]?.[1] as number | null) ?? 0;

    if (!snapNow) continue;  // pool fără snapshot scris încă

    const priceChange5m  = calcChange(snapNow.priceUsd, snap5m?.priceUsd);
    const priceChange1h  = calcChange(snapNow.priceUsd, snap1h?.priceUsd);
    const priceChange24h = calcChange(snapNow.priceUsd, snap24h?.priceUsd);

    const entry: MoverEntry = {
      chain:          s.chain,
      pairAddress:    s.pairAddress,
      tokenAddress:   s.tokenAddress ?? null,
      symbol:         s.symbol,
      dexType:        s.dexType,
      priceUsd:       snapNow.priceUsd,
      reserveUsd:     s.reserveUsd,
      priceChange5m,
      priceChange1h,
      priceChange24h,
      direction:      deriveDirection(priceChange5m),
      historyStatus:  deriveHistoryStatus(snapCount),
      snapshotCount:  snapCount,
      ts:             now,
    };

    if (!moversByChain[s.chain]) moversByChain[s.chain] = [];
    moversByChain[s.chain].push(entry);
  }

  // ── Sort + write top N per chain ────────────────────────────────────────────
  const writePipeline = r.pipeline();
  let totalWritten = 0;

  for (const [chain, movers] of Object.entries(moversByChain)) {
    const sorted = movers
      .filter(m => m.priceChange5m !== null || m.priceChange1h !== null)
      .sort((a, b) => {
        const d5m = Math.abs(b.priceChange5m ?? 0) - Math.abs(a.priceChange5m ?? 0);
        if (d5m !== 0) return d5m;
        const d1h = Math.abs(b.priceChange1h ?? 0) - Math.abs(a.priceChange1h ?? 0);
        if (d1h !== 0) return d1h;
        return b.reserveUsd - a.reserveUsd;
      })
      .slice(0, TOP_N_PER_CHAIN);

    if (!sorted.length) continue;

    writePipeline.set(
      REDIS_KEYS.trendingMovers(chain),
      JSON.stringify(sorted),
      "EX",
      MOVERS_EXPIRE_SEC,
    );
    totalWritten += sorted.length;
  }

  await writePipeline.exec();
  lastMoversAt = now;
  console.log(`[TRENDING] Movers: ${totalWritten} across ${Object.keys(moversByChain).length} chains`);
}
