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
// PairStateSnapshot moved to @preflight/schema (PreflightPairState) — it's
// written to Redis and read by MCP, so it's part of the wire contract.
// Re-exported here so existing `from "../state/pairStates"` imports
// (trendingSnapshots.ts, trendingMovers.ts, marketContext.ts) keep working.
import type { PreflightPairState, PreflightRiskSnapshot, PreflightEvmChain } from "@preflight/schema";
import { pairKey } from "@preflight/schema";
// `export type { X as Y }` only re-exports for other files — it does not
// declare Y as a usable local name in *this* file (that's what caused
// "Cannot find name 'PairStateSnapshot'" below). A real local alias fixes
// both the local usage and the re-export in one line.
export type PairStateSnapshot = PreflightPairState;

function slimRisk(risk: RiskResult | null | undefined): PreflightRiskSnapshot | null {
  if (!risk) return null;
  const safe = { ...risk } as RiskResult;
  delete safe.raw;
  return safe as PreflightRiskSnapshot;
}

// Was `value is PreflightChain` — PreflightChain now includes "solana"
// (item 6a's PreflightEvmChain/PreflightChain split), but this predicate
// only ever checks the 4 EVM literals below. The old wide predicate type
// happened to still "work" only because PreflightPairState.chain was itself
// PreflightChain at the time; now that it's narrowed to PreflightEvmChain
// too, the predicate has to match for real, not just by accident.
function isEvmPreflightChain(value: string | undefined): value is PreflightEvmChain {
  return value === "base" || value === "arbitrum" || value === "ethereum" || value === "bsc";
}

