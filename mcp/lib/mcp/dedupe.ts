/**
 * lib/mcp/dedupe.ts — dedupe chain-scoped. Mutat din redis-reader ca să fie testabil izolat (leaf, fără importuri
 * grele). Identitatea de dedupe e chain-scoped (`chain:addr` lowercase) — `base:0xabc` și `arbitrum:0xabc` sunt
 * perechi DIFERITE, nu una. Identitatea e INTERNĂ (nu părăsește funcția / nu ajunge chei Redis) → nu trebuie să
 * fie canonical `pairKey`; o cheie injectivă pe (chain, addr) e suficientă. Re-exportat din redis-reader pt. compat.
 */
export function dedupeByPair<T extends { pairAddress?: string | null; chain?: string | null }>(
  arr:     T[] | null | undefined,
  tsField: keyof T,
): Array<T & { _eventCount: number }> {
  const map = new Map<string, T & { _eventCount: number }>();

  for (const item of arr ?? []) {
    const rawAddr = item.pairAddress?.trim();
    if (!rawAddr) continue;
    const addr = rawAddr.toLowerCase();

    const identity = typeof item.chain === "string" && item.chain.trim()
      ? `${item.chain.trim().toLowerCase()}:${addr}`
      : addr;

    const ts       = Number(item[tsField] ?? 0);
    const existing = map.get(identity);

    if (!existing) {
      map.set(identity, { ...item, _eventCount: 1 });
    } else if (ts >= Number(existing[tsField] ?? 0)) {
      map.set(identity, { ...item, _eventCount: existing._eventCount + 1 });
    } else {
      existing._eventCount += 1;
    }
  }

  return [...map.values()];
}
