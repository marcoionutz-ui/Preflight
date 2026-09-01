/**
 * lib/oauth/authorizeStartWiring.test.ts — PH-2 pas 6 frunză 3b-iii (GUARD de sursă pe mount-ul `/start` + pagină).
 *
 * `app/api/oauth/authorize/start/route.ts` + `app/authorize/page.tsx` importă next/redis/supabase → NU tsx-testabile.
 * Le verificăm ca TEXT (fără import), confirmând guardrails-urile cgpt: flag-gate 404, revalidare completă, bind-before-
 * create, ordine login persist→cookie→redirect, no-store, origine canonică, duplicate RFC 6749, resume strict via
 * txn_id explicit (fără cookie), forwarding fără colaps, placeholder inert. cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 pas 6 frunză 3b-iii — mount /start + pagină (guard de sursă)");

const route = readFileSync("app/api/oauth/authorize/start/route.ts", "utf8");
const page  = readFileSync("app/authorize/page.tsx", "utf8");

// ── ROUTE: flag-gate + config ──────────────────────────────────────────────────
check("1. ⭐⭐⭐ flag OFF → 404 (isResourceOwnerAuthorizeEnabled(process.env) → status 404)",
  /if\s*\(\s*!isResourceOwnerAuthorizeEnabled\(process\.env\)\s*\)\s*return\s+notFound\(\)/.test(route) && /status:\s*404/.test(route));
check("2. ⭐⭐ runtime nodejs + dynamic force-dynamic",
  /export const runtime = "nodejs"/.test(route) && /export const dynamic = "force-dynamic"/.test(route));
check("3. ⭐⭐⭐ Cache-Control: no-store aplicat pe răspunsuri (helper noStore)",
  /res\.headers\.set\("Cache-Control",\s*"no-store"\)/.test(route));

// ── ROUTE: origine canonică + duplicate RFC 6749 ────────────────────────────────
check("4. ⭐⭐⭐ origine CANONICĂ o singură dată (resolveBaseUrl(req.headers, process.env)), NU nextUrl.origin/Host brut",
  /const origin = resolveBaseUrl\(req\.headers,\s*process\.env\)/.test(route) && !/nextUrl\.origin/.test(route) && !/req\.headers\.get\("host"\)/.test(route));
check("5. ⭐⭐⭐ parametri OAuth duplicați → localError (getAll(...).length > 1, RFC 6749)",
  /sp\.getAll\(name\)\.length\s*>\s*1[\s\S]{0,40}return localError\(\)/.test(route));

// ── ROUTE: revalidare completă → plan ───────────────────────────────────────────
check("6. ⭐⭐⭐ revalidează COMPLET: getAuthorizeRegistration + getSessionState + decideAuthorizeGetOutcome mode initial",
  /await getAuthorizeRegistration\(params\.client_id\)/.test(route) && /await getSessionState\(\)/.test(route)
  && /decideAuthorizeGetOutcome\(\{[\s\S]{0,120}mode:\s*"initial"/.test(route));
check("7. ⭐⭐⭐ dispecerizează prin planAuthorizeStart(decision)", /planAuthorizeStart\(decision\)/.test(route));
check("8. ⭐⭐ issuer/nowMs injectate (origin + Date.now())",
  /issuer:\s*origin/.test(route) && /nowMs:\s*Date\.now\(\)/.test(route));

// ── ROUTE: issue_consent = bind-before-create PUR (fără CAS) ─────────────────────
check("9. ⭐⭐⭐ issue_consent: buildTxn → bindUser PUR → createAuthzTxn (blob deja legat)",
  /const bound = bindUser\(built\.txn,\s*userId\)/.test(route) && /await createAuthzTxn\(bound\.txn\)/.test(route));
check("10. ⭐⭐⭐ issue_consent NU APELEAZĂ CAS (bindAuthzTxnUser( — e doar pt. callback; mențiunea din comentariu e ok)",
  !/bindAuthzTxnUser\(/.test(route));
check("11. ⭐⭐⭐ issue_consent succes → redirect /authorize?txn_id=",
  /new URL\(`\$\{origin\}\/authorize`\)[\s\S]{0,80}set\("txn_id",\s*bound\.txn\.txn_id\)/.test(route));

// ── ROUTE: issue_login = ordine persist → cookie → redirect ──────────────────────
check("12. ⭐⭐⭐ issue_login: createAuthzTxn ÎNAINTE de setResumeCookie (persist → cookie)", (() => {
  const m = route.match(/async function issueLogin[\s\S]*?\n\}/);
  const body = m ? m[0] : "";
  const iCreate = body.indexOf("createAuthzTxn");
  const iCookie = body.indexOf("setResumeCookie");
  return iCreate > -1 && iCookie > -1 && iCreate < iCookie;
})());
check("13. ⭐⭐⭐ issue_login: cookie DOAR pe `created` (return înainte pe unavailable / != created)", (() => {
  const m = route.match(/async function issueLogin[\s\S]*?\n\}/);
  const body = m ? m[0] : "";
  // gărzile care întorc ÎNAINTE de setResumeCookie
  const guardUnavail = /created === "unavailable"\) return unavailable\(\)/.test(body);
  const guardNotCreated = /created !== "created"\)[\s\S]{0,120}serverErrorRedirect/.test(body);
  const iGuardNot = body.indexOf('created !== "created"');
  const iCookie = body.indexOf("setResumeCookie");
  return guardUnavail && guardNotCreated && iGuardNot > -1 && iGuardNot < iCookie;
})());
check("14. ⭐⭐ issue_login succes → redirect /login", /redirectTo\(`\$\{origin\}\/login`\)/.test(route));

// ── ROUTE: eșecuri (server_error / 503) + iss ───────────────────────────────────
check("15. ⭐⭐⭐ createAuthzTxn unavailable → 503; collision/invalid (!== created) → serverErrorRedirect",
  /created === "unavailable"\) return unavailable\(\)/.test(route) && /created !== "created"[\s\S]{0,120}serverErrorRedirect/.test(route));
check("16. ⭐⭐⭐ serverErrorRedirect folosește request.redirect_uri (trusted) + error=server_error + iss=origin",
  /error",\s*"server_error"/.test(route) && /serverErrorRedirect\(request\.redirect_uri/.test(route) && /set\("iss",\s*origin\)/.test(route));
check("17. ⭐⭐⭐ client_error → redirect cu error + error_description + state + iss (iss derivat aici, din origin)",
  /u\.searchParams\.set\("error",\s*action\.error\)/.test(route) && /set\("error_description",\s*action\.error_description\)/.test(route) && /set\("iss",\s*origin\)/.test(route));
check("18. ⭐⭐⭐ generează id-uri proaspete (newAuthzTxnId/newAuthzCsrfToken/newAuthzGrantId)",
  /newAuthzTxnId\(\)/.test(route) && /newAuthzCsrfToken\(\)/.test(route) && /newAuthzGrantId\(\)/.test(route));
check("19. ⭐⭐⭐ ttlMs = AUTHZ_TXN_TTL_SEC * 1000 (blob expires_at aliniat cu Redis EX)",
  /ttlMs:\s*AUTHZ_TXN_TTL_SEC\s*\*\s*1000/.test(route));
check("20. ⭐⭐ redirect-urile folosesc status 302", /NextResponse\.redirect\([^)]*,\s*302\)/.test(route));

// ── PAGE: branch flag + resume strict + forwarding ──────────────────────────────
check("21. ⭐⭐⭐ pagina: flag ON → resourceOwnerAuthorize; altfel ramura legacy",
  /if\s*\(isResourceOwnerAuthorizeEnabled\(process\.env\)\)\s*\{[\s\S]{0,60}return resourceOwnerAuthorize\(params\)/.test(page));
check("22. ⭐⭐⭐ legacy PĂSTRAT (getClientById + form POST /api/oauth/authorize + client_secret)",
  /getClientById/.test(page) && /action="\/api\/oauth\/authorize"/.test(page) && /name="client_secret"/.test(page));
check("23. ⭐⭐⭐ resume: txn_id VALID (isValidResumeTxnId) + UNIC (!Array.isArray) + EXCLUSIV (fără parametri OAuth)",
  /Array\.isArray\(rawTxn\)\s*\|\|\s*!isValidResumeTxnId\(rawTxn\)/.test(page) && /OAUTH_PARAM_NAMES\.some\(\(n\)\s*=>\s*params\[n\]\s*!==\s*undefined\)/.test(page));
check("24. ⭐⭐⭐ resume citește DOAR txn_id explicit: readAuthzTxn + decideAuthorizeGetOutcome mode resume",
  /await readAuthzTxn\(rawTxn\)/.test(page) && /decideAuthorizeGetOutcome\(\{\s*mode:\s*"resume"/.test(page));
check("25. ⭐⭐⭐ pagina NU APELEAZĂ readResumeCookie( (cookie-ul e DOAR pt. callback; mențiunea din comentariu e ok)", !/readResumeCookie\(/.test(page));
check("26. ⭐⭐⭐ initial (fără txn_id) → redirect /api/oauth/authorize/start (pagina NU revalidează)",
  /redirect\(`\/api\/oauth\/authorize\/start\?\$\{qs\.toString\(\)\}`\)/.test(page));
check("27. ⭐⭐⭐ forwarding FĂRĂ colaps: Array.isArray → forEach append (NU join pe virgulă)",
  /Array\.isArray\(v\)\)\s*v\.forEach\(\(x\)\s*=>\s*qs\.append\(k,\s*x\)\)/.test(page) && !/\.join\(","\)/.test(page));
check("28. ⭐⭐ Props lărgit la string | string[] | undefined (fără colaps de tip)",
  /type QueryVal = string \| string\[\] \| undefined/.test(page));
check("29. ⭐⭐⭐ render_consent → consentScreen(decision.txn) (form REAL Approve/Deny + endpoint consent; NU mai placeholder INERT)",
  /decision\.kind === "render_consent"\) return consentScreen\(decision\.txn\)/.test(page)
  && !/consentPlaceholder/.test(page)
  && /action="\/api\/oauth\/authorize\/consent"/.test(page) && /name="action"/.test(page));
// ── FIX cgpt: boundary excepții + txn_id la /start + outage resume non-200 ───────
check("30. ⭐⭐⭐ ROUTE: boundary de excepții — GET try { handleStart } catch(err) → internalError (500 generic, fără leak)",
  /try\s*\{\s*return await handleStart\(req\);\s*\}\s*catch\s*\(err\)\s*\{/.test(route)
  && /catch\s*\(err\)[\s\S]*?return internalError\(\)/.test(route)
  && /function internalError[\s\S]{0,120}new NextResponse\("Internal Server Error",\s*\{\s*status:\s*500/.test(route));
check("31. ⭐⭐⭐ ROUTE: /start respinge `txn_id` în initial (getAll(\"txn_id\").length > 0 → localError; endpoint doar-initial)",
  /sp\.getAll\("txn_id"\)\.length\s*>\s*0\)\s*return localError\(\)/.test(route));
check("32. ⭐⭐⭐ PAGE: resume OUTAGE (unavailable) NU răspunde 200 — aruncă (5xx), nu errorCard", (() => {
  const m = page.match(/if \(decision\.kind === "unavailable"\) \{[\s\S]*?\n    \}/);
  const body = m ? m[0] : "";
  return body.length > 0 && /throw new Error\(/.test(body) && !/errorCard/.test(body);
})());
check("33. ⭐⭐ PAGE: resume error_local rămâne afișare locală 200 (RFC 6749 §4.1.2.1 — eroare ne-redirectabilă)",
  /errorCard\("⚠️ Invalid Request",\s*"This authorization link is invalid or has expired\."\)/.test(page));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
