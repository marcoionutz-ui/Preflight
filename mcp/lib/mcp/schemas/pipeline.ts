/**
 * lib/mcp/schemas/pipeline.ts — E8c-2 (scheme Zod pt. array-urile pipeline din redis-reader.ts).
 *
 * Validare PE ELEMENT în `mergeChainArrays` pt. cele 6 array-uri per-chain. Contracte CANONICE COMPLETE
 * (doctrina E8b/E8c: oglindesc interfețele reale, nu un guard superficial):
 *   - PipelineEvent            (./types)                          → pipeline_events
 *   - PreflightDrop            (@preflight/schema)                → recent_drops
 *   - PreflightMomentumEvent   (@preflight/schema)                → pf_momentum
 *   - PreflightSignalPipelineEntry (@preflight/schema)            → pf_pipeline
 *   - PreflightQualifiedSignal (@preflight/schema)                → pf_qualified
 *   - PreflightLifecycleEntry  (@preflight/schema)                → pf_lifecycle
 * Câmpurile de BRANCHING sunt `z.enum`; nested `flow` complet; `.passthrough()` = forward-compat.
 * Elementele invalide sunt FILTRATE de mergeChainArrays (nu pică toată lista chain-ului).
 *
 * PUR (doar `zod`) → testabil izolat în tsx.
 */
import { z } from "zod";

// ── Enum-uri canonice (oglindesc uniunile din @preflight/schema) ──
const EVM_CHAINS        = ["base", "arbitrum", "ethereum", "bsc"] as const;                                       // PreflightEvmChain
const PIPELINE_STATES   = ["NONE", "OBSERVED", "WATCHING", "HOT", "ARMED", "QUALIFIED", "DROPPED", "REJECTED"] as const; // PipelineState
const FLOW_STATUSES     = ["NO_DATA", "WEAK", "BUYING", "STRONG", "ONE_SIDED"] as const;                          // FlowStatus
const ENTRY_RISKS       = ["LOW", "MEDIUM", "HIGH", "EXTREME"] as const;                                          // EntryRisk
const DEX_TYPES         = ["V2", "V3", "V4", "UNKNOWN"] as const;                                                 // DexType
const CONFIDENCES       = ["LOW", "MEDIUM", "HIGH"] as const;                                                     // Confidence
const MOMENTUM_VERDICTS = [
  "VERTICAL_WATCH", "CONFIRMED_MOMENTUM", "LATE_WATCH", "UNCONFIRMED_VERTICAL",
  "LOW_LIQ_NOISE", "EXTREME_LATE", "NO_MOMENTUM", "NO_CHASE",
] as const;                                                                                                       // MomentumVerdict
const MOVE_TYPES        = ["ORGANIC", "VERTICAL", "LATE", "SECOND_WAVE", "NEW_POOL", "UNKNOWN"] as const;          // MoveType
const MOMENTUM_LEVELS   = ["NONE", "LOW", "MEDIUM", "HIGH", "EXTREME"] as const;                                  // MomentumLevel
const LIFECYCLE_OUTCOMES   = ["QUALIFIED_EMITTED", "DROPPED", "EXPIRED", "FAILED_CONFIRMATION"] as const;         // LifecycleOutcome
const LIFECYCLE_FROMSTATES = ["WATCHING", "HOT", "ARMED"] as const;

// ── PipelineEvent (./types) — chain/type = string (nu enum în contract) ──
export const PipelineEventSchema = z.object({
  type:        z.string(),
  symbol:      z.string(),
  chain:       z.string(),
  pairAddress: z.string(),
  from:        z.string(),
  to:          z.string(),
  reason:      z.string().optional(),
  ts:          z.number(),
}).passthrough();

