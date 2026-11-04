/**
 * lib/db/ph2Lookup.test.ts — PH-2 step 10.3b-ii GUARD (clasificatori lookup entitlement + registration, pur).
 */
import { classifyEntitlementLookup, isAccountEntitlementRow, parseAccessExpiresAt, isAccessExpired } from "./entitlementLookup";
import { classifyRegistrationLookup, mapRegistrationRow } from "./registrationLookup";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const entRow = { user_id: "u1", plan: "pro", scopes: ["read:all"], rate_limit_per_minute: 60, rate_limit_per_day: 10000, status: "active", entitlement_version: 3, access_expires_at: null };
// Ceas fix injectat (frunza e pură): NOW = 2026-11-03T12:00:00Z.
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const regRow = { registration_id: "reg1", client_id: "c1", status: "active", grant_types: ["authorization_code", "refresh_token"], expires_at: null };

function main(): void {
console.log("PH-2 step 10.3b-ii — ph2Lookup (clasificatori, pur)");

// ── entitlement ─────────────────────────────────────────────────────────────────
check("1. ⭐⭐ eroare → unavailable (NU not_found)", classifyEntitlementLookup(null, { message: "down" }, NOW).status === "unavailable");
check("2. ⭐⭐ data null → not_found", classifyEntitlementLookup(null, null, NOW).status === "not_found");
check("2a. ⭐⭐⭐ data undefined → unavailable (răspuns neașteptat, NU not_found)", classifyEntitlementLookup(undefined, null, NOW).status === "unavailable");
check("3. ⭐⭐ rând valid → found + entitlement", (() => { const r = classifyEntitlementLookup(entRow, null, NOW); return r.status === "found" && r.entitlement.user_id === "u1" && r.entitlement.entitlement_version === 3; })());
check("4. ⭐⭐⭐ rând prezent dar malformat (status necunoscut) → unavailable (nu found)", classifyEntitlementLookup({ ...entRow, status: "bogus" }, null, NOW).status === "unavailable");
check("5. ⭐⭐ scopes goale → row invalid", !isAccountEntitlementRow({ ...entRow, scopes: [] }));
check("6. ⭐ entitlement_version 0 → row invalid", !isAccountEntitlementRow({ ...entRow, entitlement_version: 0 }));
check("7. ⭐ rate_limit -1 (nelimitat) → valid", isAccountEntitlementRow({ ...entRow, rate_limit_per_minute: -1 }));
check("8. rate_limit -2 → invalid", !isAccountEntitlementRow({ ...entRow, rate_limit_per_minute: -2 }));
check("9. user_id gol → invalid", !isAccountEntitlementRow({ ...entRow, user_id: "" }));

// ── entitlement: access_expires_at (lotul OAuth staging, migrarea 0002) ───────────────────────
const cls = (over: Record<string, unknown>, now: number = NOW) => classifyEntitlementLookup({ ...entRow, ...over }, null, now);
check("9a. ⭐⭐⭐ access_expires_at null → found (fără expirare, rândurile dinainte de 0002)", (() => { const r = cls({ access_expires_at: null }); return r.status === "found" && r.entitlement.user_id === "u1"; })());
check("9b. ⭐⭐⭐ neexpirat (+14 zile, format PostgREST cu µs și +00:00) → found, entitlement neschimbat", (() => {
  const r = cls({ access_expires_at: "2026-11-17T12:00:00.123456+00:00" });
  return r.status === "found" && r.entitlement.plan === "pro" && r.entitlement.scopes.length === 1 && r.entitlement.entitlement_version === 3;
})());
check("9c. ⭐⭐⭐ expirat (în trecut) → expired (NU found; fără scopes/limite în rezultat)", (() => {
  const r = cls({ access_expires_at: "2026-11-01T00:00:00Z" });
  return r.status === "expired" && r.user_id === "u1" && r.access_expires_at_ms === Date.parse("2026-11-01T00:00:00Z") && !("entitlement" in r);
})());
check("9d. ⭐⭐⭐ granița: access_expires_at == now → expired (<= now)", cls({ access_expires_at: "2026-11-03T12:00:00.000Z" }).status === "expired");
check("9e. ⭐⭐ granița: now + 1 ms → found", cls({ access_expires_at: "2026-11-03T12:00:00.001Z" }).status === "found");
check("9f. ⭐⭐⭐ coloana LIPSĂ (select fără access_expires_at / 0002 neaplicată) → unavailable (NU „nu expiră”)", (() => {
  const { access_expires_at: _omit, ...noCol } = entRow; void _omit;
  return classifyEntitlementLookup(noCol, null, NOW).status === "unavailable";
})());
check("9g. ⭐⭐⭐ malformat: șir neparsabil → unavailable (rând corupt)", cls({ access_expires_at: "not-a-date" }).status === "unavailable");
check("9h. ⭐⭐⭐ malformat: fără fus orar → unavailable (ambiguu)", cls({ access_expires_at: "2026-11-17T12:00:00" }).status === "unavailable");
check("9i. ⭐⭐ malformat: număr / boolean / undefined → unavailable", cls({ access_expires_at: 1794909600000 }).status === "unavailable"
  && cls({ access_expires_at: true }).status === "unavailable" && cls({ access_expires_at: undefined }).status === "unavailable");
check("9j. ⭐⭐⭐ nowMs NaN + expirare setată → expired (fail-closed)", cls({ access_expires_at: "2099-01-01T00:00:00Z" }, Number.NaN).status === "expired");
check("9k. ⭐⭐ nowMs NaN + expirare null → found (null = niciodată)", cls({ access_expires_at: null }, Number.NaN).status === "found");
check("9l. ⭐⭐ expirarea NU ascunde coruperea: rând expirat + status necunoscut → unavailable", cls({ access_expires_at: "2020-01-01T00:00:00Z", status: "bogus" }).status === "unavailable");
check("9m. ⭐ found NU propagă access_expires_at în entitlement (doar câmpurile tipului)", (() => {
  const r = cls({ access_expires_at: "2026-11-17T12:00:00Z" });
  return r.status === "found" && !("access_expires_at" in r.entitlement);
})());
check("9n. ⭐ parseAccessExpiresAt / isAccessExpired direct", parseAccessExpiresAt({ access_expires_at: null }).ok === true
  && parseAccessExpiresAt({}).ok === false && parseAccessExpiresAt(null).ok === false
  && isAccessExpired(null, NOW) === false && isAccessExpired(NOW - 1, NOW) === true && isAccessExpired(NOW + 1, NOW) === false);

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
