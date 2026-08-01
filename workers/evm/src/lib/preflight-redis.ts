/**
 * worker/lib/preflight-redis.ts
 * Preflight Scanner v5.32
 *
 * Scrie preflight:* keys în Redis în paralel cu supreme:*
 * MCP-ul citește preflight:* first, fallback supreme:*
 *
 * Schema (chei per-chain, sufix :${chain}):
 * - preflight:signal_pipeline:${chain}
 * - preflight:momentum_events:${chain}
 * - preflight:qualified_signals:${chain}
 * - preflight:recent_drops:${chain}
 * (market_context/market_regime NU se mai scriu aici — MCP le derivă la read-time; B4d-2.)
 */

import type { Redis } from "ioredis";
import {
  buildWorkerObservation,
  type ObservationContext,
  type MomentumLevel,
  type FlowStatus,
  type LiquidityStatus,
  type EntryRisk,
  type MoveType,
  type PipelineState,
  type Confidence,
} from "./observation";
import type { MomentumEvent } from "../risk/momentum";
import { partitionArrayByChain } from "./redisArrays";
import {
  REDIS_KEYS, SCHEMA_VERSION,
  type PreflightDrop, type PreflightEvmChain,
  type PreflightMomentumEvent, type PreflightSignalPipelineEntry, type PreflightQualifiedSignal,
  type DexType,
} from "@preflight/schema";

// Previously a local "preflight-scanner-v1" constant here, distinct from
// the package's own SCHEMA_VERSION ("preflight-schema-v1") — every
// schemaVersion field written to Redis was tagged with the wrong contract
// version. Nothing downstream reads/validates this field today, so it
// wasn't causing bugs, but it made the field meaningless. Now sourced from
// the actual shared contract.
const MAX_EVENTS     = 50;
const MAX_DROPS      = 50;
const MAX_PIPELINE   = 50;
const MAX_QUALIFIED  = 20;

// ── Types ─────────────────────────────────────────────────────────────────────
// PreflightMomentumEvent, PreflightSignalPipelineEntry, PreflightQualifiedSignal
// used to be defined locally here (chain: string instead of PreflightChain,
// verdict/dexType widened to string instead of MomentumVerdict/DexType). Now
// imported from @preflight/schema — same reasoning as PreflightDrop below.

// PreflightDrop used to be defined locally here, drifted from the shared
// package's version (missing priceAtDrop/scoreAtDrop, chain: string instead
// of PreflightChain — see @preflight/schema). Now imported directly so
// there's exactly one definition instead of two that can silently diverge.

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveFlowStatus(pressure: string, hasData: boolean, buys5m: number, sells5m: number): FlowStatus {
  if (!hasData) return "NO_DATA";
  if (pressure === "BUYING" && sells5m === 0 && buys5m > 3) return "ONE_SIDED";
  if (pressure === "BUYING" && buys5m > 10) return "STRONG";
  if (pressure === "BUYING") return "BUYING";
  if (pressure === "SELLING") return "WEAK";
  return "WEAK";
}

function deriveLiquidityStatus(reserveUsd: number, liqStatus: string): LiquidityStatus {
  if (reserveUsd < 15_000)                       return "THIN";
  if (reserveUsd > 500_000)                      return "DEEP";
  if (liqStatus === "CONFIRMED" || reserveUsd > 100_000) return "CONFIRMED";
  return "OK";
}

function deriveConfidence(buys5m: number, sells5m: number, hasData: boolean, ageMs: number): Confidence {
  if (!hasData || buys5m < 3) return "LOW";
  if (buys5m > 15 && sells5m < buys5m * 0.3 && ageMs > 45_000) return "HIGH";
  return "MEDIUM";
}

function deriveRiskFlags(
  poolCountSameToken: number,
  liqStatus: string,
  reserveUsd: number,
  consecutiveLosses: number,
  badExits24h: number,
  wins24h: number,
  sellRatio: number,
  lpStatus: string,
  buys5m?:     number,
  sells5m?:    number,
): string[] {
  const flags: string[] = [];
  if (poolCountSameToken >= 3)                        flags.push("CLONE_FRAGMENTATION");
  if (reserveUsd < 15_000)                            flags.push("THIN_LIQUIDITY");
  if (consecutiveLosses >= 3)                         flags.push("BAD_HISTORY");
  if (badExits24h >= 2 && wins24h === 0)              flags.push("BAD_HISTORY");
  if (sellRatio > 0.5 && sellRatio < 1)               flags.push("DISTRIBUTION_RISK");
  const totalSwaps   = (buys5m ?? 0) + (sells5m ?? 0);
  const oneSidedFlow = totalSwaps >= 3 && ((buys5m ?? 0) === 0 || (sells5m ?? 0) === 0);
  if (oneSidedFlow && liqStatus === "CONFIRMED") flags.push("ONE_SIDED_FLOW");
  if (lpStatus === "REMOVED")                         flags.push("LP_RISK");
  return flags;
}

