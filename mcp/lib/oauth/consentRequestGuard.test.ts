/**
 * lib/oauth/consentRequestGuard.test.ts — PH-2 pas 6 frunză 5b-i (gărzi pure POST /consent).
 */
import { parseConsentForm, isSameOriginRequest, isFormUrlEncoded, MAX_CONSENT_BODY_BYTES } from "./consentRequestGuard";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const TXN = "abcdefghijklmnopqrstuvwxyz012345";                 // base64url 32 → isValidResumeTxnId
const CSRF = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";     // base64url 43
const ORIGIN = "https://preflight.app";
const enc = (o: Record<string, string>) => new URLSearchParams(o).toString();

function main(): void {
console.log("PH-2 pas 6 frunză 5b-i — consentRequestGuard (pur)");

// ── parseConsentForm ──────────────────────────────────────────────────────────────────────────────
{
  const r = parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF, action: "approve" }));
  check("1. ⭐⭐⭐ approve valid → ok cu cele 3 câmpuri", r.ok && r.txn_id === TXN && r.csrf_token === CSRF && r.action === "approve");
}
check("2. ⭐⭐ deny valid → ok", parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF, action: "deny" })).ok === true);
// duplicate (injecție de parametru) → reject pe FIECARE câmp
check("3. ⭐⭐⭐ txn_id duplicat → reject", parseConsentForm(`txn_id=${TXN}&txn_id=${TXN}&csrf_token=${CSRF}&action=approve`).ok === false);
check("4. ⭐⭐⭐ csrf_token duplicat → reject", parseConsentForm(`txn_id=${TXN}&csrf_token=${CSRF}&csrf_token=${CSRF}&action=approve`).ok === false);
check("5. ⭐⭐⭐ action duplicat → reject (approve+deny injectate)", parseConsentForm(`txn_id=${TXN}&csrf_token=${CSRF}&action=approve&action=deny`).ok === false);
// lipsă
check("6. ⭐⭐ txn_id lipsă → reject", parseConsentForm(enc({ csrf_token: CSRF, action: "approve" })).ok === false);
check("7. ⭐⭐ csrf_token lipsă → reject", parseConsentForm(enc({ txn_id: TXN, action: "approve" })).ok === false);
check("8. ⭐⭐ action lipsă → reject", parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF })).ok === false);
// format
check("9. ⭐⭐⭐ txn_id format invalid (spațiu) → reject", parseConsentForm(enc({ txn_id: "bad id!", csrf_token: CSRF, action: "approve" })).ok === false);
check("10. ⭐⭐⭐ txn_id prea scurt (<16) → reject", parseConsentForm(enc({ txn_id: "short", csrf_token: CSRF, action: "approve" })).ok === false);
check("11. ⭐⭐⭐ csrf format invalid (prea scurt) → reject", parseConsentForm(enc({ txn_id: TXN, csrf_token: "abc", action: "approve" })).ok === false);
check("12. ⭐⭐ csrf cu caracter nepermis (+) → reject", parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF.slice(0, -1) + "+", action: "approve" })).ok === false);
// action necunoscut TRECE parse (semantica e în decideConsentGrant, nu aici)
{
  const r = parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF, action: "bogus" }));
  check("13. ⭐⭐⭐ action necunoscut TRECE parse (ok, action='bogus') — semantica e în decide, nu în parse", r.ok === true && r.ok && r.action === "bogus");
}
// câmpuri extra irelevante ignorate + decode
{
  const r = parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF, action: "approve", junk: "x", state: "y" }));
  check("14. ⭐⭐ câmpuri extra ignorate → tot ok", r.ok === true);
}
// bounded input + action structural
check("14a. ⭐⭐⭐ body peste MAX_CONSENT_BODY_BYTES → reject (înainte de parsare)",
  parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF, action: "approve", pad: "x".repeat(MAX_CONSENT_BODY_BYTES) })).ok === false);
