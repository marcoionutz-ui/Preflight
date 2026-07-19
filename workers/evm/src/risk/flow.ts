/**
 * risk/flow.ts
 * Colectează swap events din WS și interpretează flow-ul (BUYING/SELLING/NEUTRAL).
 * ws/ colectează evenimente brute, risk/flow le interpretează.
 */

import { MIN_FLOW_ETH, MIN_TOTAL_FLOW_ETH, FLOW_IMBALANCE } from "../config/constants";
import { wsFlow, lpEvents } from "../state/stores";
import { NEUTRAL_FLOW, STABLE_LIQUIDITY, computeFlowFromTxns } from "../lib/engines/flowTypes";
import type { FlowSignal, LiquiditySignal } from "../lib/engines/flowTypes";
import type { SourcePool } from "../sources/normalize";

export function recordSwap(chain: string, pairAddress: string, isBuy: boolean, ethAmount: number, usdAmount?: number): void {
  const now    = Date.now();
  const events = (wsFlow.get(chain, pairAddress) ?? []).filter(e => now - e.ts < 5 * 60_000);
  events.push({ ts: now, isBuy, ethAmount, usdAmount });
  wsFlow.set(chain, pairAddress, events);
}

export function recordLp(chain: string, pairAddress: string, isAdd: boolean, ethAmount: number): void {
  const now    = Date.now();
  const events = (lpEvents.get(chain, pairAddress) ?? []).filter(e => now - e.ts < 5 * 60_000);
  events.push({ ts: now, isAdd, ethAmount });
  lpEvents.set(chain, pairAddress, events);
}

export function getWsFlow(chain: string | undefined, pairAddress: string): FlowSignal {
  // chain opțional (unii calleri au `mem.chain?`/`trade.chain?`): fără chain nu
  // putem forma cheia → NEUTRAL (fără date), nu fabricăm.
  if (!chain) return NEUTRAL_FLOW;
  const now    = Date.now();
  const events = (wsFlow.get(chain, pairAddress) ?? []).filter(e => now - e.ts < 5 * 60_000);

  if (!events.length) {
    wsFlow.delete(chain, pairAddress);
    return NEUTRAL_FLOW;
  }
  wsFlow.set(chain, pairAddress, events);

  const e1m = events.filter(e => now - e.ts < 60_000);
  const m5  = events.filter(e => e.ethAmount >= MIN_FLOW_ETH);
  const m1  = e1m.filter(e => e.ethAmount >= MIN_FLOW_ETH);

  const buyVol5m    = m5.filter(e =>  e.isBuy).reduce((s, e) => s + e.ethAmount, 0);
  const sellVol5m   = m5.filter(e => !e.isBuy).reduce((s, e) => s + e.ethAmount, 0);
  const buyCount5m  = m5.filter(e =>  e.isBuy).length;
  const sellCount5m = m5.filter(e => !e.isBuy).length;
  const buyCount1m  = m1.filter(e =>  e.isBuy).length;
  const sellCount1m = m1.filter(e => !e.isBuy).length;
  const buyVol1m    = m1.filter(e =>  e.isBuy).reduce((s, e) => s + e.ethAmount, 0);
  const sellVol1m   = m1.filter(e => !e.isBuy).reduce((s, e) => s + e.ethAmount, 0);

  const totalVol  = buyVol5m + sellVol5m;
  const netVol    = buyVol5m - sellVol5m;
  const imbalance = totalVol > 0 ? netVol / totalVol : 0;
  const buyVol5mUsd  = Math.round(m5.filter(e =>  e.isBuy).reduce((s, e) => s + (e.usdAmount ?? 0), 0));
  const sellVol5mUsd = Math.round(m5.filter(e => !e.isBuy).reduce((s, e) => s + (e.usdAmount ?? 0), 0));
  const netVol5mUsd  = buyVol5mUsd - sellVol5mUsd;
  const hasUsdData = m5.some(e => typeof e.usdAmount === "number" && e.usdAmount > 0);

  const pressure: "BUYING" | "SELLING" | "NEUTRAL" =
    totalVol < MIN_TOTAL_FLOW_ETH ? "NEUTRAL" :
    imbalance >  FLOW_IMBALANCE   ? "BUYING"  :
    imbalance < -FLOW_IMBALANCE   ? "SELLING" : "NEUTRAL";

  const netVol1m   = buyVol1m - sellVol1m;
  const totalVol1m = buyVol1m + sellVol1m;
  const pressure1m: "BUYING" | "SELLING" | "NEUTRAL" =
    totalVol1m < MIN_TOTAL_FLOW_ETH ? "NEUTRAL" :
    (buyVol1m - sellVol1m) / totalVol1m >  FLOW_IMBALANCE ? "BUYING"  :
    (buyVol1m - sellVol1m) / totalVol1m < -FLOW_IMBALANCE ? "SELLING" : "NEUTRAL";

  return {
    hasData:    true,
    pressure,
    pressure1m,
    buys1m:     buyCount1m,
    sells1m:    sellCount1m,
    buys5m:     buyCount5m,
    sells5m:    sellCount5m,
    buyVol5m:   Math.round(buyVol5m  * 1000) / 1000,
    sellVol5m:  Math.round(sellVol5m * 1000) / 1000,
    netVol5m:   Math.round(netVol    * 1000) / 1000,
    buyVol1m:   Math.round(buyVol1m  * 1000) / 1000,
    sellVol1m:  Math.round(sellVol1m * 1000) / 1000,
    netVol1m:   Math.round(netVol1m  * 1000) / 1000,
    ...(hasUsdData ? {
      buyVol5mUsd,
      sellVol5mUsd,
      netVol5mUsd,
    } : {}),
  };
}

export function getLpSignal(chain: string | undefined, pairAddress: string): LiquiditySignal {
  if (!chain) return STABLE_LIQUIDITY;
  const events = lpEvents.get(chain, pairAddress) ?? [];
  if (!events.length) return STABLE_LIQUIDITY;

  const now = Date.now();
  const e5m = events.filter(e => now - e.ts < 5 * 60_000);
  if (!e5m.length) {
    lpEvents.delete(chain, pairAddress);
    return STABLE_LIQUIDITY;
  }

  const added   = e5m.filter(e =>  e.isAdd).reduce((s, e) => s + e.ethAmount, 0);
  const removed = e5m.filter(e => !e.isAdd).reduce((s, e) => s + e.ethAmount, 0);
  const net     = added - removed;
  const status  = net > 0.01 ? "ADDED" : net < -0.01 ? "REMOVED" : "STABLE";

  return { lpAdded5m: added, lpRemoved5m: removed, lpNet5m: net, status, hasData: true };
}

export function getFlow(pool: SourcePool): FlowSignal {
  const ws = getWsFlow(pool.chain, pool.pairAddress);
  if (ws.hasData) return ws;

  const buys5m  = pool.transactions.buys5m;
  const sells5m = pool.transactions.sells5m;
  if (buys5m + sells5m === 0) return NEUTRAL_FLOW;
  return computeFlowFromTxns(buys5m, sells5m);
}
