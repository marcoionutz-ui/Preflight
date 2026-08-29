/**
 * lib/oauth/userAuthCodePayload.test.ts — PH-2 step 10.3b-iv frunză 2 (producătorul AuthCodePayload user-shaped, pur).
 *
 * Verifică: (a) happy-path → blob valid clasificat `user`; (b) SINGLE-SOURCE — identitatea + scopes + resource din GRANT;
 * (c) transport (redirect_uri/PKCE) DIN TRANZACȚIE; (d) ANTI MIX-UP — cele 4 cross-check-uri txn↔grant
 * (registration_id/client_id/session_user_id/resource) resping combinația grant A + transport B; (e) fail-closed pe
 * grant invalid/inutilizabil / PKCE invalid / issued_at ne-finit; (f) purity; (g) round-trip prin `parseAuthCode`.
 */
import { createHash } from "node:crypto";
import { buildUserAuthCodePayload } from "./userAuthCodePayload";
import { buildGrant, type OAuthGrant } from "./grant";
import { buildAuthzTransaction, type AuthzTransaction } from "./authzTransaction";
import { isAuthCodePayload, parseAuthCode } from "../db/oauthAtomic";
import { readAuthCodeIdentity } from "./authGrantIssuance";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// PKCE S256 valid (challenge = base64url(sha256(verifier))).
const VERIFIER  = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const REDIRECT  = "https://claude.ai/api/mcp/callback";
const RESOURCE  = "https://preflight.app/api/mcp";

function mkGrant(over: Partial<OAuthGrant> = {}): OAuthGrant {
  const r = buildGrant({
    grant_id: "g1", registration_id: "reg1", client_id: "c1", user_id: "u1",
    resource: RESOURCE, scopes: ["read:all", "read:market"],
    entitlement_version: 3, nowIso: "2026-01-01T00:00:00Z",
  });
  if (!r.ok) throw new Error("fixture grant invalid: " + r.error);
  return { ...r.grant, ...over };
}

// Tranzacția legată de user "u1", ACELAȘI registration/client/resource ca grantul. `requested_scopes` DELIBERAT diferit
// de scopes-urile grantului → dovedește că payload.scopes vine din GRANT, nu din tranzacție.
function mkTxn(over: Partial<AuthzTransaction> = {}): AuthzTransaction {
  const r = buildAuthzTransaction({
    txn_id: "t1", csrf_token: "csrf1", registration_id: "reg1", client_id: "c1",
    redirect_uri: REDIRECT, state: "st", resource: RESOURCE,
    requested_scopes: ["read:basic"], code_challenge: CHALLENGE, code_challenge_method: "S256",
    now: 1000, ttlMs: 600000,
  });
  if (!r.ok) throw new Error("fixture txn invalid: " + r.error);
  return { ...r.txn, session_user_id: "u1", ...over };
}

