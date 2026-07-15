/**
 * pipeline/marketContext.ts
 * Calculează market regime din pair states și scrie supreme:market_regime.
 */

import WebSocket from "ws";
import type { Redis } from "ioredis";
import { CHAINS } from "../config/chains";
import { wsClients, recentDrops, pipelineEvents, hotCandidates, armedEntries } from "../state/stores";
import type { PairStateSnapshot } from "../state/pairStates";
import { REDIS_KEYS, type MarketRegime } from "@preflight/schema";

export interface MarketContext {
  regime:           MarketRegime;
  buyingPctAll:     number;
  sellingPctAll:    number;
  noWsPct:          number;
  flowCoveragePct:  number;
  total:            number;
  withFlowCount:    number;
}

export function deriveMarketContext(states: Record<string, PairStateSnapshot>): MarketContext {
  const total         = Object.keys(states).length;
  const stateVals     = Object.values(states) as any[];
  const withFlow      = stateVals.filter(s => s.flow?.hasData);
  const buying        = withFlow.filter(s => s.flow?.pressure === "BUYING").length;
  const selling       = withFlow.filter(s => s.flow?.pressure === "SELLING").length;
  const buyingPctAll  = total ? Math.round(buying / total * 100) : 0;
  const sellingPctAll = total ? Math.round(selling / total * 100) : 0;
  const noWsPct       = total ? Math.round((total - withFlow.length) / total * 100) : 100;
  const flowCoveragePct = total ? Math.round(withFlow.length / total * 100) : 0;
  const regime: MarketRegime =
    buyingPctAll > 30    ? "RISK_ON"  :
    sellingPctAll > 20   ? "RISK_OFF" :
    flowCoveragePct < 20 ? "DEAD"     :
    "MIXED";

  return { regime, buyingPctAll, sellingPctAll, noWsPct, flowCoveragePct, total, withFlowCount: withFlow.length };
}

export async function writeMarketRegime(r: Redis, ctx: MarketContext): Promise<void> {
  await r.set(REDIS_KEYS.marketRegime, JSON.stringify({
    regime:            ctx.regime,
    buyingPctAll:      ctx.buyingPctAll,
    sellingPctAll:     ctx.sellingPctAll,
    noWsPct:           ctx.noWsPct,
    flowCoveragePct:   ctx.flowCoveragePct,
    hotCount:          hotCandidates.size,
    armedCount:        armedEntries.size,
    wsConnectedChains: CHAINS.filter(c => {
      const ws = wsClients.get(c.id);
      return ws?.readyState === WebSocket.OPEN;
    }).map(c => c.id),
    scanOnlyChains: CHAINS.filter(c => {
      const ws = wsClients.get(c.id);
      return !ws || ws.readyState !== WebSocket.OPEN;
    }).map(c => c.id),
    trackedPairs:    ctx.total,
    pairsWithWsFlow: ctx.withFlowCount,
    calculatedAt:    Date.now(),
  }), "EX", 120);
}

export async function writeDropsAndEvents(r: Redis): Promise<void> {
  const now = Date.now();
  await r.set(REDIS_KEYS.pipelineEvents, JSON.stringify(
    pipelineEvents.filter(e => now - e.ts < 10 * 60_000),
  ), "EX", 600);
}
