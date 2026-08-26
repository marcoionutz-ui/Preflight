/**
 * lib/db/degradedAccountRate.test.ts — PH-2 step 10.5a frunza 4c (plasa degraded MULTIDIMENSIONALĂ, comportamental).
 *
 * Fix cgpt: la outage Redis, fallback-ul user păstrează AMBELE dimensiuni (cont + client). Fără Redis, funcția
 * folosește DOAR limiterele in-process (emergencyRateAllow) → testabilă pur în tsx cu `__resetDegradedState`.
 * Verificăm: (1) limita clientului 0 tot mărginește (burst apoi deny); (2) mai mulți useri pe ACELAȘI client →
 * plafon AGREGAT (bucket client partajat, NU câte un burst per user); (3) `userId === clientId` → bucket-uri
 * DISTINCTE (`acct:${userId}` vs `clientId`), fără coliziune.
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
console.log("PH-2 step 10.5a frunza 4c — degradedAccountRate (plasă multidimensională, comportamental)");

// ── 1. limită client 0 → burst (2) apoi deny (același user) ───────────────────────
__resetDegradedState();
const r1a = degradedAccountRate("u1", GEN, "c1", ZERO);
const r1b = degradedAccountRate("u1", GEN, "c1", ZERO);
const r1c = degradedAccountRate("u1", GEN, "c1", ZERO);
check("1. ⭐⭐ client limită 0: primele 2 (burst) trec", ok(r1a) && ok(r1b));
check("2. ⭐⭐⭐ client limită 0: al 3-lea → unavailable (bucket client epuizat, nu fail-open)", r1c.status === "unavailable");

// ── 3. mai mulți USERI pe ACELAȘI client → plafon AGREGAT (bucket client partajat) ──
__resetDegradedState();
const mu1 = degradedAccountRate("uA", GEN, "shared", ZERO); // client shared: 2→1
const mu2 = degradedAccountRate("uB", GEN, "shared", ZERO); // client shared: 1→0
const mu3 = degradedAccountRate("uC", GEN, "shared", ZERO); // client shared: 0 → deny
check("3. ⭐⭐⭐ 3 useri DIFERIȚI pe același client (limită mică) → doar 2 trec (plafon agregat pe client)",
  ok(mu1) && ok(mu2) && mu3.status === "unavailable");
check("4. ⭐⭐⭐ al 3-lea user e refuzat DEȘI contul lui e fresh (clientul partajat mărginește, nu per-user burst)",
  mu3.status === "unavailable");

// ── 5. coliziune userId === clientId → bucket-uri DISTINCTE (acct:${id} vs id) ─────
__resetDegradedState();
// drenează bucket-ul CLIENT "dup" direct (2 burst), apoi al 3-lea client-call ar fi deny
emergencyRateAllow("dup", 0); emergencyRateAllow("dup", 0);
check("5. ⭐⭐ (setup) bucket client 'dup' drenat → următorul emergencyRateAllow('dup',0) = unavailable",
  emergencyRateAllow("dup", 0) === "unavailable");
// contul user "dup" folosește `acct:dup` (DISTINCT de clientul "dup" drenat) → cu alt client generos, trece
const coll = degradedAccountRate("dup", GEN, "otherClient", GEN);
check("6. ⭐⭐⭐ user 'dup' (bucket acct:dup, NEatins de clientul 'dup' drenat) + client generos → ok (fără coliziune)",
  ok(coll));

// ── 7. account cap independent: account 0 + client generos → account mărginește ───
__resetDegradedState();
const a1 = degradedAccountRate("uX", ZERO, "cGen", GEN);
const a2 = degradedAccountRate("uX", ZERO, "cGen", GEN);
const a3 = degradedAccountRate("uX", ZERO, "cGen", GEN);
check("7. ⭐⭐ account limită 0 + client generos → burst 2 apoi unavailable (dimensiunea CONT mărginește)",
  ok(a1) && ok(a2) && a3.status === "unavailable");

// ── 8. userId===clientId în ACELAȘI apel, client 0 → tot mărginit de client (nu blend) ──
__resetDegradedState();
const s1 = degradedAccountRate("same", GEN, "same", ZERO); // acct:same (GEN) + client same (0)
const s2 = degradedAccountRate("same", GEN, "same", ZERO);
const s3 = degradedAccountRate("same", GEN, "same", ZERO);
check("8. ⭐⭐⭐ userId===clientId, client 0 + account generos → bound de CLIENT (2 trec, al 3-lea deny — nu se amestecă)",
  ok(s1) && ok(s2) && s3.status === "unavailable");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
