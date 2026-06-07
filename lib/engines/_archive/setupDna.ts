/**
 * Setup DNA — găsește setup-uri similare în memory și returnează statistici
 * "42 similar setups | 1h median: +8.4% | Best exit: 30-60m"
 */

import { getAllMemory } from "@/lib/engines/patternMemory";
import type { RedFlag } from "@/types";
import type { EdgeScore } from "@/lib/engines/edgeScore";

export interface SetupDNA {
  similarCount: number;
  median1h:     number;
  median6h:     number;
  winRate1h:    number;   // % cu outcome1h > 0
  bestExitWindow: string;
  confidence:   "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Găsește setup-uri similare bazat pe:
 * - EdgeScore tier (high/med/low)
 * - Număr de high flags (0, 1-2, 3+)
 * - Chain (same chain bonus, dar nu exclude alte chain-uri)
 */
export function computeSetupDNA(
  edgeScore: EdgeScore,
  flags: RedFlag[],
  chain: string
): SetupDNA {
  const all = getAllMemory();
  if (all.length < 5) {
    return {
      similarCount: 0, median1h: 0, median6h: 0,
      winRate1h: 0, bestExitWindow: "—",
      confidence: "INSUFFICIENT",
    };
  }

  const currentTier = edgeScore.total >= 75 ? "high" : edgeScore.total >= 55 ? "med" : "low";
  const currentHighFlags = flags.filter(f => f.sev === "high").length;

  // Filtrare similare — tier + flags aproximativ
  const similar = all.filter(e => {
    const eTier = e.edgeScore >= 75 ? "high" : e.edgeScore >= 55 ? "med" : "low";
    const eFlags = e.highFlags ?? 0;
    const tierMatch  = eTier === currentTier;
    const flagsMatch = Math.abs(eFlags - currentHighFlags) <= 1;
    return tierMatch && flagsMatch;
  });

  if (similar.length < 3) {
    return {
      similarCount: similar.length, median1h: 0, median6h: 0,
      winRate1h: 0, bestExitWindow: "—",
      confidence: "INSUFFICIENT",
    };
  }

  const with1h  = similar.filter(e => e.outcomes.h1);
  const with6h  = similar.filter(e => e.outcomes.h6);

  const pcts1h = with1h.map(e => e.outcomes.h1!.pct);
  const pcts6h = with6h.map(e => e.outcomes.h6!.pct);

  const med1h = median(pcts1h);
  const med6h = median(pcts6h);
  const winRate1h = with1h.length > 0
    ? with1h.filter(e => (e.outcomes.h1?.pct ?? 0) > 0).length / with1h.length
    : 0;

  // Best exit window
  let bestExitWindow = "—";
  if (with1h.length >= 3 && with6h.length >= 3) {
    bestExitWindow = med1h > med6h ? "30–60m" : "1–6h";
  } else if (with1h.length >= 3) {
    bestExitWindow = med1h > 5 ? "30–60m" : "hold";
  }

  const confidence =
    similar.length >= 20 ? "HIGH" :
    similar.length >= 8  ? "MEDIUM" : "LOW";

  return {
    similarCount: similar.length,
    median1h: med1h,
    median6h: med6h,
    winRate1h,
    bestExitWindow,
    confidence,
  };
}