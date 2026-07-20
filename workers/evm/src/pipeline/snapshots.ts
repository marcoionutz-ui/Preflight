/**
 * pipeline/snapshots.ts
 * Scrie toate Redis snapshot-urile: supreme:*, preflight:* și preflight:trending:*
 * Extras din scan.ts pentru separare clară.
 */

import type { Redis } from "ioredis";
import {
  activeWatch, hotCandidates, memory, wsFlow,
  momentumEventsBuffer, qualifiedSignalsBuffer, recentDrops,
} from "../state/stores";
import { buildPairStates, buildWatchSnapshot, buildHotSnapshot, buildArmedSnapshot } from "../state/pairStates";
import { deriveMarketContext, writeMarketRegime, writeDropsAndEvents } from "./marketContext";
import { getWsFlow } from "../risk/flow";
import { getLiquidityContext } from "../risk/liquidity";
import {
  buildSignalPipelineEntry, buildQualifiedSignalEntry, writePreflightRedis,
  deriveFlowStatus, deriveLiquidityStatus, deriveRiskFlags,
} from "../lib/preflight-redis";
import type { PreflightPairContext } from "../lib/preflight-redis";
import { buildWorkerObservation, type ObservationContext } from "../lib/observation";
import { tokenPools, tokenPoolKey } from "../infra/poolTracker";
import { WORKER_VERSION } from "../config/constants";
import { getLifecycle, getRecentLifecycles } from "../state/lifecycle";
import { CHAINS } from "../config/chains";
import { partitionArrayByChain } from "../lib/redisArrays";
import { writeCoverageSnapshot } from "./coverageSnapshot";
import { writeTrendingSnapshots } from "../trending/trendingSnapshots";
import { calculateMovers } from "../trending/trendingMovers";
import { REDIS_KEYS, SCHEMA_VERSION, pairKey, splitPairKey, type PreflightDrop, type PreflightEvmChain } from "@preflight/schema";

export async function writeAllSnapshots(r: Redis): Promise<void> {
  // ── pair_states / active_watch / hot / armed — B4: chei per-chain ─────────
  // Blob-urile sunt keyed pe pairKey (B3) → partiționăm pe chain-ul din cheie și
  // scriem o cheie per-chain (EX 120). Un worker per-chain va scrie doar cheia lui;
  // MCP agregă. Scriem și {} pt. chain-urile din CHAINS fără pairs (semnal liveness).
  const states = await buildPairStates();
  await writeSnapshotByChain(r, REDIS_KEYS.pairStates, states, 120);
  console.log(`[REDIS] Wrote ${Object.keys(states).length} pair states (per-chain)`);

  await writeSnapshotByChain(r, REDIS_KEYS.activeWatch,   buildWatchSnapshot(), 120);
  await writeSnapshotByChain(r, REDIS_KEYS.hotCandidates, buildHotSnapshot(),   120);
  await writeSnapshotByChain(r, REDIS_KEYS.armedEntries,  buildArmedSnapshot(), 120);

  // ── market context + drops ────────────────────────────────────────────────
  const ctx = deriveMarketContext(states);
  await writeMarketRegime(r, ctx);
  await writeDropsAndEvents(r);

  // ── preflight:* writes ─────────────────────────────────────────────────────
  try {
    const signalPipeline = buildSignalPipelineEntries();
    const preflightDrops = buildPreflightDrops();
    const pairContextMap = buildPairContextMap();

    await writePreflightRedis(r, {
      workerVersion:    WORKER_VERSION,
      now:              Date.now(),
      regime:           ctx.regime,
      buyingPctAll:     ctx.buyingPctAll,
      sellingPctAll:    ctx.sellingPctAll,
      flowCoveragePct:  ctx.flowCoveragePct,
      pairContextMap,
      trackedPairs:     ctx.total,
      chainsActive:     CHAINS.map(c => c.id),
      momentumEventsBuffer,
      signalPipeline,
      qualifiedSignals: qualifiedSignalsBuffer,
      recentDrops:      preflightDrops,
    });
  } catch (e) {
    console.error("[PREFLIGHT REDIS] Write failed:", e instanceof Error ? e.message : e);
  }

// ── preflight:lifecycle ───────────────────────────────────────────────────
  try {
    // B4b: lifecycle chain-scoped → o cheie per-chain (fiecare entry are `.chain`).
    const lifePipe = r.pipeline();
    for (const { key, value } of partitionArrayByChain(REDIS_KEYS.lifecycle, getRecentLifecycles())) lifePipe.set(key, value, "EX", 600);
    await lifePipe.exec();
  } catch (e) {
    console.error("[LIFECYCLE] Write failed:", e instanceof Error ? e.message : e);
  }

// ── preflight:pipeline_coverage ───────────────────────────────────────────
  try {
    await writeCoverageSnapshot(r, states);
  } catch (e) {
    console.error("[COVERAGE] Write failed:", e instanceof Error ? e.message : e);
  }

  // ── 6.10: preflight:trending:snapshot:{chain}:{pair} ──────────────────────
  try {
    await writeTrendingSnapshots(r, states);
  } catch (e) {
    console.error("[TRENDING] Write failed:", e instanceof Error ? e.message : e);
  }

  // ── 6.10: preflight:trending:movers:{chain} ────────────────────────────────
  try {
    await calculateMovers(r, states);
  } catch (e) {
    console.error("[TRENDING] Movers failed:", e instanceof Error ? e.message : e);
  }
}

