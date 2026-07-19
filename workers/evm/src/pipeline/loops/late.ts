/**
 * pipeline/loops/late.ts
 * Monitorizează candidații LATE — confirmă sau evictează în 8 minute.
 */

import { activeWatch, watchedPoolCache, memory } from "../../state/stores";
import { dropWatchCandidate, promoteHotCandidate } from "../transitions";
import { getWsFlow } from "../../risk/flow";
import { updateMemory } from "../../state/memory";
import { fetchPoolByAddress } from "../../sources/gecko";
import { CHAINS } from "../../config/chains";
import { requestImmediateScopedSubscribe } from "../../ws/subscriptions";

let processing = false;

export async function lateCandidatesLoop(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    const now = Date.now();

    for (const [{ chain, address: pairAddr }, info] of activeWatch.entries()) {
      if (info.kind !== "LATE") continue;

      const ageMs = now - info.addedAt;
      if (ageMs < 30_000) continue;

      if (ageMs > 8 * 60_000) {
        console.log(`[LATE EXPIRE] ${memory.get(pairAddr)?.symbol ?? pairAddr} — no confirmation in 8m`);
        dropWatchCandidate(pairAddr, chain, "no confirmation in 8m");
        continue;
      }

      const mem  = memory.get(pairAddr);
      const flow = getWsFlow(chain, pairAddr);
      if (!mem) continue;

      if (flow.hasData && flow.pressure === "SELLING") {
        console.log(`[LATE DROP] ${mem.symbol} — flow turned SELLING`);
        dropWatchCandidate(pairAddr, chain, "flow turned SELLING");
        continue;
      }

      if (!flow.hasData && ageMs > 4 * 60_000) {
        console.log(`[LATE DROP] ${mem.symbol} — no WS flow after ${Math.round(ageMs / 60_000)}m`);
        dropWatchCandidate(pairAddr, chain, `no WS flow after ${Math.round(ageMs / 60_000)}m`);
        continue;
      }

      if (!flow.hasData) continue;

      const chainCfg  = CHAINS.find(c => c.id === chain);
      const freshPool = chainCfg ? await fetchPoolByAddress(chainCfg, pairAddr) : null;
      if (!freshPool) continue;

      watchedPoolCache.set(chain, pairAddr, freshPool);
      updateMemory(freshPool, freshPool.priceUsd);

      const currentPrice = freshPool.priceUsd;
      const blockPrice   = info.entryPrice ?? currentPrice;

      if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(blockPrice) || blockPrice <= 0) {
        console.log(`[LATE DROP] ${mem.symbol} — invalid price`);
        dropWatchCandidate(pairAddr, chain, "invalid price");
        continue;
      }

      const currentVsBlock = currentPrice / blockPrice;

      if (currentVsBlock > 1.30) {
        console.log(`[LATE SKIP] ${mem.symbol} — +${((currentVsBlock - 1) * 100).toFixed(0)}% from block, too late`);
        dropWatchCandidate(pairAddr, chain, `too late +${((currentVsBlock - 1) * 100).toFixed(0)}% from block`);
        continue;
      }

      if (currentVsBlock < 0.85) {
        console.log(`[LATE DUMP] ${mem.symbol} — -${((1 - currentVsBlock) * 100).toFixed(0)}% from block, evict`);
        dropWatchCandidate(pairAddr, chain, `dumped -${((1 - currentVsBlock) * 100).toFixed(0)}% from block`);
        continue;
      }

      const buyVolF  = (flow as any).buyVol5m  ?? 0;
      const netVolF  = (flow as any).netVol5m  ?? 0;
      const sellVolF = (flow as any).sellVol5m ?? 0;
      const h24f     = freshPool.priceChange.h24;
      const m5f      = freshPool.priceChange.m5;
      const h1f      = freshPool.priceChange.h1;
      const reserveF = freshPool.reserveUsd;

      const flowConfirmed =
        flow.pressure === "BUYING" &&
        buyVolF  >= 0.15 &&
        netVolF  >= 0.10 &&
        flow.buys5m >= 4 &&
        sellVolF / Math.max(buyVolF, 0.001) < 0.60 &&
        h24f < 800 &&
        m5f > 3 && m5f < 30 &&
        h1f > 10 &&
        reserveF >= 50_000;

      if (!flowConfirmed) {
        console.log(
          `[LATE REJECT] ${mem.symbol}`
          + ` flow:${flow.pressure} buys:${flow.buys5m}`
          + ` buyVol:${buyVolF.toFixed(3)} netVol:${netVolF.toFixed(3)}`
          + ` m5:${m5f.toFixed(1)} h1:${h1f.toFixed(1)} h24:${h24f.toFixed(0)}`
          + ` reserve:$${Math.round(reserveF / 1000)}K`,
        );
        continue;
      }

      console.log(
        `[LATE CONFIRMED] ${mem.symbol} (${chain})`
        + ` age:${Math.round(ageMs / 1000)}s`
        + ` priceVsBlock:+${((currentVsBlock - 1) * 100).toFixed(1)}%`
        + ` buyVol:${buyVolF.toFixed(3)} netVol:${netVolF.toFixed(3)} buys:${flow.buys5m}`
        + ` h24:${h24f.toFixed(0)}% m5:${m5f.toFixed(1)}% h1:${h1f.toFixed(1)}%`,
      );

      promoteHotCandidate(pairAddr, chain, "LATE");
      activeWatch.delete(chain, pairAddr);

      const chainCfgL = CHAINS.find(c => c.id === chain);
      if (chainCfgL) requestImmediateScopedSubscribe(chainCfgL);
    }
  } finally {
    processing = false;
  }
}
