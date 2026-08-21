/**
 * lib/db/driftCompare.test.ts — PH-2a GUARD (drift pe câmpuri, pur).
 */
import { diffEntitlement, diffRegistration, sameSet,
         collectEntitlementDrift, collectRegistrationDrift,
         type TargetEntitlementRow, type ComputedEntitlementRow,
         type TargetRegistrationRow, type ComputedRegistrationRow } from "./driftCompare";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const ent = (o: Partial<TargetEntitlementRow> = {}): TargetEntitlementRow => ({
  plan: "free", scopes: ["read:pair"], rate_limit_per_minute: 60, rate_limit_per_day: 1000, status: "active", entitlement_version: 1, ...o,
});
const reg = (o: Partial<TargetRegistrationRow> = {}): TargetRegistrationRow => ({
  client_type: "confidential", token_endpoint_auth_method: "client_secret_post",
  grant_types: ["authorization_code", "refresh_token", "client_credentials"],
  redirect_uris: ["https://a/cb"], client_name: "A", status: "active", expires_at: null, ...o,
});
const wantEnt: ComputedEntitlementRow = ent();
const wantReg: ComputedRegistrationRow = { client_type: "confidential", token_endpoint_auth_method: "client_secret_post",
  grant_types: ["authorization_code", "refresh_token", "client_credentials"], redirect_uris: ["https://a/cb"], client_name: "A", status: "active" };

function main(): void {
console.log("PH-2a — driftCompare (pur)");

// ── sameSet ──────────────────────────────────────────────────────────────────
check("1. sameSet ordine irelevantă", sameSet(["a", "b"], ["b", "a"]) === true);
check("2. sameSet diferă",            sameSet(["a"], ["a", "b"]) === false);
check("3. sameSet null vs []",        sameSet(null, []) === true);

// ── entitlement: identic → zero drift ────────────────────────────────────────
check("4. ⭐ entitlement identic → 0 diff", diffEntitlement(ent(), wantEnt).length === 0);
check("5. plan diferă",               diffEntitlement(ent({ plan: "pro" }), wantEnt).join() === "plan");
check("6. scopes diferă",             diffEntitlement(ent({ scopes: ["read:all"] }), wantEnt).join() === "scopes");
check("7. rlm diferă",                diffEntitlement(ent({ rate_limit_per_minute: 5 }), wantEnt).join() === "rate_limit_per_minute");
check("8. status diferă",             diffEntitlement(ent({ status: "suspended" }), wantEnt).join() === "status");
check("9. ⭐⭐⭐ entitlement_version=2 (update legitim după dual-write) → NU drift (monoton)", diffEntitlement(ent({ entitlement_version: 2 }), wantEnt).length === 0);
check("9b. ⭐⭐ entitlement_version=99 → NU drift", diffEntitlement(ent({ entitlement_version: 99 }), wantEnt).length === 0);
check("9c. ⭐⭐⭐ entitlement_version=0 → drift (invalid, < 1)", diffEntitlement(ent({ entitlement_version: 0 }), wantEnt).join() === "entitlement_version");
check("9d. ⭐⭐ entitlement_version=1.5 (fracționar) → drift", diffEntitlement(ent({ entitlement_version: 1.5 }), wantEnt).join() === "entitlement_version");

// ── registration: identic → zero drift ───────────────────────────────────────
check("10. ⭐ registration identic → 0 diff", diffRegistration(reg(), wantReg).length === 0);
check("11. client_type diferă",       diffRegistration(reg({ client_type: "public" }), wantReg).includes("client_type"));
check("12. grant_types set diferă",   diffRegistration(reg({ grant_types: ["authorization_code"] }), wantReg).includes("grant_types"));
check("13. redirect set diferă",      diffRegistration(reg({ redirect_uris: ["https://b/cb"] }), wantReg).includes("redirect_uris"));
check("14. client_name diferă",       diffRegistration(reg({ client_name: "B" }), wantReg).includes("client_name"));
check("15. ⭐⭐⭐ expires_at non-null → drift (backfill cere NULL)", diffRegistration(reg({ expires_at: "2027-01-01T00:00:00Z" }), wantReg).join() === "expires_at");
check("16. grant_types ordine irelevantă → fără drift", diffRegistration(reg({ grant_types: ["client_credentials", "authorization_code", "refresh_token"] }), wantReg).length === 0);

// ── colectori cu fază (cgpt slice3 #1): absența unei chei ─────────────────────
const compEnt = [{ user_id: "u1", ...wantEnt }];
const compReg = [{ client_id: "cA", ...wantReg }];
{
  // pre/post-schema: cheie absentă din țintă → NU e drift (backfill-ul o va insera)
  const d = collectEntitlementDrift("post-schema", compEnt, new Map());
  check("17. ⭐⭐ post-schema (pre-backfill): entitlement absent → fără drift", d.length === 0);
}
{
  // post-backfill: cheie absentă → DRIFT (backfill incomplet)
  const d = collectEntitlementDrift("post-backfill", compEnt, new Map());
  check("18. ⭐⭐⭐ post-backfill: entitlement absent → DRIFT (incomplet)", d.length === 1 && /LIPSEȘTE/.test(d[0].detail));
}
{
  // post-backfill: prezent + identic → fără drift
  const map = new Map([["u1", ent()]]);
  const d = collectEntitlementDrift("post-backfill", compEnt, map);
  check("19. ⭐ post-backfill: entitlement prezent identic → fără drift", d.length === 0);
}
{
  // post-backfill: prezent dar diferit → drift pe câmp
  const map = new Map([["u1", ent({ plan: "pro" })]]);
  const d = collectEntitlementDrift("post-backfill", compEnt, map);
  check("20. ⭐⭐ post-backfill: entitlement diferit → drift pe plan", d.length === 1 && /plan/.test(d[0].detail));
}
{
  const d = collectRegistrationDrift("post-backfill", compReg, new Map());
  check("21. ⭐⭐⭐ post-backfill: registration absentă → DRIFT", d.length === 1 && /LIPSEȘTE/.test(d[0].detail));
}
{
  const d = collectRegistrationDrift("post-schema", compReg, new Map());
  check("22. ⭐ post-schema: registration absentă → fără drift", d.length === 0);
}
{
  const map = new Map([["cA", reg({ expires_at: "2027-01-01T00:00:00Z" })]]);
  const d = collectRegistrationDrift("post-backfill", compReg, map);
  check("23. ⭐⭐ post-backfill: registration cu expires_at non-null → drift", d.length === 1 && /expires_at/.test(d[0].detail));
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