function deriveOpportunitySignals(
  phase: string,
  moveType: MoveType,
  isSecondWave: boolean,
  isNewPool: boolean,
): string[] {
  const signals: string[] = [];
  if (isSecondWave)                                     signals.push("SECOND_WAVE");
  if (isNewPool)                                        signals.push("NEW_POOL_EXPANSION");
  if (phase === "TRENDING" && moveType === "ORGANIC")   signals.push("MOMENTUM");
  if (phase === "RECOVERING")                           signals.push("RECOVERY");
  return signals;
}

export interface PreflightPairContext {
  schemaVersion:      string;
  workerVersion:      string;
  symbol:             string;
  // EVM-only: produs exclusiv de worker-evm. Tip îngust ca să nu scape "eth"/
  // "solana"/necanonic în JSON-ul contextului (cheia e chain-scoped oricum).
  chain:              PreflightEvmChain;
  pairAddress:        string;
  pipelineState:      PipelineState;
  phase:              string;
  liquidityStatus:    LiquidityStatus;
  reserveUsd:         number;
  flow: {
    status:   FlowStatus;
    buyVol5m: number;
    netVol5m: number;
    buys5m:   number;
    sells5m:  number;
    hasData:  boolean;
  };
  entryRisk:          EntryRisk;
  riskFlags:          string[];
  opportunitySignals: string[];
  workerObservation:  string;
  updatedAt:          number;
  lifecycle?: {
    lastOutcome:   string;
    lastOutcomeAt: number;
    ageSec:        number;
    fromState:     string;
    reason:        string;
  } | null;
}

// ── Main write function ───────────────────────────────────────────────────────

export interface PreflightWriteInput {
  workerVersion:    string;
  now:              number;

  momentumEventsBuffer: PreflightMomentumEvent[];

  // Signal pipeline (activeWatch + hotCandidates)
  signalPipeline:   PreflightSignalPipelineEntry[];

  // Qualified signals (armedEntries)
  qualifiedSignals: PreflightQualifiedSignal[];

  // Recent drops
  recentDrops:      PreflightDrop[];

  // Per-pair context map
  pairContextMap:   Record<string, PreflightPairContext>;

  // E24: TTL (sec) pentru snapshot-urile rescrise la FIECARE scan (signal_pipeline / qualified_signals /
  // pair_context). Trebuie ≥ 2× intervalul de scan (vezi snapshotTtl.ts) ca să nu flap-uie în DEV.
  // momentum_events / recent_drops au TTL propriu, intenționat mai lung (600).
  ttlSec:           number;
}

export async function writePreflightRedis(r: Redis, input: PreflightWriteInput): Promise<void> {
  const {
    now,
    momentumEventsBuffer, signalPipeline, qualifiedSignals, recentDrops, ttlSec,
  } = input;

  const recent10m = (ts: number) => now - ts < 10 * 60_000;

  const pipeline = r.pipeline();

  // B4d-2: market_context NU se mai scrie aici — MCP-ul îl derivă la read-time din
  // pair_states-urile per-chain (vezi redis-reader.ts). Workerul publică doar heartbeat-ul
  // WS per-chain (worker_runtime, în snapshots.ts).

  // ── preflight:momentum_events ────────────────────────────────────────────
  // B4b: limita per-chain (MAX_EVENTS în helper, după partiție) → fiecare chain
  // deținut își păstrează propriile top-N, fără înfometare cross-chain.
  const recentMomentum = momentumEventsBuffer.filter(e => recent10m(e.detectedAt));
  for (const { key, value } of partitionArrayByChain(REDIS_KEYS.momentumEvents, recentMomentum, MAX_EVENTS)) pipeline.set(key, value, "EX", 600);

  // ── preflight:signal_pipeline ────────────────────────────────────────────
  // E24: TTL derivat (≥ 2× scanInterval), NU 120 hardcodat — se rescrie la fiecare scan.
  for (const { key, value } of partitionArrayByChain(REDIS_KEYS.signalPipeline, signalPipeline, MAX_PIPELINE)) pipeline.set(key, value, "EX", ttlSec);

  // ── preflight:qualified_signals ──────────────────────────────────────────
  for (const { key, value } of partitionArrayByChain(REDIS_KEYS.qualifiedSignals, qualifiedSignals, MAX_QUALIFIED)) pipeline.set(key, value, "EX", ttlSec);

  // ── preflight:recent_drops ───────────────────────────────────────────────
  for (const { key, value } of partitionArrayByChain(REDIS_KEYS.recentDrops, recentDrops.filter(d => recent10m(d.droppedAt)), MAX_DROPS)) pipeline.set(key, value, "EX", 600);

  // ── preflight:pair_context ───────────────────────────────────────────────
  const pairContexts = Object.values(input.pairContextMap);
  if (pairContexts.length > 0) {
    for (const ctx of pairContexts) {
      // Faza B2/B3: cheia derivă din DATELE contextului (ctx.chain + ctx.pairAddress),
      // NU din cheia internă a mapului. În B3 cheia mapului devine deja `${chain}:${addr}`,
      // iar `pairContext(ctx.chain, mapKey)` ar produce `pair_context:base:base:0xabc`.
      pipeline.set(REDIS_KEYS.pairContext(ctx.chain, ctx.pairAddress), JSON.stringify(ctx), "EX", ttlSec);
    }
  }

  await pipeline.exec();
}

