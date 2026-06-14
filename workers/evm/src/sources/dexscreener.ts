/**
 * sources/dexscreener.ts
 * DexScreener API — fallback source pentru follow refresh.
 * Folosit când Gecko fetchPoolByAddress eșuează (ex: V4 poolIds).
 * Rate limit: 300 req/min pentru pair/token lookup endpoints.
 */

import type { ChainConfig } from "../config/chains";
import type { DexType, SourcePool } from "./normalize";
import { cleanEvmAddress, isBlockedSymbol } from "./normalize";
import { V3_DEXES } from "../config/constants";

const DS_API    = "https://api.dexscreener.com";
const DS_LATEST = `${DS_API}/latest/dex`;

async function dsGet(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function dsGetWithStatus(url: string): Promise<{ status: number; data: any | null }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return { status: res.status, data: null };
    return { status: res.status, data: await res.json() };
  } catch {
    return { status: 0, data: null };
  }
}

function normalizeDsPair(raw: any, chain: ChainConfig): SourcePool | null {
  const pairAddressRaw = String(raw?.pairAddress ?? "").toLowerCase();
  if (!pairAddressRaw) return null;

  const priceUsd = Number(raw.priceUsd ?? 0);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const symbol = String(raw.baseToken?.symbol ?? "?").trim();
  if (!symbol || isBlockedSymbol(symbol)) return null;

  const tokenAddress =
    cleanEvmAddress(raw.baseToken?.address) ??
    String(raw.baseToken?.address ?? "").toLowerCase();

  const dexId = String(raw.dexId ?? "unknown");

  const isV4 = chain.id === "base" && /^0x[a-f0-9]{64}$/.test(pairAddressRaw);
  const isV3 = !isV4 && cleanEvmAddress(pairAddressRaw) !== null && V3_DEXES.has(dexId);
  const dexType: DexType = isV4 ? "V4" : isV3 ? "V3" : "V2";

  return {
    chain:       chain.id,
    pairAddress: pairAddressRaw,
    tokenAddress,
    symbol,
    dexType,
    dexId,
    priceUsd,
    priceChange: {
      m5:  Number(raw.priceChange?.m5  ?? 0),
      h1:  Number(raw.priceChange?.h1  ?? 0),
      h24: Number(raw.priceChange?.h24 ?? 0),
    },
    reserveUsd:   Number(raw.liquidity?.usd ?? 0),
    volumeUsd24h: Number(raw.volume?.h24    ?? 0),
    transactions: {
      buys5m:  Number(raw.txns?.m5?.buys  ?? 0),
      sells5m: Number(raw.txns?.m5?.sells ?? 0),
      buys1h:  Number(raw.txns?.h1?.buys  ?? 0),
      sells1h: Number(raw.txns?.h1?.sells ?? 0),
    },
    _chain: chain,
    _raw:   raw,
  };
}

/**
 * Fetch pair by pair address — primary DexScreener lookup.
 * Fallback pentru când Gecko fetchPoolByAddress eșuează.
 */
export async function fetchDsPairByAddress(
  chain:       ChainConfig,
  pairAddress: string,
): Promise<SourcePool | null> {
  const data = await dsGet(`${DS_LATEST}/pairs/${chain.id}/${pairAddress}`);
  const pair = data?.pairs?.[0] ?? null;
  if (!pair) return null;
  return normalizeDsPair(pair, chain);
}

/**
 * Fetch pairs by token address — fallback dacă pair lookup eșuează.
 * Util pentru V4 poolIds care nu sunt pair addresses standard.
 */
export async function fetchDsTokenPairs(
  chain:        ChainConfig,
  tokenAddress: string,
): Promise<SourcePool[]> {
  const data = await dsGet(`${DS_API}/token-pairs/v1/${chain.id}/${tokenAddress}`);
  const pairs: any[] = Array.isArray(data) ? data : (data?.pairs ?? []);
  return pairs
    .filter(p => p?.chainId === chain.id)
    .map(p => normalizeDsPair(p, chain))
    .filter((p): p is SourcePool => p !== null)
    .slice(0, 5);
}

export async function fetchDsBoostedTokens(
  allowedChainIds: Set<string>,
): Promise<{
  status: number;
  tokens: Array<{ chainId: string; tokenAddress: string; pairAddress?: string }>;
}> {
  const { status, data } = await dsGetWithStatus(`${DS_API}/token-boosts/v1/latest`);
  if (!Array.isArray(data)) return { status, tokens: [] };

  const tokens: Array<{ chainId: string; tokenAddress: string; pairAddress?: string }> = [];

  for (const item of data) {
    const chainId = String(item?.chainId ?? "").toLowerCase();
    if (!allowedChainIds.has(chainId)) continue;

    const tokenAddress = cleanEvmAddress(item?.tokenAddress);
    if (!tokenAddress) continue;

    const lastUrlPart = String(item?.url ?? "").split("/").pop()?.toLowerCase();
    const pairAddress =
      cleanEvmAddress(lastUrlPart) ??
      (/^0x[a-f0-9]{64}$/.test(lastUrlPart ?? "") ? lastUrlPart : undefined);

    tokens.push({ chainId, tokenAddress, pairAddress });
  }

  return { status, tokens };
}