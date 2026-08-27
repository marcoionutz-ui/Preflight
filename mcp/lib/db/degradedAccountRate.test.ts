/**
 * lib/db/degradedAccountRate.test.ts — PH-2 step 10.5 (plasa degraded ACCOUNT-ONLY, comportamental; rework DCR).
 *
 * Fix cgpt DCR: un token USER (client DCR public) NU are entitlement de client în oauth_clients → NU există dimensiune
 * secundară de client de plafonat. Plasa degraded (Redis jos) e ACCOUNT-ONLY: un singur bucket `acct:${userId}`
 * (`emergencyRateAllow`), testabil pur în tsx cu `__resetDegradedState`. Verificăm: (1) limita 0 tot mărginește (burst
 * apoi deny); (2) useri diferiți → bucket-uri INDEPENDENTE; (3) namespace `acct:${id}` DISTINCT de bucket-urile de
 * client legacy (fără coliziune dacă un client are același id ca userId).
 */
import { __degradedAccountRateForTest as degradedAccountRate } from "./oauth-tokens";
import { __resetDegradedState, emergencyRateAllow } from "../mcp/degraded";
import type { ScopeLimits } from "./quotaAtomic";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const GEN:  ScopeLimits = { perMinute: 60, perDay: 100000 }; // generos (burst efectiv 2)
const ZERO: ScopeLimits = { perMinute: 0,  perDay: 0 };      // limită 0 (tot burst 2 — plasa e bounded, nu strict 0)
const ok = (r: { status: string }) => r.status === "ok";

function main(): void {
console.log("PH-2 step 10.5 — degradedAccountRate (account-only, comportamental)");

// ── 1. limită cont 0 → burst (2) apoi deny (același user) ──────────────────────────
__resetDegradedState();
const r1a = degradedAccountRate("u1", ZERO);
const r1b = degradedAccountRate("u1", ZERO);
const r1c = degradedAccountRate("u1", ZERO);
check("1. ⭐⭐ cont limită 0: primele 2 (burst) trec", ok(r1a) && ok(r1b));
check("2. ⭐⭐⭐ cont limită 0: al 3-lea → unavailable (bucket cont epuizat, NU fail-open)", r1c.status === "unavailable");

// ── 3. useri DIFERIȚI → bucket-uri INDEPENDENTE (acct:${userId}) ───────────────────
__resetDegradedState();
const uA1 = degradedAccountRate("uA", ZERO);
const uA2 = degradedAccountRate("uA", ZERO);
const uA3 = degradedAccountRate("uA", ZERO); // uA epuizat
const uB1 = degradedAccountRate("uB", ZERO); // uB proaspăt → trece
check("3. ⭐⭐⭐ uA epuizat (2+deny) dar uB proaspăt → uB trece (bucket per-cont independent)",
  ok(uA1) && ok(uA2) && uA3.status === "unavailable" && ok(uB1));

// ── 4. account generos → trece (plasa bounded lasă burst-ul) ──────────────────────
__resetDegradedState();
check("4. ⭐⭐ cont generos → trece", ok(degradedAccountRate("uX", GEN)));

// ── 5. namespace `acct:${id}` DISTINCT de bucket-ul de client legacy cu același id ─
__resetDegradedState();
// drenează bucket-ul CLIENT "dup" direct (2 burst) → al 3-lea client-call ar fi deny
emergencyRateAllow("dup", 0); emergencyRateAllow("dup", 0);
check("5. ⭐⭐ (setup) bucket client 'dup' drenat → următorul emergencyRateAllow('dup',0) = unavailable",
  emergencyRateAllow("dup", 0) === "unavailable");
// contul "dup" folosește `acct:dup` (DISTINCT de clientul "dup" drenat) → trece
check("6. ⭐⭐⭐ cont 'dup' (bucket acct:dup, NEatins de clientul 'dup' drenat) → ok (fără coliziune de namespace)",
  ok(degradedAccountRate("dup", GEN)));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
