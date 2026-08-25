/**
 * lib/db/ph2Lookup.test.ts — PH-2 step 10.3b-ii GUARD (clasificatori lookup entitlement + registration, pur).
 */
import { classifyEntitlementLookup, isAccountEntitlementRow } from "./entitlementLookup";
import { classifyRegistrationLookup, mapRegistrationRow } from "./registrationLookup";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const entRow = { user_id: "u1", plan: "pro", scopes: ["read:all"], rate_limit_per_minute: 60, rate_limit_per_day: 10000, status: "active", entitlement_version: 3 };
const regRow = { registration_id: "reg1", client_id: "c1", status: "active", grant_types: ["authorization_code", "refresh_token"], expires_at: null };

function main(): void {
console.log("PH-2 step 10.3b-ii — ph2Lookup (clasificatori, pur)");

// ── entitlement ─────────────────────────────────────────────────────────────────
check("1. ⭐⭐ eroare → unavailable (NU not_found)", classifyEntitlementLookup(null, { message: "down" }).status === "unavailable");
check("2. ⭐⭐ data null → not_found", classifyEntitlementLookup(null, null).status === "not_found");
check("2a. ⭐⭐⭐ data undefined → unavailable (răspuns neașteptat, NU not_found)", classifyEntitlementLookup(undefined, null).status === "unavailable");
check("3. ⭐⭐ rând valid → found + entitlement", (() => { const r = classifyEntitlementLookup(entRow, null); return r.status === "found" && r.entitlement.user_id === "u1" && r.entitlement.entitlement_version === 3; })());
check("4. ⭐⭐⭐ rând prezent dar malformat (status necunoscut) → unavailable (nu found)", classifyEntitlementLookup({ ...entRow, status: "bogus" }, null).status === "unavailable");
check("5. ⭐⭐ scopes goale → row invalid", !isAccountEntitlementRow({ ...entRow, scopes: [] }));
check("6. ⭐ entitlement_version 0 → row invalid", !isAccountEntitlementRow({ ...entRow, entitlement_version: 0 }));
check("7. ⭐ rate_limit -1 (nelimitat) → valid", isAccountEntitlementRow({ ...entRow, rate_limit_per_minute: -1 }));
check("8. rate_limit -2 → invalid", !isAccountEntitlementRow({ ...entRow, rate_limit_per_minute: -2 }));
check("9. user_id gol → invalid", !isAccountEntitlementRow({ ...entRow, user_id: "" }));

// ── registration ────────────────────────────────────────────────────────────────
check("10. ⭐⭐ eroare → unavailable", classifyRegistrationLookup(null, { message: "down" }).status === "unavailable");
check("11. ⭐⭐ data null → not_found", classifyRegistrationLookup(null, null).status === "not_found");
check("11a. ⭐⭐⭐ data undefined → unavailable (NU not_found)", classifyRegistrationLookup(undefined, null).status === "unavailable");
check("12. ⭐⭐ rând valid (expires_at null) → found", (() => { const r = classifyRegistrationLookup(regRow, null); return r.status === "found" && r.registration.registration_id === "reg1" && r.registration.expires_at === null; })());
check("13. ⭐⭐⭐ expires_at ISO → convertit în ms", (() => { const r = classifyRegistrationLookup({ ...regRow, expires_at: "2026-08-22T10:00:00.000Z" }, null); return r.status === "found" && r.registration.expires_at === Date.parse("2026-08-22T10:00:00.000Z"); })());
check("14. ⭐⭐⭐ expires_at ISO invalid → unavailable (rând corupt)", classifyRegistrationLookup({ ...regRow, expires_at: "not-a-date" }, null).status === "unavailable");
check("14a. ⭐⭐⭐ expires_at LIPSĂ (coloană omisă) → unavailable (NU „nu expiră\")", classifyRegistrationLookup({ registration_id: "reg1", client_id: "c1", status: "active", grant_types: ["authorization_code"] }, null).status === "unavailable");
check("14b. ⭐⭐ expires_at null EXPLICIT → found cu null (nu expiră)", (() => { const r = classifyRegistrationLookup({ ...regRow, expires_at: null }, null); return r.status === "found" && r.registration.expires_at === null; })());
check("15. ⭐⭐ grant_types ne-array → unavailable", classifyRegistrationLookup({ ...regRow, grant_types: "authorization_code" }, null).status === "unavailable");
check("16. ⭐ registration_id gol → unavailable", classifyRegistrationLookup({ ...regRow, registration_id: "" }, null).status === "unavailable");
check("17. ⭐ status păstrat ca string (gate active e în consent, nu aici)", (() => { const r = classifyRegistrationLookup({ ...regRow, status: "revoked" }, null); return r.status === "found" && r.registration.status === "revoked"; })());
check("18. mapRegistrationRow non-obiect → null", mapRegistrationRow(null) === null && mapRegistrationRow(42) === null);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
