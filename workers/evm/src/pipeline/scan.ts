/**
 * pipeline/scan.ts
 * Main scan loop — fetch pools, classify momentum, arm/enter candidates.
 * Redis writes delegated to snapshots.ts și marketContext.ts.
 */

import {
  activeWatch, hotCandidates, armedEntries,
  v3PoolMap, v4PoolMap, wsFlow, poolLiquidity,
  memory, qualifiedSignalsBuffer, marketFollowList, geckoSourceHealth, WatchKind,
} from "../state/stores";
import { updateMemory, saveMemoryToRedis } from "../state/memory";
import { trackPool, tokenPools, tokenPoolKey } from "../infra/poolTracker";
import { getRedis } from "../infra/redis";
import { sendTelegram } from "../infra/telegram";
import { fetchTrendingPools, fetchPoolByAddress } from "../sources/gecko";
import { fetchDsPairByAddress } from "../sources/dexscreener";
import { isBlockedSymbol } from "../sources/normalize";
import type { SourcePool } from "../sources/normalize";
import { CHAINS } from "../config/chains";
import {
  WORKER_VERSION, MAX_SHADOW_PER_SCAN, MAX_VERTICAL_WATCH, MAX_LATE_WATCH,
  MAX_QUALIFIED_BUFFER, ARM_CONFIRM_MS, ARM_MIN_PRICE_CONFIRM, V3_DEXES,
  MAX_EVENT_WATCH, MAX_SHORT_WATCH, MAX_CONTINUATION_WATCH, MAX_FRESH_WATCH_ATT, MAX_ACTIVE_WATCH,
  FOLLOW_TTL_MS, FOLLOW_ADD_SCORE, FOLLOW_REMOVE_SCORE, FOLLOW_REFRESH_LIMIT, FOLLOW_MAX_MISSES, MAX_ACTIVE_WATCH_BY_CHAIN,
} from "../config/constants";
import { classifyMomentumEvent, isVerticalWatch, isLateWatch, isHardReject, shouldRecordEvent } from "../risk/momentum";
import { buildMomentumEventEntry, buildQualifiedSignalEntry } from "../lib/preflight-redis";
import { classifyNewPool } from "../lib/engines/newPoolDetector";
import type { KnownPool } from "../lib/engines/newPoolDetector";
import { getWsFlow, getFlow, getLpSignal } from "../risk/flow";
import { getLiquidityContext } from "../risk/liquidity";
import { quickEdgeScore } from "../risk/scoring";
import { getEntryGate } from "../risk/gates";
import { recordMomentumEvent } from "../events/momentum";
import { saveShadowTrade } from "../shadow/trades";
import { addWatchCandidate, armCandidate, recordDrop, recordPipelineEvent } from "./transitions";
import { triggerRiskCheck } from "../risk/riskChecker";
import { requestImmediateScopedSubscribe } from "../ws/subscriptions";
import { writeAllSnapshots } from "./snapshots";
import { subscribeV3Scoped, subscribeV4Scoped, subscribeV2Scoped, cleanupActiveWatch } from "../ws/subscriptions";
import { REDIS_KEYS } from "@preflight/schema";

function hasWatchSlot(chain: string): boolean {
  const maxForChain = MAX_ACTIVE_WATCH_BY_CHAIN[chain] ?? 10;
  let chainCount = 0;
  for (const w of activeWatch.values()) {
    if (w.chain === chain) chainCount++;
  }
  return activeWatch.size < MAX_ACTIVE_WATCH && chainCount < maxForChain;
}

function triggerPoolRisk(pool: SourcePool): void {
  if (!pool.tokenAddress || !pool.chain) return;
  triggerRiskCheck(pool.tokenAddress, pool.chain);
}

function clearExpiredArmedEntries(): void {
  const now = Date.now();
  const ARM_TTL_MS = 2 * 60_000;
  for (const [addr, armed] of armedEntries.entries()) {
    if (now - armed.armedAt > ARM_TTL_MS) {
      console.log(`[ARM EXPIRE] ${addr} — confirmation window expired`);
      recordDrop(addr, memory.get(addr)?.symbol ?? addr.slice(0, 8), armed.chain ?? memory.get(addr)?.chain ?? "unknown", "ARMED", "confirmation window expired");
      armedEntries.delete(addr);
    }
  }
}

