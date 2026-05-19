// Shared phase detection — folosit de worker și app

export type Phase =
  | "NEW"
  | "TRENDING"
  | "PUMPING"
  | "DUMPING"
  | "RECOVERING"
  | "ZOMBIE"
  | "DEAD";

export interface PhaseInput {
  seenCount:         number;
  consecutiveLosses: number;
  m5:                number;
  h24:               number;
  highPrice:         number;
  lowPrice:          number;
  currentPrice:      number;
  totalEntries:      number;
  wins24h:           number;
  losses24h:         number;
}

export function detectPhase(input: PhaseInput): Phase {
  const { seenCount, consecutiveLosses, m5, h24,
          highPrice, lowPrice, currentPrice,
          totalEntries, wins24h, losses24h } = input;

  if (seenCount <= 2) return "NEW";

  // Zombie: văzut des, are entries, zero outcomes
  if (seenCount > 8 && totalEntries > 0 && wins24h === 0 && losses24h === 0) {
    const range = highPrice > 0 ? (highPrice - lowPrice) / highPrice * 100 : 0;
    if (range < 15) return "ZOMBIE";
  }

  if (consecutiveLosses >= 4)                                   return "DEAD";
  if (m5 > 15 || h24 > 150)                                     return "PUMPING";
  if (highPrice > 0 && currentPrice < highPrice * 0.70)         return "DUMPING";
  if (lowPrice  > 0 && currentPrice > lowPrice  * 1.12)         return "RECOVERING";

  return "TRENDING";
}

export function phaseColor(phase: Phase): string {
  const colors: Record<Phase, string> = {
    NEW:        "#888888",
    TRENDING:   "#4fc3f7",
    PUMPING:    "#ffb347",
    DUMPING:    "#ff6b6b",
    RECOVERING: "#39ff14",
    ZOMBIE:     "#9c27b0",
    DEAD:       "#444444",
  };
  return colors[phase];
}