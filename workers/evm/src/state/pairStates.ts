/**
 * state/pairStates.ts
 * Builder pentru supreme:pair_states Redis snapshot.
 * Include chain, pairAddress, tokenAddress, priceChange — necesar pentru
 * market movers detection în MCP fără call-uri extra.
 */

import {
  memory, activeWatch, hotCandidates, armedEntries,
  v3PoolMap, wsFlow, poolLiquidity,
} from "./stores";
import { getWsFlow, getLpSignal } from "../risk/flow";
import { getLiquidityContext } from "../risk/liquidity";
import { tokenPools, tokenPoolKey } from "../infra/poolTracker";
import { getCachedRisksBulk } from "../risk/riskChecker";
import type { RiskResult } from "../risk/riskChecker";

// slim risk — fără raw GoPlus în pair_states snapshot
type RiskStateSnapshot = Omit<RiskResult, "raw">;

function slimRisk(risk: RiskResult | null | undefined): RiskStateSnapshot | null {
  if (!risk) return null;
  const safe = { ...risk } as RiskResult;
  delete safe.raw;
  return safe as RiskStateSnapshot;
}

export interface PairStateSnapshot {
  // Identity — necesar pentru market movers și drilldown fără call extra
  symbol:        string;
  chain:         string;
  pairAddress:   string;
  tokenAddress:  string;
  dexType:       string;

  // Price + momentum — necesar pentru observed movers în tp_situation_report
  currentPrice:  number;
  priceChange: {
    m5:  number;
    h1:  number;
    h24: number;
  };

  // Pipeline state
  phase:             string;
  pipelineState:     string;
  seenCount:         number;
  totalEntries:      number;

  // History
  wins24h:           number;
  losses24h:         number;
  badExits24h:       number;
  consecutiveLosses: number;
  lastEntryTime:     number;

  // Flow
  flow: {
    pressure:  string;
    buys5m:    number;
    sells5m:   number;
    hasData:   boolean;
    buyVol5m:  number;
    sellVol5m: number;
    netVol5m:  number;
  };

  // LP
  lp: {
    status:           string;
    lpNet5m:          number;
    hasData:          boolean;
    lpAdded5m:        number;
    lpRemoved5m:      number;
    removedPctOfPool: number | null;
  };

  // Liquidity
  reserveUsd:         number;
  reserveEth:         number;
  liqStatus:          string;
  poolCountSameToken: number;

  // Timing — necesar pentru agent reasoning (fix AVNT 8.5m → 0m confusion)
  firstSeenAt:        number | null;
  lastSeenAt:         number | null;
  pipelineEnteredAt:  number | null;
  currentStateAgeSec: number | null;
  priceVsFirstSeenPct: number | null;

  // Meta
  hourUtc:              number;
  updatedAt:            number;
  lastMomentumVerdict?: string | null;
  lastMomentumAt?:      number | null;
  attentionScore?:      number | null;
  monitoringTier?:      string | null;
  patternTags?:         string[] | null;
  risk?:                RiskStateSnapshot | null;
  
  // Discovery
  discovery: {
    primaryDiscoverySource: string | null;
    discoverySources:       string[];
    firstDiscoveredAt:      number | null;
    lastDiscoveryAt:        number | null;
  };
}

