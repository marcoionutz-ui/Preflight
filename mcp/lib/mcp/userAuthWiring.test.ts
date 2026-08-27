/**
 * lib/mcp/userAuthWiring.test.ts — PH-2 step 10.5 (GUARD de sursă pe wiring-ul de producție al ramurii USER; rework DCR).
 *
 * „Test verde pe helper ≠ producție wired" (cgpt): ramura user din `resolveAuth` e pură + dep-injectată; aici verificăm
 * că `auth.ts` INJECTEAZĂ deps-urile REALE corecte pentru un client DCR PUBLIC — REGISTRATION (`getRegistrationByClientId`)
 * + `touchRegistration` (oauth_client_registrations), NU `lookupClientById`/`touchClient` (oauth_clients) — ȘI că
 * `checkAccountRateLimit` (oauth-tokens) e ACCOUNT-ONLY (fără dimensiune de client). cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 step 10.5 — wiring producție ramură USER DCR (guard de sursă)");

const auth   = readFileSync("lib/mcp/auth.ts", "utf8");
const tokens = readFileSync("lib/db/oauth-tokens.ts", "utf8");

// ── auth.ts: importuri (registration + touchRegistration din ph2Reads) ────────────
check("1. ⭐⭐ auth.ts importă checkAccountRateLimit din oauth-tokens",
  /import\s*\{[^}]*checkAccountRateLimit[^}]*\}\s*from\s*"@\/lib\/db\/oauth-tokens"/.test(auth));
check("2. ⭐⭐⭐ auth.ts importă getRegistrationByClientId + touchRegistration din ph2Reads",
  /import\s*\{[^}]*getRegistrationByClientId[^}]*touchRegistration[^}]*\}\s*from\s*"@\/lib\/db\/ph2Reads"/.test(auth));

// ── auth.ts: cablarea deps-urilor USER în resolveAuth (registration, NU oauth_clients) ──
check("3. ⭐⭐⭐ auth.ts leagă getRegistration: getRegistrationByClientId", /getRegistration:\s*getRegistrationByClientId/.test(auth));
check("4. ⭐⭐⭐ auth.ts leagă touchRegistration (shorthand — last_used_at pe registration)", /\btouchRegistration\b\s*,/.test(auth));
check("5. ⭐⭐⭐ auth.ts leagă checkAccountRate: checkAccountRateLimit", /checkAccountRate:\s*checkAccountRateLimit/.test(auth));
check("6. ⭐⭐ cele 5 deps user sunt în ACELAȘI apel resolveAuth (după familyState)",
  /resolveAuth\(authHeader,\s*\{[\s\S]*familyState:\s*getFamilyState[\s\S]*getRegistration:\s*getRegistrationByClientId[\s\S]*checkAccountRate:\s*checkAccountRateLimit[\s\S]*touchRegistration[\s\S]*\}\)/.test(auth));
check("7. ⭐⭐⭐ ramura user NU se bazează pe touchClient în apelul resolveAuth (touch client rămâne DOAR pt. calea client/legacy)",
  /touch:\s*touchClient/.test(auth)); // touchClient rămâne cablat pt. calea client, dar user folosește touchRegistration

// ── oauth-tokens.ts: checkAccountRateLimit ACCOUNT-ONLY ───────────────────────────
check("8. ⭐⭐⭐ oauth-tokens exportă checkAccountRateLimit(userId, account) (fără params de client)",
  /export async function checkAccountRateLimit\(\s*userId:\s*string,\s*account:\s*ScopeLimits,?\s*\)/.test(tokens));
check("9. ⭐⭐⭐ folosește authCodeQuotaPlan(userId, account, { accountOnly: true }) (fără dimensiune client)",
  /authCodeQuotaPlan\(userId,\s*account,\s*\{\s*accountOnly:\s*true\s*\}\)/.test(tokens));
check("10. ⭐⭐⭐ rulează QUOTA_CHECK_INCR_LUA pe cheile planului (atomic, all-or-nothing)",
  /r\.eval\(QUOTA_CHECK_INCR_LUA,\s*keys\.length,\s*\.\.\.keys,\s*\.\.\.argv\)/.test(tokens));
check("11. ⭐⭐⭐ dispecerizează prin quotaFromEval(res, plan.length)", /quotaFromEval\(res,\s*plan\.length\)/.test(tokens));
check("12. ⭐⭐⭐ toate cele 3 căi de eroare Redis (jos/corupt/throw) → degradedAccountRate(userId, account) (account-only, NU fail-open)",
  (tokens.match(/degradedAccountRate\(userId,\s*account\)/g) || []).length >= 3);
// izolează corpul funcțiilor account-only (nu întregul fișier — care conține și limiterul CLIENT legacy pe clientId).
const degAcctBody = (tokens.match(/function degradedAccountRate\([\s\S]*?\n\}/) || [""])[0];
const checkAcctBody = (tokens.match(/export async function checkAccountRateLimit\([\s\S]*?\n\}/) || [""])[0];
check("13. ⭐⭐⭐ degradedAccountRate păstrează DOAR bucket-ul cont pe `acct:${userId}` (fără bucket de client)",
  /emergencyRateAllow\(`acct:\$\{userId\}`,\s*account\.perMinute\)/.test(degAcctBody) && !/clientId/.test(degAcctBody));
check("14. ⭐⭐ succes Redis → checkAccountRateLimit curăță DOAR bucket-ul contului (acct:${userId}), fără clearDegradedRate(clientId)",
  /clearDegradedRate\(`acct:\$\{userId\}`\)/.test(checkAcctBody) && !/clearDegradedRate\(clientId\)/.test(checkAcctBody));
check("15. ⭐⭐ importă primitivele 9a din quotaAtomic (QUOTA_CHECK_INCR_LUA/quotaFromEval/authCodeQuotaPlan/evalArgs)",
  /import\s*\{[^}]*QUOTA_CHECK_INCR_LUA[^}]*quotaFromEval[^}]*authCodeQuotaPlan[^}]*evalArgs[^}]*\}\s*from\s*"\.\/quotaAtomic"/.test(tokens));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
