/**
 * lib/db/paginateExact.test.ts — PH-2a GUARD (paginare efectivă, I/O injectat).
 */
import { paginateExact, isMissingTable, type PageFetcher } from "./paginateExact";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

/** Fetcher in-memory peste un dataset; poate injecta erori pe HEAD sau pe a N-a pagină. */
function makeFetcher(rows: unknown[] | null, opts: { headErr?: { code?: string; message?: string }; headCountNull?: boolean; errOnCall?: number; err?: { code?: string; message?: string } } = {}): { f: PageFetcher; rangeCalls: () => number } {
  let calls = 0;
  const f: PageFetcher = {
    async headCount() {
      if (opts.headErr) return { count: null, error: opts.headErr };
      if (opts.headCountNull) return { count: null, error: null };   // count necunoscut, fără eroare
      return { count: (rows ?? []).length, error: null };
    },
    async fetchRange(from, to) {
      calls++;
      if (opts.errOnCall && calls === opts.errOnCall) return { data: null, error: opts.err ?? { message: "boom" } };
      return { data: (rows ?? []).slice(from, to + 1), error: null };
    },
  };
  return { f, rangeCalls: () => calls };
}

async function main(): Promise<void> {
console.log("PH-2a — paginateExact (I/O injectat)");

// ── isMissingTable ────────────────────────────────────────────────────────────
check("1. 42P01 → missing", isMissingTable({ code: "42P01" }) === true);
check("2. mesaj does not exist → missing", isMissingTable({ message: 'relation "x" does not exist' }) === true);
check("3. altă eroare → NU missing", isMissingTable({ code: "42501", message: "permission denied" }) === false);

// ── happy: o pagină ───────────────────────────────────────────────────────────
{
  const { f } = makeFetcher([1, 2, 3]);
  const r = await paginateExact<number>(f, 1000);
  check("4. ⭐ 3 rânduri, o pagină → present, expected=3, rows=3", r.present && r.expected === 3 && r.rows.length === 3);
}

// ── ⭐⭐⭐ 1001 rânduri în două pagini (cgpt slice3 #4) ─────────────────────────
{
  const data = Array.from({ length: 1001 }, (_, i) => i);
  const { f, rangeCalls } = makeFetcher(data);
  const r = await paginateExact<number>(f, 1000);
  check("5. ⭐⭐⭐ 1001 rânduri → aduse toate (2 pagini)", r.rows.length === 1001 && r.expected === 1001);
  check("6. ⭐⭐ a făcut 2 apeluri de range (nu s-a oprit la 1000)", rangeCalls() === 2);
}
// exact la limită: 1000 → 2 pagini (a doua goală) ca să detecteze finalul
{
  const data = Array.from({ length: 1000 }, (_, i) => i);
  const { f, rangeCalls } = makeFetcher(data);
  const r = await paginateExact<number>(f, 1000);
  check("7. ⭐ exact 1000 → toate + a doua pagină goală confirmă finalul", r.rows.length === 1000 && rangeCalls() === 2);
}

// ── ⭐⭐⭐ eroare pe a doua pagină → ARUNCĂ ────────────────────────────────────
{
  const data = Array.from({ length: 1001 }, (_, i) => i);
  const { f } = makeFetcher(data, { errOnCall: 2, err: { code: "57014", message: "canceling statement" } });
  let threw = false;
  try { await paginateExact<number>(f, 1000); } catch { threw = true; }
  check("8. ⭐⭐⭐ eroare non-missing pe pagina 2 → aruncă (fail-closed)", threw === true);
}

// ── missing la HEAD → present=false ──────────────────────────────────────────
{
  const { f } = makeFetcher(null, { headErr: { code: "42P01" } });
  const r = await paginateExact<number>(f, 1000);
  check("9. ⭐ tabel absent la HEAD → present=false", r.present === false && r.rows.length === 0);
}

// ── ⭐⭐⭐ tabel dispare între HEAD și citire → present=false ──────────────────
{
  const { f } = makeFetcher([1, 2, 3], { errOnCall: 1, err: { code: "42P01", message: 'relation "t" does not exist' } });
  const r = await paginateExact<number>(f, 1000);
  check("10. ⭐⭐⭐ dispare între HEAD și range → present=false (nu aruncă)", r.present === false);
}

// ── pageSize invalid → aruncă ────────────────────────────────────────────────
{
  const { f } = makeFetcher([1]);
  let threw = false;
  try { await paginateExact<number>(f, 0); } catch { threw = true; }
  check("11. pageSize 0 → aruncă", threw === true);
}

// ── ⭐⭐⭐ head.count=null pe tabel care EXISTĂ → aruncă (fail-closed, nu 0) (cgpt nit 1) ──
{
  const { f } = makeFetcher([1, 2, 3], { headCountNull: true });
  let threw = false, msg = "";
  try { await paginateExact<number>(f, 1000); } catch (e) { threw = true; msg = String(e); }
  check("12. ⭐⭐⭐ count=null (tabel existent) → aruncă (nu tratează ca 0)", threw === true && /necunoscut/.test(msg));
}
// ── ⭐⭐⭐ REGRESIE: count=null la HEAD + tabel ABSENT la citire (pre-schema) → present=false, NU aruncă ──
{
  const { f } = makeFetcher([1, 2, 3], { headCountNull: true, errOnCall: 1, err: { code: "42P01", message: 'could not find the table' } });
  let threw = false; let res: { present: boolean } | null = null;
  try { res = await paginateExact<number>(f, 1000); } catch { threw = true; }
  check("13. ⭐⭐⭐ count=null la HEAD + absent la citire → present=false (nu aruncă; pre-schema)", threw === false && res?.present === false);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
