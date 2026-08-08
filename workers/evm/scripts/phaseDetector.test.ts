/**
 * lib/engines/phaseDetector.test.ts — U6 / NF-E33 (win-tracking + legacy-phase removal).
 *
 * `detectPhase` e o funcție PURĂ (singurul import e `type Phase`, erased la runtime) → rulează standalone în tsx.
 *
 * Dovedește:
 *  (1) semantica de bază rămâne: NEW / PUMPING / DUMPING / RECOVERING / TRENDING pe input price-only;
 *  (2) INVARIANTUL DEEP: pe o grilă largă de inputuri, `detectPhase` NU mai întoarce NICIODATĂ
 *      "DEAD" / "ZOMBIE" / "SECOND_WAVE" (fazele derivate din win-tracking, scoase în U6);
 *  (3) `PhaseInput` nu mai are câmpuri de win-tracking (compile-time: construim input fără ele).
 */
import { detectPhase, type PhaseInput, type Phase } from "../src/lib/engines/phaseDetector";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

// Input de bază price-only — fără seenCount>2 declanșează NEW; suprascriem per test.
function inp(o: Partial<PhaseInput>): PhaseInput {
  return {
    seenCount:    5,
    m5:           0,
    h24:          0,
    highPrice:    100,
    lowPrice:     100,
    currentPrice: 100,
    ...o,
  };
}

const ALLOWED: Phase[] = ["NEW", "TRENDING", "PUMPING", "DUMPING", "RECOVERING"];
const LEGACY = ["DEAD", "ZOMBIE", "SECOND_WAVE"];

// ── A. Semantică de bază ──────────────────────────────────────────────────────
check("A1. seenCount<=2 -> NEW", detectPhase(inp({ seenCount: 1 })) === "NEW");
check("A2. seenCount==2 -> NEW", detectPhase(inp({ seenCount: 2 })) === "NEW");
check("A3. m5>15 -> PUMPING", detectPhase(inp({ m5: 20 })) === "PUMPING");
check("A4. h24>150 -> PUMPING", detectPhase(inp({ h24: 200 })) === "PUMPING");
// dump: currentPrice < highPrice*0.70; bounce = (cur-low)/low*100
check("A5. dump, bounce<12 -> DUMPING",
  detectPhase(inp({ highPrice: 100, currentPrice: 50, lowPrice: 49 })) === "DUMPING");
check("A6. dump, bounce>=12 -> RECOVERING",
  detectPhase(inp({ highPrice: 100, currentPrice: 50, lowPrice: 40 })) === "RECOVERING");
check("A7. fără dump, rise>1.12*low -> RECOVERING",
  detectPhase(inp({ highPrice: 60, currentPrice: 60, lowPrice: 50 })) === "RECOVERING");
check("A8. altfel -> TRENDING",
  detectPhase(inp({ highPrice: 100, currentPrice: 90, lowPrice: 89 })) === "TRENDING");

// ── B. INVARIANT DEEP: fazele legacy nu mai sunt produse NICIODATĂ ─────────────
let legacySeen = 0, total = 0;
const seenPhases = new Set<string>();
for (const seenCount of [1, 2, 3, 8, 50, 200]) {
  for (const m5 of [-30, -5, 0, 5, 14, 16, 40]) {
    for (const h24 of [-50, 0, 50, 149, 151, 300]) {
      for (const [highPrice, lowPrice, currentPrice] of [
        [100, 100, 100], [100, 40, 50], [100, 49, 50], [100, 90, 95],
        [60, 50, 60], [100, 89, 90], [0, 0, 0], [100, 10, 12],
      ] as const) {
        const ph = detectPhase(inp({ seenCount, m5, h24, highPrice, lowPrice, currentPrice }));
        total++;
        seenPhases.add(ph);
        if (LEGACY.includes(ph as string)) legacySeen++;
        if (!ALLOWED.includes(ph)) { failed++; console.log(`  XX  B: phase în afara enum-ului: ${ph}`); }
      }
    }
  }
}
check(`B1. niciun DEAD/ZOMBIE/SECOND_WAVE pe ${total} combinații`, legacySeen === 0);
check("B2. toate fazele produse ∈ ALLOWED", [...seenPhases].every(p => ALLOWED.includes(p as Phase)));

// ── C. seenCount are prioritate peste price action (NEW înainte de orice) ──────
check("C1. seenCount<=2 domină chiar cu dump masiv",
  detectPhase(inp({ seenCount: 1, highPrice: 100, currentPrice: 10, lowPrice: 10 })) === "NEW");

console.log(`\n[phaseDetector.test] ${passed} passed, ${failed} failed (grid: ${total} combos)`);
if (failed > 0) process.exit(1);
