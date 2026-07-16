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
import type { MomentumEvent } from "../risk/momentum";
import {
  REDIS_KEYS, SCHEMA_VERSION,
  type PreflightDrop, type PreflightMarketContext, type PreflightChain, type MarketRegime,
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

  // Market context
  regime:           MarketRegime;
  buyingPctAll:     number;
  sellingPctAll:    number;
  flowCoveragePct:  number;
  trackedPairs:     number;
  chainsActive:     PreflightChain[];
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
  // Typed against the shared contract instead of an inline literal, so a
  // field rename/removal in @preflight/schema is caught here at compile
  // time instead of silently drifting like PreflightDrop did. No casts
  // needed — regime/chainsActive are typed as MarketRegime/PreflightChain[]
  // all the way back to their source (marketContext.ts's deriveMarketContext,
  // config/chains.ts's ChainConfig.id), not just widened to fit here.
  const marketContext: PreflightMarketContext = {
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
  };
  pipeline.set(REDIS_KEYS.marketContext, JSON.stringify(marketContext), "EX", 120);

  // ── preflight:momentum_events ────────────────────────────────────────────
  const recentMomentum = momentumEventsBuffer
    .filter(e => recent10m(e.detectedAt))
    .slice(0, MAX_EVENTS);
  pipeline.set(REDIS_KEYS.momentumEvents, JSON.stringify(recentMomentum), "EX", 600);

  // ── preflight:signal_pipeline ────────────────────────────────────────────
  pipeline.set(
    REDIS_KEYS.signalPipeline,
    JSON.stringify(signalPipeline.slice(0, MAX_PIPELINE)),
    "EX", 120,
  );

  // ── preflight:qualified_signals ──────────────────────────────────────────
  pipeline.set(
    REDIS_KEYS.qualifiedSignals,
    JSON.stringify(qualifiedSignals.slice(0, MAX_QUALIFIED)),
    "EX", 120,
  );

  // ── preflight:recent_drops ───────────────────────────────────────────────
  pipeline.set(
    REDIS_KEYS.recentDrops,
    JSON.stringify(recentDrops.filter(d => recent10m(d.droppedAt)).slice(0, MAX_DROPS)),
    "EX", 600,
  );

  // ── preflight:pair_context ───────────────────────────────────────────────
  const pairContextEntries = Object.entries(input.pairContextMap);
  if (pairContextEntries.length > 0) {
    for (const [addr, ctx] of pairContextEntries) {
      pipeline.set(REDIS_KEYS.pairContext(addr), JSON.stringify(ctx), "EX", 120);
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
    symbol, chain: chain as PreflightChain, pairAddress,
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
  };

  return {
    schemaVersion:     SCHEMA_VERSION,
    workerVersion,
    symbol, chain: chain as PreflightChain, pairAddress,
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
    symbol, chain: chain as PreflightChain, pairAddress, qualifiedAt,
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