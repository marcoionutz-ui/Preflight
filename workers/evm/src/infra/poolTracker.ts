/**
 * infra/poolTracker.ts
 * Trackează câte pool-uri există per token — detectează clone fragmentation.
 */

import { BLUECHIP_SYMBOLS } from "../config/constants";
import { cleanEvmAddress } from "../sources/normalize";
import { memory } from "../state/stores";

// tokenAddress → Set<pairAddress>
export const tokenPools = new Map<string, Set<string>>();

export function tokenPoolKey(chain: string, tokenId: string): string {
  const clean = cleanEvmAddress(tokenId);
  if (clean) return `${chain}:${clean}`;
  const raw = tokenId.includes("_")
    ? tokenId.split("_").slice(1).join("_").toLowerCase()
    : tokenId.toLowerCase();
  return `${chain}:${raw}`;
}

export function trackPool(tokenAddress: string, pairAddress: string, chain: string): boolean {
  const sym = memory.get(chain, pairAddress)?.symbol?.trim().toLowerCase() ?? "";
  if (BLUECHIP_SYMBOLS.has(sym)) return false;
  const key   = tokenPoolKey(chain, tokenAddress);
  const known = tokenPools.get(key) ?? new Set<string>();
  const isNew = !known.has(pairAddress.toLowerCase());
  known.add(pairAddress.toLowerCase());
  tokenPools.set(key, known);
  return isNew && known.size > 1;
}
