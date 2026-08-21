/**
 * lib/db/backfillVerdict.test.ts — PH-2a GUARD (verdict pur pentru inspector).
 */
import { evaluateBackfillVerdict, type BackfillVerdictInput } from "./backfillVerdict";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
// bază CURATĂ post-schema (ambele tabele prezente, paginare țintă coerentă)
const clean = (o: Partial<BackfillVerdictInput> = {}): BackfillVerdictInput => ({
  schema:       { phase: "post-schema", entPresent: true, regPresent: true },
  fetch:        { expected: 10, fetched: 10 },
  targetFetch:  { entitlements: { expected: 3, fetched: 3 }, registrations: { expected: 2, fetched: 2 } },
  orphanUserIds: [],
  entitlement:  { conflicts: 0, invalidRows: 0 },
  registration: { invalidRows: 0 },
  targetDrift:  [],
  ...o,
});

function main(): void {
console.log("PH-2a — backfillVerdict (pur)");

check("1. ⭐ totul zero (post-schema) → CURAT", evaluateBackfillVerdict(clean()).clean === true);
check("2. curat → zero probleme", evaluateBackfillVerdict(clean()).problems.length === 0);

// ── fază pre-schema: tabele absente permise ──────────────────────────────────
{
  const v = evaluateBackfillVerdict(clean({ schema: { phase: "pre-schema", entPresent: false, regPresent: false }, targetFetch: { entitlements: null, registrations: null } }));
  check("3. ⭐⭐ pre-schema fără tabele țintă → CURAT (permis)", v.clean === true);
}
// ── fază post-schema: tabel absent → NU curat (cgpt #1) ───────────────────────
{
  const v = evaluateBackfillVerdict(clean({ schema: { phase: "post-schema", entPresent: false, regPresent: true } }));
  check("4. ⭐⭐⭐ post-schema cu account_entitlements absent → NU curat", v.clean === false && /account_entitlements LIPSEȘTE/.test(v.problems.join()));
}
{
  const v = evaluateBackfillVerdict(clean({ schema: { phase: "post-schema", entPresent: true, regPresent: false } }));
  check("5. ⭐⭐ post-schema cu registrations absent → NU curat", v.clean === false && /registrations LIPSEȘTE/.test(v.problems.join()));
}
{
  const v = evaluateBackfillVerdict(clean({ schema: { phase: "nonsense" as unknown as "pre-schema", entPresent: true, regPresent: true } }));
  check("6. fază invalidă → NU curat", v.clean === false && /fază schema invalidă/.test(v.problems.join()));
}

// ── integritate citire sursă ─────────────────────────────────────────────────
check("7. ⭐⭐⭐ sursă fetched != expected → NU curat", evaluateBackfillVerdict(clean({ fetch: { expected: 100, fetched: 50 } })).clean === false);
check("8. sursă expected NaN → NU curat", evaluateBackfillVerdict(clean({ fetch: { expected: NaN, fetched: 10 } })).clean === false);

// ── integritate citire țintă (cgpt #2: paginare țintă) ───────────────────────
{
  const v = evaluateBackfillVerdict(clean({ targetFetch: { entitlements: { expected: 1500, fetched: 1000 }, registrations: { expected: 2, fetched: 2 } } }));
  check("9. ⭐⭐⭐ țintă tăiată la 1000 (>1000 rânduri) → NU curat", v.clean === false && /paginare țintă account_entitlements incompletă/.test(v.problems.join()));
}
{
  const v = evaluateBackfillVerdict(clean({ targetFetch: { entitlements: { expected: 3, fetched: 3 }, registrations: { expected: 1200, fetched: 1000 } } }));
  check("10. ⭐⭐ registrations țintă tăiată → NU curat", v.clean === false && /paginare țintă oauth_client_registrations incompletă/.test(v.problems.join()));
}
// ── fază post-backfill (cgpt slice3 #1) ──────────────────────────────────────
{
  const v = evaluateBackfillVerdict(clean({ schema: { phase: "post-backfill", entPresent: true, regPresent: true } }));
  check("10c. ⭐⭐ post-backfill cu ținte prezente + fără drift → CURAT", v.clean === true);
}
{
  const v = evaluateBackfillVerdict(clean({ schema: { phase: "post-backfill", entPresent: false, regPresent: true } }));
  check("10d. ⭐⭐⭐ post-backfill cu account_entitlements absent → NU curat", v.clean === false && /post-backfill dar account_entitlements LIPSEȘTE/.test(v.problems.join()));
}
// ── fail-closed: prezent=true DAR targetFetch null (cgpt slice3 #3) ──────────
{
  const v = evaluateBackfillVerdict(clean({ targetFetch: { entitlements: null, registrations: { expected: 2, fetched: 2 } } }));
  check("10e. ⭐⭐⭐ entPresent=true dar targetFetch.entitlements null → NU curat", v.clean === false && /integritate citire țintă account_entitlements/.test(v.problems.join()));
}

// ── orphans ──────────────────────────────────────────────────────────────────
{
  const v = evaluateBackfillVerdict(clean({ orphanUserIds: ["u1", "u2"] }));
  check("11. ⭐⭐⭐ orphan user_id → NU curat", v.clean === false && /orfani/.test(v.problems.join()));
}
{
  const many = Array.from({ length: 8 }, (_, i) => "u" + i);
  check("12. orphans multe → trunchiere la 5 + „…”", /u0, u1, u2, u3, u4 …/.test(evaluateBackfillVerdict(clean({ orphanUserIds: many })).problems.join()));
}

// ── contoare fail-closed (cgpt #4): NaN / negativ / fracționar / lipsă ────────
check("13. ⭐⭐⭐ conflicts NaN → NU curat (nu zero implicit)", evaluateBackfillVerdict(clean({ entitlement: { conflicts: NaN, invalidRows: 0 } })).clean === false);
check("14. ⭐⭐ invalidRows entitlement negativ → NU curat", evaluateBackfillVerdict(clean({ entitlement: { conflicts: 0, invalidRows: -1 } })).clean === false);
check("15. ⭐⭐ invalidRows registration fracționar → NU curat", evaluateBackfillVerdict(clean({ registration: { invalidRows: 1.5 } })).clean === false);
{
  const v = evaluateBackfillVerdict(clean({ entitlement: { conflicts: undefined as unknown as number, invalidRows: 0 } }));
  check("16. ⭐⭐⭐ contor lipsă (undefined) → NU curat (fail-closed)", v.clean === false && /contor.*invalid/.test(v.problems.join()));
}
check("17. conflicte pozitive → NU curat", evaluateBackfillVerdict(clean({ entitlement: { conflicts: 2, invalidRows: 0 } })).clean === false);

// ── drift țintă ──────────────────────────────────────────────────────────────
{
  const v = evaluateBackfillVerdict(clean({ targetDrift: [{ table: "account_entitlements", detail: "user u1 diferă la: entitlement_version" }] }));
  check("18. ⭐⭐ drift (entitlement_version) → NU curat", v.clean === false && /drift în account_entitlements/.test(v.problems.join()));
}

// ── secțiuni lipsă fail-closed (cgpt nit 2) ──────────────────────────────────
{
  const v = evaluateBackfillVerdict(clean({ orphanUserIds: undefined as unknown as string[] }));
  check("18b. ⭐⭐⭐ orphanUserIds lipsă → NU curat (fail-closed)", v.clean === false && /orphanUserIds lipsește/.test(v.problems.join()));
}
{
  const v = evaluateBackfillVerdict(clean({ targetDrift: undefined as unknown as [] }));
  check("18c. ⭐⭐⭐ targetDrift lipsă → NU curat (fail-closed)", v.clean === false && /targetDrift lipsește/.test(v.problems.join()));
}

// ── cumul ────────────────────────────────────────────────────────────────────
{
  const v = evaluateBackfillVerdict(clean({
    fetch: { expected: 5, fetched: 4 }, orphanUserIds: ["x"],
    entitlement: { conflicts: 1, invalidRows: 1 }, registration: { invalidRows: 1 },
    targetDrift: [{ table: "oauth_grants", detail: "d" }],
  }));
  check("19. probleme multiple → toate raportate", v.clean === false && v.problems.length === 6);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