// ── Builder helpers pentru index.ts ──────────────────────────────────────────

export function buildMomentumEventEntry(
  event: MomentumEvent,
  symbol: string,
  chain: string,
  pairAddress: string,
  dexType: DexType,
  flowHasData: boolean,
  flowBuyVol5m: number,
  flowNetVol5m: number,
  flowBuys5m: number,
  flowSells5m: number,
  workerVersion: string,
): PreflightMomentumEvent {
  const flowStatus = event.hasWsFlow
    ? deriveFlowStatus("BUYING", flowHasData, flowBuys5m, flowSells5m)
    : "NO_DATA";

  const obsCtx: ObservationContext = {
    moveType:          event.moveType,
    momentumLevel:     event.momentumLevel,
    flowStatus,
    liquidityStatus:   deriveLiquidityStatus(event.reserveUsd, ""),
    entryRisk:         event.entryRisk,
    riskFlags:         event.riskFlags,
    opportunitySignals: [],
    pipelineState:     "WATCHING",
    confidence:        event.hasWsFlow ? "MEDIUM" : "LOW",
    m5Pct:             event.m5Pct,
    h24Pct:            event.h24Pct,
    // E34: counts reale buy/sell pt. mesajul one-sided — sells5m vine REAL din wsFlowReal (scan.ts), NU hardcodat
    // 0 (altfel 5 buy / 2 sell ar raporta fals „buying-only"). Aceeași valoare merge și în deriveFlowStatus.
    flowCounts:        { buys5m: flowBuys5m, sells5m: flowSells5m },
  };

  return {
    schemaVersion:    SCHEMA_VERSION,
    workerVersion,
    symbol, chain: chain as PreflightEvmChain, pairAddress,
    detectedAt:       Date.now(),
    verdict:          event.verdict,
    moveType:         event.moveType,
    momentumLevel:    event.momentumLevel,
    entryRisk:        event.entryRisk,
    reason:           event.reason,
    m5Pct:            event.m5Pct,
    h1Pct:            event.h1Pct,
    h24Pct:           event.h24Pct,
    reserveUsd:       event.reserveUsd,
    dexType,
    flow: {
      hasData:  flowHasData,
      status:   flowStatus,
      buyVol5m: flowBuyVol5m,
      netVol5m: flowNetVol5m,
      buys5m:   flowBuys5m,
    },
    riskFlags:         event.riskFlags,
    pipelineState:     "WATCHING",
    workerObservation: buildWorkerObservation(obsCtx),
  };
}