// B4: partiționează un blob {pairKey: value} pe chain (din cheia decodată) și
// scrie o cheie per-chain cu EX ttlSec. Inițializăm cu toate CHAINS ca să scriem
// {} pt. chain-urile fără pairs (cheia există → worker viu pe acel chain; expiră
// singură dacă worker-ul acelui chain moare).
async function writeSnapshotByChain(
  r: Redis,
  keyFn: (chain: string) => string,
  obj: Record<string, unknown>,
  ttlSec: number,
): Promise<void> {
  const byChain: Record<string, Record<string, unknown>> = {};
  for (const c of CHAINS) byChain[c.id] = {};
  for (const [key, val] of Object.entries(obj)) {
    const chain = splitPairKey(key).chain;
    if (!chain || !(chain in byChain)) continue; // fără `:` sau chain din afara runtime-ului → NU-l adoptăm
    byChain[chain][key] = val;
  }
  const pipe = r.pipeline();
  for (const [chain, subset] of Object.entries(byChain)) {
    pipe.set(keyFn(chain), JSON.stringify(subset), "EX", ttlSec);
  }
  await pipe.exec();
}

function buildSignalPipelineEntries() {
  const makeEntry = (addr: string, chain: string, pipelineState: string, watchKind: string, enteredAt: number, entryPrice?: number) => {
    const mem2       = memory.get(chain, addr);
    const flow2      = getWsFlow(chain, addr);
    const events2    = wsFlow.get(chain, addr) ?? [];
    const buys2      = events2.filter(e => e.isBuy);
    const sells2     = events2.filter(e => !e.isBuy);
    const liq2       = getLiquidityContext(chain, addr);
    const poolCount2 = (() => {
      const cp = mem2?.chain ?? "";
      return mem2 ? tokenPools.get(tokenPoolKey(cp, mem2.tokenAddress))?.size ?? 1 : 1;
    })();
    return buildSignalPipelineEntry({
      symbol:             mem2?.symbol ?? addr.slice(0, 8),
      chain,
      pairAddress:        addr,
      pipelineState:      pipelineState as any,
      watchKind,
      enteredWatchAt:     enteredAt,
      now:                Date.now(),
      flow: {
        pressure:     flow2.pressure, hasData: flow2.hasData,
        buyVol5m:     (flow2 as any).buyVol5m     ?? 0,
        netVol5m:     (flow2 as any).netVol5m     ?? 0,
        buys5m:       buys2.length, sells5m: sells2.length,
        buyVol5mUsd:  (flow2 as any).buyVol5mUsd  ?? null,
        sellVol5mUsd: (flow2 as any).sellVol5mUsd ?? null,
        netVol5mUsd:  (flow2 as any).netVol5mUsd  ?? null,
      },
      reserveUsd:         liq2.reserveUsd,
      liqStatus:          liq2.status,
      poolCountSameToken: poolCount2,
      consecutiveLosses:  (mem2 as any)?.consecutiveLosses ?? 0,
      badExits24h:        (mem2 as any)?.badExits24h ?? 0,
      wins24h:            (mem2 as any)?.wins24h ?? 0,
      phase:              mem2?.phase ?? "UNKNOWN",
      priceVsEntryPct:    (entryPrice && mem2?.currentPrice)
        ? Number(((mem2.currentPrice - entryPrice) / entryPrice * 100).toFixed(2)) : null,
      workerVersion:      WORKER_VERSION,
    });
  };

  return [
    ...[...activeWatch.entries()].map(([{ chain, address: addr }, info]) =>
      makeEntry(addr, chain, hotCandidates.has(chain, addr) ? "HOT" : "WATCHING", info.kind ?? "NORMAL", info.addedAt, info.entryPrice)
    ),
    ...[...hotCandidates.entries()]
      .filter(([{ chain, address: addr }]) => !activeWatch.has(chain, addr))
      .map(([{ chain, address: addr }, info]) =>
        makeEntry(addr, chain, "HOT", info.source ?? "NORMAL", info.promotedAt)
      ),
  ];
}

