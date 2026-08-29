/**
 * lib/oauth/sessionResume.test.ts — PH-2 pas 6 frunză 2a (clasificator sesiune + cookie resume, PUR).
 *
 * Acoperă: `classifySessionResult` (eroare → unavailable; data null/undefined → unavailable; user null → anonymous;
 * id gol/whitespace/non-string → anonymous NICIODATĂ authenticated(""); id valid → authenticated; eroare+user →
 * unavailable — eroarea bate). Plus cookie-ul de resume: atribute fixe (HttpOnly/SameSite=Lax/Path=//secure injectat),
 * Max-Age ≤ 600 la set + 0 la clear, `isValidResumeTxnId` (charset + lungime).
 */
import {
  classifySessionResult,
  resumeCookieSetAttrs,
  resumeCookieClearAttrs,
  isValidResumeTxnId,
  AUTHZ_RESUME_COOKIE,
  AUTHZ_RESUME_MAX_AGE_SEC,
} from "./sessionResume";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 pas 6 frunză 2a — sessionResume (clasificator sesiune + cookie, pur)");

// ── 1) classifySessionResult ─────────────────────────────────────────────────────
// AuthSessionMissingError = vizitator DELOGAT legit (supabase-js#1024) → anonymous, NU 503.
const authSessionMissing = { name: "AuthSessionMissingError", message: "Auth session missing!" };
check("1. ⭐⭐⭐ AuthSessionMissingError (name) + user null → anonymous (delogat legit → login, NU 503)",
  classifySessionResult({ user: null }, authSessionMissing).kind === "anonymous");
check("2. ⭐⭐⭐ AuthSessionMissingError detectat și doar pe mesaj → anonymous",
  classifySessionResult({ user: null }, { message: "Auth session missing!" }).kind === "anonymous");
check("2b. ⭐⭐⭐ AuthSessionMissingError + user PREZENT → unavailable (combinație anormală, NU anonim)",
  classifySessionResult({ user: { id: "u1" } }, authSessionMissing).kind === "unavailable");
check("2c. ⭐⭐⭐ AuthSessionMissingError + data ABSENT (null) → unavailable (contract încălcat)",
  classifySessionResult(null, authSessionMissing).kind === "unavailable");
check("3. ⭐⭐⭐ ALTĂ eroare → unavailable (outage → 503, NU login)",
  classifySessionResult({ user: null }, { name: "AuthRetryableFetchError", message: "network down" }).kind === "unavailable");
check("4. ⭐⭐⭐ eroare generică (fără name) → unavailable",
  classifySessionResult({ user: { id: "u1" } }, { message: "boom" }).kind === "unavailable");
check("5. ⭐⭐ eroare + user prezent (non-AuthSessionMissing) → unavailable (eroarea are precedență)",
  classifySessionResult({ user: { id: "u1" } }, { name: "AuthApiError", message: "500" }).kind === "unavailable");
check("6. ⭐⭐⭐ data null → unavailable (răspuns neașteptat → fail-closed)",
  classifySessionResult(null, null).kind === "unavailable");
check("7. ⭐⭐⭐ data undefined → unavailable",
  classifySessionResult(undefined, null).kind === "unavailable");
check("8. ⭐⭐⭐ user === null, fără eroare → anonymous (compat)",
  classifySessionResult({ user: null }, null).kind === "anonymous");
check("9. ⭐⭐⭐ user absent ({}) → unavailable (proprietate absentă → corupt, NU anonim)",
  classifySessionResult({}, null).kind === "unavailable");
check("10. ⭐⭐ user undefined explicit → unavailable",
  classifySessionResult({ user: undefined }, null).kind === "unavailable");
check("11. ⭐⭐⭐ id valid → authenticated cu userId", (() => {
  const s = classifySessionResult({ user: { id: "u-123" } }, null);
  return s.kind === "authenticated" && s.userId === "u-123";
})());
check("12. ⭐⭐⭐ user prezent + id gol '' → unavailable (corupt, NU anonim, NU authenticated(''))",
  classifySessionResult({ user: { id: "" } }, null).kind === "unavailable");
