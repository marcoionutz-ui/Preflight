/**
 * discovery/pricingInputs.ts — C1: helper PUR pentru race-ul stale-pricing-input (C3 reprice ↔ C2 enrich).
 *
 * Un reprice calculează pricing-ul din metadata (`baseToken/quoteToken/quoteStatus/baseDecimals/
 * quoteDecimals`) citită din `pair` ÎNAINTE de calcul. Dacă între timp enrich-ul a rescris altă metadata
 * (ex. `baseDecimals` de la null la valoarea corectă), pricing-ul rezultat e calculat din inputuri STALE
 * și NU trebuie aplicat — chiar dacă `pricedAt` e mai nou. CAS previne overwrite-ul unui blob stale, dar
 * NU aplicarea unui rezultat calculat din inputuri stale. Verificarea e aici, pură și testabilă izolat
 * (fără dependențele grele din pairRegistry.ts).
 */

// NB: `| null` pe quoteToken/decimals ca să fie asignabil din `IndexedPair` (care are exact aceste tipuri
// nullable) — altfel TS2345 la `pricingInputsMatch(pair, current)`. Comparațiile normalizează null/undefined.
export interface PricingInputsSnapshot {
  baseToken?:     string;
  quoteToken?:    string | null;
  quoteStatus?:   string;
  baseDecimals?:  number | null;
  quoteDecimals?: number | null;
}

/**
 * `true` dacă metadata-inputurile de pricing din `snapshot` (starea la momentul calculului) sunt încă
 * identice cu cele din `current` (starea din registry la momentul CAS). Normalizează opționalele:
 * `quoteToken`/`decimals` lipsă → `null`; `quoteStatus` lipsă → `"NO_KNOWN_QUOTE"`.
 */
export function pricingInputsMatch(snapshot: PricingInputsSnapshot, current: PricingInputsSnapshot): boolean {
  return current.baseToken === snapshot.baseToken
    && (current.quoteToken   ?? null) === (snapshot.quoteToken   ?? null)
    && (current.quoteStatus  ?? "NO_KNOWN_QUOTE") === (snapshot.quoteStatus ?? "NO_KNOWN_QUOTE")
    && (current.baseDecimals ?? null) === (snapshot.baseDecimals ?? null)
    && (current.quoteDecimals ?? null) === (snapshot.quoteDecimals ?? null);
}

/**
 * C1: `true` dacă enrich-ul TREBUIE să-și aplice pricing-ul (calculat din metadata SA proaspătă) peste cel
 * din registry. Regula (asimetrică față de reprice): dacă enrich SCHIMBĂ metadata-inputurile
 * (`snapshot` ≠ `current`), pricing-ul existent a fost calculat din inputuri acum-stale → înlocuiește-l
 * NECONDIȚIONAT (chiar dacă are `pricedAt` mai nou); dacă inputurile-s identice, aplică DOAR dacă e strict
 * mai nou. Enrich-ul poate face asta pt. că își scrie ȘI metadata ȘI pricing-ul din același calcul.
 */
export function shouldApplyComputedPricing(
  snapshot: PricingInputsSnapshot,
  current:  PricingInputsSnapshot & { pricedAt?: number },
  candidatePricedAt: number,
): boolean {
  return !pricingInputsMatch(snapshot, current)
    || candidatePricedAt > (current.pricedAt ?? 0);
}
