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
import type { PreflightMomentumEvent, PreflightQualifiedSignal } from "../lib/preflight-redis";
import { MAX_MOMENTUM_BUFFER, MAX_QUALIFIED_BUFFER } from "../config/constants";

// ── Types ─────────────────────────────────────────────────────────────────────

export type EntrySource = "WS" | "FOMO" | "SCAN" | "VERTICAL" | "LATE";
export type WatchKind   = "NORMAL" | "FOMO" | "VERTICAL" | "LATE" | "CONFIRMED_MOMENTUM";

export type PipelineEventType =
  | "WATCH_ADDED"
  | "PROMOTED_HOT"
  | "ARMED"
  | "DROPPED"
  | "ARM_CONFIRMED";

export interface SwapEvent { ts: number; isBuy: boolean; ethAmount: number; }
export interface LpEvent   { ts: number; isAdd: boolean; ethAmount: number; }

// ── Pair memory ───────────────────────────────────────────────────────────────

export const memory = new Map<string, PairMemoryEntry>();

// ── WS flow data ──────────────────────────────────────────────────────────────

export const wsFlow   = new Map<string, SwapEvent[]>();
export const lpEvents = new Map<string, LpEvent[]>();

// ── Pipeline state ────────────────────────────────────────────────────────────

export const activeWatch = new Map<string, {
  chain:       string;
  addedAt:     number;
  kind?:       WatchKind;
  entryPrice?: number;
  reason?:     string;
}>();

export const hotCandidates = new Map<string, {
  chain:      string;
  promotedAt: number;
  source?:    EntrySource;
}>();

export const armedEntries = new Map<string, {
  armedAt:       number;
  price:         number;
  score:         number;
  flowPressure:  string;
}>();

// ── Liquidity ─────────────────────────────────────────────────────────────────

export const poolLiquidity = new Map<string, {
  reserveUsd: number;
  reserveEth: number;
  updatedAt:  number;
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

export const v3PoolMap = new Map<string, SourcePool>();
export const v4PoolMap = new Map<string, SourcePool>();

// ── Cache ─────────────────────────────────────────────────────────────────────

export const watchedPoolCache = new Map<string, SourcePool>();

// ── Pipeline events & drops ───────────────────────────────────────────────────

export const recentDrops: Array<{
  symbol:        string;
  chain:         string;
  pairAddress:   string;
  previousState: "WATCHING" | "HOT" | "ARMED";
  reason:        string;
  droppedAt:     number;
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

export function pushMomentumEvent(event: PreflightMomentumEvent): void {
  momentumEventsBuffer.unshift(event);
  if (momentumEventsBuffer.length > MAX_MOMENTUM_BUFFER) {
    momentumEventsBuffer.splice(MAX_MOMENTUM_BUFFER);
  }
}
