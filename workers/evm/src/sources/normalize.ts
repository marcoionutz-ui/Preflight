/**
 * sources/normalize.ts
 * Transformă raw Gecko API response → SourcePool normalizat.
 * Nimeni din afara sources/ nu ar trebui să vadă raw Gecko attributes.
 */

import type { ChainConfig } from "../config/chains";
import { BLOCKED_SYMBOLS } from "../config/constants";
import { V3_DEXES } from "../config/constants";
import type { DiscoverySource, ReserveSource } from "@preflight/schema";
import { isV4PoolAddress } from "../ws/v4Hooks";

export type DexType = "V2" | "V3" | "V4" | "UNKNOWN";

/** Sursa prețului quote token — oglindă a QuotePriceSource din indexer-evm. */
export type QuotePriceSource = "STATIC_STABLE" | "CHAINLINK" | "ENV_FALLBACK" | "UNKNOWN";

export interface SourcePool {
  // Identity
  chain:        string;
  pairAddress:  string;
  tokenAddress: string;
  symbol:       string;
  dexType:      DexType;
  dexId:        string;
  // NF1: V4 hooks (tri-stare) — `string` custom hook / `null` vanilla (zero-address) / `undefined` indisponibil
  // (non-V4 sau sursă fără info hook, ex. Gecko). Vezi normalizeHooks + flowCoverageForPool (ws/v4Hooks.ts).
  hooks?:       string | null;
  // Discovery provenance
  discoverySource?: DiscoverySource;
  // 6.11: quote price transparency (prezent doar pentru INDEXER source)
  quotePriceSource?: QuotePriceSource;
  quotePriceAgeSec?: number;

  // Price
  priceUsd: number;
  priceChange: {
    m5:  number;
    h1:  number;
    h24: number;
  };

  // Liquidity
  reserveUsd: number;
  // NF/U5: proveniența lui `reserveUsd`. Doar `V4_STATE_LIQUIDITY` (din INDEXER) e un ESTIMAT care poate
  // supraestima (virtual reserves); Gecko/DexScreener raportează lichiditate reală → GECKO_REPORTED/DEXSCREENER_REPORTED;
  // INDEXER V2/V3 = rezerve reale on-chain. Propagat prin poolLiquidity → getLiquidityContext → pair_states.
  reserveSource?: ReserveSource;
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

/**
 * E19: rezultat DISCRIMINAT al unui fetch de pool după adresă. Distinge „chiar nu există" (`not_found`)
 * de un eșec TRANZITORIU (`error` — 429/5xx/timeout/network) care NU e dovadă că pair-ul e mort. Callerii
 * (ex. follow-list refresh, E19) NU trebuie să evicteze o pereche pe un `error`.
 */
export type PoolFetchOutcome =
  | { status: "found"; pool: SourcePool }
  | { status: "not_found" }
  | { status: "error" };

/**
 * E19: mapează un status HTTP la o clasă de outcome, FAIL-CLOSED pe absență. Doar `2xx` = răspuns valid
 * (`ok`) și doar `404`/`410` = dovadă explicită că pool-ul nu există (`not_found`). ORICE alt non-2xx —
 * `401/403/408/425/429/5xx` sau `0` (network/timeout) — e `error` TRANZITORIU: nu tratăm auth/config/timeout
 * drept „pool mort", altfel un burst de astfel de răspunsuri ar evacua fals perechi vii din follow-list.
 */
export function classifyPoolFetchHttpStatus(status: number): "ok" | "not_found" | "error" {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 410) return "not_found";
  return "error";
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

  // V4: poolId = bytes32 (0x + 64 hex) — pe ORICE chain, nu doar Base (fix NF1 varu: înainte `chain.id==="base"`
  // rata V4 pe arbitrum/ethereum → clasificat V2). Gecko nu furnizează `hooks` → rămâne `undefined` (indisponibil).
  const isV4 = isV4PoolAddress(addr);
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
    reserveSource: "GECKO_REPORTED", // NF/U5: reserve_in_usd raportat de Gecko — reală, nu estimat V4
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