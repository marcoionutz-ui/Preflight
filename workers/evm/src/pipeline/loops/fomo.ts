/**
 * pipeline/loops/fomo.ts
 * Monitorizează candidații FOMO — verifică continuation după block.
 */

import { activeWatch, watchedPoolCache, memory } from "../../state/stores";
import { dropWatchCandidate, promoteHotCandidate } from "../transitions";
import { getWsFlow } from "../../risk/flow";
import { updateMemory } from "../../state/memory";
import { fetchPoolByAddress } from "../../sources/gecko";
import { CHAINS } from "../../config/chains";
import {
  FOMO_RECHECK_MIN_AGE_MS, FOMO_RECHECK_MAX_AGE_MS, FOMO_NO_WS_DROP_MS,
} from "../../config/constants";
import { requestImmediateScopedSubscribe } from "../../ws/subscriptions";

export async function fomoCandidatesLoop(): Promise<void> {
  const now = Date.now();

  for (const [pairAddr, info] of activeWatch.entries()) {
    if (info.kind !== "FOMO") continue;

    const ageMs = now - info.addedAt;
    if (ageMs < FOMO_RECHECK_MIN_AGE_MS) continue;

    if (ageMs > FOMO_RECHECK_MAX_AGE_MS) {
      console.log(`[FOMO EXPIRE] ${memory.get(pairAddr)?.symbol ?? pairAddr} — no continuation after ${Math.round(ageMs / 60_000)}m`);
      dropWatchCandidate(pairAddr, `no continuation after ${Math.round(ageMs / 60_000)}m`);
      continue;
    }

    const cachedPool = watchedPoolCache.get(info.chain, pairAddr);
    const mem        = memory.get(pairAddr);
    const flow       = getWsFlow(pairAddr);

    if (!cachedPool || !mem) continue;

    const chainCfg  = CHAINS.find(c => c.id === info.chain || c.gecko === info.chain);
    const freshPool = chainCfg ? await fetchPoolByAddress(chainCfg, pairAddr) : null;
    const pool      = freshPool ?? cachedPool;

    if (freshPool) {
      watchedPoolCache.set(info.chain, pairAddr, freshPool);
      updateMemory(freshPool, freshPool.priceUsd);
    }

    const currentPrice = pool.priceUsd;
    const blockPrice   = info.entryPrice ?? currentPrice;
    const buyVolF  = Number((flow as any).buyVol5m  ?? 0);
    const sellVolF = Number((flow as any).sellVol5m ?? 0);
    const netVolF  = Number((flow as any).netVol5m  ?? buyVolF - sellVolF);

    if (!flow.hasData && ageMs > FOMO_NO_WS_DROP_MS) {
      console.log(`[FOMO DROP] ${mem.symbol} — no WS confirmation after ${Math.round(ageMs / 60_000)}m`);
      dropWatchCandidate(pairAddr, `no WS confirmation after ${Math.round(ageMs / 60_000)}m`);
      continue;
    }

    if (
      flow.hasData &&
      flow.pressure === "SELLING" &&
      netVolF < -0.03 &&
      ageMs > FOMO_RECHECK_MIN_AGE_MS
    ) {
      console.log(
        `[FOMO DROP] ${mem.symbol} — selling confirmation`
        + ` netVol:${netVolF.toFixed(3)}`
        + ` sellRatio:${(sellVolF / Math.max(buyVolF, 0.001) * 100).toFixed(1)}%`,
      );
      dropWatchCandidate(pairAddr, `selling confirmation netVol:${netVolF.toFixed(3)}`);
      continue;
    }

    const survivedPump =
      Number.isFinite(currentPrice) &&
      Number.isFinite(blockPrice) &&
      currentPrice >= blockPrice * 0.82;

    const flowConfirmed =
      flow.hasData &&
      flow.pressure === "BUYING" &&
      survivedPump &&
      buyVolF >= 0.05 &&
      netVolF >= 0.03 &&
      flow.buys5m >= 2 &&
      sellVolF / Math.max(buyVolF, 0.001) < 0.55;

    if (!survivedPump) {
      const pricePct =
        Number.isFinite(currentPrice) && Number.isFinite(blockPrice) && blockPrice > 0
          ? (((currentPrice / blockPrice) - 1) * 100).toFixed(1) : "NaN";
      console.log(`[FOMO FAIL] ${mem.symbol} — dumped after block current:${currentPrice} block:${blockPrice} pricePct:${pricePct}%`);
      dropWatchCandidate(pairAddr, `dumped after block pricePct:${pricePct}%`);
      continue;
    }

    if (!flowConfirmed) {
      console.log(
        `[FOMO REJECT] ${mem.symbol}`
        + ` price:${currentPrice} block:${blockPrice}`
        + ` survived:${survivedPump ? 1 : 0}`
        + ` flow:${flow.hasData ? flow.pressure : "NO_WS"}`
        + ` buys:${flow.buys5m ?? 0}`
        + ` buyVol:${buyVolF.toFixed(3)}`
        + ` netVol:${netVolF.toFixed(3)}`
        + ` sellRatio:${(sellVolF / Math.max(buyVolF, 0.001) * 100).toFixed(1)}%`,
      );
      continue;
    }

    const priceMovePct =
      Number.isFinite(currentPrice) && Number.isFinite(blockPrice) && blockPrice > 0
        ? (((currentPrice / blockPrice) - 1) * 100).toFixed(1) : "NaN";
    console.log(
      `[FOMO CONTINUATION] ${mem.symbol}`
      + ` age:${Math.round(ageMs / 60_000)}m priceMove:${priceMovePct}%`
      + ` buys:${flow.buys5m ?? 0} buyVol:${buyVolF.toFixed(3)} netVol:${netVolF.toFixed(3)}`,
    );

    promoteHotCandidate(pairAddr, info.chain ?? "base", "FOMO");
    activeWatch.delete(pairAddr);

    const chainCfgF = CHAINS.find(c => c.id === info.chain || c.gecko === info.chain);
    if (chainCfgF) requestImmediateScopedSubscribe(chainCfgF);
  }
}
