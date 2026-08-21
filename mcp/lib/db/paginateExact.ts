/**
 * lib/db/paginateExact.ts — PH-2a (paginare stabilă + count exact, cu I/O INJECTAT). Testabil izolat în tsx.
 *
 * Extras din inspector ca să putem testa PAGINAREA EFECTIVĂ (cgpt slice3 #4), nu doar verdictul:
 *  - aduce toate rândurile în pagini de `pageSize`, până când o pagină vine incompletă;
 *  - `present=false` DOAR dacă tabelul lipsește (42P01 / „does not exist”) — la HEAD SAU la orice pagină
 *    (tabelul poate dispărea între HEAD și citire → tot present=false, fail-closed în amonte);
 *  - orice ALTĂ eroare ARUNCĂ (nu se maschează drept „fără date”).
 * NU verifică `fetched === expected` — asta e treaba verdictului (îi întoarce ambele numere).
 */

export interface PgError { code?: string; message?: string; }
export interface PageFetcher {
  /** HEAD cu count exact — fără rânduri. */
  headCount(): Promise<{ count: number | null; error: PgError | null }>;
  /** o pagină [from, to] inclusiv, ordine stabilă. */
  fetchRange(from: number, to: number): Promise<{ data: unknown[] | null; error: PgError | null }>;
}

const UNDEFINED_TABLE = "42P01";
export function isMissingTable(err: PgError | null | undefined): boolean {
  if (!err) return false;
  if (err.code === UNDEFINED_TABLE) return true;
  return typeof err.message === "string" && /does not exist|could not find the table/i.test(err.message);
}

export interface PaginateResult<T> { rows: T[]; expected: number; present: boolean; }

export async function paginateExact<T>(f: PageFetcher, pageSize: number, label = "tabel"): Promise<PaginateResult<T>> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error(`pageSize invalid pentru ${label}: ${pageSize}`);

  const head = await f.headCount();
  if (head.error) {
    if (isMissingTable(head.error)) return { rows: [], expected: 0, present: false };
    throw new Error(`count ${label} eșuat: ${head.error.message}`);
  }
  // fail-closed: un count exact NECUNOSCUT (null fără eroare) NU e 0 — nu putem verifica integritatea paginării.
  if (!Number.isInteger(head.count)) throw new Error(`count ${label} necunoscut (count=null fără eroare) — fail-closed`);
  const expected = head.count as number;

  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await f.fetchRange(from, from + pageSize - 1);
    if (error) {
      if (isMissingTable(error)) return { rows: [], expected: 0, present: false }; // dispărut între HEAD și citire
      throw new Error(`citire pagină ${label} eșuată: ${error.message}`);
    }
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { rows, expected, present: true };
}
