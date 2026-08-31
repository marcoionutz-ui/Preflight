/**
 * lib/oauth/authorizeConsent.test.ts — PH-2 step 10.3a GUARD (grant post-consimțământ, pur).
 */
import { decideConsentGrant, type RegistrationRef } from "./authorizeConsent";
import { buildAuthzTransaction, bindUser, type AuthzTransaction } from "./authzTransaction";
import type { AccountEntitlement } from "./entitlement";
import { isValidGrant } from "./grant";
import { buildGrantInsertRow, grantRowMatchesGrant } from "../db/grantInsert";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // 43 base64url (RFC 7636)
const NOW_MS = 1_800_000_000_000;
const RES = "https://preflight.app/api/mcp";
const POLICY = ["read:basic", "read:all", "read:market", "read:pair", "read:safety"];

function makeTxn(userId: string | null, scopes: string[] = ["read:pair"], clientId = "c1"): AuthzTransaction {
  const b = buildAuthzTransaction({
    txn_id: "t1", csrf_token: "csrf1", grant_id: "g1", registration_id: "reg1", client_id: clientId, redirect_uri: "https://claude.ai/cb",
    state: "st", resource: RES, requested_scopes: scopes, code_challenge: CHALLENGE, code_challenge_method: "S256",
    now: NOW_MS, ttlMs: 300_000,
  });
  if (!b.ok) throw new Error(b.error);
  if (userId === null) return b.txn;
  const bound = bindUser(b.txn, userId);
  if (!bound.ok) throw new Error(bound.error);
  return bound.txn;
}

const account: AccountEntitlement = {
  user_id: "u1", plan: "pro", scopes: ["read:all"], rate_limit_per_minute: 60, rate_limit_per_day: 10000,
  status: "active", entitlement_version: 4,
};
const registration: RegistrationRef = {
  registration_id: "reg1", client_id: "c1", status: "active", grant_types: ["authorization_code", "refresh_token", "client_credentials"],
  expires_at: null,
};
const base = {
  txn: makeTxn("u1"),
  presented: { txn_id: "t1", csrf_token: "csrf1", action: "approve" },
  currentSessionUserId: "u1" as string | null,
  registration,
  account,
  serverPolicy: POLICY,
  nowMs: NOW_MS + 1000,
};

