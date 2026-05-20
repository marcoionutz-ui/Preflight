// Shared pair memory types + gate function

import type { Phase }       from "./phaseDetector";
import type { FlowSignal }  from "./flowTypes";

export interface PairMemoryEntry {
  pairAddress:       string;
  symbol:            string;
  tokenAddress:      string;
  firstSeen:         number;
  lastSeen:          number;
  seenCount:         number;
  priceAtFirstSeen:  number;
  highPrice:         number;
  lowPrice:          number;
  currentPrice:      number;
  totalEntries:      number;
  lastEntryTime:     number;
  lastEntryPrice:    number;
  wins24h:           number;
  losses24h:         number;
  badExits24h:       number;  // MAX HOLD + SELL PRESSURE + LP REMOVED
  consecutiveLosses: number;
  lastExitReason:    string | null;
  lastExitTime:      number | null;
  phase:             Phase;
}

export function emptyPairMemory(pairAddress: string, symbol: string): PairMemoryEntry {
  const now = Date.now();
  return {
    pairAddress, symbol, tokenAddress: "",
    firstSeen: now, lastSeen: now, seenCount: 0,
    priceAtFirstSeen: 0, highPrice: 0, lowPrice: 0, currentPrice: 0,
    totalEntries: 0, lastEntryTime: 0, lastEntryPrice: 0,
    wins24h: 0, losses24h: 0, badExits24h: 0, consecutiveLosses: 0,
    lastExitReason: null, lastExitTime: null,
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
  cooldownMs   = 2 * 60 * 60_000,
): EntryGateResult {
  // Max 3 intrări per token per 24h (totalEntries = last 24h din Supabase)
  if (mem.totalEntries >= 3)
    return { allowed: false, reason: `max 3 entries/24h (${mem.totalEntries} so far)` };

  if (mem.seenCount < minSeenCount)
    return { allowed: false, reason: `too new (seen ${mem.seenCount}x, need ${minSeenCount})` };

  if (mem.phase === "ZOMBIE")
    return { allowed: false, reason: "zombie pair — no outcome signal" };

  if (mem.phase === "DEAD" || mem.consecutiveLosses >= 3)
    return { allowed: false, reason: `dead — ${mem.consecutiveLosses} consecutive SL` };

  if (mem.lastEntryTime > 0 && Date.now() - mem.lastEntryTime < cooldownMs) {
    const minsLeft = Math.ceil((mem.lastEntryTime + cooldownMs - Date.now()) / 60_000);
    return { allowed: false, reason: `cooldown ${minsLeft}m left` };
  }

  if (mem.phase === "PUMPING")
    return { allowed: false, reason: "vertical pump phase" };

  if (flow.hasData && flow.pressure === "SELLING")
    return { allowed: false, reason: `sell pressure (${flow.sells5m}s vs ${flow.buys5m}b in 5m)` };

  return {
    allowed: true,
    reason: `phase:${mem.phase} seen:${mem.seenCount}x flow:${flow.pressure}`,
  };
}