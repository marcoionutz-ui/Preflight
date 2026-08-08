// Shared phase detection — folosit de worker și app

// Phase moved to @preflight/schema — it's written to Redis (pair_states,
// worker_snapshot) and read by MCP, so it's part of the wire contract, not
// just an internal detail. Re-exported here so existing
// `from "./phaseDetector"` imports keep working (same pattern as
// MomentumVerdict in risk/momentum.ts).
import type { Phase } from "@preflight/schema";
export type { Phase };

export interface PhaseInput {
  seenCount:         number;
  m5:                number;
  h24:               number;
  highPrice:         number;
  lowPrice:          number;
  currentPrice:      number;
}

export function detectPhase(input: PhaseInput): Phase {
  const { seenCount, m5, h24,
          highPrice, lowPrice, currentPrice } = input;

  if (seenCount <= 2) return "NEW";

  if (m5 > 15 || h24 > 150)                                          return "PUMPING";

  // Dumping: scăzut față de high
  if (highPrice > 0 && currentPrice < highPrice * 0.70) {
    const bounce = lowPrice > 0 ? (currentPrice - lowPrice) / lowPrice * 100 : 0;
    if (bounce >= 12) return "RECOVERING";
    return "DUMPING";
  }

  // Recovering fără să fi dumpuit major
  if (lowPrice > 0 && currentPrice > lowPrice * 1.12) {
    return "RECOVERING";
  }

  return "TRENDING";
}

export function phaseColor(phase: Phase): string {
  const colors: Record<Phase, string> = {
    NEW:         "#888888",
    TRENDING:    "#4fc3f7",
    PUMPING:     "#ffb347",
    DUMPING:     "#ff6b6b",
    RECOVERING:  "#39ff14",
  };
  return colors[phase];
}
