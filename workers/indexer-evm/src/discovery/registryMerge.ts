/**
 * discovery/registryMerge.ts — P1-2/P1-3 (indexer-evm): mutațiile CAS pentru scrierile de metadata/preț.
 *
 * `pairRegistry.ts` scria enrichment (linia ~171) și reprice (linia ~296) cu `r.set(...)` NECONDIȚIONAT —
 * un GET→modify→SET neatomic. Între GET și SET un alt writer (enrich ↔ reprice) putea rescrie blob-ul, iar
 * SET-ul îl clobber-uia → repricing vechi suprascria metadata nouă; enrichment lent rescria un preț mai
 * recent; regresii `pricedAt`/`priceStatus`/`quotePriceSource` (P1-3). Fix: `casUpdateJson` (compare-and-swap
 * Lua din `registryWrite.ts`) + aceste două funcții PURE care decid ce se scrie peste starea CURENTĂ din
 * registry (nu peste snapshotul stale citit înainte de calcul). Identic ca doctrină cu C1 pe Solana; pure →
 * testabile izolat (leaf), fără dependențele grele din `pairRegistry.ts` (import type strip-uit de tsx).
 */

import type { IndexedPair, PricingFields, MetadataFields } from "./pairRegistry";
import {
  pricingInputsMatch, shouldApplyComputedPricing, type PricingInputsSnapshot,
} from "./pricingInputs";

/**
 * P1-3 (reprice): mutația CAS pentru re-pricing. `snapshot` = inputurile de metadata din care s-a CALCULAT
 * `pricing` (citite din `pair` ÎNAINTE de calcul). Aplică pricing-ul peste starea CURENTĂ din registry DOAR
 * dacă:
 *   (a) inputurile de metadata sunt încă identice — altfel enrich-ul a rescris metadata sub noi și pricing-ul
 *       nostru e calculat din inputuri STALE (chiar dacă `pricedAt` e mai nou) → NU aplica; ȘI
 *   (b) candidatul e STRICT mai nou decât ce e în registry — idempotent / nu retrograda.
 * Întoarce `null` (skip / no-op CAS) când nu trebuie scris. Merge-ul e pe `current`, NU pe `pair` stale.
 */
export function buildRepriceMutation(
  current:  IndexedPair,
  snapshot: PricingInputsSnapshot,
  pricing:  PricingFields,
): IndexedPair | null {
  if (!pricingInputsMatch(snapshot, current)) return null;      // enrich a schimbat inputurile → pricing stale
  if (pricing.pricedAt <= (current.pricedAt ?? 0)) return null; // mai vechi sau egal → idempotent skip
  return { ...current, ...pricing };
}

/**
 * P1-2 (enrichment write): mutația CAS pentru enrichment. Enrich-ul tocmai a fetch-uit metadata proaspătă,
 * deci o aplică ÎNTOTDEAUNA peste `current` (simboluri/decimals/status sunt autoritative — enrich e single-flight
 * pe pereche via claim-ul atomic al cozii). Pricing-ul (calculat din ACEEAȘI metadata) se aplică doar dacă
 * `shouldApplyComputedPricing`: inputurile diferă de `current` (enrich SCHIMBĂ metadata → pricing-ul vechi,
 * calculat din inputuri acum-stale, trebuie invalidat necondiționat) SAU e strict mai nou. Astfel un reprice
 * concurent cu `pricedAt` mai nou pe ACELEAȘI inputuri nu e retrogradat.
 */
export function buildEnrichMutation(
  current:  IndexedPair,
  metadata: MetadataFields,
  pricing:  PricingFields,
  snapshot: PricingInputsSnapshot,
): IndexedPair {
  const applyPricing = shouldApplyComputedPricing(snapshot, current, pricing.pricedAt);
  return applyPricing
    ? { ...current, ...metadata, ...pricing }
    : { ...current, ...metadata };
}

/**
 * P1-3 (lifecycle coadă): outcome-ul cozii de enrichment TREBUIE decis din recordul EFECTIV persistat de CAS
 * (mutația câștigătoare returnată de `buildEnrichMutation`), NU din candidatul calculat înaintea cursei — altfel
 * un record STALE păstrat (candidat mai vechi ca current) e marcat DONE, iar un record OK păstrat (candidat mai
 * stale ca current) e retry-uit inutil. Servabil ⇔ `priceStatus` persistat === "OK"; fail-closed (retry) dacă
 * `priceStatus` lipsește (record persistat indeterminabil).
 */
export function isEnrichServable(persisted: Pick<IndexedPair, "priceStatus">): boolean {
  return persisted.priceStatus === "OK";
}
