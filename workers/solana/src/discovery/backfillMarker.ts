/**
 * discovery/backfillMarker.ts — P1-5 (fix review cgpt R2): decizia PURĂ de scriere a markerului de backfill.
 *
 * PROBLEMA: `runCpmmBackfill` scrie fiecare pool cu `writeSolanaPool` apoi scrie un MARKER Redis; markerul
 * face backfill-ul să ruleze o singură dată per versiune. `writeSolanaPool` face acum enqueue de enrichment
 * AWAITED (P1-5): dacă insertul reușește dar enqueue-ul aruncă (Redis blip), writer-ul întoarce "error" →
 * pool-ul rămâne PENDING FĂRĂ job de enrichment. Spre deosebire de discovery queue, backfill-ul NU are
 * redelivery — deci dacă am scrie markerul, backfill-ul nu ar mai rula, iar pool-ul ar rămâne veșnic PENDING.
 *
 * FIX: dacă ORICE `writeSolanaPool` a întors "error", NU scriem markerul. Următorul startup re-rulează
 * backfill-ul → insertul e idempotent (writeSolanaPool → "exists") → RE-enqueue (writeSolanaPool
 * enqueue-uiește pe „exists" tot). Astfel backfill-ul capătă aceeași reconciliere durabilă ca discovery.
 *
 * NB: NUMĂRĂM doar erorile de SCRIERE (writeSolanaPool === "error"), NU și erorile de PARSE (account
 * malformat) — un parse error e permanent (re-rularea nu-l repară) și nu lasă un pool PENDING orfan, deci
 * nu trebuie să blocheze markerul la infinit.
 */

/**
 * `"skip"` → NU scrie markerul (au fost erori de scriere → backfill se re-rulează pt. reconciliere).
 * `"write"` → scrie markerul (toate scrierile au reușit → backfill complet pt. această versiune).
 */
export function backfillMarkerDecision(writeErrors: number): "write" | "skip" {
  return writeErrors > 0 ? "skip" : "write";
}
