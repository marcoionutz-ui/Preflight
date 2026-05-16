/**
 * Live Trading Configuration
 *
 * Three modes: paper | semi | live
 *
 * paper: no real execution, paper trades only
 * semi:  shows quotes + simulation, user manually confirms each trade
 * live:  auto-executes when all gates pass (FUTURE — not yet active)
 *
 * Change mode ONLY after:
 * ✅ 100+ paper trades analyzed
 * ✅ Winning edge confirmed in memory stats
 * ✅ Burner wallet funded with small amount
 * ✅ All 10 live checklist items passed
 */

export type TradingMode = "paper" | "semi" | "live";

export interface LiveConfig {
  mode:              TradingMode;
  maxTradeEth:       number;   // max ETH per single trade
  maxDailyLossEth:   number;   // daily stop-loss in ETH
  maxOpenPositions:  number;   // max concurrent positions
  minEdgeScore:      number;   // minimum total edge score
  minSafetyScore:    number;   // minimum safety component
  minLiquidityUsd:   number;   // minimum pool liquidity
  requireGoPlus:     boolean;  // block if GoPlus has no data
  requireSimulation: boolean;  // block if sell simulation fails
  maxSlippageBps:    number;   // hard cap on slippage (bps)
  stopLossPct:       number;   // default SL % (e.g. 22)
  takeProfit1Pct:    number;   // TP1 % (e.g. 35)
  takeProfit2Pct:    number;   // TP2 %
  solanaEnabled:     boolean;  // Solana execution (decimals issue pending)
}

export const LIVE_CONFIG: LiveConfig = {
  mode:              "paper",   // ← CHANGE ONLY WHEN READY
  maxTradeEth:       0.003,
  maxDailyLossEth:   0.015,
  maxOpenPositions:  2,
  minEdgeScore:      75,        // paper: 55 | semi: 65 | live: 75
  minSafetyScore:    18,        // out of 30
  minLiquidityUsd:   25_000,
  requireGoPlus:     true,
  requireSimulation: true,
  maxSlippageBps:    300,       // 3% hard max
  stopLossPct:       22,
  takeProfit1Pct:    35,
  takeProfit2Pct:    90,
  solanaEnabled:     false,     // pending decimals fix
};

export const MODE_LABELS: Record<TradingMode, { label: string; color: string }> = {
  paper: { label: "PAPER",     color: "#39ff14" },
  semi:  { label: "SEMI-LIVE", color: "#ffb347" },
  live:  { label: "LIVE",      color: "#ff3b3b" },
};


