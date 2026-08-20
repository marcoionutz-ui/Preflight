/**
 * lib/oauth/entitlement.test.ts — PH-2a GUARD (rezolvare scope + semantica read:all + clamp la refresh, pur).
 */
import { resolveGrantedScopes, isAccountUsable, clampScopes, scopeCoveredByEntitlement } from "./entitlement";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

function main(): void {
console.log("PH-2a — entitlement (semantica read:all + clamp, pur)");

// serverPolicy concretă (ca app/.well-known + KNOWN_SCOPES), inclusiv un scope non-read ipotetic.
const POLICY = ["read:basic", "read:all", "read:market", "read:pair", "read:safety", "read:reports"];

// ── semantica read:all (cgpt P1) ──────────────────────────────────────────────
check("1. ⭐⭐⭐ cont [read:all] + cere [read:pair] → [read:pair] (NU [])",
  eq(resolveGrantedScopes(["read:pair"], ["read:all"], POLICY), ["read:pair"]));
check("2. ⭐⭐ cont [read:all] + cere mai multe granulare → toate (acoperite de wildcard)",
  eq(resolveGrantedScopes(["read:pair", "read:market"], ["read:all"], POLICY), ["read:pair", "read:market"]));
check("3. ⭐⭐ cont [read:all] + cerere goală → [read:all] (comportament actual păstrat)",
  eq(resolveGrantedScopes([], ["read:all"], POLICY), ["read:all"]));
check("4. ⭐⭐⭐ read:all NU acoperă non-read (admin:x cerut → exclus)",
  eq(resolveGrantedScopes(["read:pair", "admin:x"], ["read:all"], POLICY), ["read:pair"]));
check("5. ⭐ read:all acoperă read:all însuși", scopeCoveredByEntitlement("read:all", new Set(["read:all"])) === true);
check("6. ⭐ read:all NU acoperă admin", scopeCoveredByEntitlement("admin:x", new Set(["read:all"])) === false);

// ── intersecție literală (cont fără read:all) ─────────────────────────────────
check("7. cont granular: requested ∩ account ∩ policy",
  eq(resolveGrantedScopes(["read:basic", "read:market"], ["read:basic", "read:market", "read:pair"], POLICY), ["read:basic", "read:market"]));
check("8. ⭐ cere mai mult decât are contul (fără read:all) → doar ce are contul",
  eq(resolveGrantedScopes(["read:market", "read:pair"], ["read:market"], POLICY), ["read:market"]));
check("9. ⭐ cere ceva ce policy nu conține → exclus (chiar dacă contul îl are)",
  eq(resolveGrantedScopes(["read:basic", "read:ghost"], ["read:basic", "read:ghost"], POLICY), ["read:basic"]));
check("10. ⭐ nimic comun → [] (fail-closed)", eq(resolveGrantedScopes(["read:reports"], ["read:basic"], POLICY), []));
check("11. dedup + ordine stabilă", eq(resolveGrantedScopes(["read:pair", "read:pair", "read:basic"], ["read:pair", "read:basic"], POLICY), ["read:pair", "read:basic"]));
check("12. account gol → []", eq(resolveGrantedScopes(["read:basic"], [], POLICY), []));

// ── isAccountUsable ───────────────────────────────────────────────────────────
check("13. active + scopes → usable", isAccountUsable({ status: "active", scopes: ["read:basic"] }) === true);
check("14. suspended → NU", isAccountUsable({ status: "suspended", scopes: ["read:basic"] }) === false);
check("15. revoked → NU", isAccountUsable({ status: "revoked", scopes: ["read:basic"] }) === false);
check("16. active fără scopes → NU (fail-closed)", isAccountUsable({ status: "active", scopes: [] }) === false);

// ── clampScopes la refresh: grant ∩ account curent ∩ policy curentă (cgpt P2) ─
check("17. grant ⊆ cont+policy → neschimbat", eq(clampScopes(["read:basic"], ["read:basic", "read:pair"], POLICY), ["read:basic"]));
check("18. ⭐⭐⭐ policy RETRAGE un scope din grant+cont → dropat la refresh",
  eq(clampScopes(["read:pair"], ["read:pair", "read:basic"], ["read:basic", "read:market"]), []));
check("19. ⭐⭐ policy retrage read:pair dar păstrează read:basic → doar read:basic supraviețuiește",
  eq(clampScopes(["read:pair", "read:basic"], ["read:pair", "read:basic"], ["read:basic", "read:market"]), ["read:basic"]));
check("20. ⭐⭐ contul restrâns (fără read:all acum) → grant read:pair via wildcard vechi cade dacă contul nu-l mai acoperă",
  eq(clampScopes(["read:pair"], ["read:basic"], POLICY), []));
check("21. ⭐ cont [read:all] curent + grant granular + policy îl are → păstrat (wildcard cont acoperă)",
  eq(clampScopes(["read:pair"], ["read:all"], POLICY), ["read:pair"]));
check("22. ⭐ cont [read:all] curent DAR policy a retras read:pair → dropat (policy concretă câștigă)",
  eq(clampScopes(["read:pair"], ["read:all"], ["read:basic", "read:market"]), []));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
