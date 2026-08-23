/**
 * lib/oauth/authGrantIssuance.test.ts — PH-2 step 10.2 GUARD (grant + claim-uri cod, pur).
 */
import {
  buildAuthGrantAndCodeClaims, isUserAuthCodeClaims, readAuthCodeIdentity,
} from "./authGrantIssuance";
import { isValidGrant } from "./grant";
import type { AccountEntitlement } from "./entitlement";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const NOW = "2026-08-22T10:00:00.000Z";
const RES = "https://preflight.app/api/mcp";
const account: AccountEntitlement = {
  user_id: "u1", plan: "pro", scopes: ["read:all"], rate_limit_per_minute: 60, rate_limit_per_day: 10000,
  status: "active", entitlement_version: 3,
};
const POLICY = ["read:basic", "read:all", "read:market", "read:pair", "read:safety"];
const ok = {
  grant_id: "g1", registration_id: "reg1", client_id: "c1", resource: RES,
  requestedScopes: ["read:pair", "read:market"], serverPolicy: POLICY, account, nowIso: NOW,
};
// base AuthCodePayload valid (fără claim-uri user) pentru readAuthCodeIdentity
const baseCode = { client_id: "c1", scopes: ["read:all"], redirect_uri: "https://claude.ai/cb", code_challenge: "cc", code_challenge_method: "S256", issued_at: 1, resource: RES };

