/**
 * state/lifecycle.ts
 * Tracks lastOutcome per pair — written to Redis so MCP can read it.
 */

// LifecycleOutcome + the entry shape moved to @preflight/schema (item 5a) —
// preflight:lifecycle is real wire contract, read by mcp's tp_why_not and
// pair-context-report. Re-exported here so existing `from "./lifecycle"`
// imports keep working (same pattern as Phase/MonitoringTier).
import type { LifecycleOutcome, PreflightLifecycleEntry } from "@preflight/schema";
export type { LifecycleOutcome };
export type PairLifecycle = PreflightLifecycleEntry;

const lifecycleStore = new Map<string, PairLifecycle>();

export function recordLifecycleOutcome(
  pairAddress: string,
  outcome:     LifecycleOutcome,
  fromState:   "WATCHING" | "HOT" | "ARMED",
  reason:      string,
): void {
  // Normalized before both the Map key AND the stored pairAddress — keeps
  // the wire JSON deterministic. Not a current bug (consumers already
  // .toLowerCase() on lookup), just consistency.
  const normalizedAddress = pairAddress.toLowerCase();
  lifecycleStore.set(normalizedAddress, {
    pairAddress:   normalizedAddress,
    lastOutcome:   outcome,
    lastOutcomeAt: Date.now(),
    reason,
    fromState,
  });
  if (lifecycleStore.size > 500) {
    const oldest = [...lifecycleStore.entries()]
      .sort(([, a], [, b]) => a.lastOutcomeAt - b.lastOutcomeAt)[0];
    if (oldest) lifecycleStore.delete(oldest[0]);
  }
}

export function getLifecycle(pairAddress: string): PairLifecycle | null {
  return lifecycleStore.get(pairAddress.toLowerCase()) ?? null;
}

export function getRecentLifecycles(limitMs = 10 * 60_000): PairLifecycle[] {
  const cutoff = Date.now() - limitMs;
  return [...lifecycleStore.values()]
    .filter(l => l.lastOutcomeAt >= cutoff)
    .sort((a, b) => b.lastOutcomeAt - a.lastOutcomeAt);
}