function pruneMemory(): void {
  const now    = Date.now();
  let   pruned = 0;
  for (const [addr, mem] of memory.entries()) {
    if (activeWatch.has(addr) || hotCandidates.has(addr) || armedEntries.has(addr)) continue;
    const ageMs         = now - mem.lastSeen;
    const noRecentTrade = !mem.lastEntryTime || now - mem.lastEntryTime > 48 * 60 * 60_000;
    if (ageMs > 48 * 60 * 60_000 && noRecentTrade) {
      memory.delete(addr);
      poolLiquidity.delete(addr);
      wsFlow.delete(addr);
      pruned++;
    }
  }
  if (pruned > 0) console.log(`[MEMORY PRUNE] Removed ${pruned} stale pairs`);
}

function rebuildPoolMaps(pools: SourcePool[]): void {
  const chainsPresent = new Set(pools.map(p => p.chain));
  for (const [addr, p] of v3PoolMap.entries()) {
    if (chainsPresent.has(p.chain)) v3PoolMap.delete(addr);
  }
  for (const [addr, p] of v4PoolMap.entries()) {
    if (chainsPresent.has(p.chain)) v4PoolMap.delete(addr);
  }
  for (const p of pools) {
	if (isBlockedSymbol(p.symbol)) continue;
    if (p.dexType === "V3" && V3_DEXES.has(p.dexId)) v3PoolMap.set(p.pairAddress, p);
    if (p.dexType === "V4") v4PoolMap.set(p.pairAddress, p);
  }
}

async function writeScannerStats(
  r: any,
  scanStart: number,
  totalFetched: number,
  processedPools: number,
): Promise<void> {
  const chainsHealth: Record<string, any> = {};
  for (const [chainId, health] of geckoSourceHealth.entries()) {
    chainsHealth[chainId] = health;
  }
  await r.set(REDIS_KEYS.scannerStats, JSON.stringify({
    savedAt: Date.now(),
    scan: { durationMs: Date.now() - scanStart, totalFetched, processedPools },
    chains: chainsHealth,
  }), "EX", 300);
}

export async function scan(): Promise<void> {
  const ts        = new Date().toISOString();
  const scanStart = Date.now();
  cleanupActiveWatch();
  clearExpiredArmedEntries();
  pruneMemory();

  const allPoolsPerChain = await Promise.all(CHAINS.map(c => fetchTrendingPools(c)));

  // Actualizează Gecko source health per chain
  CHAINS.forEach((chain, i) => {
    const count = allPoolsPerChain[i]?.length ?? 0;
    const prev  = geckoSourceHealth.get(chain.id);
    geckoSourceHealth.set(chain.id, {
      lastResultCount: count,
      emptyStreak:     count === 0 ? (prev?.emptyStreak ?? 0) + 1 : 0,
      lastFetchAt:     Date.now(),
    });
    if (count === 0) {
      console.log(`[GECKO EMPTY] ${chain.id} — emptyStreak:${(prev?.emptyStreak ?? 0) + 1}`);
    }
  });

  const seenInScan = new Set<string>();
  const allPools = [...allPoolsPerChain.flat()].filter(p => {
    const addr = `${p.chain}:${p.pairAddress}`;
    if (seenInScan.has(addr)) return false;
    seenInScan.add(addr);
    return true;
  });

  if (allPoolsPerChain.flat().length > 0) {
    rebuildPoolMaps(allPools);
  } else {
    console.log(`[MAPS] Keeping previous V3/V4 maps — Gecko returned empty`);
    if (!allPools.length) {
      console.log("No pools fetched");
      const rEmpty = getRedis();
      if (rEmpty) await writeScannerStats(rEmpty, scanStart, 0, 0).catch(() => {});
      return;
    }
  }

  console.log(`[${ts}] Scanning ${CHAINS.map(c => c.id).join("+")} — ${allPools.length} pools total`);

  const counters = {
    shadowCount: 0, fomoBlockCount: 0, fomoWatchAdded: 0,
    fomoNoSlot: 0, fomoLowScore: 0, fomoNoDex: 0, fomoLowReserve: 0,
    fomoPattern: 0, fomoAlready: 0, vertNoSlot: 0, lateNoSlot: 0,
    v3Seen: 0, v4Seen: 0, noWs: 0, lowScore: 0, maxBlock: 0,
    gateCount: 0, armedCount: 0, armFail: 0,
    buying: 0, neutral: 0, selling: 0,
  };
  const chainCounts: Record<string, number> = {};

  for (const pool of allPools) {
    const result = await processPool(pool, counters, chainCounts);
    if (result === "BREAK") break;
  }

  const vals     = [...memory.values()];
  const chainStr = Object.entries(chainCounts).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(
    `[${ts}] Done — shadows:${counters.shadowCount} [${chainStr || "none"}]`
    + ` | mem:${memory.size} | ws:${wsFlow.size}`
    + ` | zombies:${vals.filter(m => m.phase === "ZOMBIE").length}`
    + ` | dead:${vals.filter(m => m.phase === "DEAD").length}`
    + ` | 2wave:${vals.filter(m => m.phase === "SECOND_WAVE").length}`
    + ` | recovering:${vals.filter(m => m.phase === "RECOVERING").length}`,
  );

  // ── Redis writes ────────────────────────────────────────────────────────────
  try {
    const r = getRedis();
    if (r) {
      await writeAllSnapshots(r);
      console.log(`[REDIS] watch:${activeWatch.size} hot:${hotCandidates.size} armed:${armedEntries.size}`);
      await writeScannerStats(r, scanStart, allPools.length, allPools.length).catch(() => {});
    }
  } catch { /* Redis optional */ }

  CHAINS.forEach(c => subscribeV4Scoped(c));
  CHAINS.forEach(c => subscribeV3Scoped(c));
  CHAINS.forEach(c => subscribeV2Scoped(c));

  console.log(
    `[MOMENTUM SUMMARY] events:${counters.fomoBlockCount} watched:${counters.fomoWatchAdded}`
    + ` noSlot:${counters.fomoNoSlot} pattern:${counters.fomoPattern} already:${counters.fomoAlready}`
    + ` vertNoSlot:${counters.vertNoSlot} lateNoSlot:${counters.lateNoSlot}`,
  );
  console.log(
    `[NO TRADE SUMMARY] v3:${counters.v3Seen} v4:${counters.v4Seen} watched:${activeWatch.size}`
    + ` noWs:${counters.noWs} buying:${counters.buying} neutral:${counters.neutral} selling:${counters.selling}`
    + ` lowScore:${counters.lowScore} entryGate:${counters.gateCount} maxBlock:${counters.maxBlock}`
    + ` armed:${counters.armedCount} armFail:${counters.armFail} entered:${counters.shadowCount}`,
  );

  await saveMemoryToRedis();
}

