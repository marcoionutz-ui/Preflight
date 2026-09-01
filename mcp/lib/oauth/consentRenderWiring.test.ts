/**
 * lib/oauth/consentRenderWiring.test.ts — PH-2 pas 6 frunză 5c-ii (guard de sursă: ecranul de consent din app/authorize/page.tsx).
 *
 * app/ nu se poate tsc/import în container → verificăm STRUCTURA sursei (ca celelalte *-wire): pagina încarcă
 * registration + cont, aplică doctrina outage (unavailable → throw 5xx, NU errorCard 200), construiește view-model-ul
 * PUR `buildConsentView` (afișare == acordare) și randează form-ul POST /api/oauth/authorize/consent cu CSRF + Approve/Deny.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const page = readFileSync("app/authorize/page.tsx", "utf8");

function main(): void {
console.log("PH-2 pas 6 frunză 5c-ii — consent render wiring (guard de sursă)");

// ── dispecerizare + importuri ────────────────────────────────────────────────────
check("1. ⭐⭐⭐ render_consent → consentScreen(decision.txn)",
  /decision\.kind === "render_consent"\) return consentScreen\(decision\.txn\)/.test(page));
check("2. ⭐⭐ importă buildConsentView + ConsentView din consentView",
  /import \{\s*buildConsentView,\s*type ConsentView\s*\} from "@\/lib\/oauth\/consentView"/.test(page));
check("3. ⭐⭐ importă getAuthorizeRegistration + getAccountEntitlement din ph2Reads",
  /import \{\s*getAuthorizeRegistration,\s*getAccountEntitlement\s*\} from "@\/lib\/db\/ph2Reads"/.test(page));
check("4. ⭐⭐ importă SERVER_SCOPE_CATALOG (serverPolicy = catalogul unic)",
  /import \{\s*SERVER_SCOPE_CATALOG\s*\} from "@\/lib\/oauth\/scopeCatalog"/.test(page));
check("5. ⭐⭐ NU mai există consentPlaceholder (înlocuit de ecranul real)", !/consentPlaceholder/.test(page));

// ── încărcarea lookup-urilor ─────────────────────────────────────────────────────
check("6. ⭐⭐⭐ încarcă registration = getAuthorizeRegistration(txn.client_id)",
  /getAuthorizeRegistration\(txn\.client_id\)/.test(page));
check("7. ⭐⭐⭐ încarcă cont = getAccountEntitlement(userId) (userul legat în txn)",
  /getAccountEntitlement\(userId\)/.test(page));
check("8. ⭐⭐⭐ userId = txn.session_user_id; fără user → errorCard (nu interogăm cont gol)",
  /const userId = txn\.session_user_id/.test(page) && /if \(!userId\) return errorCard\(/.test(page));

// ── DOCTRINA OUTAGE (ca la resume): unavailable → throw 5xx, NU errorCard 200 ─────
check("9. ⭐⭐⭐ unavailable pe ORICARE lookup → throw (5xx), NU errorCard", (() => {
  const m = page.match(/if \(regLookup\.status === "unavailable" \|\| acctLookup\.status === "unavailable"\) \{[\s\S]*?\}/);
  const body = m ? m[0] : "";
  return body.length > 0 && /throw new Error\(/.test(body) && !/errorCard/.test(body);
})());
check("10. ⭐⭐⭐ not_found → null (registration/cont), NU throw (buildConsentView tratează null → error 200)",
  /regLookup\.status === "found" \? regLookup\.registration : null/.test(page)
  && /acctLookup\.status === "found" \? acctLookup\.entitlement : null/.test(page));

// ── view-model PUR (afișare == acordare) ─────────────────────────────────────────
check("11. ⭐⭐⭐ buildConsentView({ txn, registration, account, serverPolicy: SERVER_SCOPE_CATALOG, nowMs })",
  /buildConsentView\(\{\s*txn,\s*registration,\s*account,\s*serverPolicy:\s*SERVER_SCOPE_CATALOG,\s*nowMs:\s*Date\.now\(\)\s*\}\)/.test(page));
check("12. ⭐⭐⭐ view error → errorCard local 200 (cerere invalidă, RFC 6749 §4.1.2.1), NU throw",
  /built\.kind === "error"\) \{[\s\S]{0,200}return errorCard\(/.test(page));
check("13. ⭐⭐ view consent → consentForm(built.view)", /return consentForm\(built\.view\)/.test(page));

// ── form-ul POST (CSRF + Approve/Deny), enctype implicit form-urlencoded ──────────
check("14. ⭐⭐⭐ form POST la /api/oauth/authorize/consent",
  /<form\s+action="\/api\/oauth\/authorize\/consent"\s+method="POST"/.test(page));
check("15. ⭐⭐⭐ hidden txn_id = view.txnId", /<input type="hidden" name="txn_id"\s+value=\{view\.txnId\}/.test(page));
check("16. ⭐⭐⭐ hidden csrf_token = view.csrfToken", /<input type="hidden" name="csrf_token" value=\{view\.csrfToken\}/.test(page));
check("17. ⭐⭐⭐ buton Approve: name=action value=approve",
  /<button type="submit" name="action" value="approve"/.test(page));
check("18. ⭐⭐⭐ buton Deny: name=action value=deny",
  /<button type="submit" name="action" value="deny"/.test(page));
check("19. ⭐⭐ DOUĂ butoane action (exact o valoare trimisă — cerută de parseConsentForm)",
  (page.match(/name="action"/g) ?? []).length === 2);
check("20. ⭐⭐⭐ FĂRĂ client_secret în corpul consentForm (nu-i re-autentificare; legacy îl are separat)", (() => {
  // Izolează corpul funcției consentForm (între declarația ei și următoarea funcție, errorCard).
  const m = page.match(/function consentForm\(view: ConsentView\)[\s\S]*?(?=\nfunction errorCard)/);
  const body = m ? m[0] : "";
  return body.length > 0 && !/client_secret/.test(body) && !/type="password"/.test(body);
})());
check("21. ⭐⭐ afișează clientName + clientId + redirectHost + scope-uri etichetate din view",
  /\{view\.clientName\}/.test(page) && /\{view\.clientId\}/.test(page) && /\{view\.redirectHost\}/.test(page)
  && /view\.scopes\.map\(/.test(page) && /\{s\.label\}/.test(page));
check("22. ⭐⭐ FĂRĂ auto-submit (consimțământ = acțiune umană; niciun script de submit programatic)",
  !/\.submit\(\)/.test(page) && !/useEffect/.test(page));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
