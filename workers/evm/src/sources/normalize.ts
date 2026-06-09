/**
 * sources/normalize.ts
 * Transformă raw Gecko API response → SourcePool normalizat.
 * Nimeni din afara sources/ nu ar trebui să vadă raw Gecko attributes.
 */

import type { ChainConfig } from "../config/chains";
import { BLOCKED_SYMBOLS } from "../config/constants";
import { V3_DEXES } from "../config/constants";

export type DexType = "V2" | "V3" | "V4" | "UNKNOWN";

export interface SourcePool {
  // Identity
  chain:        string;
  pairAddress:  string;
  tokenAddress: string;
  symbol:       string;
  dexType:      DexType;
  dexId:        string;

  // Price
  priceUsd: number;
  priceChange: {
    m5:  number;
    h1:  number;
    h24: number;
  };

  // Liquidity
  reserveUsd: number;
  volumeUsd24h: number;

  // On-chain transactions (Gecko snapshot, nu WS)
  transactions: {
    buys5m:  number;
    sells5m: number;
    buys1h:  number;
    sells1h: number;
  };

  // Internal chain reference (pentru WS subscriptions)
  _chain: ChainConfig;

  // Raw păstrat pentru cazuri edge — nu folosit în pipeline logic
  _raw: unknown;
}

export function cleanEvmAddress(addr: string | undefined | null): string | null {
  if (!addr) return null;
  const raw = addr.toLowerCase().trim();
  const cleaned = raw.includes("_")
    ? raw.split("_").pop()!
    : raw.includes(":")
      ? raw.split(":").pop()!
      : raw;
  return /^0x[a-f0-9]{40}$/.test(cleaned) ? cleaned : null;
}

export function isEvmAddress(addr: string | undefined | null): boolean {
  return cleanEvmAddress(addr) !== null;
}

export function isBlockedSymbol(symbol: string): boolean {
  return BLOCKED_SYMBOLS.has(symbol.trim().toLowerCase());
}

export function normalizePool(raw: any, chain: ChainConfig): SourcePool | null {
  const addr = raw.attributes?.address;
  if (!addr) return null;

  const symbol = raw.attributes?.name?.split("/")[0]?.trim() ?? "?";
  if (isBlockedSymbol(symbol)) return null;

  const pairAddress  = addr.toLowerCase();
  const tokenId      = raw.relationships?.base_token?.data?.id ?? "";
  const tokenAddress = cleanEvmAddress(tokenId) ?? tokenId.toLowerCase();
  const dexId        = raw.relationships?.dex?.data?.id ?? "";

  // V4: Base chain, non-EVM address (length 66 = 0x + 64 hex)
  const isV4 = chain.id === "base" && cleanEvmAddress(addr) === null;
  // V3: standard EVM address + known V3 dex id
  const isV3 = !isV4 && cleanEvmAddress(addr) !== null && V3_DEXES.has(dexId);
  const dexType: DexType = isV4 ? "V4" : isV3 ? "V3" : "V2";

  return {
    chain:        chain.id,
    pairAddress,
    tokenAddress,
    symbol,
    dexType,
    dexId,
    priceUsd:    Number(raw.attributes?.base_token_price_usd ?? 0),
    priceChange: {
      m5:  Number(raw.attributes?.price_change_percentage?.m5  ?? 0),
      h1:  Number(raw.attributes?.price_change_percentage?.h1  ?? 0),
      h24: Number(raw.attributes?.price_change_percentage?.h24 ?? 0),
    },
    reserveUsd:   Number(raw.attributes?.reserve_in_usd ?? 0),
    volumeUsd24h: Number(raw.attributes?.volume_usd?.h24 ?? 0),
    transactions: {
      buys5m:  raw.attributes?.transactions?.m5?.buys  ?? 0,
      sells5m: raw.attributes?.transactions?.m5?.sells ?? 0,
      buys1h:  raw.attributes?.transactions?.h1?.buys  ?? 0,
      sells1h: raw.attributes?.transactions?.h1?.sells ?? 0,
    },
    _chain: chain,
    _raw:   raw,
  };
}