/**
 * lib/db/grantValidation.test.ts — PH-2 step 10.5a leaf 1 (grant lookup + cross-check user↔grant, pur).
 */
import { classifyGrantLookup, isOAuthGrantRow } from "./grantLookup";
import { verifyUserTokenGrant } from "../oauth/userTokenGrantVerify";
import type { OAuthGrant } from "../oauth/grant";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const grant: OAuthGrant = {
  grant_id: "g1", registration_id: "r1", client_id: "c1", user_id: "u1",
  resource: "https://x/api/mcp", scopes: ["read:pair", "read:market"],
  entitlement_version: 2, status: "active", created_at: "2026-01-01T00:00:00Z",
} as OAuthGrant;

function main(): void {
console.log("PH-2 step 10.5a — grant lookup + verifyUserTokenGrant (pur)");

// ── classifyGrantLookup (discriminat, fail-closed) ───────────────────────────────
check("1. ⭐⭐ error → unavailable (NU not_found)", classifyGrantLookup(null, { message: "down" }).status === "unavailable");
check("2. ⭐⭐ data null → not_found", classifyGrantLookup(null, null).status === "not_found");
check("3. ⭐⭐⭐ data undefined → unavailable (fail-closed, NU not_found)", classifyGrantLookup(undefined, null).status === "unavailable");
check("4. ⭐⭐ grant activ valid → found", (() => { const r = classifyGrantLookup(grant, null); return r.status === "found" && r.grant.grant_id === "g1"; })());
check("5. ⭐⭐⭐ grant REVOCAT valid → found (rând valid; gate-ul active e în verify)", (() => { const r = classifyGrantLookup({ ...grant, status: "revoked" }, null); return r.status === "found"; })());
check("6. ⭐⭐⭐ rând malformat (status necunoscut) → unavailable (nu found)", classifyGrantLookup({ ...grant, status: "suspended" }, null).status === "unavailable");
check("7. ⭐⭐ scopes goale → unavailable", classifyGrantLookup({ ...grant, scopes: [] }, null).status === "unavailable");
check("8. ⭐⭐ scopes cu '' → unavailable", classifyGrantLookup({ ...grant, scopes: ["read:pair", ""] }, null).status === "unavailable");
check("9. ⭐⭐ entitlement_version 0 → unavailable", classifyGrantLookup({ ...grant, entitlement_version: 0 }, null).status === "unavailable");
check("10. ⭐ user_id gol → unavailable", classifyGrantLookup({ ...grant, user_id: "" }, null).status === "unavailable");
check("11. ⭐ grant_id lipsă → unavailable", classifyGrantLookup({ ...grant, grant_id: undefined }, null).status === "unavailable");
check("12. ⭐ non-obiect → unavailable via isOAuthGrantRow false", classifyGrantLookup(42, null).status === "unavailable" && !isOAuthGrantRow(42));
check("12a. ⭐⭐⭐ created_at LIPSĂ → unavailable (found ar fi OAuthGrant type-unsound)", classifyGrantLookup({ ...grant, created_at: undefined }, null).status === "unavailable" && !isOAuthGrantRow({ ...grant, created_at: undefined }));
check("12b. ⭐⭐ created_at gol → unavailable", classifyGrantLookup({ ...grant, created_at: "" }, null).status === "unavailable");

// ── verifyUserTokenGrant (cross-check, fail-closed) ──────────────────────────────
const okClaims = { grant, grantId: "g1", userId: "u1", clientId: "c1", audience: "https://x/api/mcp", entitlementVersion: 2, scopes: ["read:pair"] };
check("13. ⭐⭐⭐ token consistent + subset scopes → ok", verifyUserTokenGrant(okClaims).ok === true);
check("14. ⭐⭐ scopes EGALE cu grantul → ok", verifyUserTokenGrant({ ...okClaims, scopes: ["read:pair", "read:market"] }).ok === true);
check("15. ⭐⭐⭐ grant REVOCAT → reject (consent tăiat)", verifyUserTokenGrant({ ...okClaims, grant: { ...grant, status: "revoked" } }).ok === false);
check("16. ⭐⭐⭐ user_id mismatch → reject", verifyUserTokenGrant({ ...okClaims, userId: "uX" }).ok === false);
check("17. ⭐⭐⭐ client_id mismatch → reject (anti client-substitution la citire)", verifyUserTokenGrant({ ...okClaims, clientId: "cX" }).ok === false);
check("18. ⭐⭐⭐ resource != audience → reject", verifyUserTokenGrant({ ...okClaims, audience: "https://y/api/mcp" }).ok === false);
check("19. ⭐⭐⭐ entitlement_version mismatch token↔grant → reject", verifyUserTokenGrant({ ...okClaims, entitlementVersion: 3 }).ok === false);
check("20. ⭐⭐⭐ scope escalation (token cere ceva ce grantul nu are) → reject", verifyUserTokenGrant({ ...okClaims, scopes: ["read:pair", "admin:all"] }).ok === false);
check("21. ⭐⭐ reason prezent pe reject (mesaj pt. log)", (() => { const r = verifyUserTokenGrant({ ...okClaims, userId: "uX" }); return r.ok === false && typeof r.reason === "string" && r.reason.length > 0; })());
check("22. ⭐⭐⭐ grant_id mismatch (token↔rând) → reject (verifierul confirmă explicit, nu se bazează pe query)", verifyUserTokenGrant({ ...okClaims, grantId: "gX" }).ok === false);
check("23. ⭐⭐⭐ token scopes [] → reject (nu subset trivial valid)", verifyUserTokenGrant({ ...okClaims, scopes: [] }).ok === false);
check("24. ⭐⭐⭐ token scopes cu '' → reject (blob corupt la citire)", verifyUserTokenGrant({ ...okClaims, scopes: ["read:pair", ""] }).ok === false);
check("25. ⭐⭐ token scopes cu whitespace-only (' ') → reject", verifyUserTokenGrant({ ...okClaims, scopes: [" "] }).ok === false);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