// d.chain is plain string internally (state/stores.ts value types use
// `chain: string`, not PreflightEvmChain). De la B3c, dropHotCandidate()/
// dropWatchCandidate() cer chain OBLIGATORIU, deci nu mai produc literalul
// "unknown" — PreflightDrop.chain e mereu un chain real. Guardul rămâne ca
// plasă defensivă pură (narrowing string → PreflightEvmChain), nu ca `as`-lie.
function isEvmChain(value: string): value is PreflightEvmChain {
  return value === "base" || value === "arbitrum" || value === "ethereum" || value === "bsc";
}

function buildPreflightDrops(): PreflightDrop[] {
  return recentDrops
    .filter(d => Date.now() - d.droppedAt < 10 * 60_000)
    .flatMap((d): PreflightDrop[] => {
      if (!isEvmChain(d.chain)) {
        console.warn(`[DROP SKIP] invalid/missing EVM chain for ${d.pairAddress}: ${d.chain}`);
        return [];
      }

      const dropFlow = getWsFlow(d.chain, d.pairAddress);
      const wasIn =
        d.previousState === "HOT"   ? "HOT"   as const :
        d.previousState === "ARMED" ? "ARMED" as const :
        "WATCHING" as const;
      return [{
        schemaVersion: SCHEMA_VERSION,
        workerVersion: WORKER_VERSION,
        symbol: d.symbol, chain: d.chain, pairAddress: d.pairAddress,
        droppedAt: d.droppedAt, wasIn, dropReason: d.reason,
        timeInPipelineMs: 0,
        priceAtDrop: d.priceAtDrop ?? null,
        scoreAtDrop: d.scoreAtDrop ?? null,
        flowAtDrop: {
          status:  dropFlow.hasData && dropFlow.pressure === "BUYING" ? "BUYING" as const : "WEAK" as const,
          buys5m:  dropFlow.buys5m ?? 0,
          sells5m: dropFlow.sells5m ?? 0,
        },
      }];
    });
}

