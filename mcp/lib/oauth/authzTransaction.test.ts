/**
 * lib/oauth/authzTransaction.test.ts — PH-2a GUARD (tranzacție de consent: build/bind sticky/expiry/validare/decizie).
 */
import {
  buildAuthzTransaction, bindUser, isTransactionExpired, isValidAuthzTransaction, verifyConsentSubmission,
  type AuthzTransaction,
} from "./authzTransaction";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const NOW = 1_700_000_000_000;
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // 43 base64url canonic
const baseParams = {
  txn_id: "txn_abc", csrf_token: "csrf_xyz", grant_id: "grant_1", registration_id: "reg_1", client_id: "tp_x",
  redirect_uri: "http://127.0.0.1:5000/cb", state: "st1", resource: "https://preflight.app/api/mcp",
  requested_scopes: ["read:pair", "read:market"], code_challenge: CHALLENGE, code_challenge_method: "S256",
  now: NOW, ttlMs: 300_000,
};
function txn(over: Partial<AuthzTransaction> = {}): AuthzTransaction {
  const built = buildAuthzTransaction(baseParams);
  if (!built.ok) throw new Error("build failed: " + built.error);
  return { ...built.txn, session_user_id: "userA", ...over }; // implicit user legat = userA
}
const submit = (action: string, over: Partial<{ txn_id: string; csrf_token: string }> = {}) =>
  ({ txn_id: "txn_abc", csrf_token: "csrf_xyz", action, ...over });

