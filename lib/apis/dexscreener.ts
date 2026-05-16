import type { Pair } from "@/types";

const BASE = "https://api.dexscreener.com";

export async function searchToken(query: string): Promise<Pair | null> {
  const url = query.startsWith("0x") || query.length > 30
    ? `${BASE}/latest/dex/tokens/${query}`
    : `${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, { next: { revalidate: 0 } });
  const data = await res.json();
  const pairs: Pair[] = data.pairs ?? [];

  return pairs.sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
  )[0] ?? null;
}
