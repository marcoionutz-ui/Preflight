/**
 * lib/db/entitlementBackfill.test.ts — PH-2a GUARD (backfill: set scopes + validare + invalidRows + client_id).
 */
import { computeEntitlementBackfill, type LegacyClientRow } from "./entitlementBackfill";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const row = (o: Partial<LegacyClientRow>): LegacyClientRow => ({
  client_id: "tp_a", user_id: "u1", plan: "starter", scopes: ["read:all"], rate_limit_per_minute: 60, rate_limit_per_day: 10_000, status: "active", ...o,
});

function main(): void {
console.log("PH-2a — entitlement backfill (set scopes + validare + raport acționabil)");

// ── un client valid → un entitlement, scopes normalizate ──────────────────────
{
  const r = computeEntitlementBackfill([row({ scopes: [" read:pair ", "read:all", "read:all", ""] })]);
  check("1. un client → un entitlement", r.entitlements.length === 1 && r.conflicts.length === 0 && r.invalidRows.length === 0);
  check("2. ⭐ scopes OUTPUT normalizate (trim+dedup+sort)", JSON.stringify(r.entitlements[0].scopes) === JSON.stringify(["read:all", "read:pair"]));
  check("3. entitlement_version = 1", r.entitlements[0].entitlement_version === 1);
}

// ── dedup: [read:all] vs [read:all,read:all] NU e conflict (cgpt P2) ──────────
{
  const r = computeEntitlementBackfill([row({ client_id: "a", scopes: ["read:all"] }), row({ client_id: "b", scopes: ["read:all", "read:all"] })]);
  check("4. ⭐⭐⭐ [read:all] vs [read:all,read:all] → UN entitlement, 0 conflicte (set, nu listă)",
    r.entitlements.length === 1 && r.conflicts.length === 0);
}
{
  const r = computeEntitlementBackfill([row({ client_id: "a", scopes: ["read:all", "read:pair"] }), row({ client_id: "b", scopes: ["read:pair", "read:all", "read:pair"] })]);
  check("5. ⭐ aceeași mulțime, ordine+dubluri diferite → NU conflict", r.entitlements.length === 1 && r.conflicts.length === 0);
}

// ── conflict real → raport cu client_id-uri (cgpt: acționabil) ────────────────
{
  const r = computeEntitlementBackfill([row({ client_id: "tp_x", plan: "starter" }), row({ client_id: "tp_y", plan: "pro" })]);
  check("6. ⭐⭐⭐ plan divergent → conflict (NU alegem tacit)", r.conflicts.length === 1 && r.entitlements.length === 0);
  check("7. ⭐⭐ conflictul listează client_id-urile pe variante",
    r.conflicts[0].variants.length === 2 &&
    r.conflicts[0].variants.some(v => v.client_ids.includes("tp_x")) &&
    r.conflicts[0].variants.some(v => v.client_ids.includes("tp_y")));
}
{
  // aceeași variantă acoperă 2 clienți + o variantă divergentă → 2 variante, prima cu 2 client_ids
  const r = computeEntitlementBackfill([
    row({ client_id: "a", plan: "starter" }), row({ client_id: "b", plan: "starter" }), row({ client_id: "c", plan: "pro" }),
  ]);
  const starterVariant = r.conflicts[0]?.variants.find(v => v.client_ids.length === 2);
  check("8. ⭐ variantă cu mai mulți clienți grupează client_id-urile", !!starterVariant && starterVariant.client_ids.includes("a") && starterVariant.client_ids.includes("b"));
}

// ── validare runtime → invalidRows separat (cgpt P2) ──────────────────────────
{
  const r = computeEntitlementBackfill([row({ client_id: "bad1", status: "zombie" })]);
  check("9. ⭐⭐ status necunoscut → invalidRow (nu migrat, nu variantă)", r.invalidRows.length === 1 && r.entitlements.length === 0 && /status necunoscut/.test(r.invalidRows[0].reasons.join()));
  check("10. invalidRow poartă client_id", r.invalidRows[0].client_id === "bad1");
}
{
  const r = computeEntitlementBackfill([row({ client_id: "bad2", rate_limit_per_day: NaN })]);
  check("11. ⭐⭐ limită NaN → invalidRow (NaN nu se serializează tacit ca null)", r.invalidRows.length === 1 && /rate_limit_per_day invalid/.test(r.invalidRows[0].reasons.join()));
}
{
  const r = computeEntitlementBackfill([row({ client_id: "bad3", rate_limit_per_minute: Infinity })]);
  check("12. ⭐ limită Infinity → invalidRow", r.invalidRows.length === 1);
}
{
  const r = computeEntitlementBackfill([row({ client_id: "bad4", rate_limit_per_minute: 1.5 })]);
  check("13. ⭐ limită non-întreagă → invalidRow", r.invalidRows.length === 1);
}
{
  const r = computeEntitlementBackfill([row({ client_id: "ok-unl", rate_limit_per_day: -1 })]);
  check("14. ⭐ limită -1 (unlimited) → VALID (politică explicită)", r.entitlements.length === 1 && r.invalidRows.length === 0);
}
{
  const r = computeEntitlementBackfill([row({ client_id: "bad5", rate_limit_per_day: -5 })]);
  check("15. ⭐ alt negativ (-5) → invalidRow", r.invalidRows.length === 1);
}
{
  const r = computeEntitlementBackfill([row({ client_id: "bad6", scopes: ["", "  "] })]);
  check("16. ⭐⭐ scopes goale după normalizare → invalidRow (nu entitlement fără scope)", r.invalidRows.length === 1 && /scopes goale/.test(r.invalidRows[0].reasons.join()));
}
{
  const r = computeEntitlementBackfill([row({ client_id: "bad7", plan: "  " })]);
  check("17. ⭐ plan gol → invalidRow", r.invalidRows.length === 1);
}

// ── izolare: valid + invalid + conflict pe useri diferiți ─────────────────────
{
  const r = computeEntitlementBackfill([
    row({ client_id: "v", user_id: "uA", plan: "basic" }),                                   // valid
    row({ client_id: "bad", user_id: "uB", status: "nope" }),                                // invalid
    row({ client_id: "c1", user_id: "uC", plan: "starter" }), row({ client_id: "c2", user_id: "uC", plan: "pro" }), // conflict
  ]);
  check("18. ⭐⭐ izolare: uA entitlement, uB invalid, uC conflict — fiecare pe canalul lui",
    r.entitlements.length === 1 && r.entitlements[0].user_id === "uA" &&
    r.invalidRows.length === 1 && r.invalidRows[0].user_id === "uB" &&
    r.conflicts.length === 1 && r.conflicts[0].user_id === "uC");
}

// ── user_id null → skip; input gol ────────────────────────────────────────────
{
  const r = computeEntitlementBackfill([row({ user_id: null }), row({ user_id: "" }), row({ client_id: "z", user_id: "u9" })]);
  check("19. ⭐ user_id null/'' → skip (contorizat), nu invalid", r.skippedNullUser === 2 && r.entitlements.length === 1 && r.invalidRows.length === 0);
}
check("20. input gol → totul gol", (() => { const r = computeEntitlementBackfill([]); return r.entitlements.length === 0 && r.conflicts.length === 0 && r.invalidRows.length === 0 && r.skippedNullUser === 0; })());

// ── cgpt R2 P1: user cu rând valid + rând invalid → BLOCAT integral ────────────
{
  const r = computeEntitlementBackfill([
    row({ client_id: "good", user_id: "uX", plan: "starter", status: "active" }),
    row({ client_id: "bad",  user_id: "uX", status: "corrupt" }),
  ]);
  check("21. ⭐⭐⭐ user cu 1 valid + 1 invalid → ZERO entitlements (fail-closed pe stare incertă)",
    r.entitlements.length === 0 && r.conflicts.length === 0 && r.invalidRows.length === 1 && r.invalidRows[0].client_id === "bad");
}

// ── cgpt R2 P2: element non-string în scopes → invalidRow, fără throw, alt user OK ─
{
  const r = computeEntitlementBackfill([
    row({ client_id: "ns", user_id: "uBad", scopes: ["read:all", null as unknown as string] }),
    row({ client_id: "ok", user_id: "uOk", plan: "basic" }),
  ]);
  check("22. ⭐⭐⭐ scopes [read:all, null] → invalidRow (nu aruncă), userul valid separat backfilled",
    r.invalidRows.length === 1 && r.invalidRows[0].user_id === "uBad" && r.entitlements.length === 1 && r.entitlements[0].user_id === "uOk");
  check("23. ⭐ invalidRow raportează motivul non-string", /scopes invalide/.test(r.invalidRows[0].reasons.join()));
}
{
  // number/object elemente → tot invalid, tot fără throw
  const r = computeEntitlementBackfill([row({ client_id: "n2", scopes: [123 as unknown as string] })]);
  check("24. ⭐ scopes cu number → invalidRow", r.invalidRows.length === 1 && r.entitlements.length === 0);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
