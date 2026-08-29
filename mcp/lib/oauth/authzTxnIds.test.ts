/**
 * lib/oauth/authzTxnIds.test.ts — PH-2 pas 6 frunză 3b-i (generatoare id tranzacție consent).
 *
 * Contracte de FORMĂ: txn_id trece `isValidResumeTxnId` (round-trip cookie/resume — CRITIC), csrf opac ne-gol, grant_id
 * e UUID (coloana uuid). Plus unicitate pe o baterie de apeluri (nu constante).
 */
import { newAuthzTxnId, newAuthzCsrfToken, newAuthzGrantId } from "./authzTxnIds";
import { isValidResumeTxnId } from "./sessionResume";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function main(): void {
console.log("PH-2 pas 6 frunză 3b-i — authzTxnIds (generatoare id tranzacție)");

// ── newAuthzTxnId: round-trip cu validatorul de cookie/resume ──────────────────────
check("1. ⭐⭐⭐ newAuthzTxnId() trece isValidResumeTxnId (round-trip cookie/resume garantat)",
  isValidResumeTxnId(newAuthzTxnId()));
check("2. ⭐⭐⭐ 200 de txn_id-uri consecutive TOATE trec isValidResumeTxnId", (() => {
  for (let i = 0; i < 200; i++) if (!isValidResumeTxnId(newAuthzTxnId())) return false;
  return true;
})());
check("3. ⭐⭐ txn_id e base64url (charset)", BASE64URL_RE.test(newAuthzTxnId()));
check("4. ⭐⭐ txn_id lungime în [16,128] (32 aici)", (() => { const t = newAuthzTxnId(); return t.length >= 16 && t.length <= 128; })());
check("5. ⭐⭐⭐ txn_id-uri UNICE pe o baterie (nu constantă)", (() => {
  const s = new Set<string>(); for (let i = 0; i < 500; i++) s.add(newAuthzTxnId()); return s.size === 500;
})());

// ── newAuthzCsrfToken ──────────────────────────────────────────────────────────────
check("6. ⭐⭐ csrf opac ne-gol + base64url", (() => { const c = newAuthzCsrfToken(); return c.length > 0 && BASE64URL_RE.test(c); })());
check("7. ⭐⭐ csrf lungime rezonabilă (32B → ~43 chars)", newAuthzCsrfToken().length >= 40);
check("8. ⭐⭐⭐ csrf UNIC pe o baterie", (() => {
  const s = new Set<string>(); for (let i = 0; i < 500; i++) s.add(newAuthzCsrfToken()); return s.size === 500;
})());

// ── newAuthzGrantId: UUID (coloana uuid) ───────────────────────────────────────────
check("9. ⭐⭐⭐ newAuthzGrantId() e UUID valid (coloana oauth_grants.grant_id e uuid)", UUID_RE.test(newAuthzGrantId()));
check("10. ⭐⭐ grant_id UNIC pe o baterie", (() => {
  const s = new Set<string>(); for (let i = 0; i < 500; i++) s.add(newAuthzGrantId()); return s.size === 500;
})());
check("11. ⭐⭐ grant_id NU e base64url-de-32 (e UUID, formă distinctă de txn_id)", (() => {
  const g = newAuthzGrantId();
  return g.includes("-") && g.length === 36; // UUID canonic, nu se confundă cu txn_id
})());

// ── cele trei sunt independente (nu împart valoarea) ───────────────────────────────
check("12. ⭐ txn_id ≠ csrf ≠ grant_id (surse independente)", (() => {
  const t = newAuthzTxnId(), c = newAuthzCsrfToken(), g = newAuthzGrantId();
  return t !== c && c !== g && t !== g;
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
