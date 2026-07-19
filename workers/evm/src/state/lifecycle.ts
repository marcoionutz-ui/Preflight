/**
 * state/lifecycle.ts
 * Tracks lastOutcome per pair — written to Redis so MCP can read it.
 */

// LifecycleOutcome + the entry shape moved to @preflight/schema (item 5a) —
// preflight:lifecycle is real wire contract, read by mcp's tp_why_not and
// pair-context-report. Re-exported here so existing `from "./lifecycle"`
// imports keep working (same pattern as Phase/MonitoringTier).
import { normalizeChainId, normalizePairAddress, type LifecycleOutcome, type PreflightLifecycleEntry } from "@preflight/schema";
import { PairMap } from "./PairMap";
export type { LifecycleOutcome };
export type PairLifecycle = PreflightLifecycleEntry;

const lifecycleStore = new PairMap<PairLifecycle>();

export function recordLifecycleOutcome(
  chain:       string,
  pairAddress: string,
  outcome:     LifecycleOutcome,
  fromState:   "WATCHING" | "HOT" | "ARMED",
  reason:      string,
): void {
  // pairAddress păstrat normalizat în JSON-ul wire (consumatorii .toLowerCase()
  // la lookup); cheia PairMap e chain-scoped → aceeași adresă pe 2 chainuri nu
  // se mai suprascrie (P0-1). `chain` e acum și în entry, ca MCP-ul (B3f) să
  // poată lega lifecycle-ul de chain-ul corect.
  // Canonicalizăm chain ȘI adresa ÎNAINTE de cheie ȘI de valoare, ca wire-ul
  // (pe care B3f îl filtrează după chain) să fie identic cu cheia PairMap.
  // Altfel: cheie `ethereum:0xabc` dar valoare `{chain:"eth"}` → MCP ratează.
  const normalizedChain   = normalizeChainId(chain);
  const normalizedAddress = normalizePairAddress(normalizedChain, pairAddress);
  lifecycleStore.set(normalizedChain, normalizedAddress, {
    chain:         normalizedChain,
    pairAddress:   normalizedAddress,
    lastOutcome:   outcome,
    lastOutcomeAt: Date.now(),
    reason,
    fromState,
  });
  if (lifecycleStore.size > 500) {
    const oldest = [...lifecycleStore.entries()]
      .sort(([, a], [, b]) => a.lastOutcomeAt - b.lastOutcomeAt)[0];
    if (oldest) lifecycleStore.delete(oldest[0].chain, oldest[0].address);
  }
}

export function getLifecycle(chain: string, pairAddress: string): PairLifecycle | null {
  return lifecycleStore.get(chain, pairAddress) ?? null;
}

export function getRecentLifecycles(limitMs = 10 * 60_000): PairLifecycle[] {
  const cutoff = Date.now() - limitMs;
  return [...lifecycleStore.values()]
    .filter(l => l.lastOutcomeAt >= cutoff)
    .sort((a, b) => b.lastOutcomeAt - a.lastOutcomeAt);
}