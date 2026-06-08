/**
 * worker/lib/preflight-redis.ts
 * Preflight Scanner v5.32
 *
 * Scrie preflight:* keys în Redis în paralel cu supreme:*
 * MCP-ul citește preflight:* first, fallback supreme:*
 *
 * Schema nouă:
 * - preflight:market_context
 * - preflight:signal_pipeline
 * - preflight:momentum_events
 * - preflight:qualified_signals
 * - preflight:recent_drops
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
import type { MomentumEvent, MomentumVerdict } from "./momentum";

const SCHEMA_VERSION = "preflight-scanner-v1";
const MAX_EVENTS     = 50;
const MAX_DROPS      = 50;
const MAX_PIPELINE   = 50;
const MAX_QUALIFIED  = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PreflightMomentumEvent {
  schemaVersion:    string;
  workerVersion:    string;
  symbol:           string;
  chain:            string;
  pairAddress:      string;
  detectedAt:       number;
  verdict:          MomentumVerdict;
  moveType:         MoveType;
  momentumLevel:    MomentumLevel;
  entryRisk:        EntryRisk;
  reason:           string;
  m5Pct:            number;
  h1Pct:            number;
  h24Pct:           number;
  reserveUsd:       number;
  dexType:          string;
  flow: {
    hasData:  boolean;
    status:   FlowStatus;
    buyVol5m: number;
    netVol5m: number;
    buys5m:   number;
  };
  riskFlags:          string[];
  pipelineState:      PipelineState;
  workerObservation:  string;
}

export interface PreflightSignalPipelineEntry {
  schemaVersion:     string;
  workerVersion:     string;
  symbol:            string;
  chain:             string;
  pairAddress:       string;
  pipelineState:     PipelineState;
  watchKind:         string;
  enteredWatchAt:    number;
  watchAgeMs:        number;
  confidence:        Confidence;
  entryRisk:         EntryRisk;
  flow: {
    status:   FlowStatus;
    buyVol5m: number;
    netVol5m: number;
    buys5m:   number;
    sells5m:  number;
  };
  riskFlags:          string[];
  opportunitySignals: string[];
  priceVsEntryPct:    number | null;
  workerObservation:  string;
  updatedAt:          number;
}

export interface PreflightQualifiedSignal {
  schemaVersion:     string;
  workerVersion:     string;
  symbol:            string;
  chain:             string;
  pairAddress:       string;
  qualifiedAt:       number;
  confidence:        Confidence;
  entryRisk:         EntryRisk;
  flow: {
    status:   FlowStatus;
    buyVol5m: number;
    netVol5m: number;
    buys5m:   number;
  };
  riskFlags:          string[];
  opportunitySignals: string[];
  workerObservation:  string;
}

export interface PreflightDrop {
  schemaVersion:  string;
  workerVersion:  string;
  symbol:         string;
  chain:          string;
  pairAddress:    string;
  droppedAt:      number;
  wasIn:          PipelineState;
  dropReason:     string;
  timeInPipelineMs: number;
  flowAtDrop: {
    status:  FlowStatus;
    buys5m:  number;
    sells5m: number;
  };
}

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
): string[] {
  const flags: string[] = [];
  if (poolCountSameToken >= 3)                        flags.push("CLONE_FRAGMENTATION");
  if (reserveUsd < 15_000)                            flags.push("THIN_LIQUIDITY");
  if (consecutiveLosses >= 3)                         flags.push("BAD_HISTORY");
  if (badExits24h >= 2 && wins24h === 0)              flags.push("BAD_HISTORY");
  if (sellRatio > 0.5 && sellRatio < 1)               flags.push("DISTRIBUTION_RISK");
  if (sellRatio === 0 && liqStatus === "CONFIRMED")   flags.push("ONE_SIDED_FLOW");
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
  chain:              string;
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
}

// ── Main write function ───────────────────────────────────────────────────────

export interface PreflightWriteInput {
  workerVersion:    string;
  now:              number;

  // Market context
  regime:           string;
  buyingPctAll:     number;
  sellingPctAll:    number;
  flowCoveragePct:  number;
  trackedPairs:     number;
  chainsActive:     string[];
  momentumEventsBuffer: PreflightMomentumEvent[];

  // Signal pipeline (activeWatch + hotCandidates)
  signalPipeline:   PreflightSignalPipelineEntry[];

  // Qualified signals (armedEntries)
  qualifiedSignals: PreflightQualifiedSignal[];

  // Recent drops
  recentDrops:      PreflightDrop[];

  // Per-pair context map
  pairContextMap:   Record<string, PreflightPairContext>;
}

export async function writePreflightRedis(r: Redis, input: PreflightWriteInput): Promise<void> {
  const {
    workerVersion, now,
    regime, buyingPctAll, sellingPctAll, flowCoveragePct, trackedPairs, chainsActive,
    momentumEventsBuffer, signalPipeline, qualifiedSignals, recentDrops,
  } = input;

  const recent10m = (ts: number) => now - ts < 10 * 60_000;

  const pipeline = r.pipeline();

  // ── preflight:market_context ─────────────────────────────────────────────
  pipeline.set("preflight:market_context", JSON.stringify({
    schemaVersion:   SCHEMA_VERSION,
    workerVersion,
    regime,
    buyingPct:       buyingPctAll,
    sellingPct:      sellingPctAll,
    flowCoveragePct,
    trackedPairs,
    chainsActive,
    momentumEventsLast10m: momentumEventsBuffer.filter(e => recent10m(e.detectedAt)).length,
    contextQuality:  "fresh",
    updatedAt:       now,
  }), "EX", 120);

  // ── preflight:momentum_events ────────────────────────────────────────────
  const recentMomentum = momentumEventsBuffer
    .filter(e => recent10m(e.detectedAt))
    .slice(-MAX_EVENTS);
  pipeline.set("preflight:momentum_events", JSON.stringify(recentMomentum), "EX", 600);

  // ── preflight:signal_pipeline ────────────────────────────────────────────
  pipeline.set(
    "preflight:signal_pipeline",
    JSON.stringify(signalPipeline.slice(0, MAX_PIPELINE)),
    "EX", 120,
  );

  // ── preflight:qualified_signals ──────────────────────────────────────────
  pipeline.set(
    "preflight:qualified_signals",
    JSON.stringify(qualifiedSignals.slice(0, MAX_QUALIFIED)),
    "EX", 120,
  );

  // ── preflight:recent_drops ───────────────────────────────────────────────
  pipeline.set(
    "preflight:recent_drops",
    JSON.stringify(recentDrops.filter(d => recent10m(d.droppedAt)).slice(0, MAX_DROPS)),
    "EX", 600,
  );

  // ── preflight:pair_context ───────────────────────────────────────────────
  const pairContextEntries = Object.entries(input.pairContextMap);
  if (pairContextEntries.length > 0) {
    for (const [addr, ctx] of pairContextEntries) {
      pipeline.set(`preflight:pair_context:${addr}`, JSON.stringify(ctx), "EX", 120);
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
  dexType: string,
  flowHasData: boolean,
  flowBuyVol5m: number,
  flowNetVol5m: number,
  flowBuys5m: number,
  workerVersion: string,
): PreflightMomentumEvent {
  const flowStatus = event.hasWsFlow
    ? deriveFlowStatus("BUYING", flowHasData, flowBuys5m, 0)
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
  };

  return {
    schemaVersion:    SCHEMA_VERSION,
    workerVersion,
    symbol, chain, pairAddress,
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
    pressure:  string;
    hasData:   boolean;
    buyVol5m:  number;
    netVol5m:  number;
    buys5m:    number;
    sells5m:   number;
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
  const riskFlags   = deriveRiskFlags(poolCountSameToken, liqStatus, reserveUsd, consecutiveLosses, badExits24h, wins24h, sellRatio, "");
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
  };

  return {
    schemaVersion:     SCHEMA_VERSION,
    workerVersion,
    symbol, chain, pairAddress,
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
  };

  return {
    schemaVersion:     SCHEMA_VERSION,
    workerVersion,
    symbol, chain, pairAddress, qualifiedAt,
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