function main(): void {
console.log("PH-2 step 10.3b-iv frunză 2 — buildUserAuthCodePayload (producător AuthCodePayload user, legat de txn)");

// ── (a) happy-path ───────────────────────────────────────────────────────────────
const okRes = buildUserAuthCodePayload({ grant: mkGrant(), txn: mkTxn(), issued_at: 1700 });
check("1. ⭐⭐⭐ grant + txn coerente → ok", okRes.ok === true);
const pl = okRes.ok ? okRes.payload : null;
check("2. ⭐⭐⭐ blob valid AuthCodePayload", pl !== null && isAuthCodePayload(pl));
check("3. ⭐⭐⭐ readAuthCodeIdentity → kind === 'user'", pl !== null && readAuthCodeIdentity(pl).kind === "user");

// ── (b) SINGLE-SOURCE: identitate + scopes + resource DIN GRANT ──────────────────
check("4. ⭐⭐⭐ client_id din grant", pl?.client_id === "c1");
check("5. ⭐⭐⭐ user_id din grant", pl?.user_id === "u1");
check("6. ⭐⭐⭐ grant_id din grant", pl?.grant_id === "g1");
check("7. ⭐⭐⭐ entitlement_version din grant", pl?.entitlement_version === 3);
check("8. ⭐⭐⭐ scopes din GRANT, nu din txn (txn cerea read:basic)", JSON.stringify(pl?.scopes) === JSON.stringify(["read:all", "read:market"]));
check("9. ⭐⭐ resource din grant (audience legat)", pl?.resource === RESOURCE);

// ── (c) transport DIN TRANZACȚIE ─────────────────────────────────────────────────
const txCustom = mkTxn({ redirect_uri: "https://claude.ai/api/mcp/other-cb" });
const rCustom = buildUserAuthCodePayload({ grant: mkGrant(), txn: txCustom, issued_at: 2 });
check("10. ⭐⭐⭐ redirect_uri vine DIN txn", rCustom.ok === true && rCustom.payload.redirect_uri === "https://claude.ai/api/mcp/other-cb");
check("11. ⭐⭐ code_challenge din txn", pl?.code_challenge === CHALLENGE);
check("12. ⭐ code_challenge_method S256 din txn", pl?.code_challenge_method === "S256");
check("13. ⭐ issued_at injectat", pl?.issued_at === 1700);

// ── (d) ANTI MIX-UP: cele 4 cross-check-uri txn↔grant ────────────────────────────
const misReg = buildUserAuthCodePayload({ grant: mkGrant(), txn: mkTxn({ registration_id: "regX" }), issued_at: 1 });
check("14. ⭐⭐⭐ registration_id txn ≠ grant → error (mix-up)", misReg.ok === false);

const misClient = buildUserAuthCodePayload({ grant: mkGrant(), txn: mkTxn({ client_id: "cX" }), issued_at: 1 });
check("15. ⭐⭐⭐ client_id txn ≠ grant → error (mix-up)", misClient.ok === false);

const misUser = buildUserAuthCodePayload({ grant: mkGrant(), txn: mkTxn({ session_user_id: "uX" }), issued_at: 1 });
check("16. ⭐⭐⭐ session_user_id txn ≠ user_id grant → error (mix-up: grant A + txn B)", misUser.ok === false);

const nullUser = buildUserAuthCodePayload({ grant: mkGrant(), txn: mkTxn({ session_user_id: null }), issued_at: 1 });
check("17. ⭐⭐⭐ session_user_id null (txn nelegată) → error", nullUser.ok === false);

const misRes = buildUserAuthCodePayload({ grant: mkGrant(), txn: mkTxn({ resource: "https://evil.example/api/mcp" }), issued_at: 1 });
check("18. ⭐⭐⭐ resource txn ≠ grant → error (mix-up audience)", misRes.ok === false);

// ── (e) fail-closed pe grant + PKCE + issued_at ──────────────────────────────────
const revoked = buildUserAuthCodePayload({ grant: mkGrant({ status: "revoked" }), txn: mkTxn(), issued_at: 1 });
check("19. ⭐⭐⭐ grant revocat → error", revoked.ok === false);

const noScopes = buildUserAuthCodePayload({ grant: mkGrant({ scopes: [] }), txn: mkTxn(), issued_at: 1 });
check("20. ⭐⭐⭐ grant fără scopes → error", noScopes.ok === false);

const corruptGrant = buildUserAuthCodePayload({ grant: mkGrant({ created_at: "" }), txn: mkTxn(), issued_at: 1 });
check("21. ⭐⭐⭐ grant cu created_at corupt → error (isValidGrant)", corruptGrant.ok === false);

const corruptReg = buildUserAuthCodePayload({ grant: mkGrant({ registration_id: "" }), txn: mkTxn({ registration_id: "" }), issued_at: 1 });
check("22. ⭐⭐ grant cu registration_id gol → error (isValidGrant, chiar dacă txn ar „potrivi\")", corruptReg.ok === false);

const badMethod = buildUserAuthCodePayload({ grant: mkGrant(), txn: mkTxn({ code_challenge_method: "plain" }), issued_at: 1 });
check("23. ⭐⭐⭐ PKCE method ≠ S256 în txn → error (downgrade blocat)", badMethod.ok === false);

const badChallenge = buildUserAuthCodePayload({ grant: mkGrant(), txn: mkTxn({ code_challenge: "short" }), issued_at: 1 });
check("24. ⭐⭐ PKCE challenge malformat în txn → error", badChallenge.ok === false);

const nanIssued = buildUserAuthCodePayload({ grant: mkGrant(), txn: mkTxn(), issued_at: NaN });
check("25. ⭐⭐ issued_at NaN → error", nanIssued.ok === false);

// ── (f) purity ───────────────────────────────────────────────────────────────────
const g = mkGrant();
const before = JSON.stringify(g.scopes);
const r2 = buildUserAuthCodePayload({ grant: g, txn: mkTxn(), issued_at: 5 });
check("26. ⭐⭐ nu mută grant.scopes", JSON.stringify(g.scopes) === before);
check("27. ⭐ payload.scopes e COPIE (referință diferită)", r2.ok === true && r2.payload.scopes !== g.scopes);

// ── (g) round-trip prin stocare ──────────────────────────────────────────────────
const roundTrip = pl !== null ? parseAuthCode(JSON.stringify(pl)) : null;
check("28. ⭐⭐⭐ round-trip: JSON → parseAuthCode → non-null (se stochează + recitește valid)", roundTrip !== null);
check("29. ⭐⭐⭐ round-trip → încă clasificat 'user'", roundTrip !== null && readAuthCodeIdentity(roundTrip).kind === "user");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