export function buildSignalPipelineEntry(params: {
  symbol:             string;
  chain:              string;
  pairAddress:        string;
  pipelineState:      PipelineState;
  watchKind:          string;
  enteredWatchAt:     number;
  now:                number;
  flow: {
    pressure:     string;
    hasData:      boolean;
    buyVol5m:     number;
    netVol5m:     number;
    buys5m:       number;
    sells5m:      number;
    buyVol5mUsd:  number | null;
    sellVol5mUsd: number | null;
    netVol5mUsd:  number | null;
  };
  reserveUsd:         number;
  liqStatus:          string;
  poolCountSameToken: number;
  consecutiveLosses:  number;
  badExits24h:        number;
  wins24h:            number;
  phase:              string;
  priceVsEntryPct:    number | null;
  workerVersion:      string;
}): PreflightSignalPipelineEntry {
  const {
    symbol, chain, pairAddress, pipelineState, watchKind,
    enteredWatchAt, now, flow, reserveUsd, liqStatus,
    poolCountSameToken, consecutiveLosses, badExits24h, wins24h,
    phase, priceVsEntryPct, workerVersion,
  } = params;

  const flowStatus  = deriveFlowStatus(flow.pressure, flow.hasData, flow.buys5m, flow.sells5m);
  const liqStatus2  = deriveLiquidityStatus(reserveUsd, liqStatus);
  const confidence  = deriveConfidence(flow.buys5m, flow.sells5m, flow.hasData, now - enteredWatchAt);
  const sellRatio   = (flow.buyVol5m + (flow.buyVol5m - flow.netVol5m)) > 0
    ? (flow.buyVol5m - flow.netVol5m) / (flow.buyVol5m + (flow.buyVol5m - flow.netVol5m))
    : 0;
  const riskFlags = deriveRiskFlags(poolCountSameToken, liqStatus, reserveUsd, consecutiveLosses, badExits24h, wins24h, sellRatio, "", flow.buys5m, flow.sells5m);
  const opSignals   = deriveOpportunitySignals(phase, "ORGANIC", false, false);
  const entryRisk: EntryRisk = riskFlags.includes("BAD_HISTORY") ? "HIGH" : confidence === "HIGH" ? "MEDIUM" : "MEDIUM";

  const obsCtx: ObservationContext = {
    moveType:          "ORGANIC",
    momentumLevel:     "MEDIUM",
    flowStatus,
    liquidityStatus:   liqStatus2,
    entryRisk,
    riskFlags,
    opportunitySignals: opSignals,
    pipelineState,
    confidence,
    priceVsEntryPct,
    // E34: counts reale buy/sell pt. mesajul one-sided (tipizat, nu mai `(ctx as any).flow`).
    flowCounts:         { buys5m: flow.buys5m, sells5m: flow.sells5m },
  };

  return {
    schemaVersion:     SCHEMA_VERSION,
    workerVersion,
    symbol, chain: chain as PreflightEvmChain, pairAddress,
    pipelineState,
    watchKind,
    enteredWatchAt,
    watchAgeMs:        now - enteredWatchAt,
    confidence,
    entryRisk,
    flow: {
      status:   flowStatus,
      buyVol5m: flow.buyVol5m,
      netVol5m: flow.netVol5m,
      buys5m:   flow.buys5m,
      sells5m:  flow.sells5m,
    },
    riskFlags,
    opportunitySignals: opSignals,
    priceVsEntryPct,
    workerObservation:  buildWorkerObservation(obsCtx),
    updatedAt:          now,
  };
}

export function buildQualifiedSignalEntry(params: {
  symbol:         string;
  chain:          string;
  pairAddress:    string;
  qualifiedAt:    number;
  flow: {
    pressure: string;
    hasData:  boolean;
    buyVol5m: number;
    netVol5m: number;
    buys5m:   number;
    sells5m:  number;
  };
  reserveUsd:     number;
  liqStatus:      string;
  riskFlags:      string[];
  phase:          string;
  workerVersion:  string;
}): PreflightQualifiedSignal {
  const { symbol, chain, pairAddress, qualifiedAt, flow, reserveUsd, liqStatus, riskFlags, phase, workerVersion } = params;

  const flowStatus = deriveFlowStatus(flow.pressure, flow.hasData, flow.buys5m, flow.sells5m);
  const confidence = deriveConfidence(flow.buys5m, flow.sells5m, flow.hasData, 60_000);
  const opSignals  = deriveOpportunitySignals(phase, "ORGANIC", false, false);
  const entryRisk: EntryRisk = riskFlags.includes("BAD_HISTORY") ? "HIGH" : "MEDIUM";

  const obsCtx: ObservationContext = {
    moveType:          "ORGANIC",
    momentumLevel:     "HIGH",
    flowStatus,
    liquidityStatus:   deriveLiquidityStatus(reserveUsd, liqStatus),
    entryRisk,
    riskFlags,
    opportunitySignals: opSignals,
    pipelineState:     "QUALIFIED",
    confidence,
    // E34: counts reale buy/sell pt. mesajul one-sided (tipizat, nu mai `(ctx as any).flow`).
    flowCounts:        { buys5m: flow.buys5m, sells5m: flow.sells5m },
  };

  return {
    schemaVersion:     SCHEMA_VERSION,
    workerVersion,
    symbol, chain: chain as PreflightEvmChain, pairAddress, qualifiedAt,
    confidence,
    entryRisk,
    flow: {
      status:   flowStatus,
      buyVol5m: flow.buyVol5m,
      netVol5m: flow.netVol5m,
      buys5m:   flow.buys5m,
    },
    riskFlags,
    opportunitySignals: opSignals,
    workerObservation:  buildWorkerObservation(obsCtx),
  };
}

export {
  deriveFlowStatus,
  deriveLiquidityStatus,
  deriveConfidence,
  deriveRiskFlags,
  deriveOpportunitySignals,
};