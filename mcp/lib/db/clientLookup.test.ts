/**
 * lib/db/clientLookup.test.ts — NF4 (classifyClientLookup: not_found vs unavailable).
 *
 * `getClientById` conflă „client inexistent" cu „eroare Supabase" în `null`. `classifyClientLookup` le separă:
 * error prezent → unavailable (503); data null fără error → not_found (401); data prezent → found. Leaf pur.
 */
import { readFileSync } from "node:fs";
import { classifyClientLookup, classifyClientCredentials } from "./clientLookup";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// Stub minimal de client. Tip STRICT (NonNullable) — altfel `OAuthClient|null|undefined` nu se poate pasa la
// `{ status:"found", client: OAuthClient }` sub `strict` (tsx nu typecheck-uiește, dar `tsc`/CI da). (cgpt PH-9)
type TestClient = NonNullable<Parameters<typeof classifyClientLookup>[0]>;
const CLIENT = { client_id: "c1", secret_rotated_at: "v1" } as unknown as TestClient;

function main(): void {
console.log("NF4 — classifyClientLookup (found | not_found | unavailable)");

// found: data prezent, fără eroare.
const found = classifyClientLookup(CLIENT, null);
check("1. data prezent + fără eroare → found", found.status === "found" && (found as { client?: unknown }).client === CLIENT);

// not_found: 0 rânduri (.maybeSingle → data null, error null).
check("2. ⭐ data null + error null (0 rânduri) → not_found", classifyClientLookup(null, null).status === "not_found");
check("3. data undefined + error undefined → not_found", classifyClientLookup(undefined, undefined).status === "not_found");

// unavailable: eroare Supabase reală — NU „not_found".
const unavail = classifyClientLookup(null, { message: "ECONNREFUSED to supabase" });
check("4. ⭐ error prezent (data null) → unavailable (NU not_found)", unavail.status === "unavailable");
check("5. unavailable păstrează reason din error.message", unavail.status === "unavailable" && unavail.reason === "ECONNREFUSED to supabase");
check("6. error fără message → unavailable + reason fallback", (() => {
  const r = classifyClientLookup(null, {});
  return r.status === "unavailable" && r.reason === "supabase_error";
})());

// ⭐ eroarea are PRIORITATE peste data: dacă backend-ul a dat și eroare, NU pretinde „found" pe date parțiale.
check("7. ⭐ error prezent CHIAR cu data → unavailable (eroarea câștigă, nu found)", classifyClientLookup(CLIENT, { message: "partial failure" }).status === "unavailable");

// ⭐ dovada NF4: not_found și unavailable sunt DISTINCTE (înainte ambele → null → 401).
const a = classifyClientLookup(null, null);
const b = classifyClientLookup(null, { message: "down" });
check("8. ⭐ not_found ≠ unavailable (nu mai sunt ambele null/401)", a.status !== b.status);

// ── PH-9: classifyClientCredentials (token endpoint: outage ≠ invalid_client) ──
const matchYes = () => true;
const matchNo  = () => false;
// found + secret corect → ok
check("9. found + secret corect → ok", (() => {
  const r = classifyClientCredentials({ status: "found", client: CLIENT }, matchYes);
  return r.status === "ok" && (r as { client?: unknown }).client === CLIENT;
})());
// found + secret greșit → invalid_client (verificarea a reușit, răspunsul e „nu")
check("10. ⭐ found + secret GREȘIT → invalid_client", classifyClientCredentials({ status: "found", client: CLIENT }, matchNo).status === "invalid_client");
// not_found → invalid_client
check("11. not_found → invalid_client", classifyClientCredentials({ status: "not_found" }, matchYes).status === "invalid_client");
// ⭐⭐ unavailable → unavailable (NU invalid_client) — outage Supabase nu minte „secret greșit"
check("12. ⭐⭐ unavailable → unavailable (NU invalid_client — outage ≠ credențiale greșite)", (() => {
  const r = classifyClientCredentials({ status: "unavailable", reason: "ECONNREFUSED" }, matchNo);
  return r.status === "unavailable" && (r as { reason?: string }).reason === "ECONNREFUSED";
})());
// ⭐ secretMatches NU e chemat pe unavailable (nu putem verifica secretul dacă n-avem clientul)
check("13. ⭐ pe unavailable, secretMatches irelevant (chiar cu matchYes → tot unavailable)",
  classifyClientCredentials({ status: "unavailable", reason: "down" }, matchYes).status === "unavailable");
// ⭐ dovada PH-9: outage și credențiale-greșite sunt DISTINCTE (înainte ambele → 401 invalid_client)
check("14. ⭐ unavailable ≠ invalid_client (nu mai sunt ambele 401)",
  classifyClientCredentials({ status: "unavailable", reason: "x" }, matchNo).status !==
  classifyClientCredentials({ status: "not_found" }, matchNo).status);

// ── PH-9: GUARD DE SURSĂ — token route chiar CABLEAZĂ clasificatorul discriminat (cgpt) ──
// Clasificatorul e verde mai sus, dar dacă ruta ar regresa mâine la `verifyClientCredentials()` + 401, testele
// pure ar rămâne verzi. Guard-ul citește ruta și cade dacă wiring-ul (discriminare unavailable→503) dispare.
// cwd = pachetul mcp (npm rulează scriptul din dir-ul pachetului), deci calea e relativă la mcp.
{
  const route = readFileSync("app/api/oauth/token/route.ts", "utf8");
  check("15. ⭐ ruta folosește verifyClientCredentialsResult (discriminat)", /verifyClientCredentialsResult\(/.test(route));
  check("16. ⭐ ruta folosește lookupClientById în auth_code (discriminat)", /lookupClientById\(/.test(route));
  check("17. ⭐ client_credentials: unavailable → 503 temporarily_unavailable",
    /cred\.status === "unavailable"[\s\S]{0,140}503,\s*"temporarily_unavailable"/.test(route));
  check("18. ⭐ client_credentials: invalid_client → 401",
    /cred\.status === "invalid_client"[\s\S]{0,140}401,\s*"invalid_client"/.test(route));
  check("19. ⭐ auth_code: unavailable → 503 temporarily_unavailable",
    /clientLookup\.status === "unavailable"[\s\S]{0,140}503,\s*"temporarily_unavailable"/.test(route));
  check("20. ⭐ NU a regresat la verifyClientCredentials() bare (fără Result)",
    !/verifyClientCredentials\(/.test(route));
  check("21. ⭐ NU a regresat la getClientById() în token route (colapsează unavailable→null)",
    !/getClientById\(/.test(route));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
