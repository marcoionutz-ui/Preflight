/**
 * state/stores.ts
 * Toate store-urile in-memory ale workerului.
 * Un singur loc unde trăiesc Maps-urile globale.
 *
 * Note: acestea sunt globale acum pentru compatibilitate cu refactorul mecanic.
 * Pe termen lung → WorkerContext pasat explicit între funcții.
 */

import type { PairMemoryEntry } from "../lib/engines/pairMemory";
import type { SourcePool } from "../sources/normalize";
import { PairMap } from "./PairMap";
import { MAX_MOMENTUM_BUFFER, MAX_QUALIFIED_BUFFER } from "../config/constants";
import { pairKey, type DiscoverySource, type PreflightMomentumEvent, type PreflightQualifiedSignal } from "@preflight/schema";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EntrySource = "WS" | "FOMO" | "SCAN" | "VERTICAL" | "LATE";
export type WatchKind =
  | "NORMAL"
  | "VERTICAL"
  | "CONFIRMED_MOMENTUM"
  | "LATE"
  | "FOMO"
  | "EVENT_WATCH"
  | "SHORT_WATCH"
  | "FRESH_WATCH"
  | "CONTINUATION_WATCH"
  | "CONTEXT_HIGH_LIQ"
  | "CONTEXT_MOVER_5M"
  | "CONTEXT_MOVER_1H"
  | "CONTEXT_MOVER_24H"
  | "HIGH_LIQ"
  | "MOVER_5M"
  | "MOVER_1H"
  | "MOVER_24H"
  | "NEW_POOL";

export type PipelineEventType =
  | "WATCH_ADDED"
  | "PROMOTED_HOT"
  | "ARMED"
  | "DROPPED"
  | "ARM_CONFIRMED";

export interface SwapEvent { ts: number; isBuy: boolean; ethAmount: number; usdAmount?: number; }
export interface LpEvent   { ts: number; isAdd: boolean; ethAmount: number; }

// ── Pair memory ───────────────────────────────────────────────────────────────

export const memory = new Map<string, PairMemoryEntry>();

// ── WS flow data ──────────────────────────────────────────────────────────────

export const wsFlow   = new Map<string, SwapEvent[]>();
export const lpEvents = new Map<string, LpEvent[]>();

// ── Pipeline state ────────────────────────────────────────────────────────────

export const activeWatch = new PairMap<{
  chain:       string;
  addedAt:     number;
  kind?:       WatchKind;
  entryPrice?: number;
  reason?:     string;
}>();

export const hotCandidates = new PairMap<{
  chain:      string;
  promotedAt: number;
  source?:    EntrySource;
}>();

export const armedEntries = new PairMap<{
  chain:         string;
  armedAt:       number;
  price:         number;
  score:         number;
  flowPressure:  string;
}>();

// ── Liquidity ─────────────────────────────────────────────────────────────────

export const poolLiquidity = new PairMap<{
  reserveUsd:    number;
  reserveEth:    number; 
  reserveNative: number;
  nativeSymbol:  "ETH" | "BNB";
  updatedAt:     number;
}>();

// ── WS client state ───────────────────────────────────────────────────────────

export const wsClients        = new Map<string, any>(); // WebSocket per chain
export const swapSubIds        = new Map<string, string[]>();
export const pendingSwapSubs   = new Map<number, string>();
export let   swapSubReqId      = 10_000;
export const swapSubSnapshot   = new Map<string, string>();
export const v3SwapSubIds      = new Map<string, string>();
export const v4SwapSubIds      = new Map<string, string>();
export const lastImmediateSub  = new Map<string, number>();

export function incrementSwapSubReqId(): number {
  return ++swapSubReqId;
}

// ── Pool maps (pentru V3/V4 detection) ───────────────────────────────────────

export const v3PoolMap = new PairMap<SourcePool>();
export const v4PoolMap = new PairMap<SourcePool>();

// ── Cache ─────────────────────────────────────────────────────────────────────

export const watchedPoolCache = new PairMap<SourcePool>();

// ── Pipeline events & drops ───────────────────────────────────────────────────

export const recentDrops: Array<{
  symbol:        string;
  chain:         string;
  pairAddress:   string;
  previousState: "WATCHING" | "HOT" | "ARMED";
  reason:        string;
  droppedAt:     number;
  priceAtDrop?:  number;
  scoreAtDrop?:  number;
}> = [];

export const pipelineEvents: Array<{
  type:        PipelineEventType;
  symbol:      string;
  chain:       string;
  pairAddress: string;
  from:        string;
  to:          string;
  reason?:     string;
  ts:          number;
}> = [];

// ── Momentum & qualified buffers ──────────────────────────────────────────────

export const momentumEventsBuffer: PreflightMomentumEvent[] = [];
export const qualifiedSignalsBuffer: PreflightQualifiedSignal[] = [];

export function clearQualifiedForPair(chain: string, pairAddress: string): void {
  const key = pairKey(chain, pairAddress);
  for (let i = qualifiedSignalsBuffer.length - 1; i >= 0; i--) {
    const q = qualifiedSignalsBuffer[i];
    if (q && pairKey(q.chain, q.pairAddress) === key) {
      qualifiedSignalsBuffer.splice(i, 1);
    }
  }
}

export function pushMomentumEvent(event: PreflightMomentumEvent): void {
  momentumEventsBuffer.unshift(event);
  if (momentumEventsBuffer.length > MAX_MOMENTUM_BUFFER) {
    momentumEventsBuffer.splice(MAX_MOMENTUM_BUFFER);
  }
}

// ── Market follow list ────────────────────────────────────────────────────────
// Pair-uri cu attention mare care se refreshează direct chiar dacă nu mai apar în trending

export const marketFollowList = new PairMap<{
  chain:            string;
  addedAt:          number;
  lastRefreshedAt:  number;
  attentionScore:   number;
  reason:           string;
  missCount:        number;
  source?:          DiscoverySource;
}>();

// ── Gecko source health ───────────────────────────────────────────────────────
// GeckoHealthStatus + the entry shape moved to @preflight/schema (item 5c) —
// preflight:scanner_stats is real wire contract, read by mcp's
// tp_health_check. Re-exported here so existing `from "./stores"` imports
// keep working (same pattern as Phase/MonitoringTier/LifecycleOutcome).
import type { GeckoHealthStatus, PreflightGeckoChainHealth, PreflightDexscreenerHealth } from "@preflight/schema";
export type { GeckoHealthStatus };

export const geckoSourceHealth = new Map<string, PreflightGeckoChainHealth>();

// ── DexScreener source health ───────────────────────────────────────────────────────
// status starts "STARTING" — no DexScreener request has happened yet, so
// "OK" would falsely claim health before any evidence existed. scan.ts sets
// it to RATE_LIMITED/DEGRADED/OK explicitly on/after the first request.
export const dexscreenerSourceHealth = {
  lastFetchAt:      null as number | null,
  lastResultCount:  0,
  last429At:        null as number | null,
  status:           "STARTING" as PreflightDexscreenerHealth["status"],
};

export let lastDsBoostedFetchAt = 0;
export function setLastDsBoostedFetchAt(ts: number): void { lastDsBoostedFetchAt = ts; }