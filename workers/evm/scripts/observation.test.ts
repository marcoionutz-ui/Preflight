/**
 * lib/observation.test.ts — E34 (advisor wording + one-sided flow counts-driven).
 *
 * `buildWorkerObservation` e o funcție PURĂ (zero importuri) → rulează standalone în tsx.
 *
 * Dovedește: (1) buy-only și sell-only sunt identificate din `flowCounts` TIPIZAT (înainte `(ctx as any).flow`
 * era mereu undefined → 0/0 → fallback 'stale', iar sell-only NU era identificat); (2) mesajul one-sided apare
 * O SINGURĂ DATĂ (înainte buy-only ieșea dublat: flow-block + risk-block); (3) fără counts → 'counts unavailable'
 * NU 'stale'; (4) DISTRIBUTION_RISK are prioritate (suprimă one-sided); (5) reformulările non-advisory.
 */
import { buildWorkerObservation, type ObservationContext } from "../src/lib/observation";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

// Context de bază neutru — flowStatus/riskFlags se suprascriu per test.
function base(): ObservationContext {
  return {
    moveType:           "UNKNOWN",
    momentumLevel:      "NONE",
    flowStatus:         "NO_DATA",
    liquidityStatus:    "OK",
    entryRisk:          "MEDIUM",
    riskFlags:          [],
    opportunitySignals: [],
    pipelineState:      "NONE",
    confidence:         "MEDIUM",
  };
}
function obs(o: Partial<ObservationContext>): string {
  return buildWorkerObservation({ ...base(), ...o });
}

const BUY_ONLY  = "No sell pressure observed — buying-only flow in current window.";
const SELL_ONLY = "Sell-only flow observed — buying support absent in current window.";
const UNAVAIL   = "One-sided flow observed; current buy/sell counts unavailable.";
// numără câte propoziții one-sided (din cele 3) apar -> dovada 'o singură propoziție'.
function oneSidedCount(s: string): number {
  return [BUY_ONLY, SELL_ONLY, UNAVAIL].filter(x => s.includes(x)).length;
}

function main(): void {
console.log("E34 — buildWorkerObservation (wording + one-sided counts-driven)");

// -- buy-only via riskFlag ONE_SIDED_FLOW + counts --
const buyRisk = obs({ flowStatus: "WEAK", riskFlags: ["ONE_SIDED_FLOW"], flowCounts: { buys5m: 5, sells5m: 0 } });
check("1. * buy-only (ONE_SIDED_FLOW + counts 5/0) -> mesaj buy-only", buyRisk.includes(BUY_ONLY));
check("2. buy-only NU contine mesajul sell-only", !buyRisk.includes(SELL_ONLY));
check("3. * buy-only NU mai spune 'incomplete or stale' (bugul vechi)", !buyRisk.toLowerCase().includes("stale"));
check("4. * buy-only = O SINGURA propozitie one-sided (nu dublat)", oneSidedCount(buyRisk) === 1);

// -- sell-only via riskFlag ONE_SIDED_FLOW + counts (cazul care NU era identificat) --
const sellOnly = obs({ flowStatus: "WEAK", riskFlags: ["ONE_SIDED_FLOW"], flowCounts: { buys5m: 0, sells5m: 5 } });
check("5. * sell-only (counts 0/5) -> mesaj sell-only (inainte NU era identificat)", sellOnly.includes(SELL_ONLY));
check("6. sell-only NU contine mesajul buy-only", !sellOnly.includes(BUY_ONLY));
check("7. sell-only = o singura propozitie one-sided", oneSidedCount(sellOnly) === 1);

// -- buy-only via flowStatus ONE_SIDED + riskFlag (dedup: flow-block + risk-block nu mai dubleaza) --
const both = obs({ flowStatus: "ONE_SIDED", riskFlags: ["ONE_SIDED_FLOW"], flowCounts: { buys5m: 8, sells5m: 0 } });
check("8. * flowStatus ONE_SIDED + ONE_SIDED_FLOW -> tot O SINGURA propozitie (dedup)", oneSidedCount(both) === 1);
check("9. dedup: mesajul e cel buy-only din counts", both.includes(BUY_ONLY));
check("10. * NU mai apare vechiul string din flow-block ('One-sided buy flow — sell side absent.')",
  !both.includes("One-sided buy flow — sell side absent."));

// -- flowStatus ONE_SIDED singur (fara riskFlag) tot produce mesaj --
const statusOnly = obs({ flowStatus: "ONE_SIDED", flowCounts: { buys5m: 6, sells5m: 0 } });
check("11. flowStatus ONE_SIDED singur + counts -> mesaj buy-only (o data)",
  statusOnly.includes(BUY_ONLY) && oneSidedCount(statusOnly) === 1);

// -- counts absente -> 'unavailable', NU 'stale' --
const noCounts = obs({ flowStatus: "WEAK", riskFlags: ["ONE_SIDED_FLOW"] }); // fara flowCounts
check("12. * counts absente -> 'counts unavailable'", noCounts.includes(UNAVAIL));
check("13. * counts absente -> NU 'stale'", !noCounts.toLowerCase().includes("stale"));
check("14. counts absente = o singura propozitie one-sided", oneSidedCount(noCounts) === 1);

// -- DISTRIBUTION_RISK are prioritate -> suprima one-sided --
const distrib = obs({
  flowStatus: "ONE_SIDED",
  riskFlags: ["ONE_SIDED_FLOW", "DISTRIBUTION_RISK"],
  flowCounts: { buys5m: 7, sells5m: 0 },
});
check("15. * DISTRIBUTION_RISK -> propozitia de distribution e prezenta",
  distrib.includes("Distribution pattern possible — elevated sell ratio during buying."));
check("16. * DISTRIBUTION_RISK -> one-sided SUPRIMAT (0 propozitii one-sided)", oneSidedCount(distrib) === 0);

// -- reformulari non-advisory (pastrate) --
const qualified = obs({ pipelineState: "QUALIFIED" });
check("17. QUALIFIED -> 'All configured qualification checks were observed.'",
  qualified.includes("All configured qualification checks were observed."));
check("18. * QUALIFIED NU mai spune 'Passed all filters.'", !qualified.includes("Passed all filters."));
const highConf = obs({ confidence: "HIGH", flowStatus: "STRONG" });
check("19. HIGH+STRONG -> 'High data confidence for the observed state.'",
  highConf.includes("High data confidence for the observed state."));
check("20. * HIGH+STRONG NU mai spune 'High confidence signal.'", !highConf.includes("High confidence signal."));

// -- fara one-sided cand nu-i cazul --
const plain = obs({ flowStatus: "BUYING", flowCounts: { buys5m: 4, sells5m: 3 } });
check("21. flow normal (fara ONE_SIDED/ONE_SIDED_FLOW) -> 0 propozitii one-sided", oneSidedCount(plain) === 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main();
