/**
 * Market Regime Detector
 * Determină starea pieței și ajustează comportamentul agentului
 */

import type { FearGreedEntry, CoinPrices, Pair } from "@/types";

export type RegimeType =
  | "MEME_FRENZY"    // F&G > 75, BTC up, totul pompează
  | "RISK_ON"        // F&G 55-75, BTC pozitiv, piață bună
  | "NEUTRAL"        // F&G 40-55, BTC flat
  | "CHOP"           // F&G 40-55 dar calitate slabă pe trending
  | "CAUTION"        // F&G 25-45, BTC -3% to -8%
  | "DANGER";        // F&G < 25 sau BTC < -8%

export interface MarketRegime {
  regime: RegimeType;
  label: string;
  color: string;
  emoji: string;
  // Ajustări față de LIVE_CONFIG default
  minEdgeScoreAdj: number;   // +/- față de 75 default
  fomoMultiplier: number;    // 1.0 = normal, 0.8 = mai relaxat, 1.3 = mai strict
  autoPaperEnabled: boolean;
  reasoning: string[];
}

export function detectMarketRegime(
  fg: FearGreedEntry[],
  coins: CoinPrices,
  trending: Pair[]
): MarketRegime {
  const fgVal   = Number(fg?.[0]?.value ?? 50);
  const btcPct  = coins?.bitcoin?.usd_24h_change ?? 0;
  const ethPct  = coins?.ethereum?.usd_24h_change ?? 0;

  // Calitate trending — % din top 20 cu pct24h pozitiv
  const top20 = trending.slice(0, 20);
  const positiveCount = top20.filter(p => Number(p.priceChange?.h24 ?? 0) > 0).length;
  const trendingQuality = top20.length > 0 ? positiveCount / top20.length : 0.5;

  // High liq count — câte au lichiditate > 50k
  const highLiqCount = top20.filter(p => Number(p.liquidity?.usd ?? 0) > 50_000).length;

  const reasoning: string[] = [];

  // ── DANGER ────────────────────────────────────────────────────────────────
  if (fgVal < 25 || btcPct < -8) {
    if (fgVal < 25) reasoning.push(`Fear & Greed ${fgVal} — extreme fear`);
    if (btcPct < -8) reasoning.push(`BTC ${btcPct.toFixed(1)}% — major dump`);
    return {
      regime: "DANGER",
      label: "DANGER ZONE",
      color: "#ff0000",
      emoji: "🚨",
      minEdgeScoreAdj: +10,
      fomoMultiplier: 1.5,
      autoPaperEnabled: false,
      reasoning,
    };
  }

  // ── CAUTION ───────────────────────────────────────────────────────────────
  if (fgVal < 40 || btcPct < -3) {
    if (fgVal < 40) reasoning.push(`Fear & Greed ${fgVal} — fear`);
    if (btcPct < -3) reasoning.push(`BTC ${btcPct.toFixed(1)}% — negative`);
    return {
      regime: "CAUTION",
      label: "CAUTION",
      color: "#ff3b3b",
      emoji: "⚠️",
      minEdgeScoreAdj: +5,
      fomoMultiplier: 1.3,
      autoPaperEnabled: true,
      reasoning,
    };
  }

  // ── MEME FRENZY ───────────────────────────────────────────────────────────
  if (fgVal > 75 && btcPct > 2 && trendingQuality > 0.7) {
    reasoning.push(`Fear & Greed ${fgVal} — extreme greed`);
    reasoning.push(`BTC +${btcPct.toFixed(1)}%, ${Math.round(trendingQuality * 100)}% trending positive`);
    return {
      regime: "MEME_FRENZY",
      label: "MEME FRENZY",
      color: "#ff00ff",
      emoji: "🚀",
      minEdgeScoreAdj: -5,
      fomoMultiplier: 0.8,
      autoPaperEnabled: true,
      reasoning,
    };
  }

  // ── RISK ON ───────────────────────────────────────────────────────────────
  if (fgVal > 55 && btcPct > 0 && trendingQuality > 0.5) {
    reasoning.push(`Fear & Greed ${fgVal} — greed`);
    reasoning.push(`BTC +${btcPct.toFixed(1)}%, market healthy`);
    if (highLiqCount >= 10) reasoning.push(`${highLiqCount}/20 trending tokens high liquidity`);
    return {
      regime: "RISK_ON",
      label: "RISK ON",
      color: "#39ff14",
      emoji: "📈",
      minEdgeScoreAdj: 0,
      fomoMultiplier: 1.0,
      autoPaperEnabled: true,
      reasoning,
    };
  }

  // ── CHOP ─────────────────────────────────────────────────────────────────
  if (trendingQuality < 0.4 || highLiqCount < 5) {
    reasoning.push(`Only ${Math.round(trendingQuality * 100)}% trending positive — low quality`);
    if (highLiqCount < 5) reasoning.push(`Only ${highLiqCount}/20 tokens have decent liquidity`);
    return {
      regime: "CHOP",
      label: "CHOP / LOW QUALITY",
      color: "#ffb347",
      emoji: "〰️",
      minEdgeScoreAdj: +5,
      fomoMultiplier: 1.2,
      autoPaperEnabled: true,
      reasoning,
    };
  }

  // ── NEUTRAL ───────────────────────────────────────────────────────────────
  reasoning.push(`Fear & Greed ${fgVal} — neutral`);
  reasoning.push(`BTC ${btcPct >= 0 ? "+" : ""}${btcPct.toFixed(1)}%`);
  return {
    regime: "NEUTRAL",
    label: "NEUTRAL",
    color: "#888888",
    emoji: "➖",
    minEdgeScoreAdj: 0,
    fomoMultiplier: 1.0,
    autoPaperEnabled: true,
    reasoning,
  };
}