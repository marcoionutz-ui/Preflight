/**
 * Exit Intelligence Engine
 *
 * Computes TP/SL targets for each trade and monitors them.
 * Called on every price update.
 *
 * Philosophy: most bots fail on exits, not entries.
 * A partial exit at TP1 + trailing stop = survival.
 */

import type { PaperTrade } from "@/types";

export interface ExitTargets {
  sl:   number;   // stop loss price
  tp1:  number;   // take profit 1 (partial exit 25%)
  tp2:  number;   // take profit 2 (partial exit 25%)
  tp3:  number;   // take profit 3 (let remaining run)
  trailingStopPct: number; // trailing stop % once TP1 hit
}

export type ExitStatus =
  | "active"
  | "sl_hit"
  | "tp1_hit"   // 25% sold
  | "tp2_hit"   // 50% sold
  | "tp3_hit"   // 75% sold
  | "manual";

export interface ExitSignal {
  action: "hold" | "sell_partial" | "sell_all" | "move_stop";
  reason: string;
  sellPct: number;      // 0-100% of remaining position
  newStop?: number;
  urgency: "low" | "medium" | "high";
}

/**
 * Compute TP/SL targets based on entry price and edge score
 * Higher edge score = wider targets (more conviction)
 */
export function computeTargets(entryPrice: number, edgeScore: number): ExitTargets {
  // Scale targets with edge score
  const slPct    = edgeScore >= 75 ? 0.22 : edgeScore >= 55 ? 0.18 : 0.15;
  const tp1Pct   = edgeScore >= 75 ? 0.35 : edgeScore >= 55 ? 0.28 : 0.22;
  const tp2Pct   = edgeScore >= 75 ? 0.90 : edgeScore >= 55 ? 0.70 : 0.50;
  const tp3Pct   = edgeScore >= 75 ? 2.00 : edgeScore >= 55 ? 1.50 : 1.00;
  const trailPct = edgeScore >= 75 ? 0.15 : 0.20;

  return {
    sl:              entryPrice * (1 - slPct),
    tp1:             entryPrice * (1 + tp1Pct),
    tp2:             entryPrice * (1 + tp2Pct),
    tp3:             entryPrice * (1 + tp3Pct),
    trailingStopPct: trailPct,
  };
}

/**
 * Check current price against targets and return exit signal
 */
export function checkExit(
  trade: PaperTrade,
  currentPrice: number,
  targets: ExitTargets
): ExitSignal | null {
  const pct = (currentPrice - trade.entryPrice) / trade.entryPrice;

  // Stop loss hit
  if (currentPrice <= targets.sl) {
    return {
      action:   "sell_all",
      reason:   `SL hit at ${(-(1 - currentPrice/trade.entryPrice)*100).toFixed(1)}%`,
      sellPct:  100,
      urgency:  "high",
    };
  }

  // TP3 hit — sell remaining
  if (currentPrice >= targets.tp3) {
    return {
      action:  "sell_all",
      reason:  `TP3 hit +${(pct*100).toFixed(0)}% — full exit`,
      sellPct: 100,
      urgency: "medium",
    };
  }

  // TP2 hit — sell another 25%
  if (currentPrice >= targets.tp2) {
    return {
      action:    "sell_partial",
      reason:    `TP2 hit +${(pct*100).toFixed(0)}% — sell 25%, trail remaining`,
      sellPct:   25,
      newStop:   trade.entryPrice * 1.05, // lock in 5% profit minimum
      urgency:   "low",
    };
  }

  // TP1 hit — sell 25%, move stop to breakeven
  if (currentPrice >= targets.tp1) {
    return {
      action:    "sell_partial",
      reason:    `TP1 hit +${(pct*100).toFixed(0)}% — sell 25%, move stop to BE`,
      sellPct:   25,
      newStop:   trade.entryPrice * 1.01, // breakeven + 1%
      urgency:   "low",
    };
  }

  // Volume dying + significant pullback from high — early exit signal
  // (simplified: if -15% from entry and never hit TP1)
  if (pct < -0.12) {
    return {
      action:  "sell_all",
      reason:  `-${(Math.abs(pct)*100).toFixed(0)}% — approaching SL, consider exit`,
      sellPct: 100,
      urgency: "medium",
    };
  }

  return null; // hold
}

/**
 * Format exit signal for display
 */
export function fmtExitSignal(signal: ExitSignal): { text: string; color: string } {
  const colors = { low: "#ffb347", medium: "#ff8c00", high: "#ff3b3b" };
  return {
    text:  `${signal.action.toUpperCase().replace("_", " ")} — ${signal.reason}`,
    color: colors[signal.urgency],
  };
}