async function processPool(
  pool: SourcePool,
  counters: Record<string, number>,
  chainCounts: Record<string, number>,
  opts: { source?: "scan" | "follow_refresh" } = {},
): Promise<"CONTINUE" | "BREAK"> {
  const price = pool.priceUsd;
  if (!price || isNaN(price)) return "CONTINUE";

  const mem      = updateMemory(pool, price);
  const pairAddr = pool.pairAddress;

  if (isBlockedSymbol(mem.symbol)) return "CONTINUE";
  const isFollowRefresh = opts.source === "follow_refresh";

  // New pool detection
  const tokenAddr = pool.tokenAddress ?? "";
  const isNewPool = tokenAddr ? trackPool(tokenAddr, pairAddr, pool.chain) : false;

  if (isNewPool) {
    const knownPools: KnownPool[] = [...(tokenPools.get(tokenPoolKey(pool.chain, tokenAddr)) ?? [])]
      .filter(pa => pa !== pairAddr)
      .map(pa => ({ pairAddress: pa, liquidityUsd: poolLiquidity.get(pa)?.reserveUsd ?? 0 }));

    const sig = classifyNewPool(tokenAddr, mem.symbol, pool.chain, pairAddr, pool.reserveUsd, knownPools);
    if (sig.classification !== "LOW_LIQ_NOISE" && sig.classification !== "CLONE_RISK") {
      console.log(`[NEW POOL] ${mem.symbol} (${pool.chain}) — ${sig.classification} | $${(sig.newLiquidityUsd / 1000).toFixed(1)}K liq | score:${sig.score}`);
      if (!isFollowRefresh) {
        await sendTelegram(
          `🆕 <b>NEW POOL</b> ${mem.symbol} [${pool.chain.toUpperCase()}]\n`
          + `${sig.classification}\nLichiditate: $${(sig.newLiquidityUsd / 1000).toFixed(1)}K\n`
          + sig.reasons.join("\n"),
        );
      }
    }
  }

  const wsFlowReal = getWsFlow(pairAddr);
  const flow       = getFlow(pool);
  const lp         = getLpSignal(pairAddr);
  const isV3pool   = v3PoolMap.has(pairAddr);
  const isV4pool   = v4PoolMap.has(pairAddr);
  if (isV3pool) counters.v3Seen++;
  if (isV4pool) counters.v4Seen++;

  const momentumEvent = classifyMomentumEvent({
    m5: pool.priceChange.m5, h1: pool.priceChange.h1, h24: pool.priceChange.h24,
    reserveUsd: pool.reserveUsd,
    isV3orV4: isV3pool || isV4pool,
    hasWsFlow: wsFlowReal.hasData && wsFlowReal.pressure === "BUYING",
  }, mem.seenCount);

  // attentionScore salvat pe TOATE pool-urile — inclusiv NO_MOMENTUM
  // AttentionScore descrie importanța de piață, nu verdictul de trading
  (mem as any).attentionScore = momentumEvent.attentionScore;
  (mem as any).monitoringTier = momentumEvent.monitoringTier;
  (mem as any).patternTags    = momentumEvent.patternTags;

  // Populare marketFollowList pentru high-attention pairs
  const att = momentumEvent.attentionScore;
  const shouldFollow =
    att >= FOLLOW_ADD_SCORE ||
    momentumEvent.monitoringTier === "EVENT_WATCH" ||
    (pool.reserveUsd >= 250_000 && (Math.abs(pool.priceChange.h1) >= 500 || Math.abs(pool.priceChange.h24) >= 1000));

  if (shouldFollow) {
    const existing = marketFollowList.get(pairAddr);
    marketFollowList.set(pairAddr, {
      chain:           pool.chain,
      addedAt:         existing?.addedAt ?? Date.now(),
      lastRefreshedAt: Date.now(),
      attentionScore:  att,
      reason:          momentumEvent.monitoringTier,
      missCount:       existing?.missCount ?? 0,
    });
  } else if (marketFollowList.has(pairAddr) && att < FOLLOW_REMOVE_SCORE) {
    marketFollowList.delete(pairAddr);
  }

  if (momentumEvent.verdict !== "NO_MOMENTUM") {
    mem.lastMomentumVerdict = momentumEvent.verdict;
    mem.lastMomentumAt      = Date.now();
  }

  if (momentumEvent.verdict !== "NO_MOMENTUM") {
    const entry = buildMomentumEventEntry(
      momentumEvent, mem.symbol, pool.chain, pairAddr,
      pairAddr.length === 66 ? "V4" : isV3pool ? "V3" : "V2",
      wsFlowReal.hasData,
      (wsFlowReal as any).buyVol5m ?? 0,
      (wsFlowReal as any).netVol5m ?? 0,
      wsFlowReal.buys5m ?? 0,
      WORKER_VERSION,
    );

    if (!isFollowRefresh && shouldRecordEvent(momentumEvent.verdict)) {
      await recordMomentumEvent(pool, entry);
      counters.fomoBlockCount++;
    }

    // isHardReject oprește pipeline, dar nu înainte de a verifica attention
    if (isHardReject(momentumEvent.verdict)) {
      // EVENT_WATCH pentru hard rejects cu attention mare
      const { attentionScore, monitoringTier } = momentumEvent;
      if (monitoringTier === "EVENT_WATCH" && !activeWatch.has(pairAddr)) {
        const currentEvent = [...activeWatch.values()].filter(w => w.chain === pool.chain && w.kind === "EVENT_WATCH").length;
        if (currentEvent < MAX_EVENT_WATCH) {
          addWatchCandidate(pairAddr, {
            chain: pool.chain, addedAt: Date.now(),
            kind: "EVENT_WATCH",
            entryPrice: price, reason: `attention:${attentionScore} tier:EVENT_WATCH`,
          }, pool);
          console.log(`[EVENT_WATCH] ${mem.symbol} (${pool.chain}) — attention:${attentionScore} verdict:${momentumEvent.verdict} liq:$${Math.round(pool.reserveUsd/1000)}K`);
          const chainCfg = CHAINS.find(c => c.id === pool.chain);
          if (chainCfg) requestImmediateScopedSubscribe(chainCfg);
          triggerPoolRisk(pool);
        }
      } else if (monitoringTier === "SHORT_WATCH" && !activeWatch.has(pairAddr)) {
        const currentShort = [...activeWatch.values()].filter(w => w.chain === pool.chain && w.kind === "SHORT_WATCH").length;
        if (currentShort < MAX_SHORT_WATCH) {
          addWatchCandidate(pairAddr, {
            chain: pool.chain, addedAt: Date.now(),
            kind: "SHORT_WATCH",
            entryPrice: price, reason: `attention:${attentionScore} tier:SHORT_WATCH`,
          }, pool);
          console.log(`[SHORT_WATCH] ${mem.symbol} (${pool.chain}) — attention:${attentionScore} verdict:${momentumEvent.verdict}`);
          const chainCfgShort = CHAINS.find(c => c.id === pool.chain);
          if (chainCfgShort) requestImmediateScopedSubscribe(chainCfgShort);
          triggerPoolRisk(pool);
        }
      }

      // Context watch — colectare dosar, nu pipeline candidate
      if (!activeWatch.has(pairAddr) && hasWatchSlot(pool.chain)) {
        const shouldContextWatch =
          pool.reserveUsd >= 500_000 ||
          Math.abs(pool.priceChange?.m5  ?? 0) >= 5  ||
          Math.abs(pool.priceChange?.h1  ?? 0) >= 10 ||
          Math.abs(pool.priceChange?.h24 ?? 0) >= 50;

        if (shouldContextWatch) {
          const watchKind: WatchKind =
            Math.abs(pool.priceChange?.m5  ?? 0) >= 5   ? "CONTEXT_MOVER_5M"  :
            Math.abs(pool.priceChange?.h1  ?? 0) >= 10  ? "CONTEXT_MOVER_1H"  :
            Math.abs(pool.priceChange?.h24 ?? 0) >= 50  ? "CONTEXT_MOVER_24H" :
            "CONTEXT_HIGH_LIQ";

          addWatchCandidate(pairAddr, { chain: pool.chain, addedAt: Date.now(), kind: watchKind }, pool);
          console.log(`[CONTEXT_WATCH] ${mem.symbol} (${pool.chain}) — kind:${watchKind} verdict:${momentumEvent.verdict}`);
          const chainCfgCtx = CHAINS.find(c => c.id === pool.chain);
          if (chainCfgCtx) requestImmediateScopedSubscribe(chainCfgCtx);
          triggerPoolRisk(pool);
        }
      
      }
      return "CONTINUE";
    }

    if (isVerticalWatch(momentumEvent.verdict)) {
      const currentVertical = [...activeWatch.values()].filter(w => w.kind === "VERTICAL").length;
      if (activeWatch.has(pairAddr)) {
        counters.fomoAlready++;
      } else if (currentVertical >= MAX_VERTICAL_WATCH) {
        counters.vertNoSlot++;
      } else {
        const isPriority = momentumEvent.verdict === "CONFIRMED_MOMENTUM";
        addWatchCandidate(pairAddr, {
          chain: pool.chain, addedAt: Date.now(),
          kind: isPriority ? "CONFIRMED_MOMENTUM" : "VERTICAL",
          entryPrice: price, reason: momentumEvent.reason,
        }, pool);
        counters.fomoWatchAdded++;
        console.log(`[${isPriority ? "CONFIRMED_MOMENTUM" : "VERTICAL WATCH"}] ${mem.symbol} (${pool.chain}) — m5:${momentumEvent.m5Pct.toFixed(1)}% reserve:$${Math.round(momentumEvent.reserveUsd / 1000)}K verdict:${momentumEvent.verdict}`);
        if (isPriority || momentumEvent.m5Pct > 50) {
          const chainCfg = CHAINS.find(c => c.id === pool.chain);
          if (chainCfg) requestImmediateScopedSubscribe(chainCfg);
        }
        triggerPoolRisk(pool);
      }
      return "CONTINUE";
    }

    if (isLateWatch(momentumEvent.verdict)) {
      const currentLate = [...activeWatch.values()].filter(w => w.kind === "LATE").length;
      if (activeWatch.has(pairAddr)) {
        counters.fomoAlready++;
      } else if (currentLate >= MAX_LATE_WATCH) {
        counters.lateNoSlot++;
      } else {
        addWatchCandidate(pairAddr, {
          chain: pool.chain, addedAt: Date.now(),
          kind: "LATE", entryPrice: price, reason: momentumEvent.reason,
        }, pool);
        counters.fomoWatchAdded++;
        console.log(`[LATE WATCH] ${mem.symbol} (${pool.chain}) — h24:${momentumEvent.h24Pct.toFixed(0)}% verdict:${momentumEvent.verdict}`);
        triggerPoolRisk(pool);
      }
      return "CONTINUE";
    }

    counters.fomoPattern++;
    return "CONTINUE";
  }

 // Attention-based watch selection — cap global + immediate subscribe
  const attScore = (mem as any).attentionScore ?? 0;
  const attTier  = (mem as any).monitoringTier ?? "MARKET_ONLY";

    if (!activeWatch.has(pairAddr) && hasWatchSlot(pool.chain)) {
    if (attTier === "CONTINUATION_WATCH") {
      const currentCont = [...activeWatch.values()].filter(w => w.chain === pool.chain && w.kind === "CONTINUATION_WATCH").length;
      if (currentCont < MAX_CONTINUATION_WATCH) {
        addWatchCandidate(pairAddr, {
          chain: pool.chain, addedAt: Date.now(),
          kind: "CONTINUATION_WATCH",
          entryPrice: price, reason: `attention:${attScore} tier:CONTINUATION_WATCH`,
        }, pool);
        console.log(`[CONTINUATION_WATCH] ${mem.symbol} (${pool.chain}) — attention:${attScore} m5:${pool.priceChange.m5.toFixed(1)}% h1:${pool.priceChange.h1.toFixed(1)}%`);
        const chainCfgCont = CHAINS.find(c => c.id === pool.chain);
        if (chainCfgCont) requestImmediateScopedSubscribe(chainCfgCont);
        triggerPoolRisk(pool);
      }
    } else if (attTier === "FRESH_WATCH") {
      const currentFresh = [...activeWatch.values()].filter(w => w.chain === pool.chain && w.kind === "FRESH_WATCH").length;
      if (currentFresh < MAX_FRESH_WATCH_ATT) {
        addWatchCandidate(pairAddr, {
          chain: pool.chain, addedAt: Date.now(),
          kind: "FRESH_WATCH",
          entryPrice: price, reason: `attention:${attScore} tier:FRESH_WATCH`,
        }, pool);
        console.log(`[FRESH_WATCH] ${mem.symbol} (${pool.chain}) — attention:${attScore} m5:${pool.priceChange.m5.toFixed(1)}% h1:${pool.priceChange.h1.toFixed(1)}%`);
        const chainCfgFresh = CHAINS.find(c => c.id === pool.chain);
        if (chainCfgFresh) requestImmediateScopedSubscribe(chainCfgFresh);
        triggerPoolRisk(pool);
      }
    } else if (!wsFlowReal.hasData) {
      const prelScore = quickEdgeScore(pool, mem, flow, lp);
      const shouldWatchForContext =
        Math.abs(pool.priceChange?.m5  ?? 0) >= 5  ||
        Math.abs(pool.priceChange?.h1  ?? 0) >= 10 ||
        Math.abs(pool.priceChange?.h24 ?? 0) >= 50 ||
        pool.reserveUsd >= 500_000 ||
        mem.phase === "PUMPING" ||
        mem.phase === "NEW" ||
        prelScore >= 70;

      if (shouldWatchForContext) {
        const watchKind: WatchKind =
          Math.abs(pool.priceChange?.m5  ?? 0) >= 5   ? "MOVER_5M"  :
          Math.abs(pool.priceChange?.h1  ?? 0) >= 10  ? "MOVER_1H"  :
          Math.abs(pool.priceChange?.h24 ?? 0) >= 50  ? "MOVER_24H" :
          pool.reserveUsd >= 500_000                  ? "HIGH_LIQ"  :
          mem.phase === "NEW"                         ? "NEW_POOL"  :
          "NORMAL";

        addWatchCandidate(pairAddr, { chain: pool.chain, addedAt: Date.now(), kind: watchKind }, pool);
        console.log(`[WATCH] ${mem.symbol} (${pool.chain}) — added, kind:${watchKind} prelScore:${prelScore}`);
        triggerPoolRisk(pool);
      }
    }
  }

  if (!wsFlowReal.hasData) {
    if (activeWatch.has(pairAddr)) {
      counters.noWs++;
      console.log(`[WATCH WAIT] ${mem.symbol} (${pool.chain}) — subscribed, waiting for WS flow`);
    }
    return "CONTINUE";
  }

  if (wsFlowReal.pressure === "BUYING")        counters.buying++;
  else if (wsFlowReal.pressure === "NEUTRAL")  counters.neutral++;
  else if (wsFlowReal.pressure === "SELLING")  counters.selling++;

  if (counters.shadowCount >= MAX_SHADOW_PER_SCAN) {
    counters.maxBlock++;
    return "CONTINUE";
  }

  const score = quickEdgeScore(pool, mem, wsFlowReal, lp);
  if (score < 80) {
    counters.lowScore++;
    console.log(`[LOW SCORE] ${mem.symbol} (${pool.chain}) score=${score} flow=${wsFlowReal.pressure} liq=${getLiquidityContext(pairAddr).status}`);
    return "CONTINUE";
  }

  const gate = getEntryGate(mem, wsFlowReal, lp, score, "SCAN");
  if (!gate.allowed) {
    counters.gateCount++;
    console.log(`[SKIP] ${mem.symbol} (${pool.chain}) — ${gate.reason}`);
    if (armedEntries.has(pairAddr)) {
      recordDrop(pairAddr, mem.symbol, pool.chain, "ARMED", `gate failed: ${gate.reason}`, price, score);
    }
    armedEntries.delete(pairAddr);
    return "CONTINUE";
  }

  const armed = armedEntries.get(pairAddr);

  if (!armed) {
    armCandidate(pairAddr, pool.chain, price, score, wsFlowReal.pressure);
    counters.armedCount++;
    console.log(`[ARMED] ${mem.symbol} (${pool.chain}) — waiting confirmation price:${price.toExponential(4)} score:${score} flow:${wsFlowReal.pressure} net:${((wsFlowReal as any).netVol5m ?? 0).toFixed(3)}ETH`);
    return "CONTINUE";
  }

  if (Date.now() - armed.armedAt < ARM_CONFIRM_MS) {
    console.log(`[ARM WAIT] ${mem.symbol} (${pool.chain}) — confirmation pending`);
    return "CONTINUE";
  }

  if (price < armed.price * ARM_MIN_PRICE_CONFIRM) {
    console.log(`[ARM SKIP] ${mem.symbol} (${pool.chain}) — price failed confirmation`);
    recordDrop(pairAddr, mem.symbol, pool.chain, "ARMED", `price failed confirmation ${price.toExponential(4)} < ${armed.price.toExponential(4)}`, price, armed.score);
    armedEntries.delete(pairAddr); counters.armFail++;
    return "CONTINUE";
  }

  if (!wsFlowReal.hasData || wsFlowReal.pressure !== "BUYING") {
    console.log(`[ARM SKIP] ${mem.symbol} (${pool.chain}) — flow faded (${wsFlowReal.pressure})`);
    recordDrop(pairAddr, mem.symbol, pool.chain, "ARMED", `flow faded: ${wsFlowReal.pressure}`, price, armed.score);
    armedEntries.delete(pairAddr); counters.armFail++;
    return "CONTINUE";
  }

  const currentNetVol = (wsFlowReal as any).netVol5m ?? 0;
  if (currentNetVol < 0.05) {
    console.log(`[ARM SKIP] ${mem.symbol} (${pool.chain}) — netVol faded ${currentNetVol.toFixed(3)}ETH`);
    recordDrop(pairAddr, mem.symbol, pool.chain, "ARMED", `netVol faded ${currentNetVol.toFixed(3)}ETH`, price, armed.score);
    armedEntries.delete(pairAddr); counters.armFail++;
    return "CONTINUE";
  }

  console.log(`[ARM CONFIRMED] ${mem.symbol} (${pool.chain}) — entering armed:${armed.price.toExponential(4)} now:${price.toExponential(4)} net:${currentNetVol.toFixed(3)}ETH`);
  armedEntries.delete(pairAddr);

  recordPipelineEvent("ARM_CONFIRMED", mem.symbol, pool.chain, pairAddr, "ARMED", "CONFIRMED");

  const liqCtx = getLiquidityContext(pairAddr);
  const qsScan = buildQualifiedSignalEntry({
    symbol: mem.symbol, chain: pool.chain, pairAddress: pairAddr, qualifiedAt: Date.now(),
    flow: {
      pressure: wsFlowReal.pressure, hasData: wsFlowReal.hasData,
      buyVol5m: (wsFlowReal as any).buyVol5m ?? 0,
      netVol5m: (wsFlowReal as any).netVol5m ?? 0,
      buys5m:   wsFlowReal.buys5m ?? 0,
      sells5m:  wsFlowReal.sells5m ?? 0,
    },
    reserveUsd: liqCtx.reserveUsd, liqStatus: liqCtx.status,
    riskFlags: [], phase: mem.phase, workerVersion: WORKER_VERSION,
  });
  qualifiedSignalsBuffer.unshift(qsScan);
  if (qualifiedSignalsBuffer.length > MAX_QUALIFIED_BUFFER) qualifiedSignalsBuffer.pop();

  if (!isFollowRefresh) {
    await saveShadowTrade(pool, score, mem, wsFlowReal, lp, "SCAN");
    counters.shadowCount++;
    chainCounts[pool.chain] = (chainCounts[pool.chain] ?? 0) + 1;
  }

  return "CONTINUE";
}

