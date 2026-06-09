import type { Pair, SmartScore } from "@/types";
import { ageHours } from "@/lib/utils";

export function computeSmartScore(pair: Pair): SmartScore {
  const liq = pair.liquidity?.usd ?? 0;
  const vol24 = pair.volume?.h24 ?? 0;
  const buys1h = pair.txns?.h1?.buys ?? 0;
  const sells1h = pair.txns?.h1?.sells ?? 0;
  const buys5m = pair.txns?.m5?.buys ?? 0;
  const sells5m = pair.txns?.m5?.sells ?? 0;
  const t1h = buys1h + sells1h || 1;
  const t5m = buys5m + sells5m;
  const ah = ageHours(pair.pairCreatedAt);
  const pct24 = pair.priceChange?.h24 ?? 0;
  const pct1h = pair.priceChange?.h1 ?? 0;

  const empty: SmartScore = { total: 0, liqScore: 0, momentumScore: 0, safetyScore: 0, buyPressure: 0, buyRatio1h: 0, hardReject: null };

  // Hard rejects — score 0 immediately
  if (liq < 3_000)
    return { ...empty, hardReject: "CRITICAL: Liquidity <$3K" };
  if (pct1h < -50)
    return { ...empty, hardReject: "CRITICAL: -50% in 1h" };

  // ── Liquidity score (0-25) ──────────────────────────────────────────────────
  const liqScore =
    liq >= 1_000_000 ? 25 :
    liq >= 250_000   ? 22 :
    liq >= 100_000   ? 18 :
    liq >= 50_000    ? 14 :
    liq >= 10_000    ? 8  : 3;

  // ── Momentum score (0-25): blended buy ratio ────────────────────────────────
  const buyR1h = buys1h / t1h;
  const buyR5m = t5m >= 3 ? buys5m / t5m : buyR1h;
  const blended = buyR5m * 0.6 + buyR1h * 0.4;
  const momentumScore = Math.round(blended * 25);

  // ── Safety score (0-25): age + vol/liq sanity ───────────────────────────────
  const agePoints =
    ah < 0.25  ? 0  :
    ah < 1     ? 4  :
    ah < 6     ? 9  :
    ah < 24    ? 14 :
    ah < 168   ? 20 : 25;

  const volLiqRatio = liq > 0 ? vol24 / liq : 999;
  const volPenalty = volLiqRatio > 30 ? -10 : volLiqRatio > 15 ? -5 : 0;
  const safetyScore = Math.max(0, agePoints + volPenalty);

  // ── Buy pressure (0-25): recency-weighted + late entry penalty ───────────────
  let buyPressure = Math.round(buyR5m * 25);
  if (pct24 > 400) buyPressure = Math.max(0, buyPressure - 10);
  else if (pct24 > 200) buyPressure = Math.max(0, buyPressure - 5);

  const total = Math.min(100, liqScore + momentumScore + safetyScore + buyPressure);

  return {
    total,
    liqScore,
    momentumScore,
    safetyScore,
    buyPressure,
    buyRatio1h: Math.round(buyR1h * 100),
    hardReject: null,
  };
}
