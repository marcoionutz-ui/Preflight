/**
 * lib/mcp/moverReadTime.test.ts — E38 (offset read-time pe movers Solana).
 *
 * Dovedește că `adjustMoverReadTime` adună offset-ul read-time la `currentAgeSec` și re-derivă STALE la fel ca
 * moversTracker.getHistoryStatus (STALE peste 10m, suprascrie non-STALE; UNKNOWN lăsat neatins). Leaf pur → tsx.
 */
import { adjustMoverReadTime, MOVER_STALE_AGE_SEC } from "./moverReadTime";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

function main(): void {
  console.log("E38 — adjustMoverReadTime (currentAgeSec += computedAgeSec, STALE re-derivat)");

  // currentAgeSec primește offset-ul read-time.
  const a = adjustMoverReadTime(30, "READY", 45);
  check("1. * currentAgeSec = compute + offset (30+45=75)", a.currentAgeSec === 75);
  check("2. proaspăt sub prag -> status neschimbat (READY)", a.historyStatus === "READY");

  // Offset-ul împinge vârsta peste pragul de 10m -> STALE re-derivat (chiar dacă compute-time era READY).
  const b = adjustMoverReadTime(300, "READY", 320);
  check("3. * 300+320=620 > 600 -> STALE (era READY la compute)", b.historyStatus === "STALE" && b.currentAgeSec === 620);

  // STALE suprascrie și PARTIAL/INSUFFICIENT (precedența din getHistoryStatus).
  check("4. PARTIAL + vârstă efectivă >10m -> STALE", adjustMoverReadTime(400, "PARTIAL", 250).historyStatus === "STALE");
  check("5. INSUFFICIENT + vârstă efectivă >10m -> STALE", adjustMoverReadTime(590, "INSUFFICIENT", 30).historyStatus === "STALE");

  // Prag exact: 600 NU e STALE (> strict, ca în getHistoryStatus); 601 e STALE.
  check("6. exact 600s -> NU STALE (> strict)", adjustMoverReadTime(600, "READY", 0).historyStatus === "READY");
  check("7. 601s -> STALE", adjustMoverReadTime(600, "READY", 1).historyStatus === "STALE");
  check("8. pragul e 10 min", MOVER_STALE_AGE_SEC === 600);

  // UNKNOWN (coercion defensiv reader) NU e promovat la STALE — nu inventăm certitudine pe record suspect.
  check("9. * UNKNOWN + vârstă mare -> rămâne UNKNOWN", adjustMoverReadTime(999, "UNKNOWN", 999).historyStatus === "UNKNOWN");

  // Robustețe: valori negative/NaN tratate ca 0 (nu produc vârste absurde).
  check("10. offset negativ -> ignorat (0)", adjustMoverReadTime(50, "READY", -5).currentAgeSec === 50);
  check("11. compute NaN -> 0 + offset", adjustMoverReadTime(NaN, "READY", 40).currentAgeSec === 40);
  check("12. ambele invalide -> 0, status neschimbat", (() => { const r = adjustMoverReadTime(NaN, "READY", NaN); return r.currentAgeSec === 0 && r.historyStatus === "READY"; })());

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main();
