// Second Wave Detection — re-entry după pullback real

import type { PairMemoryEntry } from "./pairMemory";
import type { FlowSignal }      from "./flowTypes";

export interface SecondWaveSignal {
  isSecondWave:        boolean;
  score:               number; // 0-100
  confidence:          "LOW" | "MEDIUM" | "HIGH";
  reasons:             string[];
  drawdownFromHighPct: number;
  bounceFromLowPct:    number;
}

export function detectSecondWave(
  mem:  PairMemoryEntry,
  flow: FlowSignal,
  m5 = 0,
  h1 = 0,
): SecondWaveSignal {
  const reasons: string[] = [];
  let score = 0;

  const { highPrice, lowPrice, currentPrice, priceAtFirstSeen } = mem;

  if (!highPrice || !lowPrice || !currentPrice) {
    return { isSecondWave: false, score: 0, confidence: "LOW",
      reasons: ["no price history"], drawdownFromHighPct: 0, bounceFromLowPct: 0 };
  }

  const drawdownFromHighPct = (highPrice - currentPrice) / highPrice * 100;
  const bounceFromLowPct    = lowPrice > 0 ? (currentPrice - lowPrice) / lowPrice * 100 : 0;

  // 1. A trebuit să pompeze față de prima apariție
  if (priceAtFirstSeen > 0 && highPrice > priceAtFirstSeen * 1.4) {
    score += 15;
    reasons.push(`pumped ${((highPrice / priceAtFirstSeen - 1) * 100).toFixed(0)}% from first seen`);
  }

  // 2. Dump semnificativ de la high (20-75%) — nu mort, nu minor
  if (drawdownFromHighPct >= 20 && drawdownFromHighPct <= 75) {
    score += 20;
    reasons.push(`dumped ${drawdownFromHighPct.toFixed(0)}% from high`);
  } else {
    return { isSecondWave: false, score, confidence: "LOW",
      reasons: [...reasons, drawdownFromHighPct < 20 ? "pullback too small" : "dumped too hard"],
      drawdownFromHighPct, bounceFromLowPct };
  }

  // 3. Bounce real de la low (>8%)
  if (bounceFromLowPct >= 8) {
    score += 20;
    reasons.push(`bounced ${bounceFromLowPct.toFixed(0)}% from low`);
  } else {
    return { isSecondWave: false, score, confidence: "LOW",
      reasons: [...reasons, "bounce too small"], drawdownFromHighPct, bounceFromLowPct };
  }

  // 4. Flow — buyers revin
  if (flow.hasData) {
    if (flow.pressure === "BUYING")  { score += 20; reasons.push(`buy pressure (${flow.buys5m}b vs ${flow.sells5m}s)`); }
    if (flow.pressure === "SELLING") { score -= 20; reasons.push("sell pressure — not ready"); }
    if (flow.pressure === "NEUTRAL") { score +=  5; }
  }
  
  // 5. Momentum 5m fresh
  if (m5 > 2 && m5 < 15) { score += 8; reasons.push(`+${m5.toFixed(1)}% 5m momentum`); }
  if (h1 > 5 && h1 < 35)  { score += 5; reasons.push(`+${h1.toFixed(1)}% 1h momentum`); }

  score = Math.max(0, Math.min(100, score));

  return {
    isSecondWave: score >= 50,
    score,
    confidence: score >= 70 ? "HIGH" : score >= 50 ? "MEDIUM" : "LOW",
    reasons,
    drawdownFromHighPct,
    bounceFromLowPct,
  };
}