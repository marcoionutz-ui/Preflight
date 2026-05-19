/**
 * Edge Score Engine
 *
 * Combines all available signals into a single 0-100 score
 * with deterministic rules for trade entry.
 *
 * Philosophy: AI can recommend. Edge Score can veto.
 * Execution only runs if canEnterTrade === true.
 */

import type { PairMemoryEntry } from "./pairMemory";
import type { FlowSignal }      from "./flowTypes";

import type { Pair, RedFlag } from "@/types";
import type { GoPlusResult } from "@/lib/apis/goplus";
import { ageHours } from "@/lib/utils";

export interface EdgeScore {
  // Component scores (total = sum)
  safety:    number;   // 0-30  (GoPlus data — real on-chain)
  liquidity: number;   // 0-20  (liq size + quality)
  momentum:  number;   // 0-20  (price + volume acceleration)
  flow:      number;   // 0-20  (buy/sell pressure)
  timing:    number;   // 0-10  (entry quality — age, price structure)
  total:     number;   // 0-100

  // Trade gate — deterministic, not AI
  canEnterTrade: boolean;
  blockers:  string[];  // hard stops (MUST fix to trade)
  warnings:  string[];  // soft issues (trade with caution)

  // Key metrics for display
  buyTax:       number;
  sellTax:      number;
  holderCount:  number;
  isHoneypot:   boolean;
  isOpenSource: boolean;
  isMintable:   boolean;

  dataSource: "goplus+market" | "market-only";
}