check("14b. ⭐⭐⭐ action gol → reject (structural, ne-gol)", parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF, action: "" })).ok === false);
check("14c. ⭐⭐⭐ action >32 caractere → reject", parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF, action: "a".repeat(33) })).ok === false);
check("14d. ⭐⭐ action cu caracter nepermis (cifră/spațiu) → reject", parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF, action: "approve1" })).ok === false && parseConsentForm(enc({ txn_id: TXN, csrf_token: CSRF, action: "ap prove" })).ok === false);
check("14e. ⭐⭐ MAX_CONSENT_BODY_BYTES rezonabil (4–8 KiB)", MAX_CONSENT_BODY_BYTES >= 4096 && MAX_CONSENT_BODY_BYTES <= 8192);

// ── isFormUrlEncoded ──────────────────────────────────────────────────────────────────────────────
check("14f. ⭐⭐⭐ form-urlencoded → true", isFormUrlEncoded("application/x-www-form-urlencoded") === true);
check("14g. ⭐⭐⭐ form-urlencoded + charset → true", isFormUrlEncoded("application/x-www-form-urlencoded; charset=utf-8") === true);
check("14h. ⭐⭐ case-insensitive → true", isFormUrlEncoded("Application/X-WWW-Form-Urlencoded") === true);
check("14i. ⭐⭐⭐ JSON → false", isFormUrlEncoded("application/json") === false);
check("14j. ⭐⭐⭐ multipart → false", isFormUrlEncoded("multipart/form-data; boundary=xyz") === false);
check("14k. ⭐⭐⭐ lipsă (null/undefined) → false", isFormUrlEncoded(null) === false && isFormUrlEncoded(undefined) === false);
check("14l. ⭐⭐ gol → false", isFormUrlEncoded("") === false);

// ── isSameOriginRequest ───────────────────────────────────────────────────────────────────────────
check("15. ⭐⭐⭐ Origin === canonic → true", isSameOriginRequest(ORIGIN, null, ORIGIN) === true);
check("16. ⭐⭐⭐ Origin ≠ canonic → false (CSRF blocat)", isSameOriginRequest("https://evil.test", null, ORIGIN) === false);
check("17. ⭐⭐⭐ Origin 'null' (opac) → false", isSameOriginRequest("null", null, ORIGIN) === false);
check("18. ⭐⭐⭐ Origin AUTORITAR: Origin greșit + Referer bun → false (Origin câștigă)", isSameOriginRequest("https://evil.test", ORIGIN + "/authorize", ORIGIN) === false);
check("19. ⭐⭐⭐ fără Origin, Referer === canonic → true", isSameOriginRequest(null, ORIGIN + "/authorize?txn_id=x", ORIGIN) === true);
check("20. ⭐⭐⭐ fără Origin, Referer ≠ canonic → false", isSameOriginRequest(null, "https://evil.test/x", ORIGIN) === false);
check("21. ⭐⭐⭐ nici Origin nici Referer → false (fail-closed pe POST)", isSameOriginRequest(null, null, ORIGIN) === false);
check("22. ⭐⭐⭐ nici Origin nici Referer (goale) → false", isSameOriginRequest("", "", ORIGIN) === false);
check("23. ⭐⭐ port diferit → false", isSameOriginRequest("https://preflight.app:8443", null, ORIGIN) === false);
check("24. ⭐⭐ scheme diferit (http vs https) → false", isSameOriginRequest("http://preflight.app", null, ORIGIN) === false);
check("25. ⭐⭐⭐ canonic cu PATH PREFIX → doar originea contează (Origin fără path se potrivește)", isSameOriginRequest(ORIGIN, null, ORIGIN + "/base/path") === true);
check("26. ⭐⭐⭐ origine canonică coruptă → false (fail-closed)", isSameOriginRequest(ORIGIN, null, "not a url") === false);
check("27. ⭐⭐ Referer cu path + query se normalizează la origine → true", isSameOriginRequest(null, ORIGIN + "/a/b/c?q=1#frag", ORIGIN) === true);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
