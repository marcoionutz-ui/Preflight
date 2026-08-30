/**
 * lib/oauth/authResumeWiring.test.ts — PH-2 pas 6 frunză 4c/4d (GUARD de sursă pe `/auth/resume` + callback).
 *
 * Ambele fișiere importă next/redis/supabase → NU tsx-testabile. Le verificăm ca TEXT. DOVADA DECISIVĂ (cerința lui
 * Marco): (1) `exchangeCodeForSession` se apelează EXACT o dată, DOAR în callback; (2) `/auth/resume` NU-l apelează
 * niciodată → refresh sigur pe outage; (3) `unavailable` PĂSTREAZĂ cookie-ul (clear DOAR via `resumeClearsCookie`); (4)
 * retry-ul rulează în `/auth/resume` (alt endpoint), deci fără a atinge codul Supabase. cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const count = (s: string, re: RegExp): number => (s.match(re) || []).length;

function main(): void {
console.log("PH-2 pas 6 frunză 4c/4d — /auth/resume + callback (guard de sursă)");

const route = readFileSync("app/auth/resume/route.ts", "utf8");
const cb    = readFileSync("app/auth/callback/route.ts", "utf8");

// ── DOVADA DECISIVĂ: codul Supabase se schimbă o SINGURĂ dată, doar în callback ──
check("1. ⭐⭐⭐ callback apelează exchangeCodeForSession EXACT o dată",
  count(cb, /exchangeCodeForSession\(/g) === 1);
check("2. ⭐⭐⭐ /auth/resume NU apelează exchangeCodeForSession (retry sigur pe refresh)",
  !/exchangeCodeForSession\(/.test(route));
check("3. ⭐⭐⭐ /auth/resume NU importă createClient supabase, nici nu apelează exchange (nu atinge deloc codul Supabase; mențiunea din comentariu e ok)",
  !/createClient/.test(route) && !/exchangeCodeForSession\(/.test(route));

// ── CALLBACK (4d): exchange o dată → handoff flag-gated, restul neschimbat ───────
check("4. ⭐⭐⭐ callback: handoff via planCallbackRedirect(isResourceOwnerAuthorizeEnabled(process.env))",
  /planCallbackRedirect\(isResourceOwnerAuthorizeEnabled\(process\.env\)\)/.test(cb));
check("5. ⭐⭐⭐ callback: resume_handoff → 303 /auth/resume",
  /kind === "resume_handoff"[\s\S]{0,260}redirect\(`\$\{origin\}\/auth\/resume`,\s*303\)/.test(cb));
check("6. ⭐⭐ callback: fallback → /dashboard (flag OFF, comportamentul de azi)",
  /redirect\(`\$\{origin\}\/dashboard`\)/.test(cb));
check("7. ⭐⭐ callback: exchange eșuat → /login?error=auth_failed (redirect păstrat)",
  /redirect\(`\$\{origin\}\/login\?error=auth_failed`\)/.test(cb));
check("8. ⭐⭐ callback: origine CANONICĂ resolveBaseUrl(request.headers, process.env)",
  /resolveBaseUrl\(request\.headers,\s*process\.env\)/.test(cb));

// ── ROUTE (4c): gate + config + ordine corecția 1 ───────────────────────────────
check("9. ⭐⭐⭐ ROUTE: flag OFF → 404 (dormant ca /start)",
  /if\s*\(\s*!isResourceOwnerAuthorizeEnabled\(process\.env\)\s*\)\s*return\s+notFound\(\)/.test(route) && /status:\s*404/.test(route));
check("10. ⭐⭐ ROUTE: runtime nodejs + dynamic force-dynamic",
  /export const runtime = "nodejs"/.test(route) && /export const dynamic = "force-dynamic"/.test(route));
check("11. ⭐⭐⭐ ROUTE: Cache-Control no-store (helper noStore)",
  /res\.headers\.set\("Cache-Control",\s*"no-store"\)/.test(route));
check("12. ⭐⭐⭐ corecția 1: fără cookie → /dashboard ÎNAINTE de getSessionState (readResumeCookie null → redirect, apoi session)", (() => {
  const iCookie  = route.indexOf("await readResumeCookie()");
  const iDash    = route.search(/txnId === null\) return redirectTo\(`\$\{origin\}\/dashboard`\)/);
  const iSession = route.indexOf("await getSessionState()");
  return iCookie > -1 && iDash > -1 && iSession > -1 && iCookie < iDash && iDash < iSession;
})());

// ── ROUTE: entry dispatch (login/retryable cookie PĂSTRAT; proceed → ladder) ─────
check("13. ⭐⭐⭐ ROUTE: planResumeEntry(session) → login → /login (cookie PĂSTRAT: fără clearResumeCookie pe ramura login)",
  /entry\.kind === "login"\)\s*return redirectTo\(`\$\{origin\}\/login`\)/.test(route));
check("14. ⭐⭐⭐ ROUTE: entry retryable → 503 (unavailable), cookie PĂSTRAT",
  /entry\.kind === "retryable"\)\s*return unavailable\(\)/.test(route));
check("15. ⭐⭐⭐ ROUTE: proceed → runLadder(txnId, entry.userId) (timpul e citit PROASPĂT intern, nu pasat unic)",
  /runLadder\(txnId,\s*entry\.userId\)/.test(route) && !/runLadder\([^)]*Date\.now\(\)/.test(route));

// ── ROUTE: cookie clear DOAR pe terminale consumate (regula lui Marco) ───────────
check("16. ⭐⭐⭐ ROUTE: clear cookie DOAR via resumeClearsCookie(outcome.kind) (NU pe retryable/login)",
  /if\s*\(resumeClearsCookie\(outcome\.kind\)\)\s*await clearResumeCookie\(\)/.test(route));
check("17. ⭐⭐⭐ ROUTE: clearResumeCookie apelat EXACT o dată (doar sub garda resumeClearsCookie)",
  count(route, /clearResumeCookie\(\)/g) === 1);
check("18. ⭐⭐⭐ ROUTE: resume_ok → redirect /authorize?txn_id=",
  /new URL\(`\$\{origin\}\/authorize`\)[\s\S]{0,80}set\("txn_id",\s*outcome\.txnId\)/.test(route));
check("19. ⭐⭐ ROUTE: invalid → errorCard (400); retryable → unavailable (503)",
  /case "invalid":[\s\S]{0,120}return errorCard\(\)/.test(route) && /case "retryable":[\s\S]{0,120}return unavailable\(\)/.test(route));

// ── ROUTE: ladder retry-o-dată + expirare înainte de bind + CAS ─────────────────
check("20. ⭐⭐⭐ ROUTE (cgpt P1): DOUĂ citiri PROASPETE de timp — classifyReadStep(read1, Date.now()) ȘI classifyReadStep(read2, Date.now()); re-read NU reutilizează timpul vechi",
  /classifyReadStep\(read1,\s*Date\.now\(\)\)/.test(route) && /classifyReadStep\(read2,\s*Date\.now\(\)\)/.test(route)
  && count(route, /classifyReadStep\([^)]*Date\.now\(\)\)/g) === 2 && !/classifyReadStep\([^)]*nowMs/.test(route));
check("21. ⭐⭐⭐ ROUTE: retry O DATĂ — classifyBindStep(bind1, true) → reread; classifyBindStep(bind2, false) (fără al treilea)",
  /classifyBindStep\(bind1,\s*true\)/.test(route) && /classifyBindStep\(bind2,\s*false\)/.test(route));
check("22. ⭐⭐⭐ ROUTE: re-read inspectat via classifyRebind(step2, userId) (același user / alt user / încă nelegat)",
  /classifyRebind\(step2,\s*userId\)/.test(route));
check("23. ⭐⭐⭐ ROUTE: bind-ul CAS folosește bindAuthzTxnUser (calea unde CAS se folosește în sfârșit)",
  /bindAuthzTxnUser\(\{\s*txn:\s*step1\.txn,\s*raw:\s*step1\.raw\s*\},\s*userId\)/.test(route)
  && /bindAuthzTxnUser\(\{\s*txn:\s*reb\.txn,\s*raw:\s*reb\.raw\s*\},\s*userId\)/.test(route));

// ── ROUTE: boundary de excepții ─────────────────────────────────────────────────
check("24. ⭐⭐⭐ ROUTE: boundary excepții — GET try { handleResume } catch → internalError (500, fără leak)",
  /try\s*\{\s*return await handleResume\(req\);\s*\}\s*catch\s*\(err\)\s*\{/.test(route)
  && /catch\s*\(err\)[\s\S]*?return internalError\(\)/.test(route)
  && /function internalError[\s\S]{0,120}status:\s*500/.test(route));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
