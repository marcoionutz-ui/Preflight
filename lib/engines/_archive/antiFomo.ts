/**
 * Anti-FOMO Engine
 *
 * Deterministic rules that block entries when the setup is chasing.
 * No AI — pure price/volume logic.
 *
 * Philosophy: the hardest thing to code is NOT buying when everyone
 * is screaming. These rules enforce discipline automatically.
 */

import type { Pair } from "@/types";
import type { OHLCVCandle } from "@/types";

export interface FOMOCheck {
  blocked: boolean;
  reason: string | null;    // primary block reason
  warnings: string[];       // soft cautions (don't block, but note)
  cooldownUntil?: number;   // epoch ms
}

/**
 * Main check — call before showing Trade Gate OPEN
 */
export function checkAntiFOMO(
  pair: Pair,
  ohlcv: OHLCVCandle[],
  recentLosses = 0         // consecutive losses from memory
): FOMOCheck {
  const warnings: string[] = [];

  const pct5m  = Number(pair.priceChange?.m5  ?? 0);
  const pct1h  = Number(pair.priceChange?.h1  ?? 0);
  const pct24  = Number(pair.priceChange?.h24 ?? 0);
  const liq    = Number(pair.liquidity?.usd   ?? 0);
  const vol5m  = Number(pair.volume?.m5       ?? 0);
  const vol1h  = Number(pair.volume?.h1       ?? 0);

  // ── HARD BLOCKS ────────────────────────────────────────────────────────────

  // 1. Vertical 5m candle — price spiked too fast
  if (pct5m > 30) {
    return { blocked: true, reason: `+${pct5m.toFixed(0)}% in 5m — vertical candle, wait for pullback`, warnings };
  }

  // 2. Already blown off — 1h pump + still going
  if (pct1h > 100 && pct5m > 10) {
    return { blocked: true, reason: `+${pct1h.toFixed(0)}% in 1h and still rising — likely blow-off top`, warnings };
  }

  // 3. 24h pump extreme — very late entry
  if (pct24 > 600) {
    return { blocked: true, reason: `+${pct24.toFixed(0)}% in 24h — extremely late entry risk`, warnings };
  }

  // 4. Volume manipulation: huge vol spike on thin liquidity
  if (liq > 0 && liq < 30_000 && vol5m > liq * 0.5 && pct5m > 10) {
    return { blocked: true, reason: "Volume spike on thin liquidity — possible manipulation", warnings };
  }

  // 5. OHLCV: 3 consecutive large green candles without pullback
  if (ohlcv.length >= 3) {
    const last3 = ohlcv.slice(-3);
    const allGreen = last3.every(c => c.close > c.open);
    const allLarge = last3.every(c => (c.close - c.open) / c.open > 0.04); // each >4%
    if (allGreen && allLarge) {
      return { blocked: true, reason: "3 consecutive large green candles — wait for pullback", warnings };
    }
  }

  // 6. After consecutive losses — enforce cooldown thinking
  if (recentLosses >= 3) {
    return { blocked: true, reason: `${recentLosses} consecutive losses — cooldown enforced`, warnings };
  }

  // ── SOFT WARNINGS ──────────────────────────────────────────────────────────

  if (pct5m > 15)  warnings.push(`+${pct5m.toFixed(0)}% in 5m — momentum high, consider smaller size`);
  if (pct1h > 50)  warnings.push(`+${pct1h.toFixed(0)}% in 1h — partially late`);
  if (pct24 > 300) warnings.push(`+${pct24.toFixed(0)}% in 24h — late entry risk`);

  if (ohlcv.length >= 3) {
    const last3 = ohlcv.slice(-3);
    const allGreen = last3.every(c => c.close > c.open);
    if (allGreen) warnings.push("3 consecutive green candles — watch for reversal");
  }

  const avgVol5m = vol1h / 12;
  if (avgVol5m > 0 && vol5m > avgVol5m * 4) {
    warnings.push(`Volume ×${(vol5m / avgVol5m).toFixed(0)} vs avg — could be coordinated`);
  }

  if (recentLosses >= 2) warnings.push(`${recentLosses} recent losses — trade smaller`);

  return { blocked: false, reason: null, warnings };
}

/**
 * Count consecutive losses in recent memory entries
 * Used to trigger loss cooldown
 */
export function countRecentLosses(
  entries: Array<{ outcomes: { h1?: { pct: number } } }>
): number {
  let count = 0;
  for (const e of entries) {
    const pct = e.outcomes.h1?.pct;
    if (pct === undefined) break;
    if (pct < -10) count++;
    else break;
  }
  return count;
}
