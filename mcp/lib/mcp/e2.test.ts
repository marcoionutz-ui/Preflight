/**
 * lib/mcp/e2.test.ts — E2 (dev auth bypass — opt-in explicit, fail-closed).
 *
 * Vechiul gate se DESCHIDEA din absența config-ului (`!MCP_API_KEY && NODE_ENV !== "production"`) → un deploy care
 * uita cheia, cu NODE_ENV nesetat, dădea acces LIBER read:all. Acum bypass-ul cere flag EXPLICIT + non-producție.
 * `authPolicy.ts` importă doar `import type` (șters de esbuild) → rulabil standalone în tsx.
 */
import { isDevBypassEnabled, resolveDevBypass } from "./authPolicy";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

function main(): void {
console.log("E2 — isDevBypassEnabled (truthy explicit)");
check("1. '1' → true", isDevBypassEnabled("1") === true);
check("2. 'true' → true", isDevBypassEnabled("true") === true);
check("3. 'TRUE'/'True' (case-insensitive) → true", isDevBypassEnabled("TRUE") === true && isDevBypassEnabled("True") === true);
check("4. 'yes'/'on' → true", isDevBypassEnabled("yes") === true && isDevBypassEnabled("on") === true);
check("5. ' 1 ' (trim) → true", isDevBypassEnabled(" 1 ") === true);
check("6. '0' → false", isDevBypassEnabled("0") === false);
check("7. 'false' → false", isDevBypassEnabled("false") === false);
check("8. '' → false", isDevBypassEnabled("") === false);
check("9. undefined → false", isDevBypassEnabled(undefined) === false);
check("10. '2'/'enabled'/'maybe' → false (doar truthy cunoscut)", isDevBypassEnabled("2") === false && isDevBypassEnabled("enabled") === false);

console.log("\nE2 — resolveDevBypass (opt-in explicit + non-producție)");
const dev = resolveDevBypass({ nodeEnv: "development", bypassFlag: "1" });
check("11. dev + flag '1' → bypass (ok)", dev?.ok === true);
check("12. bypass = clientId 'dev', scopes [read:all], plan 'internal'", dev?.clientId === "dev" && JSON.stringify(dev?.scopes) === JSON.stringify(["read:all"]) && dev?.plan === "internal");
check("13. NODE_ENV nesetat (undefined) + flag → bypass (non-prod)", resolveDevBypass({ nodeEnv: undefined, bypassFlag: "1" })?.ok === true);
check("14. 'staging' + flag → bypass (non-prod, explicit)", resolveDevBypass({ nodeEnv: "staging", bypassFlag: "true" })?.ok === true);

console.log("\nE2 — ⭐ producție NICIODATĂ (chiar cu flag)");
check("15. ⭐ 'production' + flag '1' → null", resolveDevBypass({ nodeEnv: "production", bypassFlag: "1" }) === null);
check("16. ⭐ 'PRODUCTION' (case) + flag → null", resolveDevBypass({ nodeEnv: "PRODUCTION", bypassFlag: "1" }) === null);
check("17. ⭐ ' production ' (trim) + flag → null", resolveDevBypass({ nodeEnv: " production ", bypassFlag: "1" }) === null);

console.log("\nE2 — ⭐ fail-closed: absența opt-in-ului NU deschide ușa");
check("18. ⭐ dev + FĂRĂ flag (undefined) → null (era bug-ul: acces liber)", resolveDevBypass({ nodeEnv: "development", bypassFlag: undefined }) === null);
check("19. ⭐ dev + flag '0' → null", resolveDevBypass({ nodeEnv: "development", bypassFlag: "0" }) === null);
check("20. ⭐ dev + flag '' → null", resolveDevBypass({ nodeEnv: "development", bypassFlag: "" }) === null);
check("21. ⭐ dev + flag 'false' → null", resolveDevBypass({ nodeEnv: "development", bypassFlag: "false" }) === null);
// Regresia concretă: exact condiția care înainte deschidea (fără cheie, non-prod, dar FĂRĂ flag nou) → acum închis.
check("22. ⭐ REGRESIE: non-prod fără flag explicit → null (vechea gaură închisă)", resolveDevBypass({ nodeEnv: "", bypassFlag: undefined }) === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
