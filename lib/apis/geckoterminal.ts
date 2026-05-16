import type { Pair, GeckoPool, OHLCVCandle } from "@/types";

const BASE = "/api/proxy/gecko";
const HEADERS = {};

export async function getTrendingPools(network: string): Promise<Pair[]> {
  try {
    const res = await fetch(`${BASE}?path=networks/${network}/trending_pools?page=1`, { headers: HEADERS });
    const data = await res.json();
    return ((data.data as GeckoPool[]) ?? []).map(geckoToDisplay);
  } catch {
    return [];
  }
}

export async function getNewPools(network: string): Promise<GeckoPool[]> {
  try {
    const res = await fetch(`${BASE}?path=networks/${network}/new_pools?page=1`, { headers: HEADERS });
    const data = await res.json();
    return (data.data as GeckoPool[]) ?? [];
  } catch {
    return [];
  }
}

export async function getOHLCV(network: string, poolAddress: string): Promise<OHLCVCandle[]> {
  try {
    const res = await fetch(
      `${BASE}?path=${encodeURIComponent(`networks/${network}/pools/${poolAddress}/ohlcv/hour?limit=48`)}`,
      { headers: HEADERS }
    );
    const data = await res.json();
    const raw: number[][] = data.data?.attributes?.ohlcv_list ?? [];
    return raw.map(([t, o, h, l, c, v]) => ({
      time: new Date(t * 1000).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
      open: o, high: h, low: l, close: c, volume: v,
    }));
  } catch {
    return [];
  }
}

// GeckoTerminal network IDs → our internal ChainId
const GECKO_NETWORK_TO_CHAIN: Record<string, string> = {
  eth:      "ethereum",
  bsc:      "bsc",
  base:     "base",
  solana:   "solana",
  arbitrum: "arbitrum",
};

export function geckoToDisplay(pool: GeckoPool): Pair {
  const a = pool.attributes ?? {};
  const [baseName] = (a.name ?? "? / ?").split(" / ");
  const geckoNetworkId = pool.relationships?.network?.data?.id ?? "base";
  const chainId = GECKO_NETWORK_TO_CHAIN[geckoNetworkId] ?? geckoNetworkId;

  // Token address: GeckoTerminal stores it in relationships.base_token.data.id
  // Format: "base_0xabc..." or "solana_XYZ..." — strip the network prefix
  const baseTokenRelId =
    (pool.relationships as any)?.base_token?.data?.id ??
    a.base_token_id ??
    "";
  const tokenAddress = baseTokenRelId.includes("_")
    ? baseTokenRelId.split("_").slice(1).join("_")
    : baseTokenRelId;

  return {
    _gecko: true,
    pairAddress: a.address ?? pool.id,
    chainId,
    dexId: `gecko:${geckoNetworkId}`,
    baseToken: { symbol: baseName, name: baseName, address: tokenAddress },
    quoteToken: { symbol: "?", name: "?", address: "" },
    priceUsd: Number(a.base_token_price_usd ?? 0),
    priceChange: {
      m5:  Number(a.price_change_percentage?.m5  ?? 0),
      h1:  Number(a.price_change_percentage?.h1  ?? 0),
      h24: Number(a.price_change_percentage?.h24 ?? 0),
    },
    volume: {
      h24: Number(a.volume_usd?.h24 ?? 0),
      h1:  Number(a.volume_usd?.h1  ?? 0),
      m5:  Number(a.volume_usd?.m5  ?? 0),
    },
    liquidity: { usd: Number(a.reserve_in_usd ?? 0) },
    marketCap: Number(a.market_cap_usd ?? 0),
    fdv: 0,
    txns: {
      m5:  { buys: Number(a.transactions?.m5?.buys  ?? 0), sells: Number(a.transactions?.m5?.sells  ?? 0) },
      h1:  { buys: Number(a.transactions?.h1?.buys  ?? 0), sells: Number(a.transactions?.h1?.sells  ?? 0) },
      h24: { buys: Number(a.transactions?.h24?.buys ?? 0), sells: Number(a.transactions?.h24?.sells ?? 0) },
    },
    pairCreatedAt: a.pool_created_at ? new Date(a.pool_created_at).getTime() : undefined,
  };
}