export async function buildPairStates(): Promise<Record<string, PairStateSnapshot>> {
  const states: Record<string, PairStateSnapshot> = {};
  const now = Date.now();

  // Bulk MGET — un singur Redis call pentru toate pairs
  const riskItems = [...memory.values()]
    .filter(mem => !!mem.tokenAddress)
    .map(mem => ({ tokenAddress: mem.tokenAddress!, chain: mem.chain ?? "base" }));
  const riskMap = await getCachedRisksBulk(riskItems);

  for (const [addr, mem] of memory.entries()) {
    const flow    = getWsFlow(addr);
    const lp      = getLpSignal(addr);
    const liq     = getLiquidityContext(addr);
    const poolEth = poolLiquidity.get(addr)?.reserveEth ?? 0;
    const removed = lp.lpRemoved5m ?? 0;

    // Pipeline state derivat din stores
    const pipelineState =
	  armedEntries.has(addr)   ? "ARMED"      :
	  hotCandidates.has(addr)  ? "HOT" :
	  activeWatch.has(addr)    ? "WATCHING"   :
	  "NONE";

    // priceChange vine din PairMemoryEntry — workerul îl updatează la fiecare scan
    const mc = (mem as any).priceChange ?? { m5: 0, h1: 0, h24: 0 };

    // Timing — pipelineEnteredAt = cel mai recent moment de intrare în pipeline
    const pipelineEnteredAt =
      armedEntries.get(addr)?.armedAt ??
      hotCandidates.get(addr)?.promotedAt ??
      activeWatch.get(addr)?.addedAt ??
      null;

    // priceVsFirstSeenPct — cât a mișcat față de prima apariție în worker
    const priceAtFirstSeen = (mem as any).priceAtFirstSeen ?? 0;
    const priceVsFirstSeenPct =
      priceAtFirstSeen > 0 && mem.currentPrice > 0
        ? Number(((mem.currentPrice - priceAtFirstSeen) / priceAtFirstSeen * 100).toFixed(2))
        : null;

    states[addr] = {
      symbol:       mem.symbol,
      chain:       mem.chain ?? "unknown",
      pairAddress:  addr,
      tokenAddress: mem.tokenAddress ?? "",
      dexType:      addr.length === 66 ? "V4" : v3PoolMap.has(addr) ? "V3" : "V2",
	  
	  discovery: {
        primaryDiscoverySource: mem.primaryDiscoverySource ?? null,
        discoverySources:       mem.discoverySources ?? [],
        firstDiscoveredAt:      mem.firstDiscoveredAt ?? mem.firstSeen ?? null,
        lastDiscoveryAt:        mem.lastDiscoveryAt ?? mem.lastSeen ?? null,
      },
	  
      currentPrice: mem.currentPrice,
      priceChange: {
        m5:  mc.m5  ?? 0,
        h1:  mc.h1  ?? 0,
        h24: mc.h24 ?? 0,
      },

      phase:         mem.phase,
      pipelineState,
      lastMomentumVerdict: (mem as any).lastMomentumVerdict ?? null,
      lastMomentumAt:      (mem as any).lastMomentumAt      ?? null,
      attentionScore:      (mem as any).attentionScore      ?? null,
      monitoringTier:      (mem as any).monitoringTier      ?? null,
      patternTags:         (mem as any).patternTags         ?? null,
      seenCount:     mem.seenCount,
      totalEntries:  mem.totalEntries,

      firstSeenAt:        mem.firstSeen  ?? null,
      lastSeenAt:         mem.lastSeen   ?? null,
      pipelineEnteredAt,
      currentStateAgeSec: pipelineEnteredAt ? Math.round((now - pipelineEnteredAt) / 1000) : null,
      priceVsFirstSeenPct,

      wins24h:           mem.wins24h,
      losses24h:         mem.losses24h,
      badExits24h:       mem.badExits24h,
      consecutiveLosses: mem.consecutiveLosses,
      lastEntryTime:     mem.lastEntryTime,

      flow: {
        pressure:  flow.pressure,
        buys5m:    flow.buys5m,
        sells5m:   flow.sells5m,
        hasData:   flow.hasData,
        buyVol5m:  (flow as any).buyVol5m  ?? 0,
        sellVol5m: (flow as any).sellVol5m ?? 0,
        netVol5m:  (flow as any).netVol5m  ?? 0,
      },

      lp: {
        status:           lp.status,
        lpNet5m:          lp.lpNet5m,
        hasData:          lp.hasData,
        lpAdded5m:        lp.lpAdded5m  ?? 0,
        lpRemoved5m:      lp.lpRemoved5m ?? 0,
        removedPctOfPool: poolEth > 0 && removed > 0
          ? Number((removed / poolEth * 100).toFixed(1))
          : null,
      },

      reserveUsd:  liq.reserveUsd,
      reserveEth:  liq.reserveEth,
      liqStatus:   liq.status,
      poolCountSameToken: (() => {
        const cp = mem.chain ?? "";
        return tokenPools.get(tokenPoolKey(cp, mem.tokenAddress))?.size ?? 1;
      })(),

      hourUtc:   new Date(now).getUTCHours(),
      updatedAt: now,
      risk: (() => {
        if (!mem.tokenAddress) return null;
        const key = `${(mem.chain ?? "base").toLowerCase()}:${mem.tokenAddress.toLowerCase()}`;
        return slimRisk(riskMap.get(key));
      })(),
    };
  }

  return states;
}

