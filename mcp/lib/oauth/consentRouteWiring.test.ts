/**
 * lib/oauth/consentRouteWiring.test.ts — PH-2 pas 6 frunză 5b-ii-b (GUARD de sursă pe ruta POST /consent).
 *
 * `app/.../consent/route.ts` importă next/supabase → NU tsx-testabil (typecheck-ul WSL o acoperă). Verificăm ca TEXT:
 * gate dormant, config, ORDINEA gărzilor (bounded ÎNAINTE de parse — cerința cgpt), CSRF, cablarea decide→planner→I/O,
 * și randarea terminalelor cu iss/redirect din txn. cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 pas 6 frunză 5b-ii-b — consent/route.ts (guard de sursă)");

const src = readFileSync("app/api/oauth/authorize/consent/route.ts", "utf8");
const iOf = (s: string) => src.indexOf(s); // helper pentru aserțiuni de ORDINE

// ── gate + config ────────────────────────────────────────────────────────────────────────────────
check("1. ⭐⭐⭐ flag OFF → 404 (dormant): isResourceOwnerAuthorizeEnabled(process.env) → notFound",
  /if\s*\(!isResourceOwnerAuthorizeEnabled\(process\.env\)\)\s*return\s*notFound\(\)/.test(src));
check("2. ⭐⭐ runtime nodejs + dynamic force-dynamic",
  /runtime\s*=\s*"nodejs"/.test(src) && /dynamic\s*=\s*"force-dynamic"/.test(src));
check("3. ⭐⭐⭐ helper noStore setează Cache-Control: no-store", /Cache-Control",\s*"no-store"/.test(src));
check("4. ⭐⭐⭐ boundary de excepții: try { handleConsent } catch → internalError (500 generic)",
  /try\s*\{[\s\S]{0,80}handleConsent\(req\)[\s\S]{0,160}catch[\s\S]{0,400}return\s*internalError\(\)/.test(src));

// ── ordinea gărzilor (fail-closed) ─────────────────────────────────────────────────────────────────
check("5. ⭐⭐⭐ Content-Type: isFormUrlEncoded(...) fals → 415 (unsupportedMediaType)",
  /if\s*\(!isFormUrlEncoded\(req\.headers\.get\("content-type"\)\)\)\s*return\s*unsupportedMediaType\(\)/.test(src));
check("6. ⭐⭐⭐ Content-Length fast-reject: contentLengthExceeds(..., MAX_CONSENT_BODY_BYTES) → 413",
  /contentLengthExceeds\(req\.headers\.get\("content-length"\),\s*MAX_CONSENT_BODY_BYTES\)\)\s*return\s*payloadTooLarge\(\)/.test(src));
check("7. ⭐⭐⭐ citire MĂRGINITĂ: readBoundedText(req.body, MAX_CONSENT_BODY_BYTES); !ok → 413",
  /readBoundedText\(req\.body,\s*MAX_CONSENT_BODY_BYTES\)/.test(src) && /if\s*\(!bodyRead\.ok\)\s*return\s*payloadTooLarge\(\)/.test(src));
check("8. ⭐⭐⭐ LIMITA ÎNAINTE DE PARSARE (cgpt): readBoundedText index < parseConsentForm index",
  iOf("readBoundedText(") > -1 && iOf("parseConsentForm(") > -1 && iOf("readBoundedText(") < iOf("parseConsentForm("));
check("9. ⭐⭐⭐ parse gate: parseConsentForm(bodyRead.text); !ok → localError",
  /parseConsentForm\(bodyRead\.text\)/.test(src) && /if\s*\(!form\.ok\)[\s\S]{0,80}return\s*localError\(\)/.test(src));

// ── CSRF (Origin/Referer vs origine canonică) ──────────────────────────────────────────────────────
check("10. ⭐⭐⭐ origine CANONICĂ o singură dată: resolveBaseUrl(req.headers, process.env)",
  /const\s+origin\s*=\s*resolveBaseUrl\(req\.headers,\s*process\.env\)/.test(src));
check("11. ⭐⭐⭐ CSRF: isSameOriginRequest(Origin, Referer, origin) fals → 403 (forbidden)",
  /isSameOriginRequest\(req\.headers\.get\("origin"\),\s*req\.headers\.get\("referer"\),\s*origin\)\)\s*return\s*forbidden\(\)/.test(src));
check("12. ⭐⭐ CSRF verificat DUPĂ parse (form valid) dar ÎNAINTE de orice I/O de sesiune",
  iOf("isSameOriginRequest(") > iOf("parseConsentForm(") && iOf("isSameOriginRequest(") < iOf("getSessionState("));

// ── sesiune + txn + lookups (unavailable → 503; absent/corrupt → local) ─────────────────────────────
check("13. ⭐⭐⭐ session unavailable → 503",
  /getSessionState\(\)/.test(src) && /session\.kind === "unavailable"\)\s*return\s*unavailable\(\)/.test(src));
check("14. ⭐⭐ currentSessionUserId din session (authenticated → userId, altfel null)",
  /session\.kind === "authenticated"\s*\?\s*session\.userId\s*:\s*null/.test(src));
check("15. ⭐⭐⭐ readAuthzTxn(form.txn_id): unavailable → 503; ≠ found → localError",
  /readAuthzTxn\(form\.txn_id\)/.test(src) && /read\.status === "unavailable"\)\s*return\s*unavailable\(\)/.test(src) && /read\.status !== "found"\)[\s\S]{0,80}return\s*localError\(\)/.test(src));
check("16. ⭐⭐⭐ raw = read.raw păstrat (blob EXACT pt. compare-and-delete la consume)", /const\s+raw\s*=\s*read\.raw/.test(src));
check("17. ⭐⭐⭐ registration = getAuthorizeRegistration(txn.client_id); unavailable → 503; not_found → null",
  /getAuthorizeRegistration\(txn\.client_id\)/.test(src) && /regLookup\.status === "unavailable"\)\s*return\s*unavailable\(\)/.test(src) && /regLookup\.status === "found"\s*\?\s*regLookup\.registration\s*:\s*null/.test(src));
check("18. ⭐⭐⭐ cont = getAccountEntitlement(currentSessionUserId) DOAR dacă userId; unavailable → 503; not_found → null",
  /getAccountEntitlement\(currentSessionUserId\)/.test(src) && /acctLookup\.status === "unavailable"\)\s*return\s*unavailable\(\)/.test(src) && /acctLookup\.status === "found"\s*\?\s*acctLookup\.entitlement\s*:\s*null/.test(src));

// ── decide + planner dispatch ──────────────────────────────────────────────────────────────────────
check("19. ⭐⭐⭐ decideConsentGrant cu presented{txn_id,csrf_token,action} + currentSessionUserId + SERVER_SCOPE_CATALOG",
  /decideConsentGrant\(\{[\s\S]{0,260}presented:\s*\{\s*txn_id:\s*form\.txn_id,\s*csrf_token:\s*form\.csrf_token,\s*action:\s*form\.action\s*\}[\s\S]{0,200}serverPolicy:\s*SERVER_SCOPE_CATALOG/.test(src));
check("20. ⭐⭐⭐ redirect context: redirectUri din txn.redirect_uri + iss = origine canonică (NU din query brut)",
  /redirectUri:\s*txn\.redirect_uri[\s\S]{0,60}iss:\s*origin/.test(src));
check("21. ⭐⭐⭐ dispecerizează planConsentAction(decision) → terminal / deny / issue",
  /planConsentAction\(decision\)/.test(src) && /case "terminal":\s*return\s*renderTerminal/.test(src) && /case "deny":\s*return\s*handleDeny/.test(src) && /case "issue":\s*return\s*handleIssue/.test(src));

// ── issue path (build → insert → consume, în ordine) ───────────────────────────────────────────────
check("22. ⭐⭐⭐ issue: buildUserAuthCodePayload({grant, txn, issued_at})",
  /buildUserAuthCodePayload\(\{\s*grant,\s*txn,\s*issued_at:\s*Date\.now\(\)\s*\}\)/.test(src));
check("23. ⭐⭐⭐ issue: planPayloadBuild(build); terminal → renderTerminal",
  /planPayloadBuild\(build\)/.test(src) && /pb\.kind === "terminal"\)\s*return\s*renderTerminal\(pb\.outcome\)/.test(src));
check("24. ⭐⭐⭐ issue: insertGrant(grant) → planAfterInsert; terminal → renderTerminal",
  /insertGrant\(grant\)/.test(src) && /planAfterInsert\(insert\)/.test(src) && /ai\.kind === "terminal"\)\s*return\s*renderTerminal\(ai\.outcome\)/.test(src));
check("25. ⭐⭐⭐ issue: consumeAuthzTxnAndIssueCode(txnId, raw, pb.payload) → planAfterConsume(outcome, redirect)",
  /consumeAuthzTxnAndIssueCode\(txnId,\s*raw,\s*pb\.payload\)/.test(src) && /renderTerminal\(planAfterConsume\(outcome,\s*redirect\)\)/.test(src));
check("26. ⭐⭐⭐ ORDINE issue: build < insert < consume", (() => {
  const b = iOf("buildUserAuthCodePayload("), i = iOf("insertGrant(grant)"), c = iOf("consumeAuthzTxnAndIssueCode(");
  return b > -1 && i > b && c > i;
})());

// ── ARBITRARE cross-action: CLAIM ÎNAINTE de orice efect secundar (cursa approve↔deny, cgpt) ────────
check("26a. ⭐⭐⭐ issue: claim 'approve' via planActionClaim(await claimAuthzTxnAction(txnId, \"approve\"))",
  /planActionClaim\(await\s*claimAuthzTxnAction\(txnId,\s*"approve"\)\)/.test(src));
check("26b. ⭐⭐⭐ issue: claim.kind === 'terminal' → renderTerminal (perdant → NICIUN efect)",
  (() => { const seg = (src.match(/async function handleIssue[\s\S]*?\n\}/) || [""])[0];
           return /claim\.kind === "terminal"\)\s*return\s*renderTerminal\(claim\.outcome\)/.test(seg); })());
check("26c. ⭐⭐⭐ ORDINE issue: CLAIM < build < insert < consume (arbitrarea precede TOATE efectele)", (() => {
  const seg = (src.match(/async function handleIssue[\s\S]*?\n\}/) || [""])[0];
  const cl = seg.indexOf("claimAuthzTxnAction"), b = seg.indexOf("buildUserAuthCodePayload("), i = seg.indexOf("insertGrant(grant)"), c = seg.indexOf("consumeAuthzTxnAndIssueCode(");
  return cl > -1 && b > cl && i > b && c > i;
})());

// ── deny path ──────────────────────────────────────────────────────────────────────────────────────
check("27. ⭐⭐⭐ deny: consumeAuthzTxn(txnId, raw) → planAfterDenyConsume(outcome, redirect)",
  /consumeAuthzTxn\(txnId,\s*raw\)/.test(src) && /renderTerminal\(planAfterDenyConsume\(outcome,\s*redirect\)\)/.test(src));
check("27a. ⭐⭐⭐ deny: claim 'deny' via planActionClaim(await claimAuthzTxnAction(txnId, \"deny\")) ÎNAINTE de consume", (() => {
  const seg = (src.match(/async function handleDeny[\s\S]*?\n\}/) || [""])[0];
  const cl = seg.indexOf("claimAuthzTxnAction"), c = seg.indexOf("consumeAuthzTxn(txnId, raw)");
  return /planActionClaim\(await\s*claimAuthzTxnAction\(txnId,\s*"deny"\)\)/.test(seg) && /claim\.kind === "terminal"\)\s*return\s*renderTerminal\(claim\.outcome\)/.test(seg) && cl > -1 && c > cl;
})());

// ── renderTerminal (redirect_code/denied/local/unavailable) ────────────────────────────────────────
check("28. ⭐⭐⭐ redirect_code → set code + iss (RFC 9207); state doar dacă prezent",
  /case "redirect_code":[\s\S]{0,200}searchParams\.set\("code",\s*o\.code\)[\s\S]{0,120}searchParams\.set\("iss",\s*o\.iss\)/.test(src));
check("29. ⭐⭐⭐ redirect_denied → error=access_denied + iss, FĂRĂ code",
  (() => {
    const seg = (src.match(/case "redirect_denied":[\s\S]{0,260}?\}/) || [""])[0];
    return /searchParams\.set\("error",\s*"access_denied"\)/.test(seg) && /searchParams\.set\("iss",\s*o\.iss\)/.test(seg) && !/searchParams\.set\("code"/.test(seg);
  })());
check("30. ⭐⭐⭐ local_error → localError (400); unavailable → unavailable (503)",
  /case "local_error":[\s\S]{0,140}return\s*localError\(\)/.test(src) && /case "unavailable":[\s\S]{0,140}return\s*unavailable\(\)/.test(src));
check("31. ⭐⭐ redirect-urile folosesc status 302 (redirectTo → NextResponse.redirect(url, 302))",
  /NextResponse\.redirect\(url,\s*302\)/.test(src));
check("32. ⭐⭐⭐ cele 3 coduri de gardă distincte există (415/413/403) + 503/500",
  /status:\s*415/.test(src) && /status:\s*413/.test(src) && /status:\s*403/.test(src) && /status:\s*503/.test(src) && /status:\s*500/.test(src));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
