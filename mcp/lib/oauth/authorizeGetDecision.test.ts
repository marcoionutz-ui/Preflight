/**
 * lib/oauth/authorizeGetDecision.test.ts — PH-2 pas 6 frunză 1 (decizia GET /authorize, pură).
 *
 * INITIAL (validează intern): registration/sesiune `unavailable` → 503 (NU invalid_client/login); invalid_client →
 * error_local; error_redirect → transportă redirect_uri+state; ok+sesiune → create_and_consent; ok+anonim → create_and_login.
 * RESUME: citește DOAR txn — unavailable(Redis)/session-unavailable → 503; absent/corupt/expirat/nelegat/anonim/mismatch
 * → error_local; găsită+neexpirată+user identic → render_consent.
 */
import { createHash } from "node:crypto";
import { decideAuthorizeGetOutcome, type SessionState } from "./authorizeGetDecision";
import { buildAuthzTransaction, type AuthzTransaction } from "./authzTransaction";
import { type AuthorizeParams, type AuthorizeRegistration } from "./authorizeRequestValidate";
import type { AuthorizeRegistrationLookup } from "../db/authorizeRegistrationLookup";
import type { AuthzTxnReadResult } from "../db/authzTxnStoreIo";
import { SERVER_SCOPE_CATALOG } from "./scopeCatalog";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const CH       = createHash("sha256").update("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").digest("base64url");
const ISSUER   = "https://preflight.app";
const REDIRECT = "https://claude.ai/api/mcp/callback";
const NOW = 1_800_000_000_000;
const TTL = 600_000;

function mkParams(over: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return { client_id: "c1", redirect_uri: REDIRECT, response_type: "code", scope: "read:all",
    code_challenge: CH, code_challenge_method: "S256", resource: "", state: "xyz", ...over };
}
function mkReg(over: Partial<AuthorizeRegistration> = {}): AuthorizeRegistration {
  return { registration_id: "reg1", client_id: "c1", status: "active",
    grant_types: ["authorization_code", "refresh_token"], expires_at: null, redirect_uris: [REDIRECT],
    client_name: "Claude", client_type: "public", token_endpoint_auth_method: "none", ...over };
}
const regFound: AuthorizeRegistrationLookup    = { status: "found", registration: mkReg() };
const regNotFound: AuthorizeRegistrationLookup = { status: "not_found" };
const regUnavail: AuthorizeRegistrationLookup  = { status: "unavailable", reason: "down" };
const sAuth = (userId: string): SessionState => ({ kind: "authenticated", userId });
const sAnon: SessionState   = { kind: "anonymous" };
const sUnavail: SessionState = { kind: "unavailable" };

function initial(over: Partial<{ params: AuthorizeParams; registration: AuthorizeRegistrationLookup; session: SessionState }> = {}) {
  return decideAuthorizeGetOutcome({ mode: "initial", params: over.params ?? mkParams(),
    registration: over.registration ?? regFound, session: over.session ?? sAnon,
    issuer: ISSUER, serverPolicy: SERVER_SCOPE_CATALOG, nowMs: NOW });
}

function mkTxn(over: Partial<AuthzTransaction> = {}): AuthzTransaction {
  const r = buildAuthzTransaction({ txn_id: "t1", csrf_token: "csrf1", grant_id: "g1", registration_id: "reg1",
    client_id: "c1", redirect_uri: REDIRECT, state: "st", resource: "https://preflight.app/api/mcp",
    requested_scopes: ["read:all"], code_challenge: CH, code_challenge_method: "S256", now: NOW, ttlMs: TTL });
  if (!r.ok) throw new Error("fixture: " + r.error);
  return { ...r.txn, ...over };
}
const foundRead = (txn: AuthzTransaction): AuthzTxnReadResult => ({ status: "found", txn, raw: JSON.stringify(txn) });
function resume(txnRead: AuthzTxnReadResult, session: SessionState, nowMs = NOW) {
  return decideAuthorizeGetOutcome({ mode: "resume", txnRead, session, nowMs });
}

