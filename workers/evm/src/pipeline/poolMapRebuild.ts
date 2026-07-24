/**
 * pipeline/poolMapRebuild.ts — D5: helpere PURE pentru rebuild-ul hărților de pool V3/V4.
 *
 * BUG-ul reparat (routing): `rebuildPoolMaps` (scan.ts) reconstruia `v3PoolMap`/`v4PoolMap` DOAR din
 * scanul curent — ștergea intrările de pe chain-urile scanate, apoi re-adăuga doar pool-urile scanului.
 * Un pool încă URMĂRIT (`activeWatch`/`hot`/`armed`) căzut din scan era ȘTERS → `manager.ts` nu-l mai
 * găsea la un swap WS (`get()` = undefined → drop, fără fallback) → **flow ZERO pe un pool urmărit**;
 * `subscriptions.ts` îl ruta greșit ca V2. Fix: PĂSTREAZĂ intrarea pool-ului urmărit chiar dacă a căzut.
 *
 * BUG-ul secundar (review varu — snapshot de piață stale): `v3/v4PoolMap` țin ÎNTREG `SourcePool`, deci
 * și date de PIAȚĂ (priceUsd, priceChange m5/h1/h24, reserveUsd, volumeUsd24h, transactions) — NU doar
 * metadata imuabilă (dexType/tokeni/quote). `hot.ts` folosește pool-ul din hartă pt. `quickEdgeScore`;
 * dacă păstrăm intrarea stale, scoringul ar judeca piața cu poza veche → qualified signals greșite.
 * Fix: marchează intrările păstrate drept „routing-only" (`routingOnlyPools`); rutarea WS le folosește
 * (are nevoie doar de tip + tokeni, imuabile), dar scoringul le IGNORĂ și cere un snapshot proaspăt.
 *
 * Metadata pool-ului e imuabilă pe adresă → intrarea stale e corectă pt. RUTARE. Datele de piață NU sunt
 * → routing-only le scoate din scoring. Module PURE (fără PairMap/Redis/scan) → deciziile testabile izolat.
 */

export interface ScopedPoolKey {
  chain:   string;
  address: string;
}

export interface PoolMapRebuildPlan {
  /** chei de pe un chain scanat → șterge. Include: neurmăritele absente + TOATE cele prezente în scan
   *  (bucla de re-add restaurează doar pe cele ELIGIBILE; cele prezente-dar-neeligibile rămân șterse —
   *  „mi-a zis că nu mai e V3/V4" trebuie crezut). */
  toDelete:      ScopedPoolKey[];
  /** chei de pe un chain scanat, ABSENTE din scan ȘI încă urmărite → păstrează, marchează routing-only
   *  (metadata stale, fără scoring). Markerul se curăță la reapariția în scan (bucla re-add). */
  toMarkRouting: ScopedPoolKey[];
}

/**
 * Partiționează cheile EXISTENTE ale unei hărți de pool. NU atinge cheile de pe chain-uri neprezente în
 * scan (nu le-am rescanat → n-avem verdict). Pe un chain scanat:
 *   - ABSENT din scan + urmărit    → păstrează routing-only (`toMarkRouting`);
 *   - ABSENT din scan + neurmărit  → șterge;
 *   - PREZENT în scan (elig. sau nu)→ șterge (re-add-ul restaurează doar eligibilele, fresh).
 *
 * `seenInScan(chain, addr)` = adresa a apărut în scanul curent (indiferent de tip/eligibilitate) —
 * distinge „a dispărut din scan" (conservă) de „a apărut și s-a reclasificat" (crede scanul). Fără el,
 * un pool V3 urmărit care reapare ca V2 ar rămâne în harta V3 (rutare greșită), chiar dacă re-add-ul îl sare.
 */
export function planPoolMapRebuild(
  existing: Iterable<ScopedPoolKey>,
  scanChains: ReadonlySet<string>,
  seenInScan: (chain: string, address: string) => boolean,
  isWatched: (chain: string, address: string) => boolean,
): PoolMapRebuildPlan {
  const toDelete: ScopedPoolKey[] = [];
  const toMarkRouting: ScopedPoolKey[] = [];
  for (const { chain, address } of existing) {
    if (!scanChains.has(chain)) continue;                       // chain nescanat → nu atinge
    if (!seenInScan(chain, address) && isWatched(chain, address)) {
      toMarkRouting.push({ chain, address });                   // absent + urmărit → păstrează routing-only
    } else {
      toDelete.push({ chain, address });                        // prezent (orice tip) SAU neurmărit → șterge
    }
  }
  return { toDelete, toMarkRouting };
}

/**
 * D5: alege sursa pool-ului pentru SCORING. Dacă intrarea din hartă e „routing-only" (păstrată stale
 * doar pt. rutarea WS), NU o folosi la scoring — întoarce `undefined` ca să forțeze call-site-ul să
 * ceară un snapshot proaspăt (`fetchPoolByAddress`). Altfel, cache-ul e din scanul curent → e proaspăt.
 */
export function poolSnapshotForScoring<P>(cached: P | undefined, isRoutingOnly: boolean): P | undefined {
  return isRoutingOnly ? undefined : cached;
}
