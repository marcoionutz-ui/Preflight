/**
 * lib/oauth/grant.test.ts — PH-2a GUARD (build + validare grant, pur).
 */
import { buildGrant, isValidGrant, isGrantUsable, type OAuthGrant } from "./grant";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const base = {
  grant_id: "gr_1", registration_id: "reg_1", client_id: "tp_x", user_id: "u1",
  resource: "https://preflight.app/api/mcp", scopes: ["read:pair"], entitlement_version: 1, nowIso: "2026-01-01T00:00:00Z",
};

function main(): void {
console.log("PH-2a — grant (build + validare)");

// ── build ok ──────────────────────────────────────────────────────────────────
{
  const r = buildGrant(base);
  check("1. build valid → ok", r.ok === true);
  check("2. status active + created_at", r.ok && r.grant.status === "active" && r.grant.created_at === base.nowIso);
  check("3. FK unic registration_id + client_id denormalizat", r.ok && r.grant.registration_id === "reg_1" && r.grant.client_id === "tp_x");
}
{
  const r = buildGrant({ ...base, scopes: ["read:pair", "read:pair", "read:market"] });
  check("4. ⭐ scopes dedup + ordine stabilă", r.ok && JSON.stringify(r.grant.scopes) === JSON.stringify(["read:pair", "read:market"]));
}

// ── build fail-closed ──────────────────────────────────────────────────────────
check("5. ⭐ fără registration_id → error", buildGrant({ ...base, registration_id: "" }).ok === false);
check("6. ⭐ fără user_id → error", buildGrant({ ...base, user_id: "" }).ok === false);
check("7. ⭐⭐ scopes goale → error (grantul n-ar autoriza nimic)", buildGrant({ ...base, scopes: [] }).ok === false);
check("8. ⭐ scopes doar cu goluri → error după dedup", buildGrant({ ...base, scopes: ["", ""] as string[] }).ok === false);
check("8b. ⭐⭐ scopes doar whitespace [' ','  '] → error (trim, cgpt P2)", buildGrant({ ...base, scopes: [" ", "  "] }).ok === false);
check("8c. ⭐ scopes cu whitespace amestecat → doar cele curate, trimmed", (() => { const r = buildGrant({ ...base, scopes: [" read:pair ", "  ", "read:market"] }); return r.ok && JSON.stringify(r.grant.scopes) === JSON.stringify(["read:pair", "read:market"]); })());
check("9. ⭐ entitlement_version 0 → error", buildGrant({ ...base, entitlement_version: 0 }).ok === false);
check("10. ⭐ entitlement_version float → error", buildGrant({ ...base, entitlement_version: 1.2 }).ok === false);
check("11. ⭐ fără resource → error", buildGrant({ ...base, resource: "" }).ok === false);
check("12. fără nowIso → error", buildGrant({ ...base, nowIso: "" }).ok === false);

// ── isValidGrant (citire din DB) ──────────────────────────────────────────────
const good: OAuthGrant = (buildGrant(base) as { ok: true; grant: OAuthGrant }).grant;
check("13. isValidGrant pe grant bun → true", isValidGrant(good));
check("14. ⭐ isValidGrant: status necunoscut → false", !isValidGrant({ ...good, status: "zombie" }));
check("15. ⭐ isValidGrant: scopes goale → false", !isValidGrant({ ...good, scopes: [] }));
check("16. ⭐ isValidGrant: scopes cu non-string → false", !isValidGrant({ ...good, scopes: ["read:pair", 1] }));
check("16b. ⭐⭐ isValidGrant: [''] → false (cgpt P2)", !isValidGrant({ ...good, scopes: [""] }));
check("16c. ⭐⭐ isValidGrant: [' '] → false", !isValidGrant({ ...good, scopes: [" "] }));
check("17. isValidGrant: null → false", !isValidGrant(null));

// ── isGrantUsable ─────────────────────────────────────────────────────────────
check("18. ⭐ active + scopes → usable", isGrantUsable({ status: "active", scopes: ["read:pair"] }));
check("19. ⭐ revoked → NU usable", !isGrantUsable({ status: "revoked", scopes: ["read:pair"] }));
check("20. active fără scopes → NU usable", !isGrantUsable({ status: "active", scopes: [] }));
check("21. ⭐⭐ active + [''] → NU usable (cgpt P2)", !isGrantUsable({ status: "active", scopes: [""] }));
check("22. ⭐⭐ active + [' '] → NU usable", !isGrantUsable({ status: "active", scopes: [" "] }));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
