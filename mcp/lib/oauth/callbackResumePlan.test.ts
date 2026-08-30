/**
 * lib/oauth/callbackResumePlan.test.ts — PH-2 pas 6 frunză 4a (planner PUR callback de login).
 *
 * Gate-ul (flag) decide DOAR destinația de după un exchange reușit: ON → handoff `/auth/resume`; OFF → `/dashboard`
 * (dormant, legacy). Identitatea nu se atinge aici.
 */
import { planCallbackRedirect } from "./callbackResumePlan";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 pas 6 frunză 4a — planCallbackRedirect (gate handoff/dashboard, pur)");

check("1. ⭐⭐⭐ flag ON → resume_handoff (303 /auth/resume)", planCallbackRedirect(true).kind === "resume_handoff");
check("2. ⭐⭐⭐ flag OFF → dashboard (dormant, comportamentul de azi)", planCallbackRedirect(false).kind === "dashboard");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
