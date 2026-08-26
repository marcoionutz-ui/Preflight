/**
 * lib/mcp/userAuthWiring.test.ts — PH-2 step 10.5a frunza 4c (GUARD de sursă pe wiring-ul de producție al ramurii USER).
 *
 * „Test verde pe helper ≠ producție wired" (cgpt): ramura user din `resolveAuth` (frunza 4b) e pură + dep-injectată;
 * aici verificăm că `auth.ts` chiar INJECTEAZĂ cele trei deps reale (getGrantById / getAccountEntitlement /
 * checkAccountRateLimit) ȘI că `checkAccountRateLimit` (oauth-tokens) folosește planul atomic 9a + degradare simetrică
 * cu `checkRateLimit`. cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 step 10.5a frunza 4c — wiring producție ramură USER (guard de sursă)");

const auth   = readFileSync("lib/mcp/auth.ts", "utf8");
const tokens = readFileSync("lib/db/oauth-tokens.ts", "utf8");

// ── auth.ts: importuri ────────────────────────────────────────────────────────────
check("1. ⭐⭐ auth.ts importă checkAccountRateLimit din oauth-tokens",
  /import\s*\{[^}]*checkAccountRateLimit[^}]*\}\s*from\s*"@\/lib\/db\/oauth-tokens"/.test(auth));
check("2. ⭐⭐ auth.ts importă getGrantById + getAccountEntitlement din ph2Reads",
  /import\s*\{[^}]*getGrantById[^}]*getAccountEntitlement[^}]*\}\s*from\s*"@\/lib\/db\/ph2Reads"/.test(auth));

// ── auth.ts: cablarea celor 3 deps în resolveAuth ─────────────────────────────────
check("3. ⭐⭐⭐ auth.ts leagă getGrant: getGrantById", /getGrant:\s*getGrantById/.test(auth));
check("4. ⭐⭐⭐ auth.ts leagă getAccountEntitlement (shorthand)", /\bgetAccountEntitlement\b\s*,/.test(auth));
check("5. ⭐⭐⭐ auth.ts leagă checkAccountRate: checkAccountRateLimit", /checkAccountRate:\s*checkAccountRateLimit/.test(auth));
check("6. ⭐⭐ cele 3 deps sunt în ACELAȘI apel resolveAuth (după familyState)",
  /resolveAuth\(authHeader,\s*\{[\s\S]*familyState:\s*getFamilyState[\s\S]*getGrant:\s*getGrantById[\s\S]*checkAccountRate:\s*checkAccountRateLimit[\s\S]*\}\)/.test(auth));

// ── oauth-tokens.ts: checkAccountRateLimit folosește planul atomic 9a ─────────────
check("7. ⭐⭐⭐ oauth-tokens exportă checkAccountRateLimit", /export async function checkAccountRateLimit/.test(tokens));
check("8. ⭐⭐⭐ folosește authCodeQuotaPlan(userId, account, { clientId, limits: client }) (account primar + client secundar)",
  /authCodeQuotaPlan\(userId,\s*account,\s*\{\s*clientId,\s*limits:\s*client\s*\}\)/.test(tokens));
check("9. ⭐⭐⭐ rulează QUOTA_CHECK_INCR_LUA pe toate cheile planului (atomic, all-or-nothing)",
  /r\.eval\(QUOTA_CHECK_INCR_LUA,\s*keys\.length,\s*\.\.\.keys,\s*\.\.\.argv\)/.test(tokens));
check("10. ⭐⭐⭐ dispecerizează prin quotaFromEval(res, plan.length) (nu re-implementează parsarea)",
  /quotaFromEval\(res,\s*plan\.length\)/.test(tokens));
check("11. ⭐⭐⭐ toate cele 3 căi de eroare Redis (jos/corupt/throw) → degradedAccountRate(userId, account, clientId, client) (multidimensional, NU fail-open)",
  (tokens.match(/degradedAccountRate\(userId,\s*account,\s*clientId,\s*client\)/g) || []).length >= 3);
check("11a. ⭐⭐⭐ degradedAccountRate păstrează AMBELE dimensiuni: bucket cont pe `acct:${userId}` + bucket client pe `clientId` (partajat cu legacy)",
  /emergencyRateAllow\(`acct:\$\{userId\}`,\s*account\.perMinute\)/.test(tokens) && /emergencyRateAllow\(clientId,\s*client\.perMinute\)/.test(tokens));
check("11b. ⭐⭐⭐ trece DOAR dacă ambele permit (acctOk && clientOk)", /acctOk\s*&&\s*clientOk/.test(tokens));
check("12. ⭐⭐ succes Redis → curăță AMBELE bucket-uri (acct:${userId} + clientId)",
  /clearDegradedRate\(`acct:\$\{userId\}`\)/.test(tokens) && /clearDegradedRate\(clientId\)/.test(tokens));
check("13. ⭐⭐ importă primitivele 9a din quotaAtomic (QUOTA_CHECK_INCR_LUA/quotaFromEval/authCodeQuotaPlan/evalArgs)",
  /import\s*\{[^}]*QUOTA_CHECK_INCR_LUA[^}]*quotaFromEval[^}]*authCodeQuotaPlan[^}]*evalArgs[^}]*\}\s*from\s*"\.\/quotaAtomic"/.test(tokens));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
