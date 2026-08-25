/**
 * lib/oauth/userAccountVerify.test.ts — PH-2 step 10.5a frunza 4a (verificarea contului USER, pur).
 */
import { verifyUserAccount } from "./userAccountVerify";
import type { AccountEntitlementLookup } from "../db/entitlementLookup";
import type { AccountEntitlement } from "./entitlement";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const ent: AccountEntitlement = {
  user_id: "u1", plan: "pro", scopes: ["read:pair", "read:market"],
  rate_limit_per_minute: 60, rate_limit_per_day: 10000, status: "active", entitlement_version: 2,
};
const found = (e: AccountEntitlement): AccountEntitlementLookup => ({ status: "found", entitlement: e });

function main(): void {
console.log("PH-2 step 10.5a frunza 4a — verifyUserAccount (pur, fail-closed)");

// ── discriminare lookup: 503 vs 401 ──────────────────────────────────────────────
check("1. ⭐⭐⭐ unavailable → 503 (kind unavailable, NU 401 — contul poate exista)",
  (() => { const r = verifyUserAccount({ status: "unavailable", reason: "down" }, "u1", 2); return r.ok === false && r.kind === "unavailable"; })());
check("2. ⭐⭐⭐ not_found → 401 (kind unauthorized, cont fără entitlement)",
  (() => { const r = verifyUserAccount({ status: "not_found" }, "u1", 2); return r.ok === false && r.kind === "unauthorized"; })());

// ── found + utilizabil + versiune ────────────────────────────────────────────────
check("3. ⭐⭐⭐ found activ + user_id + versiune egală → ok + entitlement propagat",
  (() => { const r = verifyUserAccount(found(ent), "u1", 2); return r.ok === true && r.entitlement.plan === "pro"; })());
check("4. ⭐⭐⭐ found SUSPENDED → 401 (acces retras, nu 503)",
  (() => { const r = verifyUserAccount(found({ ...ent, status: "suspended" }), "u1", 2); return r.ok === false && r.kind === "unauthorized"; })());
check("5. ⭐⭐⭐ found REVOKED → 401",
  (() => { const r = verifyUserAccount(found({ ...ent, status: "revoked" }), "u1", 2); return r.ok === false && r.kind === "unauthorized"; })());
check("6. ⭐⭐ found activ dar scopes [] → 401 (isAccountUsable false — fail-closed)",
  (() => { const r = verifyUserAccount(found({ ...ent, scopes: [] }), "u1", 2); return r.ok === false && r.kind === "unauthorized"; })());
check("7. ⭐⭐⭐ entitlement_version cont ≠ token → 401 (plan schimbat = staleness pe CONT)",
  (() => { const r = verifyUserAccount(found(ent), "u1", 3); return r.ok === false && r.kind === "unauthorized"; })());
check("8. ⭐⭐ versiune token mai mică (downgrade) → tot 401 (orice ≠ respinge)",
  (() => { const r = verifyUserAccount(found({ ...ent, entitlement_version: 5 }), "u1", 2); return r.ok === false && r.kind === "unauthorized"; })());

// ── LEGARE user_id (fix cgpt): verifierul confirmă identitatea contului, nu se bazează pe query ──
check("9. ⭐⭐⭐ entitlement pt. u2 dar token pt. u1 → 401 (user_id mismatch — nu scurge contul greșit)",
  (() => { const r = verifyUserAccount(found({ ...ent, user_id: "u2" }), "u1", 2); return r.ok === false && r.kind === "unauthorized"; })());
check("10. ⭐⭐⭐ mismatch e 401 (unauthorized), NU 503 (nu-i outage, e cont greșit)",
  (() => { const r = verifyUserAccount(found({ ...ent, user_id: "u2" }), "u1", 2); return r.ok === false && r.kind === "unauthorized"; })());
check("11. ⭐⭐ mismatch verificat CHIAR dacă restul e valid (activ + versiune egală)",
  (() => { const r = verifyUserAccount(found({ ...ent, user_id: "uX", status: "active", entitlement_version: 2 }), "u1", 2); return r.ok === false; })());
check("12. ⭐⭐ tokenUserId gol ≠ entitlement.user_id 'u1' → 401 (nu trece pe string gol)",
  (() => { const r = verifyUserAccount(found(ent), "", 2); return r.ok === false && r.kind === "unauthorized"; })());

// ── reason prezent pe fiecare respingere (log) ───────────────────────────────────
check("13. ⭐ reason ne-gol pe unavailable", (() => { const r = verifyUserAccount({ status: "unavailable", reason: "x" }, "u1", 2); return r.ok === false && typeof r.reason === "string" && r.reason.length > 0; })());
check("14. ⭐ reason ne-gol pe 401 (stale)", (() => { const r = verifyUserAccount(found(ent), "u1", 99); return r.ok === false && typeof r.reason === "string" && r.reason.length > 0; })());
check("15. ⭐ reason ne-gol pe user_id mismatch", (() => { const r = verifyUserAccount(found({ ...ent, user_id: "u2" }), "u1", 2); return r.ok === false && typeof r.reason === "string" && r.reason.length > 0; })());

// ── ok expune plan + rate-limits (apelantul le folosește: subiect=cont) ──────────
check("16. ⭐⭐ ok expune rate_limit_per_minute/day (pt. planul de quota account)",
  (() => { const r = verifyUserAccount(found(ent), "u1", 2); return r.ok === true && r.entitlement.rate_limit_per_minute === 60 && r.entitlement.rate_limit_per_day === 10000; })());
check("17. ⭐ ok expune user_id (subiect account) + scopes",
  (() => { const r = verifyUserAccount(found(ent), "u1", 2); return r.ok === true && r.entitlement.user_id === "u1" && r.entitlement.scopes.length === 2; })());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
