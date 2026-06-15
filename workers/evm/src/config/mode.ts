/**
 * config/mode.ts
 * PREFLIGHT_MODE controls worker resource budget.
 * DEV | BURST | LIVE | PAID_LIVE
 */

export type PreflightMode = "DEV" | "BURST" | "LIVE" | "PAID_LIVE";

export interface ModeBudget {
  scanIntervalMs:        number;
  maxActiveWatch:        number;
  maxActiveWatchByChain: Record<string, number>;
  wsEnabled:             boolean;
  followRefreshMs:       number;
}

const BUDGETS: Record<PreflightMode, ModeBudget> = {
  DEV: {
    scanIntervalMs:        120_000,
    maxActiveWatch:        10,
    maxActiveWatchByChain: { base: 10, arbitrum: 4, bsc: 6 },
    wsEnabled:             false,
    followRefreshMs:       300_000,
  },
  BURST: {
    scanIntervalMs:        60_000,
    maxActiveWatch:        20,
    maxActiveWatchByChain: { base: 10, arbitrum: 6, bsc: 8 },
    wsEnabled:             true,
    followRefreshMs:       120_000,
  },
  LIVE: {
    scanIntervalMs:        30_000,
    maxActiveWatch:        60,
    maxActiveWatchByChain: { base: 20, arbitrum: 12, bsc: 25 },
    wsEnabled:             true,
    followRefreshMs:       60_000,
  },
  PAID_LIVE: {
    scanIntervalMs:        15_000,
    maxActiveWatch:        120,
    maxActiveWatchByChain: { base: 40, arbitrum: 30, bsc: 50 },
    wsEnabled:             true,
    followRefreshMs:       30_000,
  },
};

const raw = (process.env.PREFLIGHT_MODE ?? "LIVE").toUpperCase();
export const MODE: PreflightMode =
  raw === "DEV"       ? "DEV"       :
  raw === "BURST"     ? "BURST"     :
  raw === "PAID_LIVE" ? "PAID_LIVE" :
  "LIVE";

export const BUDGET: ModeBudget = BUDGETS[MODE];

export function maxWatchForChain(chain: string): number {
  return BUDGET.maxActiveWatchByChain[chain] ?? Math.max(1, Math.floor(BUDGET.maxActiveWatch / 3));
}

console.log(`[MODE] PREFLIGHT_MODE=${MODE} | scan:${BUDGET.scanIntervalMs}ms | maxWatch:${BUDGET.maxActiveWatch} | ws:${BUDGET.wsEnabled}`);