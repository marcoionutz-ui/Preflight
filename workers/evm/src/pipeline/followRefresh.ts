/**
 * pipeline/followRefresh.ts — E19 (429/5xx nu trebuie să evicteze perechi vii din follow-list).
 *
 * Bug: bucla de follow-refresh trata ORICE `pool == null` de la fetch (Gecko + DexScreener) ca „miss" →
 * incrementa `missCount` și, la FOLLOW_MAX_MISSES, ștergea perechea din `marketFollowList`. Dar `null` acoperea
 * și eșecuri TRANZITORII (429 rate-limit, 5xx, timeout, network). Sub un burst de 429 (exact când suntem rate-
 * limited pe toate sursele), perechi perfect vii — inclusiv AGENT_SUPPLIED — erau evacuate pe baza unor erori
 * care nu spun nimic despre viața pair-ului.
 *
 * Fix: fetch-urile propagă acum un STATUS discriminat (`PoolFetchOutcome`). `error` (tranzitoriu) NU mai e
 * dovadă de „mort". `resolveFollowMiss` decide pur: pe eroare tranzitorie → `skip` (nu atinge missCount, nu
 * evictă); doar un `not_found` real incrementează, iar la prag → `evict`. FOLLOW_TTL_MS rămâne backstop-ul care
 * evacuează perechile GENUIN moarte chiar dacă erorile tranzitorii țin missCount pe loc.
 */

export type FollowMissAction =
  | { action: "skip" }                       // eroare tranzitorie — nu atinge missCount, nu evictă
  | { action: "increment"; missCount: number } // not_found real — încă sub prag
  | { action: "evict" };                     // not_found real — a atins pragul

/**
 * Decide ce se întâmplă cu o pereche din follow-list când fetch-ul NU a întors un pool.
 *
 * @param entry            intrarea curentă (are `missCount` opțional).
 * @param transientError   true dacă vreo sursă a raportat un eșec tranzitoriu (429/5xx/timeout/network).
 * @param maxMisses        pragul de evacuare (FOLLOW_MAX_MISSES).
 *
 * Pe `transientError` → `skip` INDIFERENT de missCount: o eroare tranzitorie nu e dovadă că pair-ul e mort,
 * deci nu-l penalizăm. Doar un `not_found` real (transientError=false) avansează missCount și, la prag, evictă.
 */
export function resolveFollowMiss(
  entry: { missCount?: number },
  transientError: boolean,
  maxMisses: number,
): FollowMissAction {
  if (transientError) return { action: "skip" };
  const missCount = (entry.missCount ?? 0) + 1;
  return missCount >= maxMisses ? { action: "evict" } : { action: "increment", missCount };
}
