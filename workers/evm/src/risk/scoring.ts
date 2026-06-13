/**
 * risk/scoring.ts
 * quickEdgeScore și computeEvidenceScore.
 * Input: SourcePool + PairMemoryEntry + FlowSignal + LiquiditySignal
 */

import type { PairMemoryEntry } from "../lib/engines/pairMemory";
import type { FlowSignal, LiquiditySignal } from "../lib/engines/flowTypes";
import type { SourcePool } from "../sources/normalize";
import { getLiquidityContext } from "./liquidity";
import { detectSecondWave } from "../lib/engines/secondWave";

export function quickEdgeScore(
  pool: SourcePool,
  mem:  PairMemoryEntry,
  flow: FlowSignal,
  lp:   LiquiditySignal,
): number {
  let score = 50;

  const reserveUsd = pool.reserveUsd;
  const vol24h     = pool.volumeUsd24h;
  const h24        = pool.priceChange.h24;
  const m5         = pool.priceChange.m5;
  const h1         = pool.priceChange.h1;

  // Liquidity
  if      (reserveUsd > 100_000) score += 15;
  else if (reserveUsd >  50_000) score += 10;
  else if (reserveUsd >  25_000) score +=  5;
  else                           score -= 15;

  // Volume
  if      (vol24h > 500_000) score += 10;
  else if (vol24h > 100_000) score +=  5;
  else if (vol24h <  20_000) score -= 10;

  // h24 sweet spot
  if      (h24 > 10 && h24 < 80)   score += 15;
  else if (h24 >= 80 && h24 < 150) score +=  5;
  else if (h24 >= 150)             score -= 15;
  else if (h24 < 0)                score -= 10;

  // 5m momentum
  if      (m5 > 3 && m5 < 15) score += 10;
  else if (m5 >= 15)           score -= 10;
  else if (m5 < -5)            score -=  5;

  // 1h confirmare
  if      (h1 > 5 && h1 < 30) score += 10;
  else if (h1 >= 30)           score -=  5;
  else if (h1 < -10)           score -= 10;

  // Flow WS
  if (flow.hasData) {
    if (flow.pressure === "BUYING")  score += 15;
    if (flow.pressure === "SELLING") score -= 20;
  }

  // LP event
  if (lp.hasData) {
    if (lp.status === "ADDED")   score += 12;
    if (lp.status === "REMOVED") score -= 25;
  }

  // Liquidity context
  const liq = getLiquidityContext(mem.pairAddress);
  if      (liq.status === "CONFIRMED") score += 5;
  else if (liq.status === "WEAK")      score -= 10;
  else if (liq.status === "MISSING")   score -= 30;

  // Phase memory
  if (mem.phase === "SECOND_WAVE") score += 20;
  if (mem.phase === "RECOVERING")  score -= 30;
  if (mem.seenCount > 100) score -= 15;
  
  // Second wave bonus
  const sw = detectSecondWave(mem, flow, m5, h1);
  if (sw.isSecondWave) {
    score += Math.round(sw.score * 0.15);
  }

  return Math.max(0, Math.min(100, score));
}

export function computeEvidenceScore(
  mem:  PairMemoryEntry,
  flow: FlowSignal,
  lp:   LiquiditySignal,
): number {
  let score = 0;

  if (mem.seenCount >= 5)      score += 3;
  else if (mem.seenCount >= 3) score += 2;
  else if (mem.seenCount >= 2) score += 1;

  if (flow.hasData) {
    if (flow.pressure === "BUYING")  score += 3;
    if (flow.pressure === "NEUTRAL") score += 1;
    if (flow.pressure === "SELLING") score -= 3;
    if (flow.buys5m >= 8)  score += 1;
    if (flow.sells5m > flow.buys5m) score -= 1;
  }

  if (lp.hasData) {
    if (lp.status === "ADDED")   score += 2;
    if (lp.status === "STABLE")  score += 1;
    if (lp.status === "REMOVED") score -= 5;
  }

  if (mem.phase === "SECOND_WAVE") score += 2;
  if (mem.phase === "RECOVERING" && mem.seenCount <= 25) score += 1;
  if (mem.phase === "RECOVERING" && mem.seenCount > 50)  score -= 1;
  if (mem.phase === "PUMPING")     score -= 1;
  if (mem.phase === "DEAD")        score -= 5;
  if (mem.phase === "ZOMBIE")      score -= 3;

  return score;
}
