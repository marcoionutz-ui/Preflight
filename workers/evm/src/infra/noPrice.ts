/** P1: process-local counters; no imports, timers, sockets or reset on reconnect. */
export interface NoPriceState { total: number; lastLoggedAt: number | null; }
export const NO_PRICE_LOG_INTERVAL_MS = 60_000;
export function nextNoPriceState(previous: NoPriceState, now: number): { state: NoPriceState; emit: boolean } {
  const total = Math.min(Number.MAX_SAFE_INTEGER, previous.total + 1);
  const emit = Number.isFinite(now) && (previous.lastLoggedAt === null || now - previous.lastLoggedAt >= NO_PRICE_LOG_INTERVAL_MS);
  return { state: { total, lastLoggedAt: emit ? now : previous.lastLoggedAt }, emit };
}
const byChain = new Map<string, NoPriceState>();
export function getDroppedNoPrice(chain: string): number { return byChain.get(chain)?.total ?? 0; }
export function recordNoPriceDrop(chain: string, now = performance.now(), log: (line: string) => void = console.log): void {
  const next = nextNoPriceState(byChain.get(chain) ?? { total: 0, lastLoggedAt: null }, now);
  byChain.set(chain, next.state);
  if (next.emit) log("[NO PRICE " + chain + "] mesaje swap refuzate fără preț nativ: total=" + next.state.total);
}
