/**
 * risk/gates.ts
 * getEntryGate — decide dacă o pereche poate intra în pipeline.
 */

import type { PairMemoryEntry } from "../lib/engines/pairMemory";
import type { FlowSignal, LiquiditySignal } from "../lib/engines/flowTypes";
import { checkEntryGate } from "../lib/engines/pairMemory";
import { detectSecondWave } from "../lib/engines/secondWave";
import { getLiquidityContext } from "./liquidity";
import { computeEvidenceScore } from "./scoring";
import { v3PoolMap, hotCandidates } from "../state/stores";
import { tokenPoolKey } from "../infra/poolTracker";
import { tokenPools } from "../infra/poolTracker";
import { COOLDOWN_MS, SECOND_WAVE_COOLDOWN_MS } from "../config/constants";
import type { EntrySource } from "../state/stores";

export function getEntryGate(
  mem:         PairMemoryEntry,
  flow:        FlowSignal,
  lp:          LiquiditySignal,
  score:       number,
  entrySource: EntrySource = "SCAN",
) {
  const liq = getLiquidityContext(mem.pairAddress);
  if (liq.status === "MISSING") {
    return { allowed: false, reason: "missing liquidity context — skip" };
  }

  const isV4 = mem.pairAddress.length === 66;
  const isV3 = !isV4 && v3PoolMap.has(mem.pairAddress);
  const sw   = detectSecondWave(mem, flow);

  if ((isV3 || isV4) && liq.status !== "CONFIRMED") {
    return { allowed: false, reason: `V3/V4 liq not confirmed (${liq.status}, $${Math.round(liq.reserveUsd / 1000)}K)` };
  }

  if (lp.hasData && lp.status === "REMOVED") {
    return { allowed: false, reason: `LP removed (${lp.lpRemoved5m.toFixed(3)} ETH in 5m)` };
  }

  const buyVol = (flow as any).buyVol5m ?? 0;
  const netVol = (flow as any).netVol5m ?? 0;
  if (flow.pressure === "BUYING" && buyVol < 0.05) {
    return { allowed: false, reason: `buy volume too low (${buyVol.toFixed(3)} ETH)` };
  }

  const minNetVol =
    entrySource === "FOMO" || entrySource === "VERTICAL" ? 0.03 :
    entrySource === "LATE" ? 0.10 :
    0.05;
  if ((isV3 || isV4) && flow.pressure === "BUYING" && netVol < minNetVol) {
    return { allowed: false, reason: `V3/V4 net buy volume too low (${netVol.toFixed(3)} ETH, min ${minNetVol})` };
  }

  const minBuyCount = entrySource === "VERTICAL" ? 2 : 3;
  if (flow.pressure === "BUYING" && flow.buys5m < minBuyCount) {
    return { allowed: false, reason: `single buyer pattern (${flow.buys5m} buys/5m, need ${minBuyCount})` };
  }

  const sellVol   = (flow as any).sellVol5m ?? 0;
  const sellRatio = buyVol > 0 ? sellVol / buyVol : 0;
  const isLargeConfirmedPool = liq.status === "CONFIRMED" && liq.reserveUsd >= 100_000;
  const bypassOneSided =
    entrySource === "FOMO" ||
    entrySource === "VERTICAL" ||
    entrySource === "LATE";

  if (
    bypassOneSided &&
    !isLargeConfirmedPool &&
    flow.pressure === "BUYING" &&
    (sellVol < 0.01 || sellRatio < 0.03)
  ) {
    console.log(`[${entrySource} BYPASS] one-sided spike allowed — sellRatio ${(sellRatio * 100).toFixed(1)}%`);
  }

  const isLiquidPool = liq.reserveUsd >= 200_000;
  if (
    isLiquidPool &&
    flow.pressure === "BUYING" &&
    sellRatio > 0.50 &&
    entrySource !== "FOMO" &&
    entrySource !== "VERTICAL" &&
    entrySource !== "LATE"
  ) {
    return { allowed: false, reason: `high sell ratio in liquid pool (${(sellRatio * 100).toFixed(1)}% — likely distribution)` };
  }

  if (mem.phase === "RECOVERING" && !(sw.isSecondWave && sw.confidence !== "LOW")) {
    return { allowed: false, reason: `RECOVERING phase blocked (historically negative, not confirmed 2W)` };
  }

  const recentBadExit = mem.lastExitTime && Date.now() - mem.lastExitTime < 6 * 60 * 60_000;
  if (entrySource !== "FOMO" && mem.badExits24h >= 2 && mem.wins24h === 0 && mem.losses24h === 0 && recentBadExit) {
    return { allowed: false, reason: `bad exits only (${mem.badExits24h} bad, 0 wins/losses)` };
  }

  if ((isV3 || isV4) && mem.phase === "RECOVERING" && flow.buys5m < 5) {
    return { allowed: false, reason: `RECOVERING needs stronger participation (${flow.buys5m}/5 buys)` };
  }

  const chainPrefix = mem.chain ?? "";
  const poolCount   = tokenPools.get(tokenPoolKey(chainPrefix, mem.tokenAddress))?.size ?? 1;
  if (poolCount >= 5) {
    return { allowed: false, reason: `too many pools for token (${poolCount}) — clone/fragmentation risk` };
  }

  if (
    entrySource === "SCAN" &&
    mem.seenCount > 40 &&
    mem.totalEntries === 0
  ) {
    return { allowed: false, reason: `SCAN stale with no history (seen ${mem.seenCount}x, never entered)` };
  }

  if (
    (entrySource === "SCAN" || entrySource === "WS") &&
    mem.seenCount > 20 &&
    mem.wins24h === 0 &&
    mem.losses24h === 0 &&
    mem.badExits24h >= 2
  ) {
    return { allowed: false, reason: `stale loser — seen ${mem.seenCount}x, ${mem.badExits24h} bad exits, zero wins` };
  }

  const evidence = computeEvidenceScore(mem, flow, lp);

  if (hotCandidates.has(mem.pairAddress.toLowerCase())) {
    const requiredHotEvidence =
      entrySource === "VERTICAL" ? 4 :
      entrySource === "FOMO" || entrySource === "LATE" ? 5 :
      entrySource === "WS" ? 6 :
      7;
    if (mem.seenCount < 2) {
      return { allowed: false, reason: `HOT but too new (seen ${mem.seenCount}x, need 2)` };
    }
    if (evidence < requiredHotEvidence) {
      return { allowed: false, reason: `HOT but evidence too low (${evidence}/${requiredHotEvidence})` };
    }
    if (flow.pressure !== "BUYING") {
      return { allowed: false, reason: `HOT but flow not BUYING` };
    }
    return checkEntryGate(
      mem, flow, 2, SECOND_WAVE_COOLDOWN_MS,
      { allowPumping: entrySource === "VERTICAL" || entrySource === "LATE" || entrySource === "FOMO" },
    );
  }

  if (sw.isSecondWave && sw.confidence !== "LOW") {
    if (mem.seenCount < 3)  return { allowed: false, reason: `2W but too new (seen ${mem.seenCount}x, need 3)` };
    if (evidence < 9)       return { allowed: false, reason: `2W but evidence too low (${evidence}/9)` };
    return checkEntryGate(mem, flow, 3, SECOND_WAVE_COOLDOWN_MS);
  }

  const requiredEvidence = 6;
  if (mem.seenCount < 3)           return { allowed: false, reason: `too new (seen ${mem.seenCount}x, need 3)` };
  if (evidence < requiredEvidence) return { allowed: false, reason: `evidence too low (${evidence}/${requiredEvidence})` };

  if (isV4 && score < 90)      return { allowed: false, reason: `V4 score too low (${score}/90)` };
  if (isV4 && flow.buys5m < 5) return { allowed: false, reason: `V4 flow weak (${flow.buys5m} buys/5m)` };

  return checkEntryGate(mem, flow, 3, COOLDOWN_MS);
}