function main(): void {
console.log("PH-2 step 10.2 — authGrantIssuance (grant + claim-uri cod, pur)");

// ── buildAuthGrantAndCodeClaims: compune rezolvarea de scope ────────────────────
{
  const r = buildAuthGrantAndCodeClaims(ok);
  check("1. ⭐⭐ consimțământ valid → ok", r.ok === true);
  if (r.ok) {
    check("2. ⭐⭐⭐ grantul e valid (isValidGrant)", isValidGrant(r.grant));
    check("3. ⭐⭐⭐ claims derivate DIN grant (identice)", r.claims.user_id === r.grant.user_id && r.claims.grant_id === r.grant.grant_id && r.claims.entitlement_version === r.grant.entitlement_version);
    check("4. ⭐⭐⭐ scopes = REZOLVATE prin entitlement (read:all cont acoperă read:pair/read:market, ∩ policy)", JSON.stringify(r.grant.scopes) === JSON.stringify(["read:pair", "read:market"]));
    check("5. ⭐⭐ user_id + entitlement_version DIN cont (nu din param liber)", r.grant.user_id === "u1" && r.grant.entitlement_version === 3);
  }
}
// ── BOUNDARY de scope: cerutul brut NU trece dacă nu-l acoperă entitlement/policy ─
{
  // cont doar cu read:pair; cere read:market (necoperit) + read:pair → doar read:pair supraviețuiește
  const acc2: AccountEntitlement = { ...account, scopes: ["read:pair"] };
  const r = buildAuthGrantAndCodeClaims({ ...ok, account: acc2, requestedScopes: ["read:market", "read:pair"] });
  check("6. ⭐⭐⭐ scope cerut necoperit de cont → EXCLUS (doar read:pair)", r.ok === true && JSON.stringify((r as { grant: { scopes: string[] } }).grant.scopes) === JSON.stringify(["read:pair"]));
}
check("7. ⭐⭐⭐ scope cerut în afara policy server → exclus → dacă rămâne 0 → error",
  buildAuthGrantAndCodeClaims({ ...ok, requestedScopes: ["read:secret_not_in_policy"] }).ok === false);
// ── gate de cont (fail-closed) ──────────────────────────────────────────────────
check("8. ⭐⭐⭐ cont suspended → error (nu acordă grant)", buildAuthGrantAndCodeClaims({ ...ok, account: { ...account, status: "suspended" } }).ok === false);
check("9. ⭐⭐ cont fără scopes → error", buildAuthGrantAndCodeClaims({ ...ok, account: { ...account, scopes: [] } }).ok === false);
check("10. ⭐ fără registration_id → error (FK unic)", buildAuthGrantAndCodeClaims({ ...ok, registration_id: "" }).ok === false);
check("11. ⭐⭐ requested gol → baza = scopes cont (∩ policy)", (() => { const r = buildAuthGrantAndCodeClaims({ ...ok, requestedScopes: [] }); return r.ok === true; })());

// ── isUserAuthCodeClaims ────────────────────────────────────────────────────────
check("12. claims valide → true", isUserAuthCodeClaims({ user_id: "u1", grant_id: "g1", entitlement_version: 1 }));
check("13. ⭐ entitlement_version 0 → false", !isUserAuthCodeClaims({ user_id: "u1", grant_id: "g1", entitlement_version: 0 }));
check("14. grant_id lipsă → false", !isUserAuthCodeClaims({ user_id: "u1", entitlement_version: 1 }));

// ── readAuthCodeIdentity: fail-closed (cgpt #1/#2) ──────────────────────────────
check("15. ⭐⭐⭐ null → corrupt (NU legacy_client)", readAuthCodeIdentity(null).kind === "corrupt");
check("16. ⭐⭐⭐ {} → corrupt (base invalid, NU legacy_client)", readAuthCodeIdentity({}).kind === "corrupt");
check("17. ⭐⭐⭐ obiect fără base (doar user_id) → corrupt (nu-i AuthCodePayload valid)", readAuthCodeIdentity({ user_id: "u1", grant_id: "g1", entitlement_version: 1 }).kind === "corrupt");
check("18. ⭐⭐⭐ AuthCodePayload COMPLET fără claim-uri user → legacy_client", readAuthCodeIdentity(baseCode).kind === "legacy_client");
{
  const id = readAuthCodeIdentity({ ...baseCode, user_id: "u1", grant_id: "g1", entitlement_version: 2 });
  check("19. ⭐⭐⭐ base valid + toate claim-urile → user + claims", id.kind === "user" && (id as { claims: { user_id: string } }).claims.user_id === "u1");
}
check("20. ⭐⭐⭐ base valid + user_id fără grant_id (parțial) → corrupt", readAuthCodeIdentity({ ...baseCode, user_id: "u1" }).kind === "corrupt");
check("21. ⭐⭐⭐ base valid + entitlement_version 0 → corrupt", readAuthCodeIdentity({ ...baseCode, user_id: "u1", grant_id: "g1", entitlement_version: 0 }).kind === "corrupt");
check("22. ⭐⭐ base valid + user_id greșit tipat → corrupt", readAuthCodeIdentity({ ...baseCode, user_id: 42, grant_id: "g1", entitlement_version: 1 }).kind === "corrupt");
check("23. ⭐⭐ base INVALID (fără redirect_uri) + claim-uri user complete → corrupt (base contează)", readAuthCodeIdentity({ client_id: "c1", scopes: ["read:all"], code_challenge: "cc", code_challenge_method: "S256", issued_at: 1, user_id: "u1", grant_id: "g1", entitlement_version: 1 }).kind === "corrupt");

// ── compoziția reală: build → cod → identitate round-trip ───────────────────────
{
  const r = buildAuthGrantAndCodeClaims(ok);
  if (r.ok) {
    const codePayload = { ...baseCode, scopes: r.grant.scopes, resource: r.grant.resource, ...r.claims };
    const id = readAuthCodeIdentity(codePayload);
    check("24. ⭐⭐⭐ round-trip: claims embed-uite → readAuthCodeIdentity=user cu ACELAȘI user_id/grant_id/version",
      id.kind === "user" && (id as { claims: typeof r.claims }).claims.user_id === "u1" && (id as { claims: typeof r.claims }).claims.grant_id === "g1" && (id as { claims: typeof r.claims }).claims.entitlement_version === 3);
  } else { check("24. (build eșuat neașteptat)", false); }
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
