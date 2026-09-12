/**
 * lib/oauth/tokenRouteWiring.test.ts — PH-2 fix (canary Gate 1): GUARD de sursă pe `/token` grant `authorization_code`.
 *
 * `app/api/oauth/token/route.ts` importă redis/Supabase → NU tsx-testabil (dovada pe stack real e rularea LIVE Gate 1).
 * Verificăm ca TEXT că fluxul de ACCESS auth-code FORKEAZĂ pe identitatea codului (ca și calea de refresh): un cod USER
 * (DCR public) se validează pe REGISTRATION (`getRegistrationByClientId` + `verifyUserRegistration` cu grant type
 * `authorization_code`), NU pe `oauth_clients` legacy (`lookupClientById`); calea legacy rămâne byte-compatibilă.
 *
 * BUG-ul prins de canary: calea de access chema NECONDIȚIONAT `lookupClientById` → un cod user (client în
 * `oauth_client_registrations`) dădea `unavailable`→503 (tabel legacy jos) sau `not_found`→401 (client absent din legacy),
 * deci fluxul user nu putea emite NICIODATĂ. cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
  console.log("PH-2 fix (canary Gate 1) — /token authorization_code fork user/legacy (guard de sursă)");

  const src = readFileSync("app/api/oauth/token/route.ts", "utf8");

  // Izolează blocul grant `authorization_code` (până la blocul `refresh_token`).
  const acStart = src.indexOf('grant_type === "authorization_code"');
  const acEnd   = src.indexOf('grant_type === "refresh_token"');
  const ac = acStart > -1 && acEnd > acStart ? src.slice(acStart, acEnd) : "";
  check("0. ⭐ bloc authorization_code izolat", ac.length > 0);

  // Sub-branch USER (de la clasificarea `user` până la marcajul `Cod LEGACY`) + tail LEGACY.
  const userStart   = ac.indexOf('codeIdentity.kind === "user"');
  const legacyStart = ac.indexOf("Cod LEGACY");
  const userBranch  = userStart > -1 && legacyStart > userStart ? ac.slice(userStart, legacyStart) : "";
  const legacyTail  = legacyStart > -1 ? ac.slice(legacyStart) : "";
  check("0b. ⭐ sub-branch-uri user + legacy izolate", userBranch.length > 0 && legacyTail.length > 0);

  // ── 1. CLASIFICARE ÎNAINTE de lookup ──
  const iIdentity = ac.indexOf("readAuthCodeIdentity(payload)");
  const iLegacyLookup = ac.indexOf("lookupClientById(client_id)");
  check("1. ⭐⭐⭐ readAuthCodeIdentity clasifică ÎNAINTE de lookupClientById",
    iIdentity > -1 && iLegacyLookup > -1 && iIdentity < iLegacyLookup);
  check("2. ⭐⭐⭐ cod corupt → invalid_grant, înainte de fork",
    /codeIdentity\.kind === "corrupt"[\s\S]{0,140}invalid_grant/.test(ac)
    && ac.indexOf('codeIdentity.kind === "corrupt"') < ac.indexOf('codeIdentity.kind === "user"'));

  // ── 3–8. Ramura USER: registration DCR, NU oauth_clients ──
  check("3. ⭐⭐⭐ USER: getRegistrationByClientId(client_id) (NU oauth_clients)",
    /getRegistrationByClientId\(client_id\)/.test(userBranch));
  check("4. ⭐⭐⭐ USER: verifyUserRegistration cu requiredGrantType 'authorization_code'",
    /verifyUserRegistration\(\s*regLookup,\s*\{[\s\S]{0,120}requiredGrantType:\s*"authorization_code"/.test(userBranch));
  check("5. ⭐⭐⭐ USER: registration unavailable → 503 temporarily_unavailable",
    /rgv\.kind === "unavailable"[\s\S]{0,160}503,\s*"temporarily_unavailable"/.test(userBranch));
  check("6. ⭐⭐⭐ USER: registration invalidă (!rgv.ok) → 401 ÎNAINTE de consumarea codului (codul NU se arde)", (() => {
    const iReject   = userBranch.indexOf('401, "invalid_client"');
    const iConsume  = userBranch.indexOf("consumeCodeAndIssueUserWithRefresh");
    return iReject > -1 && iConsume > -1 && iReject < iConsume;
  })());
  check("7. ⭐⭐⭐ USER: NU cheamă NICIODATĂ lookupClientById sau touchClient",
    !/lookupClientById/.test(userBranch) && !/touchClient/.test(userBranch));
  check("8. ⭐⭐⭐ USER: emite prin consumeCodeAndIssueUserWithRefresh, apoi touchRegistration (last_used_at)", (() => {
    const iConsume = userBranch.indexOf("consumeCodeAndIssueUserWithRefresh");
    const iTouch   = userBranch.indexOf("touchRegistration(client_id)");
    return iConsume > -1 && iTouch > -1 && iTouch > iConsume;
  })());
  check("9. ⭐⭐ USER: credentialVersion \"\" (ignorat — client public fără secret)",
    /credentialVersion:\s*""/.test(userBranch));
  check("10. ⭐⭐ USER: fail-closed dacă plan.kind ≠ user (incoerență identitate/plan)",
    /plan\.kind !== "user"[\s\S]{0,120}invalid_grant/.test(userBranch));

  // ── 11–13. Ramura LEGACY: byte-compatibilă (oauth_clients), fără registration ──
  check("11. ⭐⭐⭐ LEGACY: lookupClientById + consumeCodeAndIssueWithRefresh + touchClient (comportament de AZI)",
    /lookupClientById\(client_id\)/.test(legacyTail)
    && /consumeCodeAndIssueWithRefresh\(code,\s*lookup\.raw,\s*plan\.access\)/.test(legacyTail)
    && /touchClient\(client\.client_id\)/.test(legacyTail));
  check("12. ⭐⭐ LEGACY: NU folosește registration (getRegistrationByClientId/verifyUserRegistration/touchRegistration)",
    !/getRegistrationByClientId/.test(legacyTail) && !/verifyUserRegistration/.test(legacyTail) && !/touchRegistration/.test(legacyTail));
  check("13. ⭐⭐ LEGACY: fail-closed dacă plan.kind ≠ legacy",
    /plan\.kind !== "legacy"[\s\S]{0,120}invalid_grant/.test(legacyTail));

  // ── 14. Import-uri necesare prezente ──
  check("14. ⭐ import readAuthCodeIdentity + (deja) verifyUserRegistration/getRegistrationByClientId/touchRegistration",
    /import \{ readAuthCodeIdentity \}/.test(src)
    && /verifyUserRegistration/.test(src) && /getRegistrationByClientId/.test(src) && /touchRegistration/.test(src));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
