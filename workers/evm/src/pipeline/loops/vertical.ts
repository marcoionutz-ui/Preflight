/**
 * pipeline/loops/vertical.ts
 * Monitorizează candidații VERTICAL — confirmă sau evictează în 3 minute.
 */

import { activeWatch, watchedPoolCache, memory } from "../../state/stores";
import { dropWatchCandidate, promoteHotCandidate } from "../transitions";
import { getWsFlow } from "../../risk/flow";
import { getLiquidityContext } from "../../risk/liquidity";
import { updateMemory } from "../../state/memory";
import { fetchPoolByAddress } from "../../sources/gecko";
import { CHAINS } from "../../config/chains";
import { requestImmediateScopedSubscribe } from "../../ws/subscriptions";

let processing = false;

export async function verticalCandidatesLoop(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    const now = Date.now();

    for (const [pairAddr, info] of activeWatch.entries()) {
      if (info.kind !== "VERTICAL" && info.kind !== "CONFIRMED_MOMENTUM") continue;

      const ageMs = now - info.addedAt;
      if (ageMs < 15_000) continue;

      if (ageMs > 3 * 60_000) {
        console.log(`[VERTICAL EXPIRE] ${memory.get(pairAddr)?.symbol ?? pairAddr} — no confirmation in 3m`);
        dropWatchCandidate(pairAddr, "no confirmation in 3m");
        continue;
      }

      const mem  = memory.get(pairAddr);
      const flow = getWsFlow(pairAddr);
      if (!mem) continue;

      if (flow.hasData && flow.pressure === "SELLING") {
        console.log(`[VERTICAL DROP] ${mem.symbol} — flow turned SELLING`);
        dropWatchCandidate(pairAddr, "flow turned SELLING");
        continue;
      }

      if (!flow.hasData && ageMs > 90_000) {
        console.log(`[VERTICAL DROP] ${mem.symbol} — no WS flow after ${Math.round(ageMs / 1000)}s`);
        dropWatchCandidate(pairAddr, `no WS flow after ${Math.round(ageMs / 1000)}s`);
        continue;
      }

      if (!flow.hasData) continue;

      const chainCfg  = CHAINS.find(c => c.id === info.chain);
      const freshPool = chainCfg ? await fetchPoolByAddress(chainCfg, pairAddr) : null;
      if (!freshPool) continue;

      watchedPoolCache.set(info.chain, pairAddr, freshPool);
      updateMemory(freshPool, freshPool.priceUsd);

      const currentPrice = freshPool.priceUsd;
      const blockPrice   = info.entryPrice ?? currentPrice;

      if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(blockPrice) || blockPrice <= 0) {
        console.log(`[VERTICAL DROP] ${mem.symbol} — invalid price current:${currentPrice} block:${blockPrice}`);
        dropWatchCandidate(pairAddr, "invalid price");
        continue;
      }

      const currentVsBlock = currentPrice / blockPrice;

      if (currentVsBlock > 1.40) {
        console.log(`[VERTICAL LATE] ${mem.symbol} — +${((currentVsBlock - 1) * 100).toFixed(0)}% from block, too late`);
        dropWatchCandidate(pairAddr, `too late +${((currentVsBlock - 1) * 100).toFixed(0)}% from block`);
        continue;
      }

      if (currentVsBlock < 0.75) {
        console.log(`[VERTICAL DUMP] ${mem.symbol} — -${((1 - currentVsBlock) * 100).toFixed(0)}% from block, evict`);
        dropWatchCandidate(pairAddr, `dumped -${((1 - currentVsBlock) * 100).toFixed(0)}% from block`);
        continue;
      }

      const buyVolF  = (flow as any).buyVol5m  ?? 0;
      const netVolF  = (flow as any).netVol5m  ?? 0;
      const sellVolF = (flow as any).sellVol5m ?? 0;
      const flowPressure = (flow as any).pressure1m ?? flow.pressure;
      const buyVolV  = (flow as any).buyVol1m  ?? buyVolF;
      const netVolV  = (flow as any).netVol1m  ?? netVolF;
      const sellVolV = (flow as any).sellVol1m ?? sellVolF;

      const liqF = getLiquidityContext(pairAddr);
      const minVerticalBuys   = liqF.reserveUsd < 30_000 ? 1 : 2;
      const minVerticalBuyVol = liqF.reserveUsd < 30_000 ? 0.03 : 0.05;
      const minVerticalNetVol = liqF.reserveUsd < 30_000 ? 0.02 : 0.03;

      const flowConfirmed =
        flowPressure === "BUYING" &&
        buyVolV  >= minVerticalBuyVol &&
        netVolV  >= minVerticalNetVol &&
        flow.buys5m >= minVerticalBuys &&
        sellVolV / Math.max(buyVolV, 0.001) < 0.65;

      console.log(
        `[VERTICAL CHECK] ${mem.symbol} age:${Math.round(ageMs / 1000)}s`
        + ` pressure1m:${flowPressure} buys:${flow.buys5m}`
        + ` buyVol1m:${buyVolV.toFixed(3)} netVol1m:${netVolV.toFixed(3)}`
        + ` reserve:$${Math.round(liqF.reserveUsd / 1000)}K`
        + ` priceVsBlock:+${((currentVsBlock - 1) * 100).toFixed(1)}%`,
      );

      if (!flowConfirmed) {
        console.log(
          `[VERTICAL REJECT] ${mem.symbol}`
          + ` flow:${flow.pressure} buys:${flow.buys5m}`
          + ` buyVol:${buyVolF.toFixed(3)} netVol:${netVolF.toFixed(3)}`
          + ` priceVsBlock:+${((currentVsBlock - 1) * 100).toFixed(1)}%`,
        );
        continue;
      }

      console.log(
        `[VERTICAL CONFIRMED] ${mem.symbol} (${info.chain})`
        + ` age:${Math.round(ageMs / 1000)}s`
        + ` priceVsBlock:+${((currentVsBlock - 1) * 100).toFixed(1)}%`
        + ` buyVol:${buyVolF.toFixed(3)} netVol:${netVolF.toFixed(3)} buys:${flow.buys5m}`,
      );

      promoteHotCandidate(pairAddr, info.chain, "VERTICAL");
      activeWatch.delete(pairAddr);

      const chainCfgV = CHAINS.find(c => c.id === info.chain);
      if (chainCfgV) requestImmediateScopedSubscribe(chainCfgV);
    }
  } finally {
    processing = false;
  }
}