export function buildWatchSnapshot(): Record<string, object> {
  const watchObj: Record<string, object> = {};
  for (const [addr, info] of activeWatch.entries()) {
    const mem         = memory.get(addr);
    const watchEvents = wsFlow.get(addr) ?? [];
    const watchBuys   = watchEvents.filter(e => e.isBuy);
    const watchSells  = watchEvents.filter(e => !e.isBuy);
    watchObj[addr] = {
      chain: info.chain, addedAt: info.addedAt, ageMs: Date.now() - info.addedAt,
      kind: info.kind ?? "NORMAL", entryPrice: info.entryPrice ?? null, reason: info.reason ?? null,
      symbol: mem?.symbol ?? null, phase: mem?.phase ?? null,
      pairAddress: addr,
      priceVsEntryPct: (info.entryPrice && mem?.currentPrice)
        ? Number(((mem.currentPrice - info.entryPrice) / info.entryPrice * 100).toFixed(2)) : null,
      flowAgeMs:       watchEvents.length ? Date.now() - watchEvents[0].ts : null,
      largestBuyEth:   watchBuys.length ? Math.max(...watchBuys.map(e => e.ethAmount)) : 0,
      avgBuyEth:       watchBuys.length
        ? Number((watchBuys.reduce((s, e) => s + e.ethAmount, 0) / watchBuys.length).toFixed(4)) : 0,
      buySwapCount5m:  watchBuys.length,
      sellSwapCount5m: watchSells.length,
    };
  }
  return watchObj;
}

export function buildHotSnapshot(): Record<string, object> {
  const hotObj: Record<string, object> = {};
  for (const [addr, info] of hotCandidates.entries()) {
    const mem       = memory.get(addr);
    const flow      = getWsFlow(addr);
    const hotEvents = wsFlow.get(addr) ?? [];
    const hotBuys   = hotEvents.filter(e => e.isBuy);
    const hotSells  = hotEvents.filter(e => !e.isBuy);
    hotObj[addr] = {
      chain: info.chain, promotedAt: info.promotedAt, ageMs: Date.now() - info.promotedAt,
      source: info.source ?? null, symbol: mem?.symbol ?? null, phase: mem?.phase ?? null,
      pairAddress: addr,
      flow: {
        pressure: flow.pressure, buys5m: flow.buys5m, hasData: flow.hasData,
        buyVol5m: (flow as any).buyVol5m ?? 0, netVol5m: (flow as any).netVol5m ?? 0,
      },
      flowAgeMs:       hotEvents.length ? Date.now() - hotEvents[0].ts : null,
      largestBuyEth:   hotBuys.length ? Math.max(...hotBuys.map(e => e.ethAmount)) : 0,
      avgBuyEth:       hotBuys.length
        ? Number((hotBuys.reduce((s, e) => s + e.ethAmount, 0) / hotBuys.length).toFixed(4)) : 0,
      buySwapCount5m:  hotBuys.length,
      sellSwapCount5m: hotSells.length,
    };
  }
  return hotObj;
}

export function buildArmedSnapshot(): Record<string, object> {
  const armedObj: Record<string, object> = {};
  for (const [addr, info] of armedEntries.entries()) {
    const mem = memory.get(addr);
    armedObj[addr] = {
      armedAt: info.armedAt, ageMs: Date.now() - info.armedAt,
      price: info.price, score: info.score, flowPressure: info.flowPressure,
      symbol: mem?.symbol ?? null, phase: mem?.phase ?? null,
      pairAddress: addr,
      chain: info.chain ?? mem?.chain ?? null,
    };
  }
  return armedObj;
}