check("13. ⭐⭐⭐ user prezent + id whitespace '   ' → unavailable (corupt)",
  classifySessionResult({ user: { id: "   " } }, null).kind === "unavailable");
check("14. ⭐⭐⭐ user prezent + id ` u1 ` (whitespace la margini) → unavailable (răspuns corupt, NU authenticated)",
  classifySessionResult({ user: { id: " u1 " } }, null).kind === "unavailable");
check("15. ⭐⭐ user prezent + id non-string (number) → unavailable",
  classifySessionResult({ user: { id: 42 } }, null).kind === "unavailable");
check("16. ⭐⭐ user prezent + id null → unavailable",
  classifySessionResult({ user: { id: null } }, null).kind === "unavailable");
check("17. ⭐⭐ UUID Supabase real → authenticated (păstrat exact)", (() => {
  const uuid = "8f3b1c2e-4d5a-6b7c-8d9e-0a1b2c3d4e5f";
  const s = classifySessionResult({ user: { id: uuid } }, null);
  return s.kind === "authenticated" && s.userId === uuid;
})());

// ── 2) cookie de resume ───────────────────────────────────────────────────────────
check("18. ⭐⭐ numele cookie-ului stabil", AUTHZ_RESUME_COOKIE === "ph2_authz_txn");
check("19. ⭐⭐⭐ set: HttpOnly + SameSite=Lax + Path=/ + Max-Age = fereastra consent", (() => {
  const a = resumeCookieSetAttrs(true);
  return a.httpOnly === true && a.sameSite === "lax" && a.path === "/" && a.maxAge === AUTHZ_RESUME_MAX_AGE_SEC;
})());
check("20. ⭐⭐⭐ Max-Age ≤ 600 (== fereastra de consent)", AUTHZ_RESUME_MAX_AGE_SEC <= 600 && AUTHZ_RESUME_MAX_AGE_SEC === 600);
check("21. ⭐⭐⭐ set secure=true în prod, false în dev (injectat)",
  resumeCookieSetAttrs(true).secure === true && resumeCookieSetAttrs(false).secure === false);
check("22. ⭐⭐⭐ clear: Max-Age 0 (păstrează HttpOnly/Lax/Path/secure)", (() => {
  const a = resumeCookieClearAttrs(true);
  return a.maxAge === 0 && a.httpOnly === true && a.sameSite === "lax" && a.path === "/" && a.secure === true;
})());

// ── 3) isValidResumeTxnId ───────────────────────────────────────────────────────────
check("23. ⭐⭐⭐ txn_id valid (base64url 32) → true", isValidResumeTxnId("aB3_dE7-fG9hIjKlMnOpQrStUvWxYz12") === true);
check("24. ⭐⭐ hex 16 minim → true", isValidResumeTxnId("0123456789abcdef") === true);
check("25. ⭐⭐⭐ prea scurt (<16) → false", isValidResumeTxnId("short") === false);
check("26. ⭐⭐⭐ charset invalid (spațiu/junk) → false", isValidResumeTxnId("aaaaaaaaaaaaaaaa bbb") === false);
check("27. ⭐⭐ charset invalid (punct/slash) → false", isValidResumeTxnId("../etc/passwd/aaaaaaaa") === false);
check("28. ⭐⭐ non-string → false", isValidResumeTxnId(12345678901234567 as unknown) === false);
check("29. ⭐⭐ null/undefined → false", isValidResumeTxnId(null) === false && isValidResumeTxnId(undefined) === false);
check("30. ⭐⭐ prea lung (>128) → false", isValidResumeTxnId("a".repeat(129)) === false);
check("31. ⭐⭐ exact 128 → true", isValidResumeTxnId("a".repeat(128)) === true);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
