/**
 * lib/oauth/authCodeCutover.test.ts — PH-2 step 10.4c (flag cutover legacy, pur).
 * Absent/falsy → false (legacy acceptat în rollout); truthy → true (refuz); PREZENT-NECUNOSCUT → true (fail-closed).
 */
import { isLegacyAuthCodeCutoverEnabled } from "./authCodeCutover";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const F = (raw: string | undefined) => isLegacyAuthCodeCutoverEnabled(raw === undefined ? {} : { PH2_REJECT_LEGACY_AUTHCODE: raw });

function main(): void {
console.log("PH-2 step 10.4c — isLegacyAuthCodeCutoverEnabled (pur, fail-closed pe necunoscut)");

// ── ABSENT / falsy → false (legacy acceptat în rollout) ─────────────────────────
check("1. ⭐⭐⭐ absent (undefined) → false (legacy acceptat în rollout)", F(undefined) === false);
check("2. ⭐⭐ '' (set gol) → false (tratat ca neset)", F("") === false);
check("3. ⭐⭐⭐ '0' → false", F("0") === false);
check("4. ⭐⭐ 'false' → false", F("false") === false);
check("5. ⭐⭐ 'no'/'off' → false (falsy explicit)", F("no") === false && F("off") === false);
check("6. ⭐ '  false  ' (trim) → false", F("  false  ") === false);

// ── truthy → true (cutover activat) ─────────────────────────────────────────────
check("7. ⭐⭐⭐ '1' → true", F("1") === true);
check("8. ⭐⭐ 'true'/'TRUE'/'True' (case-insensitive) → true", F("true") === true && F("TRUE") === true && F("True") === true);
check("9. ⭐ 'yes'/'on' → true", F("yes") === true && F("on") === true);
check("10. ⭐⭐ ' 1 ' (trim) → true", F(" 1 ") === true);

// ── FOOTGUN (fix cgpt): prezent-dar-necunoscut → true (fail-closed, NU redeschide legacy) ──
check("11. ⭐⭐⭐ 'treu' (typo de 'true') → true (fail-closed, nu redeschide legacy tăcut)", F("treu") === true);
check("12. ⭐⭐⭐ 'ture' (alt typo) → true", F("ture") === true);
check("13. ⭐⭐ 'enable'/'enabled'/'reject' (necunoscute) → true", F("enable") === true && F("enabled") === true && F("reject") === true);
check("14. ⭐⭐ '2'/gunoi → true (prezent necunoscut = fail-closed)", F("2") === true && F("x!@#") === true);
check("15. ⭐ regresie: NUMAI valori explicit-false/absent redeschid legacy", F(undefined) === false && F("false") === false && F("0") === false && F("") === false);
check("16. ⭐ alte env vars nu influențează (fără PH2_REJECT_LEGACY_AUTHCODE → false)", isLegacyAuthCodeCutoverEnabled({ OTHER: "1" }) === false);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
