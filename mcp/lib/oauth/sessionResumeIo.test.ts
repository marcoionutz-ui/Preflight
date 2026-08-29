/**
 * lib/oauth/sessionResumeIo.test.ts — PH-2 pas 6 frunză 2b (GUARD de sursă pe wiring-ul I/O sesiune + cookie).
 *
 * `sessionResumeIo.ts` importă `next/headers` + `@/lib/supabase/server` → NU e importabil în tsx. Îl verificăm ca TEXT
 * (fără import), la fel ca celelalte *Wiring.test.ts, ca gate-ul WSL să rămână verde. Ancore: (1) I/O real din sursele
 * corecte; (2) getSessionState deleagă TOATĂ decizia la `classifySessionResult` (nu re-implementează clasificarea) și
 * prinde throw-ul → unavailable; (3) cookie-urile folosesc primitivele pure + gate-ul de validare la citire/scriere.
 * cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 pas 6 frunză 2b — sessionResumeIo (guard de sursă)");

const io = readFileSync("lib/oauth/sessionResumeIo.ts", "utf8");

// ── importuri: I/O real + primitive pure ──────────────────────────────────────────
check("1. ⭐⭐⭐ importă cookies din next/headers", /import\s*\{\s*cookies\s*\}\s*from\s*"next\/headers"/.test(io));
check("2. ⭐⭐⭐ importă createClient din @/lib/supabase/server", /import\s*\{\s*createClient\s*\}\s*from\s*"@\/lib\/supabase\/server"/.test(io));
check("3. ⭐⭐ importă primitivele pure din ./sessionResume (classify + cookie attrs + validator + nume)",
  /import\s*\{[\s\S]*classifySessionResult[\s\S]*resumeCookieSetAttrs[\s\S]*resumeCookieClearAttrs[\s\S]*isValidResumeTxnId[\s\S]*AUTHZ_RESUME_COOKIE[\s\S]*\}\s*from\s*"\.\/sessionResume"/.test(io));
check("4. ⭐ tipul SessionState vine din decizie (import type)",
  /import\s+type\s*\{\s*SessionState\s*\}\s*from\s*"\.\/authorizeGetDecision"/.test(io));

// ── getSessionState: I/O + delegare pură ──────────────────────────────────────────
check("5. ⭐⭐⭐ getSessionState: await createClient() + auth.getUser()",
  /await createClient\(\)/.test(io) && /await supabase\.auth\.getUser\(\)/.test(io));
check("6. ⭐⭐⭐ getSessionState întoarce classifySessionResult(data, error) — NU re-implementează decizia",
  /return classifySessionResult\(data,\s*error\)/.test(io));
// Izolăm corpul getSessionState și verificăm că NU fabrică singur stări (doar catch-ul are voie cu unavailable).
{
  const m = io.match(/export async function getSessionState\(\)[\s\S]*?\n\}/);
  const body = m ? m[0] : "";
  const kindLiterals = (body.match(/kind:\s*"/g) || []).length;
  check("7. ⭐⭐⭐ getSessionState NU decide singur: un singur `kind:` literal (catch → unavailable), restul via classify",
    body.length > 0 && kindLiterals === 1);
  check("8. ⭐⭐⭐ getSessionState prinde throw-ul SDK → unavailable (fail-closed, NU 500)",
    /catch\s*\{[\s\S]*?kind:\s*"unavailable"[\s\S]*?\}/.test(body));
}

// ── readResumeCookie: gate de validare la citire ──────────────────────────────────
check("9. ⭐⭐⭐ readResumeCookie citește AUTHZ_RESUME_COOKIE via cookieStore.get(...).value",
  /cookieStore\.get\(AUTHZ_RESUME_COOKIE\)\?\.value/.test(io));
check("10. ⭐⭐⭐ readResumeCookie trece prin isValidResumeTxnId (cookie manipulat → null)",
  /isValidResumeTxnId\(raw\)\s*\?\s*raw\s*:\s*null/.test(io));

// ── secure DERIVAT central (footgun cgpt: nu-l lăsăm pe seama caller-ului) ─────────
check("11. ⭐⭐⭐ secure derivat central din process.env.NODE_ENV === 'production'",
  /function resumeCookieSecure\(\):\s*boolean\s*\{[\s\S]*?process\.env\.NODE_ENV\s*===\s*"production"[\s\S]*?\}/.test(io));
check("12. ⭐⭐⭐ setResumeCookie NU primește `secure` ca parametru (doar txnId)",
  /export async function setResumeCookie\(txnId: string\)/.test(io) && !/setResumeCookie\(txnId: string, secure/.test(io));
check("13. ⭐⭐⭐ clearResumeCookie NU primește `secure` ca parametru",
  /export async function clearResumeCookie\(\)/.test(io) && !/clearResumeCookie\(secure/.test(io));

// ── setResumeCookie: guard la scriere + atribute fixe (secure derivat) ────────────
check("14. ⭐⭐⭐ setResumeCookie validează txn_id ÎNAINTE de scriere (nu scrie cookie ne-recitibil)",
  /if\s*\(\s*!isValidResumeTxnId\(txnId\)\s*\)/.test(io));
check("15. ⭐⭐⭐ setResumeCookie scrie cu resumeCookieSetAttrs(resumeCookieSecure())",
  /cookieStore\.set\(AUTHZ_RESUME_COOKIE,\s*txnId,\s*resumeCookieSetAttrs\(resumeCookieSecure\(\)\)\)/.test(io));

// ── clearResumeCookie: Max-Age 0 (secure derivat) ─────────────────────────────────
check("16. ⭐⭐⭐ clearResumeCookie șterge cu resumeCookieClearAttrs(resumeCookieSecure())",
  /cookieStore\.set\(AUTHZ_RESUME_COOKIE,\s*"",\s*resumeCookieClearAttrs\(resumeCookieSecure\(\)\)\)/.test(io));

// ── contract de formă ─────────────────────────────────────────────────────────────
check("17. ⭐⭐ toate cele 4 funcții exportate async",
  /export async function getSessionState\(\)/.test(io)
  && /export async function readResumeCookie\(\)/.test(io)
  && /export async function setResumeCookie\(txnId: string\)/.test(io)
  && /export async function clearResumeCookie\(\)/.test(io));
check("18. ⭐⭐⭐ NU importă supabase-admin (calea userului trece prin SSR server client, nu service-role)",
  !/supabase-admin/.test(io));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
