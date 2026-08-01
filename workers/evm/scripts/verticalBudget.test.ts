/**
 * scripts/verticalBudget.test.ts — E36 (buget vertical numărat corect).
 *
 * Dovedește că `countsTowardVerticalBudget` include EXACT benzile procesate de `verticalCandidatesLoop`
 * (VERTICAL + CONFIRMED_MOMENTUM) și nimic altceva → count-ul de buget din scan.ts și filtrul loop-ului nu
 * pot drifta. Leaf pur → rulează standalone în tsx.
 */
import { countsTowardVerticalBudget } from "../src/pipeline/verticalBudget";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

function main(): void {
  console.log("E36 — countsTowardVerticalBudget (banda verticală = VERTICAL + CONFIRMED_MOMENTUM)");

  // Benzile procesate de verticalCandidatesLoop → intră la buget.
  check("1. VERTICAL -> numărat", countsTowardVerticalBudget("VERTICAL") === true);
  check("2. * CONFIRMED_MOMENTUM -> numărat (bugul vechi îl rata)", countsTowardVerticalBudget("CONFIRMED_MOMENTUM") === true);

  // Alte benzi → NU intră la bugetul vertical.
  check("3. NORMAL -> nenumărat", countsTowardVerticalBudget("NORMAL") === false);
  check("4. LATE -> nenumărat", countsTowardVerticalBudget("LATE") === false);
  check("5. FOMO -> nenumărat", countsTowardVerticalBudget("FOMO") === false);

  // kind absent (ActiveWatch.kind e opțional) → nenumărat, nu aruncă.
  check("6. undefined -> nenumărat (nu aruncă)", countsTowardVerticalBudget(undefined) === false);

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main();
