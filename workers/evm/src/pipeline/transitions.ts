/**
 * pipeline/transitions.ts
 * Toate tranzițiile de state: addWatch, promoteHot, armCandidate, drop*.
 */

import type { SourcePool } from "../sources/normalize";
import type { EntrySource, WatchKind, PipelineEventType } from "../state/stores";
import {
  activeWatch, hotCandidates, armedEntries, watchedPoolCache,
  recentDrops, pipelineEvents, memory,
} from "../state/stores";
import { MAX_ACTIVE_WATCH } from "../config/constants";

export function recordPipelineEvent(
  type:        PipelineEventType,
  symbol:      string,
  chain:       string,
  pairAddress: string,
  from:        string,
  to:          string,
  reason?:     string,
): void {
  pipelineEvents.unshift({ type, symbol, chain, pairAddress, from, to, reason, ts: Date.now() });
  if (pipelineEvents.length > 50) pipelineEvents.splice(50);
}

export function recordDrop(
  pairAddr:      string,
  symbol:        string,
  chain:         string,
  previousState: "WATCHING" | "HOT" | "ARMED",
  reason:        string,
): void {
  recentDrops.unshift({ symbol, chain, pairAddress: pairAddr, previousState, reason, droppedAt: Date.now() });
  if (recentDrops.length > 50) recentDrops.splice(50);
  recordPipelineEvent("DROPPED", symbol, chain, pairAddr, previousState, "NONE", reason);
}

export function dropHotCandidate(pairAddr: string, reason: string, chain?: string): void {
  const info   = hotCandidates.get(pairAddr);
  const sym    = memory.get(pairAddr)?.symbol ?? pairAddr.slice(0, 8);
  const c      = chain ?? info?.chain ?? "unknown";
  hotCandidates.delete(pairAddr);
  recordDrop(pairAddr, sym, c, "HOT", reason);
}

export function dropWatchCandidate(pairAddr: string, reason: string): void {
  const info = activeWatch.get(pairAddr);
  const sym  = memory.get(pairAddr)?.symbol ?? pairAddr.slice(0, 8);
  activeWatch.delete(pairAddr);
  recordDrop(pairAddr, sym, info?.chain ?? "unknown", "WATCHING", reason);
}

export function promoteHotCandidate(
  pairAddr: string,
  chain:    string,
  source?:  EntrySource,
): void {
  const sym = memory.get(pairAddr)?.symbol ?? pairAddr.slice(0, 8);
  hotCandidates.set(pairAddr, { chain, promotedAt: Date.now(), source });
  activeWatch.delete(pairAddr);
  recordPipelineEvent("PROMOTED_HOT", sym, chain, pairAddr, "WATCHING", "HOT");
}

export function addWatchCandidate(
  pairAddr: string,
  info: {
    chain:       string;
    addedAt:     number;
    kind?:       WatchKind;
    entryPrice?: number;
    reason?:     string;
  },
  pool?: SourcePool,
): void {
  if (activeWatch.size >= MAX_ACTIVE_WATCH) return;
  activeWatch.set(pairAddr, info);
  if (pool) watchedPoolCache.set(pairAddr, pool);
  const sym = memory.get(pairAddr)?.symbol ?? pairAddr.slice(0, 8);
  recordPipelineEvent("WATCH_ADDED", sym, info.chain, pairAddr, "NONE", "WATCHING", info.reason);
}

export function armCandidate(
  pairAddr:     string,
  chain:        string,
  price:        number,
  score:        number,
  flowPressure: string,
): void {
  const sym = memory.get(pairAddr)?.symbol ?? pairAddr.slice(0, 8);
  armedEntries.set(pairAddr, { armedAt: Date.now(), price, score, flowPressure });
  recordPipelineEvent("ARMED", sym, chain, pairAddr, "HOT", "ARMED");
}

export function deleteHotCandidate(pairAddr: string): void {
  hotCandidates.delete(pairAddr);
}
