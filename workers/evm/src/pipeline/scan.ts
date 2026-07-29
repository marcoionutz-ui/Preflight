/**
 * pipeline/scan.ts
 * Main scan loop — fetch pools, classify momentum, arm/enter candidates.
 * Redis writes delegated to snapshots.ts și marketContext.ts.
 */

import {
  activeWatch, hotCandidates, armedEntries,
  v3PoolMap, v4PoolMap, routingOnlyPools, wsFlow, lpEvents, poolLiquidity, watchedPoolCache,
  memory, qualifiedSignalsBuffer, marketFollowList, geckoSourceHealth, WatchKind,
  dexscreenerSourceHealth, lastDsBoostedFetchAt, setLastDsBoostedFetchAt,
} from "../state/stores";
import { BUDGET, maxWatchForChain } from "../config/mode";
import { updateMemory, saveMemoryToRedis } from "../state/memory";
import { trackPool, tokenPools, tokenPoolKey, prunePairFromAuxState } from "../infra/poolTracker";
import { getRedis } from "../infra/redis";
import { sendTelegram } from "../infra/telegram";
import { fetchDiscoveryPools, fetchPoolByAddress } from "../sources/gecko";
import { fetchIndexedDiscoveryPools, getIndexedSourceHealth } from "../sources/indexed";
import { fetchDsPairByAddress, fetchDsTokenPairs, fetchDsBoostedTokens } from "../sources/dexscreener";
import { isBlockedSymbol } from "../sources/normalize";
import type { SourcePool } from "../sources/normalize";
import { CHAINS } from "../config/chains";
import type { ChainConfig } from "../config/chains";
import {
  WORKER_VERSION, MAX_SHADOW_PER_SCAN, MAX_VERTICAL_WATCH, MAX_LATE_WATCH,
  MAX_QUALIFIED_BUFFER, ARM_CONFIRM_MS, ARM_MIN_PRICE_CONFIRM, V3_DEXES,
  MAX_EVENT_WATCH, MAX_SHORT_WATCH, MAX_CONTINUATION_WATCH, MAX_FRESH_WATCH_ATT,
  FOLLOW_TTL_MS, FOLLOW_ADD_SCORE, FOLLOW_REMOVE_SCORE, FOLLOW_REFRESH_LIMIT, FOLLOW_MAX_MISSES,
  DS_BOOSTED_INTERVAL_MS, DS_BOOSTED_MAX_PER_RUN,
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
import { addWatchCandidate, armCandidate, recordDrop, recordPipelineEvent } from "./transitions";
import { recordLifecycleOutcome } from "../state/lifecycle";
import { triggerRiskCheck } from "../risk/riskChecker";
import { requestImmediateScopedSubscribe } from "../ws/subscriptions";
import { planPoolMapRebuild } from "./poolMapRebuild";
import { writeAllSnapshots } from "./snapshots";
import { subscribeV3Scoped, subscribeV4Scoped, subscribeV2Scoped, cleanupActiveWatch } from "../ws/subscriptions";
import type { Redis } from "ioredis";
import {
  REDIS_KEYS, normalizeChainId, pairKey,
  type PreflightScannerStats, type PreflightSourceByChainEntry, type PreflightGeckoChainHealth,
} from "@preflight/schema";

function hasWatchSlot(chain: string): boolean {
  const maxForChain = maxWatchForChain(chain);
  let chainCount = 0;
  for (const [{ chain: watchChain }] of activeWatch.entries()) {
    if (watchChain === chain) chainCount++;
  }
  return activeWatch.size < BUDGET.maxActiveWatch && chainCount < maxForChain;
}

function triggerPoolRisk(pool: SourcePool): void {
  if (!pool.tokenAddress || !pool.chain) return;
  triggerRiskCheck(pool.tokenAddress, pool.chain);
}

function clearExpiredArmedEntries(): void {
  const now = Date.now();
  const ARM_TTL_MS = 2 * 60_000;
  for (const [{ chain, address: addr }, armed] of armedEntries.entries()) {
    if (now - armed.armedAt > ARM_TTL_MS) {
      console.log(`[ARM EXPIRE] ${addr} — confirmation window expired`);
      recordDrop(addr, memory.get(chain, addr)?.symbol ?? addr.slice(0, 8), chain, "ARMED", "confirmation window expired");
      armedEntries.delete(chain, addr);
    }
  }
}

function pruneMemory(): void {
  const now    = Date.now();
  let   pruned = 0;
  for (const [{ chain, address: addr }, mem] of memory.entries()) {
    // chain din cheia decodată e mereu prezent → nu mai avem nevoie de guard `if(c)`.
    if (activeWatch.has(chain, addr) || hotCandidates.has(chain, addr) || armedEntries.has(chain, addr)) continue;
    const ageMs         = now - mem.lastSeen;
    const noRecentTrade = !mem.lastEntryTime || now - mem.lastEntryTime > 48 * 60 * 60_000;
    if (ageMs > 48 * 60 * 60_000 && noRecentTrade) {
      memory.delete(chain, addr);
      poolLiquidity.delete(chain, addr); wsFlow.delete(chain, addr); lpEvents.delete(chain, addr);
      // E20: prune și starea auxiliară (watchedPoolCache + tokenPools) — altfel cresc nemărginit → leak RSS.
      prunePairFromAuxState(chain, mem.tokenAddress, addr, watchedPoolCache, tokenPools);
      pruned++;
    }
  }
  if (pruned > 0) console.log(`[MEMORY PRUNE] Removed ${pruned} stale pairs`);
}

function rebuildPoolMaps(pools: SourcePool[]): void {
  const scanChains = new Set(pools.map(p => p.chain));
  // D5: un pool încă URMĂRIT care a căzut din scanul curent trebuie PĂSTRAT în hartă — altfel
  // manager.ts nu-l mai găsește la swap-urile WS (`v3/v4PoolMap.get()` = undefined → drop, fără
  // fallback) → flow ZERO pe un pool urmărit; iar subscriptions.ts îl rutează greșit ca V2.
  // DAR: intrarea păstrată are date de piață STALE → o marcăm `routingOnly` ca scoringul (hot.ts) să
  // ceară un snapshot proaspăt în loc s-o folosească. Aceeași mulțime „activă" ca pruneMemory.
  const isWatched = (chain: string, addr: string) =>
    activeWatch.has(chain, addr) || hotCandidates.has(chain, addr) || armedEntries.has(chain, addr);
  // D5 (runda 3): un pool urmărit PREZENT în scan dar reclasificat (acum V2 / dexId neacceptat / blocat)
  // NU trebuie păstrat routing-only — re-add-ul îl sare, dar intrarea V3/V4 veche ar rămâne (rutare greșită).
  // seenInScan distinge „a dispărut din scan" (conservă) de „a apărut și s-a reclasificat" (crede scanul).
  // pairKey = aceeași normalizare (chain+adresă) ca PairMap → comparație corectă.
  const scanKeys = new Set(pools.map(p => pairKey(p.chain, p.pairAddress)));
  const seenInScan = (chain: string, addr: string) => scanKeys.has(pairKey(chain, addr));

  for (const map of [v3PoolMap, v4PoolMap]) {
    const { toDelete, toMarkRouting } = planPoolMapRebuild([...map.entries()].map(([k]) => k), scanChains, seenInScan, isWatched);
    for (const { chain, address } of toDelete)      { map.delete(chain, address); routingOnlyPools.delete(chain, address); }
    for (const { chain, address } of toMarkRouting) routingOnlyPools.set(chain, address, true);
  }
  // Re-add din scanul curent → date proaspete; curăță markerul routing-only (nu mai e stale).
  for (const p of pools) {
    if (isBlockedSymbol(p.symbol)) continue;
    if (p.dexType === "V3" && V3_DEXES.has(p.dexId)) { v3PoolMap.set(p.chain, p.pairAddress, p); routingOnlyPools.delete(p.chain, p.pairAddress); }
    if (p.dexType === "V4")                          { v4PoolMap.set(p.chain, p.pairAddress, p); routingOnlyPools.delete(p.chain, p.pairAddress); }
  }
}

async function writeScannerStats(
  r: Redis,
  scanStart: number,
  totalFetched: number,
  processedPools: number,
  sourceByChain: Record<string, PreflightSourceByChainEntry> = {},
  discoverySource: string = "auto",
): Promise<void> {
  const chainsHealth: Record<string, PreflightGeckoChainHealth> = {};
  for (const [chainId, health] of geckoSourceHealth.entries()) {
    chainsHealth[chainId] = health;
  }
  const stats: PreflightScannerStats = {
    savedAt: Date.now(),
    discoverySource,
    scan: { durationMs: Date.now() - scanStart, totalFetched, processedPools },
    chains: chainsHealth,
    sourceByChain,
    dexscreener: {
      lastFetchAgeSec:  dexscreenerSourceHealth.lastFetchAt
        ? Math.round((Date.now() - dexscreenerSourceHealth.lastFetchAt) / 1000)
        : null,
      lastResultCount:  dexscreenerSourceHealth.lastResultCount,
      last429AgeSec:    dexscreenerSourceHealth.last429At
        ? Math.round((Date.now() - dexscreenerSourceHealth.last429At) / 1000)
        : null,
      status:           dexscreenerSourceHealth.status,
    },
  };
  // B4d-1: scanner_stats chain-scoped — o cheie per-chain. `chains`/`sourceByChain`
  // sunt deja per-chain. **Scan totalurile sunt LOCALE chainului** (din sourceByChain:
  // indexedCount+geckoCount) — NU totalurile globale replicate; altfel reader-ul (care
  // sumează) ar dubla în single-process sau ar raporta doar un chain post-split.
  // durationMs = durata scanului (per-worker) → reader ia max. dexscreener = health-ul
  // sursei pt. acel worker (post-split fiecare are al lui) → reader ia cel mai sever.
  const statsPipe = r.pipeline();
  for (const { id: chainId } of CHAINS) {
    const sbc = stats.sourceByChain[chainId];
    const localFetched = sbc ? (sbc.indexedCount ?? 0) + (sbc.geckoCount ?? 0) : 0;
    statsPipe.set(REDIS_KEYS.scannerStats(chainId), JSON.stringify({
      ...stats,
      scan:          { durationMs: stats.scan.durationMs, totalFetched: localFetched, processedPools: localFetched },
      chains:        stats.chains[chainId] ? { [chainId]: stats.chains[chainId] } : {},
      sourceByChain: sbc ? { [chainId]: sbc } : {},
    }), "EX", 300);
  }
  await statsPipe.exec();
}

// ── Source dispatch ───────────────────────────────────────────────────────────

/**
 * Minimum indexed pools to consider the indexer registry ready for use.
 * Below this threshold we fall back to Gecko even if health is OK.
 */
const MIN_INDEXED_POOLS = 5;

/**
 * Health-aware pool fetcher for one chain.
 *
 * DISCOVERY_SOURCE env:
 *   "gecko"   → always use GeckoTerminal (current behaviour)
 *   "indexer" → always use indexer registry (even if health is degraded)
 *   "auto"    → use indexer if healthy + enough pools + has price data, else Gecko
 *
 * "auto" default means: in Faza 6.3 (no price data yet) the indexer registry
 * is always bypassed because indexed pools have priceUsd=0.
 * In Faza 6.5+ (price data available) auto will activate INDEXER_PRIMARY.
 */
// ── Source fetch result (Faza 6.6: sourceByChain tracking) ───────────────────

interface FetchResult {
  pools:         SourcePool[];
  source:        "INDEXER_PRIMARY" | "GECKO_FALLBACK" | "INDEXER_FORCED";
  reason?:       string;
  indexedCount?: number;
  geckoCount?:   number;
  indexedHealth?: { status: string; blocksBehind: number | null };
}

async function fetchPoolsForChain(chain: ChainConfig): Promise<FetchResult> {
  const mode = process.env.DISCOVERY_SOURCE ?? "auto";

  if (mode === "gecko") {
    const pools = await fetchDiscoveryPools(chain);
    console.log(`[SOURCE] ${chain.id}: GECKO_FALLBACK (${pools.length} pools, reason:forced_gecko)`);
    return { pools, source: "GECKO_FALLBACK", reason: "forced_gecko", geckoCount: pools.length };
  }

  const [health, indexed] = await Promise.all([
    getIndexedSourceHealth(chain.id),
    fetchIndexedDiscoveryPools(chain),
  ]);

  if (mode === "indexer") {
    console.log(`[SOURCE] ${chain.id}: INDEXER_FORCED (${indexed.length} pools, status:${health.status})`);
    return {
      pools: indexed, source: "INDEXER_FORCED",
      indexedCount: indexed.length,
      indexedHealth: { status: health.status, blocksBehind: health.blocksBehind },
    };
  }

  // auto: switch to INDEXER_PRIMARY only when indexer is healthy AND has price data
  const indexerHealthy =
    health.status === "OK" &&
    (health.blocksBehind ?? 999999) <= 20 &&
    indexed.length >= MIN_INDEXED_POOLS &&
    indexed.some(p => p.priceUsd > 0);

  if (indexerHealthy) {
    console.log(
      `[SOURCE] ${chain.id}: INDEXER_PRIMARY ` +
      `(${indexed.length} pools, behind:${health.blocksBehind})`,
    );
    return {
      pools: indexed, source: "INDEXER_PRIMARY",
      indexedCount: indexed.length,
      indexedHealth: { status: health.status, blocksBehind: health.blocksBehind },
    };
  }

  const reason =
    health.status === "MISSING"  ? "indexer_missing_health" :
    health.status === "DEGRADED" ? "indexer_degraded" :
    (health.blocksBehind ?? 999999) > 20 ? "indexer_behind" :
    indexed.length < MIN_INDEXED_POOLS    ? "indexer_pool_count_low" :
    !indexed.some(p => p.priceUsd > 0)   ? "indexer_no_price_data" :
    "unknown";

  const geckoPools = await fetchDiscoveryPools(chain);
  console.log(`[SOURCE] ${chain.id}: GECKO_FALLBACK (${geckoPools.length} pools, reason:${reason})`);
  return { pools: geckoPools, source: "GECKO_FALLBACK", reason, geckoCount: geckoPools.length };
}

export async function scan(): Promise<void> {
  const ts        = new Date().toISOString();
  const scanStart = Date.now();
  cleanupActiveWatch();
  clearExpiredArmedEntries();
  pruneMemory();

  const fetchResults     = await Promise.all(CHAINS.map(c => fetchPoolsForChain(c)));
  const allPoolsPerChain = fetchResults.map(r => r.pools);

  // ── sourceByChain (Faza 6.6) ──────────────────────────────────────────────
  const sourceByChain: Record<string, PreflightSourceByChainEntry> = {};
  fetchResults.forEach((result, i) => {
    const chainId = CHAINS[i].id;
    if (result.source === "INDEXER_PRIMARY" || result.source === "INDEXER_FORCED") {
      sourceByChain[chainId] = {
        source:        result.source,
        indexedCount:  result.indexedCount,
        indexedHealth: result.indexedHealth,
        fallbackUsed:  false,
      };
    } else {
      sourceByChain[chainId] = {
        source:       result.source,
        reason:       result.reason,
        geckoCount:   result.geckoCount,
        fallbackUsed: true,
      };
    }
  });

  // ── geckoSourceHealth — actualizat doar pentru chain-uri pe Gecko (Faza 6.6) ─
  CHAINS.forEach((chain, i) => {
    const result = fetchResults[i];
    const now    = Date.now();
    const prev   = geckoSourceHealth.get(chain.id);

    if (result.source === "INDEXER_PRIMARY" || result.source === "INDEXER_FORCED") {
      // Nu actualizăm geckoHealth pentru chain-uri pe indexer — reset + marchează ca STANDBY
      geckoSourceHealth.set(chain.id, {
        lastResultCount:  0,
        emptyStreak:      0,
        consecutiveEmpty: 0,
        lastFetchAt:      prev?.lastFetchAt ?? now,
        last429At:        prev?.last429At ?? null,
        status:           "STANDBY_INDEXER_PRIMARY",
      });
      return;
    }

    const count    = result.pools.length;
    const newEmpty = count === 0 ? (prev?.consecutiveEmpty ?? prev?.emptyStreak ?? 0) + 1 : 0;

    const hit429ThisScan = !!prev?.last429At && now - prev.last429At < 60_000;

    const status: "OK" | "DEGRADED" | "RATE_LIMITED" =
      hit429ThisScan && count === 0 ? "RATE_LIMITED" :
      hit429ThisScan                ? "DEGRADED" :
      newEmpty >= 3                 ? "DEGRADED" :
      count === 0                   ? "DEGRADED" :
      "OK";

    geckoSourceHealth.set(chain.id, {
      lastResultCount:  count,
      emptyStreak:      count === 0 ? (prev?.emptyStreak ?? 0) + 1 : 0,
      consecutiveEmpty: newEmpty,
      lastFetchAt:      now,
      last429At:        prev?.last429At ?? null,
      status,
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
      if (rEmpty) await writeScannerStats(rEmpty, scanStart, 0, 0, sourceByChain, process.env.DISCOVERY_SOURCE ?? "auto").catch(() => {});
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
      await writeScannerStats(r, scanStart, allPools.length, allPools.length, sourceByChain, process.env.DISCOVERY_SOURCE ?? "auto").catch(() => {});
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
      .map(pa => ({ pairAddress: pa, liquidityUsd: poolLiquidity.get(pool.chain, pa)?.reserveUsd ?? 0 }));

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

  const wsFlowReal = getWsFlow(pool.chain, pairAddr);
  const flow       = getFlow(pool);
  const lp         = getLpSignal(pool.chain, pairAddr);
  const isV3pool   = v3PoolMap.has(pool.chain, pairAddr);
  const isV4pool   = v4PoolMap.has(pool.chain, pairAddr);
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
  mem.attentionScore = momentumEvent.attentionScore;
  mem.monitoringTier = momentumEvent.monitoringTier;
  mem.patternTags    = momentumEvent.patternTags;

  // Populare marketFollowList pentru high-attention pairs
  const att = momentumEvent.attentionScore;
  const shouldFollow =
    att >= FOLLOW_ADD_SCORE ||
    momentumEvent.monitoringTier === "EVENT_WATCH" ||
    (pool.reserveUsd >= 250_000 && (Math.abs(pool.priceChange.h1) >= 500 || Math.abs(pool.priceChange.h24) >= 1000));

 if (shouldFollow) {
    const existing = marketFollowList.get(pool.chain, pairAddr);
    marketFollowList.set(pool.chain, pairAddr, {
      chain:           pool.chain,
      addedAt:         existing?.addedAt ?? Date.now(),
      lastRefreshedAt: Date.now(),
      attentionScore:  att,
      reason:          momentumEvent.monitoringTier,
      missCount:       existing?.missCount ?? 0,
      source:          existing?.source,
    });
  } else if (marketFollowList.has(pool.chain, pairAddr) && att < FOLLOW_REMOVE_SCORE) {
    const existingFollow = marketFollowList.get(pool.chain, pairAddr);

    // Agent-supplied watches stay until FOLLOW_TTL_MS / miss eviction.
    // Preflight still reports context; it does not decide that the agent should stop watching.
    if (existingFollow?.source !== "AGENT_SUPPLIED") {
      marketFollowList.delete(pool.chain, pairAddr);
    }
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
      if (monitoringTier === "EVENT_WATCH" && !activeWatch.has(pool.chain, pairAddr)) {
        const currentEvent = [...activeWatch.entries()].filter(([{ chain }, watch]) => chain === pool.chain && watch.kind === "EVENT_WATCH").length;
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
      } else if (monitoringTier === "SHORT_WATCH" && !activeWatch.has(pool.chain, pairAddr)) {
        const currentShort = [...activeWatch.entries()].filter(([{ chain }, watch]) => chain === pool.chain && watch.kind === "SHORT_WATCH").length;
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
      if (!activeWatch.has(pool.chain, pairAddr) && hasWatchSlot(pool.chain)) {
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
      if (activeWatch.has(pool.chain, pairAddr)) {
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
      if (activeWatch.has(pool.chain, pairAddr)) {
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
  const attScore = mem.attentionScore ?? 0;
  const attTier  = mem.monitoringTier ?? "MARKET_ONLY";

    if (!activeWatch.has(pool.chain, pairAddr) && hasWatchSlot(pool.chain)) {
    if (attTier === "CONTINUATION_WATCH") {
      const currentCont = [...activeWatch.entries()].filter(([{ chain }, watch]) => chain === pool.chain && watch.kind === "CONTINUATION_WATCH").length;
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
      const currentFresh = [...activeWatch.entries()].filter(([{ chain }, watch]) => chain === pool.chain && watch.kind === "FRESH_WATCH").length;
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
    if (activeWatch.has(pool.chain, pairAddr)) {
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
    console.log(`[LOW SCORE] ${mem.symbol} (${pool.chain}) score=${score} flow=${wsFlowReal.pressure} liq=${getLiquidityContext(pool.chain, pairAddr).status}`);
    return "CONTINUE";
  }

  const gate = getEntryGate(mem, wsFlowReal, lp, score, "SCAN");
  if (!gate.allowed) {
    counters.gateCount++;
    console.log(`[SKIP] ${mem.symbol} (${pool.chain}) — ${gate.reason}`);
    if (armedEntries.has(pool.chain, pairAddr)) {
      recordDrop(pairAddr, mem.symbol, pool.chain, "ARMED", `gate failed: ${gate.reason}`, price, score);
    }
    armedEntries.delete(pool.chain, pairAddr);
    return "CONTINUE";
  }

  const armed = armedEntries.get(pool.chain, pairAddr);

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
    armedEntries.delete(pool.chain, pairAddr); counters.armFail++;
    return "CONTINUE";
  }

  if (!wsFlowReal.hasData || wsFlowReal.pressure !== "BUYING") {
    console.log(`[ARM SKIP] ${mem.symbol} (${pool.chain}) — flow faded (${wsFlowReal.pressure})`);
    recordDrop(pairAddr, mem.symbol, pool.chain, "ARMED", `flow faded: ${wsFlowReal.pressure}`, price, armed.score);
    armedEntries.delete(pool.chain, pairAddr); counters.armFail++;
    return "CONTINUE";
  }

  const currentNetVol = (wsFlowReal as any).netVol5m ?? 0;
  if (currentNetVol < 0.05) {
    console.log(`[ARM SKIP] ${mem.symbol} (${pool.chain}) — netVol faded ${currentNetVol.toFixed(3)}ETH`);
    recordDrop(pairAddr, mem.symbol, pool.chain, "ARMED", `netVol faded ${currentNetVol.toFixed(3)}ETH`, price, armed.score);
    armedEntries.delete(pool.chain, pairAddr); counters.armFail++;
    return "CONTINUE";
  }

  console.log(`[ARM CONFIRMED] ${mem.symbol} (${pool.chain}) — entering armed:${armed.price.toExponential(4)} now:${price.toExponential(4)} net:${currentNetVol.toFixed(3)}ETH`);
  armedEntries.delete(pool.chain, pairAddr);

  recordPipelineEvent("ARM_CONFIRMED", mem.symbol, pool.chain, pairAddr, "ARMED", "CONFIRMED");
  recordLifecycleOutcome(pool.chain, pairAddr, "QUALIFIED_EMITTED", "ARMED", "ARM_CONFIRMED: price + flow held");

  const liqCtx = getLiquidityContext(pool.chain, pairAddr);
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

  // Shadow trades disabled — Preflight reports signals, does not manage simulated positions.
  // Legacy counter name: shadowCount now counts qualified signals emitted this scan.
  if (!isFollowRefresh) {
    counters.shadowCount++;
    chainCounts[pool.chain] = (chainCounts[pool.chain] ?? 0) + 1;
  }

  return "CONTINUE";
}

function seedFollowListFromMemory(): void {
  let seeded = 0;

  for (const [{ chain, address: addr }, mem] of memory.entries()) {
   const followChain = chain;
   if (marketFollowList.has(followChain, addr)) continue;
    const pc = mem.priceChange;
    if (!pc) continue;
    
    const reserveUsd = poolLiquidity.get(chain, addr)?.reserveUsd ?? 0;
  
    const shouldSeed =
      (reserveUsd >= 250_000 && (Math.abs(pc.h1) >= 500 || Math.abs(pc.h24) >= 1000)) ||
      (reserveUsd >= 50_000  && (Math.abs(pc.h1) >= 200 || Math.abs(pc.h24) >= 500));
    if (!shouldSeed) continue;

    marketFollowList.set(followChain, addr, {
      chain:           followChain,
      addedAt:         Date.now(),
      lastRefreshedAt: 0,
      attentionScore:  100,
      reason:          "seeded_from_memory",
      missCount:       0,
      source:          undefined,
    });
    seeded++;
  }

  if (seeded > 0) console.log(`[FOLLOW SEED] ${seeded} pairs seeded from memory | followList:${marketFollowList.size}`);
}

export async function runDsBoostedRefresh(): Promise<void> {
  const now = Date.now();
  if (now - lastDsBoostedFetchAt < DS_BOOSTED_INTERVAL_MS) return;
  setLastDsBoostedFetchAt(now);

  const allowedChainIds = new Set(CHAINS.map(c => c.id));

  try {
    const { status, tokens: boosted } = await fetchDsBoostedTokens(allowedChainIds);

    if (status === 429) {
      dexscreenerSourceHealth.lastFetchAt     = now;
      dexscreenerSourceHealth.last429At       = now;
      dexscreenerSourceHealth.lastResultCount = 0;
      dexscreenerSourceHealth.status          = "RATE_LIMITED";
      console.log("[DS BOOSTED] rate limited");
      return;
    }

    if (!boosted.length) {
      dexscreenerSourceHealth.lastFetchAt     = now;
      dexscreenerSourceHealth.lastResultCount = 0;
      dexscreenerSourceHealth.status          = "DEGRADED";
      return;
    }

    dexscreenerSourceHealth.lastFetchAt     = now;
    dexscreenerSourceHealth.lastResultCount = boosted.length;
    dexscreenerSourceHealth.status          = "OK";

    // Keyed by plain string, not PreflightChain — item.chainId comes from
    // DexScreener's API response, external/untrusted input that can be any
    // string (including chains we don't support at all), not a value we
    // can honestly assert is one of our known chain ids.
    const chainCfgMap = new Map<string, ChainConfig>(CHAINS.map(c => [c.id, c]));
    let added = 0;

    for (const item of boosted.slice(0, DS_BOOSTED_MAX_PER_RUN)) {
      const chainCfg = chainCfgMap.get(item.chainId);
      if (!chainCfg) continue;

      let pool: SourcePool | null = null;

      if (item.pairAddress) {
        pool = await fetchDsPairByAddress(chainCfg, item.pairAddress);
      }

      if (!pool) {
        const dsPools = await fetchDsTokenPairs(chainCfg, item.tokenAddress);
        pool = dsPools.sort((a, b) => b.reserveUsd - a.reserveUsd)[0] ?? null;
      }

      if (!pool) continue;
      if (isBlockedSymbol(pool.symbol)) continue;

      const addr     = pool.pairAddress;
      const existing = marketFollowList.get(pool.chain, addr);

      marketFollowList.set(pool.chain, addr, {
        chain:           pool.chain,
        addedAt:         existing?.addedAt ?? now,
        attentionScore:  Math.max(existing?.attentionScore ?? 0, 75),
        lastRefreshedAt: 0,
        missCount:       existing?.missCount ?? 0,
        reason:          existing?.reason
          ? `${existing.reason} | DEXSCREENER_BOOSTED`.slice(0, 160)
          : "DEXSCREENER_BOOSTED",
        source:          existing?.source === "AGENT_SUPPLIED"
          ? "AGENT_SUPPLIED"
          : "DEXSCREENER_BOOSTED",
      });

      added++;
      console.log(`[DS BOOSTED] ${pool.symbol} [${pool.chain}] pair:${addr.slice(0, 12)}...`);
    }

    console.log(`[DS BOOSTED] ${added}/${boosted.length} tokens added to followList`);
  } catch (e) {
    dexscreenerSourceHealth.status = "DEGRADED";
    console.log(`[DS BOOSTED] fetch error:`, e instanceof Error ? e.message : e);
  }
}

export async function runFollowRefresh(): Promise<void> {
  if (marketFollowList.size > 0) console.log(`[FOLLOW REFRESH TICK] followList:${marketFollowList.size}`);
  const now = Date.now();

  // Seed din memory la fiecare run
  seedFollowListFromMemory();

	// ── Agent watch requests ───────────────────────────────────────────────
  try {
    const r = getRedis();
    if (r) {
      // B4e: coadă chain-scoped — fiecare worker drenează DOAR cozile chain-urilor lui
      // (CHAINS runtime). Elimină race-ul de work-stealing: un worker Base nu mai poate face
      // rpop pe requestul Arbitrum și să-l arunce prin `continue` înainte ca workerul
      // Arbitrum să-l vadă. Autoritatea chain-ului = cheia cozii, nu payload-ul (doctrina B4d-2).
      for (const { id: queueChain } of CHAINS) {
        for (let i = 0; i < 50; i++) {
          const item = await r.rpop(REDIS_KEYS.agentWatchRequests(queueChain));
          if (!item) break;
          try {
            const req      = JSON.parse(item);
            const reqAddr  = String(req.pairAddress ?? "").toLowerCase().trim();
            const isPoolId =
              /^0x[a-f0-9]{40}$/.test(reqAddr) ||
              /^0x[a-f0-9]{64}$/.test(reqAddr);
            if (!isPoolId) continue;
            // Payload mislabeled (chain ≠ coada din care a ieșit) = respins, nu redirecționat.
            if (normalizeChainId(String(req.chain ?? "")) !== queueChain) continue;
            const reqChain      = queueChain;
            const reqReason     = String(req.reason ?? "AGENT_SUPPLIED").slice(0, 160);
            const reqAt         = Number(req.requestedAt ?? now);
            const requestedAt   = Number.isFinite(reqAt) ? reqAt : now;
            const existingEntry = marketFollowList.get(reqChain, reqAddr);
            marketFollowList.set(reqChain, reqAddr, {
              chain:           reqChain,
              addedAt:         existingEntry?.addedAt ?? requestedAt,
              attentionScore:  Math.max(existingEntry?.attentionScore ?? 0, 80),
              lastRefreshedAt: existingEntry?.lastRefreshedAt ?? 0,
              missCount:       existingEntry?.missCount ?? 0,
              reason:          existingEntry?.reason
                ? `${existingEntry.reason} | ${reqReason}`.slice(0, 160)
                : reqReason,
              source: "AGENT_SUPPLIED",
            });
            console.log(`[AGENT WATCH] queued: ${reqChain}:${reqAddr.slice(0, 12)}... reason:${reqReason}`);
          } catch { /* ignore malformed */ }
        }
      }
    }
  } catch (e) {
    console.log(`[AGENT WATCH] Redis read error:`, e instanceof Error ? e.message : e);
  }

  // Curăță entries expirate
  for (const [{ chain, address: addr }, entry] of marketFollowList.entries()) {
    if (now - entry.addedAt > FOLLOW_TTL_MS) {
      marketFollowList.delete(chain, addr);
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

  for (const [{ chain, address: addr }, entry] of toRefresh) {
    const chainCfg = CHAINS.find(c => c.id === chain);
    if (!chainCfg) continue;

    try {
      let pool = await fetchPoolByAddress(chainCfg, addr);

      // Fallback: DexScreener dacă Gecko direct fetch eșuează
      if (!pool) {
        pool = await fetchDsPairByAddress(chainCfg, addr);
        if (pool) {
          console.log(`[FOLLOW DS FALLBACK] ${chain}:${addr.slice(0, 12)}... — Gecko miss, DexScreener hit`);
        }
      }

      if (!pool) {
        const missCount = (entry.missCount ?? 0) + 1;
        if (missCount >= FOLLOW_MAX_MISSES) {
          marketFollowList.delete(chain, addr);
          console.log(`[FOLLOW EVICT] ${chain}:${addr.slice(0, 12)}... — ${missCount} consecutive misses`);
        } else {
          marketFollowList.set(chain, addr, { ...entry, lastRefreshedAt: now, missCount });
        }
        continue;
      }

      const discoverySource = entry.source ?? "MARKET_FOLLOW_LIST";

      await processPool(
        { ...pool, discoverySource },
        counters,
        chainCounts,
        { source: "follow_refresh" },
      );

      // nu suprascrie attentionScore nou cu entry vechi
      const updated = marketFollowList.get(chain, addr);
      if (updated) {
        marketFollowList.set(chain, addr, { ...updated, lastRefreshedAt: now, missCount: 0 });
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