export function computeEdgeScore(
  pair: Pair,
  flags: RedFlag[],
  goPlus?: GoPlusResult | null
  pairMem?: PairMemoryEntry | null,  // ← NOU
  flowSig?: FlowSignal | null,       // ← NOU
): EdgeScore {
  const liq     = Number(pair.liquidity?.usd   ?? 0);
  const vol24   = Number(pair.volume?.h24      ?? 0);
  const vol1h   = Number(pair.volume?.h1       ?? 0);
  const vol5m   = Number(pair.volume?.m5       ?? 0);
  const pct24   = Number(pair.priceChange?.h24 ?? 0);
  const pct1h   = Number(pair.priceChange?.h1  ?? 0);
  const pct5m   = Number(pair.priceChange?.m5  ?? 0);
  const buys1h  = Number(pair.txns?.h1?.buys   ?? 0);
  const sells1h = Number(pair.txns?.h1?.sells  ?? 0);
  const buys5m  = Number(pair.txns?.m5?.buys   ?? 0);
  const sells5m = Number(pair.txns?.m5?.sells  ?? 0);
  const t1h     = buys1h + sells1h || 1;
  const t5m     = buys5m + sells5m || 1;
  const ah      = ageHours(pair.pairCreatedAt);
  const highFlags = flags.filter(f => f.sev === "high").length;

  const blockers: string[] = [];
  const warnings: string[] = [];

  // ── SAFETY SCORE (0-30) ──────────────────────────────────────────────────
  let safety = 0;

  if (goPlus?.dataAvailable) {
    // Hard blockers from GoPlus
    if (goPlus.isHoneypot) {
      blockers.push("HONEYPOT — cannot sell");
      safety = 0;
    } else if (goPlus.cannotSell) {
      blockers.push("SELL BLOCKED — contract prevents selling");
      safety = 0;
    } else {
      // Tax scoring
      const taxPenalty =
        (goPlus.sellTax > 0.25 ? -15 : goPlus.sellTax > 0.15 ? -10 : goPlus.sellTax > 0.05 ? -4 : 0) +
        (goPlus.buyTax  > 0.15 ? -5  : goPlus.buyTax  > 0.08 ? -2  : 0);

      // Owner risk
      const ownerPenalty =
        (goPlus.hiddenOwner           ? -8 : 0) +
        (goPlus.canTakeBackOwnership  ? -5 : 0) +
        (goPlus.ownerChangeBalance    ? -4 : 0) +
        (goPlus.ownerPercent > 0.1    ? -3 : goPlus.ownerPercent > 0.05 ? -1 : 0);

      // Contract risk
      const contractPenalty =
        (goPlus.selfDestruct          ? -5 : 0) +
        (goPlus.isMintable            ? -3 : 0) +
        (goPlus.isAirdropScam         ? -8 : 0);

      // Bonuses
      const bonus =
        (goPlus.isOpenSource          ? 5  : 0) +
        (goPlus.isTrustList           ? 5  : 0) +
        (goPlus.holderCount > 1000    ? 3  : goPlus.holderCount > 200 ? 1 : 0);

      safety = Math.max(0, Math.min(30, 18 + taxPenalty + ownerPenalty + contractPenalty + bonus));

      // Warnings
      if (goPlus.sellTax > 0.05)          warnings.push(`Sell tax ${(goPlus.sellTax * 100).toFixed(0)}%`);
      if (goPlus.hiddenOwner)             warnings.push("Hidden owner");
      if (goPlus.isMintable)              warnings.push("Mintable supply");
      if (goPlus.selfDestruct)            blockers.push("Self-destruct function in contract");
      if (goPlus.sellTax > 0.25)         blockers.push(`Sell tax ${(goPlus.sellTax * 100).toFixed(0)}% — too high`);
      if (goPlus.holderCount < 50)       warnings.push(`Only ${goPlus.holderCount} holders`);
    }
  } else {
    // No GoPlus data — conservative estimate from red flags
    safety = Math.max(0, 15 - highFlags * 4);
    warnings.push("Security data unavailable — trading with unknown risk");
  }

  // ── LIQUIDITY SCORE (0-20) ───────────────────────────────────────────────
  let liquidity =
    liq >= 500_000 ? 20 :
    liq >= 100_000 ? 17 :
    liq >= 50_000  ? 14 :
    liq >= 20_000  ? 10 :
    liq >= 10_000  ? 6  :
    liq >= 5_000   ? 2  : 0;

  // Penalize wash volume
  const volLiqRatio = liq > 0 ? vol24 / liq : 999;
  if (volLiqRatio > 30)  { liquidity = Math.max(0, liquidity - 8); warnings.push("Vol/Liq ratio suspicious"); }
  if (volLiqRatio > 15)  { liquidity = Math.max(0, liquidity - 4); }

  if (liq < 5_000) blockers.push("Liquidity <$5K — too thin to trade safely");

  // ── MOMENTUM SCORE (0-20) ────────────────────────────────────────────────
  // Price acceleration: gaining momentum but not already blown off
  let momentum = 10; // baseline

  if (pct5m > 20 && pct1h > 40)    momentum += 6;  // strong sustained move
  else if (pct5m > 5 && pct1h > 10) momentum += 3; // building
  else if (pct5m < -10)             momentum -= 5;  // losing steam

  // Volume acceleration: 5m vs 1h avg
  const avg5m = vol1h / 12;
  const volAcc = avg5m > 0 ? vol5m / avg5m : 1;
  if (volAcc > 3)     momentum += 4;
  else if (volAcc > 2) momentum += 2;
  else if (volAcc < 0.3) momentum -= 3;

  // Anti-chasing: penalize if already pumped hard
  if (pct24 > 500)    { momentum -= 8; warnings.push("Already +500% 24h — late entry risk"); }
  if (pct24 > 200)    momentum -= 4;
  if (pct1h > 100)    { momentum -= 5; warnings.push("+100% in 1h — possible blow-off top"); }

  momentum = Math.max(0, Math.min(20, momentum));

  // ── FLOW SCORE (0-20) ────────────────────────────────────────────────────
  const buyR1h = buys1h / t1h;
  const buyR5m = t5m > 3 ? buys5m / t5m : buyR1h;
  const blended = buyR5m * 0.65 + buyR1h * 0.35;

  let flow = Math.round(blended * 20);

  // Penalize if heavy selling
  if (buyR1h < 0.3)  { flow = Math.max(0, flow - 5); warnings.push("Heavy selling pressure 1h"); }
  if (buyR5m < 0.25) { flow = Math.max(0, flow - 5); warnings.push("Active dumping 5m"); }

  if (t1h < 5) flow = Math.min(flow, 10); // too few txns to trust signal
  flow = Math.max(0, Math.min(20, flow));
  
  // Flow din WebSocket (worker) sau absent (app fără WS)
  if (flowSig?.hasData) {
    if (flowSig.pressure === "BUYING")  flow = Math.min(20, flow + 4);
    if (flowSig.pressure === "SELLING") flow = Math.max(0,  flow - 8);
  }

  // ── TIMING SCORE (0-10) ──────────────────────────────────────────────────
  let timing =
    ah < 0.25  ? 1 :  // <15min: too new
    ah < 1     ? 4 :  // 15min-1h: early but risky
    ah < 6     ? 7 :  // 1h-6h: sweet spot
    ah < 24    ? 8 :  // 6h-24h: established
    ah < 168   ? 9 :  // 1-7 days: proven
                 10;  // >7 days: well established

  // Penalize if we're entering after a huge candle (chasing)
  if (pct5m > 30)  timing = Math.max(0, timing - 4);
  if (pct5m > 15)  timing = Math.max(0, timing - 2);

  if (ah < 0.25) warnings.push("Pair < 15min old");
  timing = Math.max(0, Math.min(10, timing));
  
  // ── PAIR MEMORY BONUS/PENALIZARE ────────────────────────────────────────
  let memBonus = 0;
  if (pairMem) {
    if (pairMem.phase === "RECOVERING")                              memBonus += 5;
    if (pairMem.wins24h >= 2)                                        memBonus += 5;
    if (pairMem.losses24h > pairMem.wins24h && pairMem.losses24h > 2) memBonus -= 10;
    if (pairMem.consecutiveLosses >= 3)                              memBonus -= 15;
    if (pairMem.seenCount > 15 && pairMem.wins24h === 0)            memBonus -= 10;
  }
  timing = Math.max(0, Math.min(10, timing + Math.max(-5, Math.min(5, memBonus / 2))));

  // ── RED FLAG OVERRIDES ───────────────────────────────────────────────────
  if (highFlags >= 3) blockers.push(`${highFlags} HIGH severity flags`);
  else if (highFlags >= 2) warnings.push(`${highFlags} HIGH severity flags`);

  // ── TOTAL ────────────────────────────────────────────────────────────────
  const total = Math.min(100, safety + liquidity + momentum + flow + timing);

  // ── TRADE GATE ───────────────────────────────────────────────────────────
  const canEnterTrade =
    blockers.length === 0 &&
    total >= 55 &&
    safety >= 12 &&
    liquidity >= 6;

  return {
    safety, liquidity, momentum, flow, timing, total,
    canEnterTrade, blockers, warnings,
    buyTax:       goPlus?.buyTax      ?? 0,
    sellTax:      goPlus?.sellTax     ?? 0,
    holderCount:  goPlus?.holderCount ?? 0,
    isHoneypot:   goPlus?.isHoneypot  ?? false,
    isOpenSource: goPlus?.isOpenSource ?? false,
    isMintable:   goPlus?.isMintable  ?? false,
    dataSource: goPlus?.dataAvailable ? "goplus+market" : "market-only",
  };
}
