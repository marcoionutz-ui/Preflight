/**
 * scripts/snapshotTtl.test.ts — E24 (TTL snapshot ≥ 2× intervalul de scan).
 *
 * Dovedește că `snapshotTtlSec` întoarce mereu ≥ 2× intervalul (repară flap-ul din DEV) și păstrează floor-ul
 * de 120s pentru modurile rapide. Leaf pur → rulează standalone în tsx.
 */
import { snapshotTtlSec } from "../src/pipeline/snapshotTtl";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

// Intervalele reale din config/mode.ts (BUDGETS).
const DEV = 120_000, BURST = 60_000, LIVE = 30_000, PAID = 15_000;

function main(): void {
  console.log("E24 — snapshotTtlSec (TTL >= 2x scanInterval, floor 120s)");

  // * Bugul: DEV scan 120s cu TTL 120 → flap. Acum 240 (2x).
  check("1. * DEV (120s) -> 240 (era 120 == interval = flap)", snapshotTtlSec(DEV) === 240);
  check("2. BURST (60s) -> 120 (== 2x, floor)", snapshotTtlSec(BURST) === 120);
  check("3. LIVE (30s) -> 120 (floor, > 2x)", snapshotTtlSec(LIVE) === 120);
  check("4. PAID (15s) -> 120 (floor)", snapshotTtlSec(PAID) === 120);

  // Invarianta E24: TTL >= 2x interval pe TOATE modurile.
  for (const [name, ms] of [["DEV", DEV], ["BURST", BURST], ["LIVE", LIVE], ["PAID", PAID]] as const) {
    check("5. * " + name + ": TTL >= 2x interval", snapshotTtlSec(ms) >= Math.ceil(ms / 1000) * 2);
  }

  // Floor 120 pe orice interval mic.
  check("6. interval 1s -> 120 (floor, nu 2)", snapshotTtlSec(1000) === 120);

  // Interval mare > floor → 2x exact.
  check("7. interval 300s -> 600 (2x, peste floor)", snapshotTtlSec(300_000) === 600);

  // Rotunjire în sus la secundă înainte de 2x.
  check("8. 119_500ms -> ceil(119.5)=120 *2 = 240", snapshotTtlSec(119_500) === 240);

  // Robustețe: valori invalide → floor 120 (NU NaN).
  check("9. * NaN -> 120 (floor, nu NaN)", snapshotTtlSec(NaN) === 120);
  check("10. 0 -> 120 (floor)", snapshotTtlSec(0) === 120);
  check("11. negativ -> 120 (floor)", snapshotTtlSec(-5000) === 120);
  check("12. Infinity -> 120 (floor, nu Infinity)", snapshotTtlSec(Infinity) === 120);

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main();
