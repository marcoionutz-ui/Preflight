/**
 * lib/redisArrays.ts
 * B4b: partiționarea array-urilor Redis pe chain (chei per-chain).
 * Fiecare item are `.chain`; scriem o cheie per-chain deținut de runtime (CHAINS),
 * inclusiv `[]` pentru chain-urile fără itemi → ownership curat (un worker per-chain
 * NU adoptă un chain străin, iar cheia lui goală suprascrie orice date stale).
 */

import { CHAINS } from "../config/chains";
import { normalizeChainId } from "@preflight/schema";

export function partitionArrayByChain<T extends { chain: string }>(
  keyFn: (chain: string) => string,
  items: readonly T[],
  maxPerChain?: number,
): Array<{ key: string; value: string }> {
  const byChain: Record<string, T[]> = {};
  for (const c of CHAINS) byChain[c.id] = [];
  for (const item of items) {
    const chain = normalizeChainId(item.chain);
    if (!chain || !(chain in byChain)) continue; // chain din afara runtime-ului → NU-l adoptăm
    byChain[chain].push(item);
  }
  // Limita se aplică PER-CHAIN (după partiție), nu global înainte — altfel un chain
  // aglomerat (primele N globale toate pe el) ar înfometa un chain liniștit → [].
  return CHAINS.map(c => ({
    key:   keyFn(c.id),
    value: JSON.stringify(maxPerChain === undefined ? byChain[c.id] : byChain[c.id].slice(0, maxPerChain)),
  }));
}
