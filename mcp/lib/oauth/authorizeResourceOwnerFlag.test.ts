/**
 * lib/oauth/authorizeResourceOwnerFlag.test.ts — PH-2 pas 6 frunză 3a (flag dormant, pur).
 *
 * FAIL-SAFE spre comportamentul stabil (INVERS față de cutover): doar truthy EXPLICIT aprinde fluxul resource-owner;
 * absent / falsy / gunoi / necunoscut → OFF (rămâne pe `/authorize` client de azi). Alte env vars nu influențează.
 */
import { isResourceOwnerAuthorizeEnabled } from "./authorizeResourceOwnerFlag";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const F = (raw: string | undefined) =>
  isResourceOwnerAuthorizeEnabled(raw === undefined ? {} : { PH2_RESOURCE_OWNER_AUTHORIZE: raw });

function main(): void {
console.log("PH-2 pas 6 frunză 3a — isResourceOwnerAuthorizeEnabled (fail-safe spre client de azi)");

// ── OFF: default + falsy + necunoscut (fail-safe) ─────────────────────────────────
check("1. ⭐⭐⭐ absent (undefined) → false (deploy nesetat = /authorize de azi)", F(undefined) === false);
check("2. ⭐⭐ '' (set gol) → false", F("") === false);
check("3. ⭐⭐ '0' → false", F("0") === false);
check("4. ⭐⭐ 'false' → false", F("false") === false);
check("5. ⭐ 'no'/'off' → false", F("no") === false && F("off") === false);
check("6. ⭐⭐⭐ gunoi / necunoscut ('2'/'enable'/'treu') → false (INVERS de cutover: nu aprinde din greșeală)",
  F("2") === false && F("enable") === false && F("treu") === false);
check("7. ⭐ '  false  ' (trim) → false", F("  false  ") === false);

// ── ON: doar truthy explicit ──────────────────────────────────────────────────────
check("8. ⭐⭐⭐ '1' → true", F("1") === true);
check("9. ⭐⭐ 'true'/'TRUE'/'True' (case-insensitive) → true", F("true") === true && F("TRUE") === true && F("True") === true);
check("10. ⭐ 'yes'/'on' → true", F("yes") === true && F("on") === true);
check("11. ⭐⭐ ' 1 ' (trim) → true", F(" 1 ") === true);
check("12. ⭐⭐ ' YES ' (trim + case) → true", F(" YES ") === true);

// ── izolare ───────────────────────────────────────────────────────────────────────
check("13. ⭐ altă env var nu influențează (fără PH2_RESOURCE_OWNER_AUTHORIZE → false)",
  isResourceOwnerAuthorizeEnabled({ OTHER: "1" }) === false);
check("14. ⭐⭐ non-string (undefined explicit pe cheie) → false", isResourceOwnerAuthorizeEnabled({ PH2_RESOURCE_OWNER_AUTHORIZE: undefined }) === false);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