export async function buildPairStates(): Promise<Record<string, PairStateSnapshot>> {
  const states: Record<string, PairStateSnapshot> = {};
  const now = Date.now();

  // Bulk MGET — un singur Redis call pentru toate pairs
  // Same chain guard as the main loop below — a mem without a valid chain
  // would otherwise get its risk looked up under a fabricated "base" key
  // even though it's excluded from pair_states entirely.
  const riskItems = [...memory.values()]
    .filter(mem => !!mem.tokenAddress && isEvmPreflightChain(mem.chain))
    // Non-null assertion, not a cast — the .filter() above already checked
    // isEvmPreflightChain(mem.chain), but a plain boolean-returning filter
    // callback (as opposed to a callback with an inline type-predicate
    // signature) doesn't propagate that narrowing to .map(), so TS still
    // sees `string | undefined` here without it.
    .map(mem => ({ tokenAddress: mem.tokenAddress!, chain: mem.chain! }));
  const riskMap = await getCachedRisksBulk(riskItems);

  for (const [addr, mem] of memory.entries()) {
    if (!isEvmPreflightChain(mem.chain)) {
      console.warn(`[PAIR STATE SKIP] invalid/missing chain for ${addr}: ${mem.chain ?? "missing"}`);
      continue;
    }

    const flow    = getWsFlow(addr);
    const lp      = getLpSignal(addr);
    const liq     = getLiquidityContext(mem.chain, addr);
    const poolEth = poolLiquidity.get(mem.chain, addr)?.reserveEth ?? 0;
    const removed = lp.lpRemoved5m ?? 0;

    // Pipeline state derivat din stores
    const pipelineState =
	  armedEntries.has(mem.chain, addr)   ? "ARMED"      :
	  hotCandidates.has(mem.chain, addr)  ? "HOT" :
	  activeWatch.has(mem.chain, addr)    ? "WATCHING"   :
	  "NONE";

    // priceChange vine din PairMemoryEntry — workerul îl updatează la fiecare scan
    const mc = mem.priceChange ?? { m5: 0, h1: 0, h24: 0 };

    // Timing — pipelineEnteredAt = cel mai recent moment de intrare în pipeline
    const pipelineEnteredAt =
      armedEntries.get(mem.chain, addr)?.armedAt ??
      hotCandidates.get(mem.chain, addr)?.promotedAt ??
      activeWatch.get(mem.chain, addr)?.addedAt ??
      null;

    // priceVsFirstSeenPct — cât a mișcat față de prima apariție în worker
    const priceAtFirstSeen = mem.priceAtFirstSeen ?? 0;
    const priceVsFirstSeenPct =
      priceAtFirstSeen > 0 && mem.currentPrice > 0
        ? Number(((mem.currentPrice - priceAtFirstSeen) / priceAtFirstSeen * 100).toFixed(2))
        : null;

    states[addr] = {
      symbol:       mem.symbol,
      // No cast needed — isEvmPreflightChain() already narrowed mem.chain
      // above; anything that didn't validate hit `continue` before this.
      chain:        mem.chain,
      pairAddress:  addr,
      tokenAddress: mem.tokenAddress ?? "",
      dexType:      addr.length === 66 ? "V4" : v3PoolMap.has(mem.chain, addr) ? "V3" : "V2",
	  
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
      lastMomentumVerdict: mem.lastMomentumVerdict ?? null,
      lastMomentumAt:      mem.lastMomentumAt      ?? null,
      // Correction: these ARE real fields, set in pipeline/scan.ts on every
      // scanned pool (`mem.attentionScore = momentumEvent.attentionScore`
      // etc.) — an earlier pass here mistakenly flagged them as dead via a
      // grep that missed the `(mem as any).attentionScore =` assignment
      // pattern. Now real declared fields on PairMemoryEntry, no cast
      // needed.
      attentionScore:      mem.attentionScore ?? null,
      monitoringTier:      mem.monitoringTier ?? null,
      patternTags:         mem.patternTags    ?? null,
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
        pressure:     flow.pressure,
        buys5m:       flow.buys5m,
        sells5m:      flow.sells5m,
        hasData:      flow.hasData,
        buyVol5m:     (flow as any).buyVol5m     ?? 0,
        sellVol5m:    (flow as any).sellVol5m    ?? 0,
        netVol5m:     (flow as any).netVol5m     ?? 0,
        buyVol5mUsd:  (flow as any).buyVol5mUsd  ?? null,
        sellVol5mUsd: (flow as any).sellVol5mUsd ?? null,
        netVol5mUsd:  (flow as any).netVol5mUsd  ?? null,
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

      reserveUsd:    liq.reserveUsd,
      reserveEth:    liq.reserveEth,
      reserveNative: liq.reserveNative,
      nativeSymbol:  liq.nativeSymbol,
      liqStatus:     liq.status,
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
  for (const [{ chain, address: addr }, info] of activeWatch.entries()) {
    const mem         = memory.get(addr);
    const watchEvents = wsFlow.get(addr) ?? [];
    const watchBuys   = watchEvents.filter(e => e.isBuy);
    const watchSells  = watchEvents.filter(e => !e.isBuy);
    watchObj[pairKey(chain, addr)] = {
      chain, addedAt: info.addedAt, ageMs: Date.now() - info.addedAt,
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
  for (const [{ chain, address: addr }, info] of hotCandidates.entries()) {
    const mem       = memory.get(addr);
    const flow      = getWsFlow(addr);
    const hotEvents = wsFlow.get(addr) ?? [];
    const hotBuys   = hotEvents.filter(e => e.isBuy);
    const hotSells  = hotEvents.filter(e => !e.isBuy);
    hotObj[pairKey(chain, addr)] = {
      chain, promotedAt: info.promotedAt, ageMs: Date.now() - info.promotedAt,
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
  for (const [{ chain, address: addr }, info] of armedEntries.entries()) {
    const mem = memory.get(addr);
    armedObj[pairKey(chain, addr)] = {
      armedAt: info.armedAt, ageMs: Date.now() - info.armedAt,
      price: info.price, score: info.score, flowPressure: info.flowPressure,
      symbol: mem?.symbol ?? null, phase: mem?.phase ?? null,
      pairAddress: addr,
      chain,
    };
  }
  return armedObj;
}