function main(): void {
console.log("PH-2 pas 6 frunză 1 — decideAuthorizeGetOutcome (pur, stări discriminate)");

// ── INITIAL — outage-uri au precedență, NU se colapsează ─────────────────────────
check("1. ⭐⭐⭐ registration lookup unavailable → unavailable (503, NU invalid_client)", initial({ registration: regUnavail }).kind === "unavailable");
check("2. ⭐⭐⭐ session unavailable → unavailable (503, NU login)", initial({ session: sUnavail }).kind === "unavailable");
check("3. ⭐⭐⭐ registration unavailable + params invalide → tot unavailable (outage bate validarea)",
  initial({ registration: regUnavail, params: mkParams({ scope: "read:ghost" }) }).kind === "unavailable");

// ── INITIAL — validare ───────────────────────────────────────────────────────────
check("4. ⭐⭐⭐ registration not_found → error_local (validator invalid_client)", initial({ registration: regNotFound }).kind === "error_local");
check("5. ⭐⭐⭐ ok + sesiune → create_and_consent (request + userId)", (() => {
  const d = initial({ session: sAuth("u1") });
  return d.kind === "create_and_consent" && d.userId === "u1" && d.request.client_id === "c1";
})());
check("6. ⭐⭐⭐ ok + anonim → create_and_login", (() => {
  const d = initial({ session: sAnon });
  return d.kind === "create_and_login" && d.request.registration_id === "reg1";
})());

// ── INITIAL — error_redirect transportă redirect_uri + state ─────────────────────
check("7. ⭐⭐⭐ scope necunoscut → error_redirect (invalid_scope)", (() => {
  const d = initial({ params: mkParams({ scope: "read:ghost" }), session: sAuth("u1") });
  return d.kind === "error_redirect" && d.error === "invalid_scope";
})());
check("8. ⭐⭐⭐ error_redirect PĂSTREAZĂ redirect_uri + state trusted (nu recitite din query brut)", (() => {
  const d = initial({ params: mkParams({ scope: "read:ghost", state: "STATE123" }), session: sAnon });
  return d.kind === "error_redirect" && d.redirect_uri === REDIRECT && d.state === "STATE123";
})());
check("9. ⭐⭐ response_type ≠ code → error_redirect unsupported_response_type + redirect/state", (() => {
  const d = initial({ params: mkParams({ response_type: "token" }) });
  return d.kind === "error_redirect" && d.error === "unsupported_response_type" && d.redirect_uri === REDIRECT && d.state === "xyz";
})());
check("10. ⭐⭐ redirect netrusted → error_local (invalid_client, NU error_redirect)",
  initial({ params: mkParams({ redirect_uri: "https://evil.example/cb" }) }).kind === "error_local");

// ── RESUME ───────────────────────────────────────────────────────────────────────
check("11. ⭐⭐⭐ txnRead unavailable → unavailable (503)", resume({ status: "unavailable" }, sAuth("u1")).kind === "unavailable");
check("12. ⭐⭐ absent → error_local", resume({ status: "absent" }, sAuth("u1")).kind === "error_local");
check("13. ⭐⭐ corrupt → error_local", resume({ status: "corrupt" }, sAuth("u1")).kind === "error_local");
check("14. ⭐⭐⭐ found + expirat → error_local", resume(foundRead(mkTxn({ session_user_id: "u1" })), sAuth("u1"), NOW + TTL + 1).kind === "error_local");
check("15. ⭐⭐⭐ found + nelegat (session_user_id null) → error_local", resume(foundRead(mkTxn({ session_user_id: null })), sAuth("u1")).kind === "error_local");
check("16. ⭐⭐⭐ found + SESSION UNAVAILABLE → unavailable (503, NU error_local)", resume(foundRead(mkTxn({ session_user_id: "u1" })), sUnavail).kind === "unavailable");
check("17. ⭐⭐⭐ found + anonim → error_local (fără sesiune la resume)", resume(foundRead(mkTxn({ session_user_id: "u1" })), sAnon).kind === "error_local");
check("18. ⭐⭐⭐ found + MISMATCH (txn=u1, sesiune=u2) → error_local (account-switch)", resume(foundRead(mkTxn({ session_user_id: "u1" })), sAuth("u2")).kind === "error_local");
check("19. ⭐⭐⭐ found + neexpirat + user IDENTIC → render_consent (cu txn)", (() => {
  const txn = mkTxn({ session_user_id: "u1" });
  const d = resume(foundRead(txn), sAuth("u1"), NOW + 1000);
  return d.kind === "render_consent" && d.txn.txn_id === "t1" && d.txn.session_user_id === "u1";
})());
check("20. ⭐⭐ found + EXACT la expires_at → error_local (≥)", resume(foundRead(mkTxn({ session_user_id: "u1" })), sAuth("u1"), NOW + TTL).kind === "error_local");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
