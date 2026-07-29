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

/**
 * E20 (Confirmed · Intern L6/M5-mem): prune al stării AUXILIARE pentru un pair scos din `memory`.
 * `watchedPoolCache` (SourcePool per pair, `stores.ts`) și `tokenPools` (Set<pair> per token, aici)
 * creșteau NEMĂRGINIT — `pruneMemory` ștergea doar memory/poolLiquidity/wsFlow/lpEvents, nu și astea →
 * leak RSS lent. Apelat din blocul de delete al lui `pruneMemory`. Maps INJECTATE → testabil izolat.
 *   - `watchedCache`: cheiat pe pair (PairMap) → delete direct (pairKey normalizează, ca memory.delete).
 *   - `tokenPools`: Set<pair> per token → scoate pair-ul (lowercase, cum îl stochează trackPool); dacă
 *     set-ul rămâne gol → șterge cheia token-ului (altfel un token cu toate pool-urile pruned ar persista).
 */
export function prunePairFromAuxState(
  chain: string,
  tokenAddress: string,
  pairAddress: string,
  watchedCache: { delete(chain: string, address: string): boolean },
  tokenPoolsMap: Map<string, Set<string>>,
): void {
  watchedCache.delete(chain, pairAddress);

  const key = tokenPoolKey(chain, tokenAddress);
  const set = tokenPoolsMap.get(key);
  if (!set) return;
  set.delete(pairAddress.toLowerCase());
  if (set.size === 0) tokenPoolsMap.delete(key);
}