// ── PreflightDrop (recent_drops) ──
export const DropSchema = z.object({
  schemaVersion:    z.string(),
  workerVersion:    z.string(),
  chain:            z.enum(EVM_CHAINS),
  pairAddress:      z.string(),
  symbol:           z.string(),
  droppedAt:        z.number(),
  wasIn:            z.enum(PIPELINE_STATES),
  dropReason:       z.string(),
  timeInPipelineMs: z.number(),
  priceAtDrop:      z.number().nullable().optional(),
  scoreAtDrop:      z.number().nullable().optional(),
  flowAtDrop: z.object({
    status:  z.enum(FLOW_STATUSES),
    buys5m:  z.number(),
    sells5m: z.number(),
  }).passthrough(),
}).passthrough();

// ── PreflightMomentumEvent (pf_momentum) ──
export const MomentumEventSchema = z.object({
  schemaVersion: z.string(),
  workerVersion: z.string(),
  symbol:        z.string(),
  chain:         z.enum(EVM_CHAINS),
  pairAddress:   z.string(),
  detectedAt:    z.number(),
  verdict:       z.enum(MOMENTUM_VERDICTS),
  moveType:      z.enum(MOVE_TYPES),
  momentumLevel: z.enum(MOMENTUM_LEVELS),
  entryRisk:     z.enum(ENTRY_RISKS),
  reason:        z.string(),
  m5Pct:         z.number(),
  h1Pct:         z.number(),
  h24Pct:        z.number(),
  reserveUsd:    z.number(),
  dexType:       z.enum(DEX_TYPES),
  flow: z.object({
    hasData:  z.boolean(),
    status:   z.enum(FLOW_STATUSES),
    buyVol5m: z.number(),
    netVol5m: z.number(),
    buys5m:   z.number(),
  }).passthrough(),
  riskFlags:         z.array(z.string()),
  pipelineState:     z.enum(PIPELINE_STATES),
  workerObservation: z.string(),
}).passthrough();

// ── PreflightSignalPipelineEntry (pf_pipeline) ──
export const SignalPipelineEntrySchema = z.object({
  schemaVersion:  z.string(),
  workerVersion:  z.string(),
  symbol:         z.string(),
  chain:          z.enum(EVM_CHAINS),
  pairAddress:    z.string(),
  pipelineState:  z.enum(PIPELINE_STATES),
  watchKind:      z.string(),
  enteredWatchAt: z.number(),
  watchAgeMs:     z.number(),
  confidence:     z.enum(CONFIDENCES),
  entryRisk:      z.enum(ENTRY_RISKS),
  flow: z.object({
    status:   z.enum(FLOW_STATUSES),
    buyVol5m: z.number(),
    netVol5m: z.number(),
    buys5m:   z.number(),
    sells5m:  z.number(),
  }).passthrough(),
  riskFlags:          z.array(z.string()),
  opportunitySignals: z.array(z.string()),
  priceVsEntryPct:    z.number().nullable(),
  workerObservation:  z.string(),
  updatedAt:          z.number(),
}).passthrough();

// ── PreflightQualifiedSignal (pf_qualified) ──
export const QualifiedSignalSchema = z.object({
  schemaVersion: z.string(),
  workerVersion: z.string(),
  symbol:        z.string(),
  chain:         z.enum(EVM_CHAINS),
  pairAddress:   z.string(),
  qualifiedAt:   z.number(),
  confidence:    z.enum(CONFIDENCES),
  entryRisk:     z.enum(ENTRY_RISKS),
  flow: z.object({
    status:   z.enum(FLOW_STATUSES),
    buyVol5m: z.number(),
    netVol5m: z.number(),
    buys5m:   z.number(),
  }).passthrough(),
  riskFlags:          z.array(z.string()),
  opportunitySignals: z.array(z.string()),
  workerObservation:  z.string(),
}).passthrough();

// ── PreflightLifecycleEntry (pf_lifecycle) ──
export const LifecycleEntrySchema = z.object({
  chain:         z.string(),
  pairAddress:   z.string(),
  lastOutcome:   z.enum(LIFECYCLE_OUTCOMES),
  lastOutcomeAt: z.number(),
  reason:        z.string(),
  fromState:     z.enum(LIFECYCLE_FROMSTATES),
}).passthrough();
