// Shared pair memory types + gate function

import type { FlowSignal }  from "./flowTypes";
// PairMemoryEntry moved to @preflight/schema (PreflightMemoryEntry) — it's
// the shape written into worker_snapshot.memory and read by MCP, so it's
// part of the wire contract. Re-exported here so existing
// `from "./pairMemory"` imports keep working (same pattern as
// PairStateSnapshot in state/pairStates.ts).
import type { PreflightMemoryEntry } from "@preflight/schema";
export type PairMemoryEntry = PreflightMemoryEntry;

export function emptyPairMemory(pairAddress: string, symbol: string): PairMemoryEntry {
  const now = Date.now();
  return {
    pairAddress, symbol, tokenAddress: "",
    firstSeen: now, lastSeen: now, seenCount: 0,
    priceAtFirstSeen: 0, highPrice: 0, lowPrice: 0, currentPrice: 0,
    phase: "NEW",
  };
}

export interface EntryGateResult {
  allowed: boolean;
  reason:  string;
}

export function checkEntryGate(
  mem:  PairMemoryEntry,
  flow: FlowSignal,
  minSeenCount = 5,
  options?: { allowPumping?: boolean },
): EntryGateResult {
  if (mem.seenCount < minSeenCount)
    return { allowed: false, reason: `too new (seen ${mem.seenCount}x, need ${minSeenCount})` };

  if (mem.phase === "PUMPING" && !options?.allowPumping)
    return { allowed: false, reason: "vertical pump phase" };

  if (flow.hasData && flow.pressure === "SELLING")
    return { allowed: false, reason: `sell pressure (${flow.sells5m}s vs ${flow.buys5m}b in 5m)` };

  return {
    allowed: true,
    reason: `phase:${mem.phase} seen:${mem.seenCount}x flow:${flow.pressure}`,
  };
}