/**
 * state/lifecycle.ts
 * Tracks lastOutcome per pair — written to Redis so MCP can read it.
 */

export type LifecycleOutcome =
  | "QUALIFIED_EMITTED"
  | "DROPPED"
  | "EXPIRED"
  | "FAILED_CONFIRMATION";

export interface PairLifecycle {
  pairAddress:   string;
  lastOutcome:   LifecycleOutcome;
  lastOutcomeAt: number;
  reason:        string;
  fromState:     "WATCHING" | "HOT" | "ARMED";
}

const lifecycleStore = new Map<string, PairLifecycle>();

export function recordLifecycleOutcome(
  pairAddress: string,
  outcome:     LifecycleOutcome,
  fromState:   "WATCHING" | "HOT" | "ARMED",
  reason:      string,
): void {
  lifecycleStore.set(pairAddress.toLowerCase(), {
    pairAddress,
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