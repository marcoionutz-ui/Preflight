/**
 * pipeline/transitions.ts
 * Toate tranzițiile de state: addWatch, promoteHot, armCandidate, drop*.
 */

import type { SourcePool } from "../sources/normalize";
import type { EntrySource, WatchKind, PipelineEventType } from "../state/stores";
import {
  activeWatch, hotCandidates, armedEntries, watchedPoolCache,
  recentDrops, pipelineEvents, memory, clearQualifiedForPair,
} from "../state/stores";
import { MAX_ACTIVE_WATCH, MAX_ACTIVE_WATCH_BY_CHAIN } from "../config/constants";

const CONTEXT_ONLY_WATCH_KINDS = new Set([
  "CONTEXT_HIGH_LIQ",
  "CONTEXT_MOVER_5M",
  "CONTEXT_MOVER_1H",
  "CONTEXT_MOVER_24H",
]);

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
  priceAtDrop?:  number,
  scoreAtDrop?:  number,
): void {
  recentDrops.unshift({ symbol, chain, pairAddress: pairAddr, previousState, reason, droppedAt: Date.now(), priceAtDrop, scoreAtDrop });
  if (recentDrops.length > 50) recentDrops.splice(50);
  clearQualifiedForPair(pairAddr);
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
  const watchKind = activeWatch.get(pairAddr)?.kind;
  if (watchKind && CONTEXT_ONLY_WATCH_KINDS.has(watchKind)) return;
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
  const alreadyWatching = activeWatch.has(pairAddr);

  if (!alreadyWatching) {
    if (activeWatch.size >= MAX_ACTIVE_WATCH) return;
    const maxForChain = MAX_ACTIVE_WATCH_BY_CHAIN[info.chain] ?? 10;
    let chainCount = 0;
    for (const w of activeWatch.values()) {
      if (w.chain === info.chain) chainCount++;
    }
    if (chainCount >= maxForChain) return;
  }

  activeWatch.set(pairAddr, info);
  if (pool) watchedPoolCache.set(pairAddr, pool);
  const sym = memory.get(pairAddr)?.symbol ?? pairAddr.slice(0, 8);
  if (!alreadyWatching) {
    recordPipelineEvent("WATCH_ADDED", sym, info.chain, pairAddr, "NONE", "WATCHING", info.reason);
  }
}

export function armCandidate(
  pairAddr:     string,
  chain:        string,
  price:        number,
  score:        number,
  flowPressure: string,
): void {
  const sym = memory.get(pairAddr)?.symbol ?? pairAddr.slice(0, 8);
  armedEntries.set(pairAddr, { chain, armedAt: Date.now(), price, score, flowPressure });
  recordPipelineEvent("ARMED", sym, chain, pairAddr, "HOT", "ARMED");
}

export function deleteHotCandidate(pairAddr: string): void {
  hotCandidates.delete(pairAddr);
}