function main(): void {
console.log("PH-2a — authzTransaction (consent one-time + session-bound, pur)");

// ── build ─────────────────────────────────────────────────────────────────────
{
  const r = buildAuthzTransaction(baseParams);
  check("1. build valid → ok", r.ok === true);
  check("2. ⭐ session_user_id null inițial", r.ok && r.txn.session_user_id === null);
  check("3. expires_at = now + ttl", r.ok && r.txn.expires_at === NOW + 300_000);
}
check("4. ⭐ method ≠ S256 → error (downgrade blocat, via helper PKCE)", buildAuthzTransaction({ ...baseParams, code_challenge_method: "plain" }).ok === false);
check("5. ⭐ challenge malformat → error (PKCE RFC 7636)", buildAuthzTransaction({ ...baseParams, code_challenge: "prea-scurt" }).ok === false);
check("6. ⭐ fără redirect_uri → error", buildAuthzTransaction({ ...baseParams, redirect_uri: "" }).ok === false);
check("7. ttl 0 → error", buildAuthzTransaction({ ...baseParams, ttlMs: 0 }).ok === false);
check("7b. ⭐⭐ fără grant_id → error (sticky obligatoriu)", buildAuthzTransaction({ ...baseParams, grant_id: "" }).ok === false);
check("7c. ⭐ build valid → grant_id propagat în txn", (() => { const r = buildAuthzTransaction(baseParams); return r.ok && r.txn.grant_id === "grant_1"; })());

// ── bindUser STICKY (cgpt P1#1) ───────────────────────────────────────────────
{
  const t0 = (buildAuthzTransaction(baseParams) as { ok: true; txn: AuthzTransaction }).txn; // unbound
  const b1 = bindUser(t0, "userA");
  check("8. ⭐ bind pe tranzacție nelegată → ok + set user", b1.ok && b1.txn.session_user_id === "userA");
  check("9. bindUser nu mutează originalul", t0.session_user_id === null);
  const bound = txn({ session_user_id: "userA" });
  check("10. ⭐ bind același user → ok (idempotent)", (() => { const r = bindUser(bound, "userA"); return r.ok && r.txn.session_user_id === "userA"; })());
  check("11. ⭐⭐⭐ rebind la ALT user → RESPINS (account-switch nu preia tranzacția)", bindUser(bound, "userB").ok === false);
  check("12. bind user gol → error", bindUser(t0, "").ok === false);
}

// ── isTransactionExpired fail-closed (cgpt P1#2) ──────────────────────────────
check("13. înainte de expirare → nu expirat", isTransactionExpired(txn(), NOW + 1000) === false);
check("14. ⭐ exact la expires_at → expirat (≥)", isTransactionExpired(txn(), NOW + 300_000) === true);
check("15. ⭐ now invalid (NaN) → expirat", isTransactionExpired(txn(), NaN) === true);
check("16. ⭐⭐ expires_at NaN → EXPIRAT (nu fail-open)", isTransactionExpired({ expires_at: NaN }, NOW) === true);
check("17. ⭐ expires_at undefined → expirat", isTransactionExpired({ expires_at: undefined as unknown as number }, NOW) === true);

// ── isValidAuthzTransaction (citire din Redis) ────────────────────────────────
{
  const good = txn();
  check("18. ⭐ tranzacție validă → true", isValidAuthzTransaction(good));
  check("19. ⭐⭐ expires_at ≤ created_at → false", !isValidAuthzTransaction({ ...good, expires_at: good.created_at }));
  check("20. ⭐⭐ expires_at NaN → false", !isValidAuthzTransaction({ ...good, expires_at: NaN }));
  check("21. ⭐⭐ challenge malformat → false (via helper PKCE)", !isValidAuthzTransaction({ ...good, code_challenge: "x" }));
  check("22. ⭐ method plain → false", !isValidAuthzTransaction({ ...good, code_challenge_method: "plain" }));
  check("23. ⭐ requested_scopes cu '' → false", !isValidAuthzTransaction({ ...good, requested_scopes: ["read:pair", ""] }));
  check("24. ⭐ requested_scopes non-array → false", !isValidAuthzTransaction({ ...good, requested_scopes: "read:pair" as unknown as string[] }));
  check("25. ⭐ session_user_id null e OK (înainte de login)", isValidAuthzTransaction({ ...good, session_user_id: null }));
  check("26. ⭐ session_user_id number → false", !isValidAuthzTransaction({ ...good, session_user_id: 5 as unknown as string }));
  check("27. lipsă txn_id → false", !isValidAuthzTransaction({ ...good, txn_id: "" }));
  check("27b. ⭐⭐ lipsă grant_id → false (fail-closed la citire)", !isValidAuthzTransaction({ ...good, grant_id: "" }));
  check("28. null → false", !isValidAuthzTransaction(null));
}

// ── verifyConsentSubmission legat de userul sesiunii CURENTE (cgpt P1#1) ───────
check("29. ⭐⭐ approve, session curent = userA (legat) → approve", verifyConsentSubmission(txn(), submit("approve"), NOW, "userA").decision === "approve");
check("30. ⭐⭐⭐ deny, session curent = userA → deny", verifyConsentSubmission(txn(), submit("deny"), NOW, "userA").decision === "deny");
check("31. ⭐⭐⭐ ACCOUNT-SWITCH: txn legată de userA, session curent userB → reject", verifyConsentSubmission(txn(), submit("approve"), NOW, "userB").decision === "reject");
check("32. ⭐⭐⭐ logout: session curent null → reject", verifyConsentSubmission(txn(), submit("approve"), NOW, null).decision === "reject");
check("33. ⭐⭐ session curent gol → reject", verifyConsentSubmission(txn(), submit("approve"), NOW, "").decision === "reject");
check("34. ⭐⭐ txn fără user legat (session_user_id null) → reject chiar dacă session curent are user", verifyConsentSubmission(txn({ session_user_id: null }), submit("approve"), NOW, "userA").decision === "reject");
check("35. ⭐⭐ txn null (consumată) → reject", verifyConsentSubmission(null, submit("approve"), NOW, "userA").decision === "reject");
check("36. ⭐⭐ txn_id mismatch → reject", verifyConsentSubmission(txn(), submit("approve", { txn_id: "other" }), NOW, "userA").decision === "reject");
check("37. ⭐⭐⭐ CSRF mismatch → reject", verifyConsentSubmission(txn(), submit("approve", { csrf_token: "WRONG" }), NOW, "userA").decision === "reject");
check("38. ⭐ CSRF gol → reject", verifyConsentSubmission(txn(), submit("approve", { csrf_token: "" }), NOW, "userA").decision === "reject");
check("39. ⭐ expirat → reject (chiar cu approve + csrf + user corect)", verifyConsentSubmission(txn(), submit("approve"), NOW + 300_000, "userA").decision === "reject");
check("40. ⭐ action necunoscută → reject", verifyConsentSubmission(txn(), submit("delete"), NOW, "userA").decision === "reject");
check("41. ⭐ ordine fail-closed: CSRF greșit bate chiar și un deny", verifyConsentSubmission(txn(), submit("deny", { csrf_token: "WRONG" }), NOW, "userA").decision === "reject");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