function seedFollowListFromMemory(): void {
  let seeded = 0;

  for (const [addr, mem] of memory.entries()) {
   if (marketFollowList.has(addr)) continue;
    const pc = (mem as any).priceChange;
    if (!pc) continue;
    
    // Defensive key lookup — poate fi addr sau chain:addr
    const reserveUsd =
      poolLiquidity.get(addr)?.reserveUsd ??
      poolLiquidity.get(`${mem.chain}:${addr}`)?.reserveUsd ??
      0;
  
    const shouldSeed =
      (reserveUsd >= 250_000 && (Math.abs(pc.h1) >= 500 || Math.abs(pc.h24) >= 1000)) ||
      (reserveUsd >= 50_000  && (Math.abs(pc.h1) >= 200 || Math.abs(pc.h24) >= 500));
    if (!shouldSeed) continue;

    marketFollowList.set(addr, {
      chain:           mem.chain ?? "base",
      addedAt:         Date.now(),
      lastRefreshedAt: 0,
      attentionScore:  100,
      reason:          "seeded_from_memory",
      missCount:       0,
    });
    seeded++;
  }

  if (seeded > 0) console.log(`[FOLLOW SEED] ${seeded} pairs seeded from memory | followList:${marketFollowList.size}`);
}

export async function runFollowRefresh(): Promise<void> {
  if (marketFollowList.size > 0) console.log(`[FOLLOW REFRESH TICK] followList:${marketFollowList.size}`);
  const now = Date.now();

  // Seed din memory la fiecare run
  seedFollowListFromMemory();

  // Curăță entries expirate
  for (const [addr, entry] of marketFollowList.entries()) {
    if (now - entry.addedAt > FOLLOW_TTL_MS) {
      marketFollowList.delete(addr);
    }
  }

  if (marketFollowList.size === 0) return;

  // Sortează după attentionScore descendent, ia top N
  const toRefresh = [...marketFollowList.entries()]
    .sort(([, a], [, b]) => b.attentionScore - a.attentionScore)
    .slice(0, FOLLOW_REFRESH_LIMIT);

  const counters = {
    shadowCount: 0, fomoBlockCount: 0, fomoWatchAdded: 0,
    fomoNoSlot: 0, fomoLowScore: 0, fomoNoDex: 0, fomoLowReserve: 0,
    fomoPattern: 0, fomoAlready: 0, vertNoSlot: 0, lateNoSlot: 0,
    v3Seen: 0, v4Seen: 0, noWs: 0, lowScore: 0, maxBlock: 0,
    gateCount: 0, armedCount: 0, armFail: 0,
    buying: 0, neutral: 0, selling: 0,
  };
  const chainCounts: Record<string, number> = {};
  let refreshed = 0;

  for (const [addr, entry] of toRefresh) {
    const chainCfg = CHAINS.find(c => c.id === entry.chain);
    if (!chainCfg) continue;

    try {
      let pool = await fetchPoolByAddress(chainCfg, addr);

      // Fallback: DexScreener dacă Gecko direct fetch eșuează
      if (!pool) {
        pool = await fetchDsPairByAddress(chainCfg, addr);
        if (pool) {
          console.log(`[FOLLOW DS FALLBACK] ${entry.chain}:${addr.slice(0, 12)}... — Gecko miss, DexScreener hit`);
        }
      }

      if (!pool) {
        const missCount = (entry.missCount ?? 0) + 1;
        if (missCount >= FOLLOW_MAX_MISSES) {
          marketFollowList.delete(addr);
          console.log(`[FOLLOW EVICT] ${entry.chain}:${addr.slice(0, 12)}... — ${missCount} consecutive misses`);
        } else {
          marketFollowList.set(addr, { ...entry, lastRefreshedAt: now, missCount });
        }
        continue;
      }

      await processPool(pool, counters, chainCounts, { source: "follow_refresh" });

      // nu suprascrie attentionScore nou cu entry vechi
      const updated = marketFollowList.get(addr);
      if (updated) {
        marketFollowList.set(addr, { ...updated, lastRefreshedAt: now, missCount: 0 });
      }

      refreshed++;
    } catch {
      // Ignoră erori individuale
    }
  }

  if (refreshed > 0) {
    console.log(`[FOLLOW REFRESH] ${refreshed}/${toRefresh.length} refreshed | followList:${marketFollowList.size}`);
  }
}