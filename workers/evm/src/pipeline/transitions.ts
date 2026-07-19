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
import { BUDGET, maxWatchForChain } from "../config/mode";
import { recordLifecycleOutcome } from "../state/lifecycle";

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
  clearQualifiedForPair(chain, pairAddr);

  const lifecycleOutcome =
    reason.toLowerCase().includes("confirmation window expired") ? "EXPIRED" as const :
    reason.toLowerCase().includes("price failed confirmation")   ? "FAILED_CONFIRMATION" as const :
    "DROPPED" as const;
  recordLifecycleOutcome(pairAddr, lifecycleOutcome, previousState, reason);

  recordPipelineEvent("DROPPED", symbol, chain, pairAddr, previousState, "NONE", reason);
}

export function dropHotCandidate(pairAddr: string, chain: string, reason: string): void {
  // chain e acum OBLIGATORIU (toți callerii îl au) — cheia hotCandidates e
  // chain-scoped, deci nu mai putem face lookup fără el.
  const sym = memory.get(pairAddr)?.symbol ?? pairAddr.slice(0, 8);
  hotCandidates.delete(chain, pairAddr);
  recordDrop(pairAddr, sym, chain, "HOT", reason);
}

export function dropWatchCandidate(pairAddr: string, chain: string, reason: string): void {
  const sym = memory.get(pairAddr)?.symbol ?? pairAddr.slice(0, 8);
  activeWatch.delete(chain, pairAddr);
  recordDrop(pairAddr, sym, chain, "WATCHING", reason);
}

export function promoteHotCandidate(
  pairAddr: string,
  chain:    string,
  source?:  EntrySource,
): void {
  const watchKind = activeWatch.get(chain, pairAddr)?.kind;
  if (watchKind && CONTEXT_ONLY_WATCH_KINDS.has(watchKind)) return;
  const sym = memory.get(pairAddr)?.symbol ?? pairAddr.slice(0, 8);
  hotCandidates.set(chain, pairAddr, { chain, promotedAt: Date.now(), source });
  activeWatch.delete(chain, pairAddr);
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
  const alreadyWatching = activeWatch.has(info.chain, pairAddr);

  if (!alreadyWatching) {
    if (activeWatch.size >= BUDGET.maxActiveWatch) return;
	const maxForChain = maxWatchForChain(info.chain);
    let chainCount = 0;
    for (const [{ chain }] of activeWatch.entries()) {
      if (chain === info.chain) chainCount++;
    }
    if (chainCount >= maxForChain) return;
  }

  activeWatch.set(info.chain, pairAddr, info);
  if (pool) watchedPoolCache.set(info.chain, pairAddr, pool);
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
  armedEntries.set(chain, pairAddr, { chain, armedAt: Date.now(), price, score, flowPressure });
  recordPipelineEvent("ARMED", sym, chain, pairAddr, "HOT", "ARMED");
}

export function deleteHotCandidate(pairAddr: string, chain: string): void {
  hotCandidates.delete(chain, pairAddr);
}