function main(): void {
console.log("PH-2 step 10.3a — authorizeConsent (grant post-consimțământ, pur)");

// ── happy path ─────────────────────────────────────────────────────────────────
{
  const d = decideConsentGrant(base);
  check("1. ⭐⭐⭐ approve + registration legat + cont valid → grant", d.kind === "grant");
  if (d.kind === "grant") {
    check("2. ⭐⭐ grant valid + user_id din cont/tranzacție", isValidGrant(d.grant) && d.grant.user_id === "u1");
    check("3. ⭐⭐⭐ claims consistente", d.claims.grant_id === d.grant.grant_id && d.claims.entitlement_version === 4);
    check("4. ⭐⭐ scope derivat din TRANZACȚIE (read:pair) + rezolvat prin cont", JSON.stringify(d.grant.scopes) === JSON.stringify(["read:pair"]));
    check("5. registration_id legat", d.grant.registration_id === "reg1" && d.grant.client_id === "c1");
    check("5b. ⭐⭐⭐ grant.grant_id preia grant_id-ul STICKY din txn (nu param liber)", d.grant.grant_id === base.txn.grant_id);
  }
}
// STICKY: un txn cu alt grant_id → grantul preia EXACT acel grant_id (dovadă că vine din txn, nu injectat).
{
  const d = decideConsentGrant({ ...base, txn: { ...makeTxn("u1"), grant_id: "g_sticky_xyz" } });
  check("5c. ⭐⭐⭐ grant_id din txn se propagă în grant (txn.grant_id ≠ default → grant îl preia)",
    d.kind === "grant" && d.grant.grant_id === "g_sticky_xyz");
}
// STICKY created_at + IDEMPOTENȚĂ pe RETRY (blocker cgpt P1#2): același txn + `now` diferit la a doua încercare →
// grant BYTE-IDENTIC, deci insertGrant read-back dă `already_present`, NU `conflict` fals.
{
  const txn = makeTxn("u1");
  const d1 = decideConsentGrant({ ...base, txn, nowMs: NOW_MS + 1000 });
  const d2 = decideConsentGrant({ ...base, txn, nowMs: NOW_MS + 200_000 }); // retry mai TÂRZIU, dar în fereastra txn (alt "acum")
  const both = d1.kind === "grant" && d2.kind === "grant";
  check("5d. ⭐⭐⭐ created_at DETERMINIST din txn.created_at (nu din now)",
    both && d1.kind === "grant" && d1.grant.created_at === new Date(txn.created_at).toISOString());
  check("5e. ⭐⭐⭐ retry cu now DIFERIT → created_at IDENTIC (nu se plimbă cu timpul)",
    both && d1.kind === "grant" && d2.kind === "grant" && d1.grant.created_at === d2.grant.created_at);
  check("5f. ⭐⭐⭐ retry IDEMPOTENT: read-back al grantului #1 se potrivește cu grantul #2 → already_present (NU conflict)",
    both && d1.kind === "grant" && d2.kind === "grant" && grantRowMatchesGrant(buildGrantInsertRow(d1.grant), d2.grant));
}
// created_at FINIT dar în afara range-ului Date (1e20 ms) → error, NU throw (toISOString ar arunca RangeError).
check("5g. ⭐⭐⭐ created_at finit dar în afara range Date → error (fără throw)", (() => {
  const d = decideConsentGrant({ ...base, txn: { ...makeTxn("u1"), created_at: 1e20, expires_at: 1e20 + 300_000 } });
  return d.kind === "error" && d.reason.includes("created_at");
})());

// ── consent GATE (cgpt #3): grant IMPOSIBIL fără approve verificat ───────────────
check("6. ⭐⭐⭐ action=deny → denied (NU grant)", decideConsentGrant({ ...base, presented: { ...base.presented, action: "deny" } }).kind === "denied");
check("7. ⭐⭐⭐ action necunoscută → reject (nu grant)", decideConsentGrant({ ...base, presented: { ...base.presented, action: "bogus" } }).kind === "reject");
check("8. ⭐⭐⭐ csrf greșit → reject", decideConsentGrant({ ...base, presented: { ...base.presented, csrf_token: "WRONG" } }).kind === "reject");
check("9. ⭐⭐⭐ tranzacție expirată → reject", decideConsentGrant({ ...base, nowMs: NOW_MS + 400_000 }).kind === "reject");
check("10. ⭐⭐⭐ session curent ≠ user legat (account-switch) → reject", decideConsentGrant({ ...base, currentSessionUserId: "u2" }).kind === "reject");
check("11. ⭐⭐⭐ session curent null (logout) → reject", decideConsentGrant({ ...base, currentSessionUserId: null }).kind === "reject");
check("12. ⭐⭐ txn null → reject", decideConsentGrant({ ...base, txn: null }).kind === "reject");
check("13. ⭐⭐⭐ txn nelegată de user (session_user_id null) → reject (fără user autentificat)", decideConsentGrant({ ...base, txn: makeTxn(null), currentSessionUserId: "u1" }).kind === "reject");
check("14. ⭐⭐ txn_id prezentat greșit → reject", decideConsentGrant({ ...base, presented: { ...base.presented, txn_id: "OTHER" } }).kind === "reject");

// ── registration GATE (cgpt #1): legat de client + activ + authorization_code ────
check("15. ⭐⭐⭐ registration.client_id ≠ txn.client_id → error (grant cu registration de la alt client BLOCAT)",
  (() => { const d = decideConsentGrant({ ...base, registration: { ...registration, client_id: "OTHER_CLIENT" } }); return d.kind === "error" && d.reason.includes("mismatch"); })());
check("16. ⭐⭐ registration lipsă → error", decideConsentGrant({ ...base, registration: null }).kind === "error");
check("17. ⭐⭐ registration status suspended → error", decideConsentGrant({ ...base, registration: { ...registration, status: "suspended" } }).kind === "error");
check("18. ⭐⭐ registration status revoked → error", decideConsentGrant({ ...base, registration: { ...registration, status: "revoked" } }).kind === "error");
check("19. ⭐⭐⭐ registration fără authorization_code în grant_types → error", decideConsentGrant({ ...base, registration: { ...registration, grant_types: ["client_credentials"] } }).kind === "error");
check("19a. ⭐⭐⭐ registration_id ≠ cel din txn (altă registration a ACELUIAȘI client) → error", (() => { const d = decideConsentGrant({ ...base, registration: { ...registration, registration_id: "reg_OTHER" } }); return d.kind === "error" && d.reason.includes("registration_id mismatch"); })());
check("19b. ⭐⭐⭐ registration expirată (expires_at ≤ now) deși active → error", (() => { const d = decideConsentGrant({ ...base, registration: { ...registration, expires_at: NOW_MS - 1 } }); return d.kind === "error" && d.reason.includes("expirat"); })());
check("19c. ⭐⭐ registration cu expires_at în viitor → OK (grant)", decideConsentGrant({ ...base, registration: { ...registration, expires_at: NOW_MS + 1_000_000 } }).kind === "grant");
check("19d. ⭐ registration expires_at exact = nowMs → error (strict în viitor, nu ≥)", decideConsentGrant({ ...base, registration: { ...registration, expires_at: base.nowMs } }).kind === "error");

// ── account GATE ────────────────────────────────────────────────────────────────
check("20. ⭐⭐ cont lipsă → error", decideConsentGrant({ ...base, account: null }).kind === "error");
check("21. ⭐⭐⭐ cont pentru alt user decât tranzacția → error (mismatch)", (() => { const d = decideConsentGrant({ ...base, account: { ...account, user_id: "u2" } }); return d.kind === "error" && d.reason.includes("mismatch"); })());
check("22. ⭐⭐ cont suspended → error", decideConsentGrant({ ...base, account: { ...account, status: "suspended" } }).kind === "error");
check("23. ⭐⭐ cont fără scopes → error", decideConsentGrant({ ...base, account: { ...account, scopes: [] } }).kind === "error");

// ── scope boundary derivat din TRANZACȚIE (nu din param liber) ──────────────────
{
  // txn cere read:market+read:pair; cont doar read:pair → grant DOAR read:pair
  const d = decideConsentGrant({ ...base, txn: makeTxn("u1", ["read:market", "read:pair"]), account: { ...account, scopes: ["read:pair"] } });
  check("24. ⭐⭐⭐ scope cerut necoperit de cont → exclus (doar read:pair), derivat din txn", d.kind === "grant" && JSON.stringify((d as { grant: { scopes: string[] } }).grant.scopes) === JSON.stringify(["read:pair"]));
}
check("25. ⭐⭐⭐ txn cere doar scope în afara policy → niciun scope acordat → error (nu grant gol)",
  decideConsentGrant({ ...base, txn: makeTxn("u1", ["read:secret_not_in_policy"]) }).kind === "error");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