function buildPairContextMap(): Record<string, PreflightPairContext> {
  const pairContextMap: Record<string, PreflightPairContext> = {};

  const buildCtx = (addr: string, chain: PreflightEvmChain, pipelineState: "WATCHING" | "HOT", entryPrice?: number): PreflightPairContext => {
    const mem3    = memory.get(chain, addr);
    const flow3   = getWsFlow(chain, addr);
    const liq3    = getLiquidityContext(chain, addr);
    const events3 = wsFlow.get(chain, addr) ?? [];
    const buys3   = events3.filter(e => e.isBuy);
    const sells3  = events3.filter(e => !e.isBuy);
    const fs3     = deriveFlowStatus(flow3.pressure, flow3.hasData, buys3.length, sells3.length);
    const ls3     = deriveLiquidityStatus(liq3.reserveUsd, liq3.status);
    const rf3     = deriveRiskFlags(
      (() => { const cp = mem3?.chain ?? ""; return mem3 ? tokenPools.get(tokenPoolKey(cp, mem3.tokenAddress))?.size ?? 1 : 1; })(),
      liq3.status, liq3.reserveUsd,
      (mem3 as any)?.consecutiveLosses ?? 0,
      (mem3 as any)?.badExits24h ?? 0,
      (mem3 as any)?.wins24h ?? 0,
      0, "",
      buys3.length, sells3.length,
    );
    const obsCtx3: ObservationContext = {
      moveType: "ORGANIC", momentumLevel: "MEDIUM",
      flowStatus: fs3, liquidityStatus: ls3,
      entryRisk: rf3.includes("BAD_HISTORY") ? "HIGH" : "MEDIUM",
      riskFlags: rf3, opportunitySignals: [], pipelineState, confidence: "MEDIUM",
      priceVsEntryPct: (entryPrice && mem3?.currentPrice)
        ? Number(((mem3.currentPrice - entryPrice) / entryPrice * 100).toFixed(2)) : null,
    };
    const lifecycle = getLifecycle(chain, addr);

    return {
      schemaVersion: SCHEMA_VERSION, workerVersion: WORKER_VERSION,
      symbol: mem3?.symbol ?? addr.slice(0, 8), chain, pairAddress: addr, pipelineState,
      phase: mem3?.phase ?? "UNKNOWN", liquidityStatus: ls3, reserveUsd: liq3.reserveUsd,
      flow: {
        status: fs3,
        buyVol5m:  (flow3 as any).buyVol5m ?? 0,
        netVol5m:  (flow3 as any).netVol5m ?? 0,
        buys5m:    buys3.length, sells5m: sells3.length,
        hasData:   flow3.hasData,
      },
      entryRisk: rf3.includes("BAD_HISTORY") ? "HIGH" : "MEDIUM",
      riskFlags: rf3, opportunitySignals: [],
      workerObservation: buildWorkerObservation(obsCtx3),
      updatedAt: Date.now(),
      lifecycle: lifecycle ? {
        lastOutcome:   lifecycle.lastOutcome,
        lastOutcomeAt: lifecycle.lastOutcomeAt,
        ageSec:        Math.round((Date.now() - lifecycle.lastOutcomeAt) / 1000),
        fromState:     lifecycle.fromState,
        reason:        lifecycle.reason,
      } : null,
    };
  };

  // Guard isEvmChain narrows info.chain (string în stores.ts) la PreflightEvmChain.
  // La runtime chain-ul de aici e mereu un chain EVM real (fallback-ul "unknown"
  // e doar pe căile de drop → PreflightDrop, nu pe watch/hot); guardul e puntea
  // de tip + o plasă defensivă (skip contexte fără chain valid).
  for (const [{ chain, address: addr }, info] of activeWatch.entries()) {
    if (!isEvmChain(chain)) continue;
    const key = pairKey(chain, addr);
    pairContextMap[key] = buildCtx(addr, chain, hotCandidates.has(chain, addr) ? "HOT" : "WATCHING", info.entryPrice);
  }
  for (const [{ chain, address: addr }] of hotCandidates.entries()) {
    if (!isEvmChain(chain)) continue;
    const key = pairKey(chain, addr);
    if (!pairContextMap[key]) {
      pairContextMap[key] = buildCtx(addr, chain, "HOT");
    }
  }

  return pairContextMap;
}
