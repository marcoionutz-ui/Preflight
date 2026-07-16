/**
 * lib/mcp/types.ts
 * Toate interfețele pentru datele din Redis — extrase din route.ts
 */

import type {
  PreflightMarketContext, PreflightDrop,
  PreflightMomentumEvent, PreflightSignalPipelineEntry, PreflightQualifiedSignal,
  PreflightPairState, PreflightMemoryEntry, PreflightWorkerSnapshot,
} from "@preflight/schema";

// Report-output shape for tp_pair_context / tp_candidate_brief's risk payload
// — NOT the raw wire shape stored in pair_states (that's
// PreflightRiskSnapshot, on PairState.risk below). checkedAgeSec is a
// derived display field (now - checkedAt), computed once in
// lib/reports/pair-context-report.ts, never present on the Redis JSON —
// a required field here that used to silently never exist on the raw
// blob it got merged into as `any`.
export type PairRiskSummary = {
  riskLevel:            string;
  confidence:           string;
  flags:                string[];
  summary:              string;
  isHoneypot:           boolean | null;
  cannotSell:           boolean | null;
  buyTaxPct:            number  | null;
  sellTaxPct:           number  | null;
  ownerRenounced:       boolean | null;
  canMint:              boolean | null;
  canBlacklist:         boolean | null;
  canPauseTrading:      boolean | null;
  canChangeTax:         boolean | null;
  canChangeBalance:     boolean | null;
  canTakeBackOwnership: boolean | null;
  missingData:          string[];
  checkedAt:            number;
  checkedAgeSec:        number | null;
};

// PairState used to be a hand-maintained, drifted copy of the real
// preflight:pair_states shape (missing pipelineState/discovery/
// reserveNative/nativeSymbol, wrong risk type) — every consumer worked
// around the gaps with `as any`. Now sourced directly from
// @preflight/schema, matching what workers/evm actually writes.
export type PairState = PreflightPairState;

// MemoryEntry used to `extends PairState`, which meant TypeScript believed
// every worker_snapshot.memory[addr] entry had flow/lp/reserveUsd/
// reserveNative/liqStatus/dexType/discovery/risk/pipelineState/updatedAt —
// none of which the worker actually writes into that map (those live in
// pair_states / PairState, a genuinely different, richer contract). A pair
// can exist in worker_snapshot without existing in pair_states at all, so
// any code trusting the inheritance would type-check fine and crash at
// runtime. Now sourced directly from @preflight/schema, matching the real
// PairMemoryEntry shape workers/evm writes.
export type MemoryEntry = PreflightMemoryEntry;

export interface WatchEntry {
  chain:           string;
  addedAt:         number;
  ageMs:           number;
  kind:            string;
  entryPrice:      number | null;
  reason:          string | null;
  symbol:          string | null;
  phase:           string | null;
  priceVsEntryPct: number | null;
  flowAgeMs:       number | null;
  largestBuyEth:   number;
  avgBuyEth:       number;
  buySwapCount5m:  number;
  sellSwapCount5m: number;
}

export interface HotEntry {
  chain:           string;
  promotedAt:      number;
  ageMs:           number;
  source:          string | null;
  symbol:          string | null;
  phase:           string | null;
  flowAgeMs:       number | null;
  largestBuyEth:   number;
  avgBuyEth:       number;
  buySwapCount5m:  number;
  sellSwapCount5m: number;
  flow: {
    pressure: string;
    buys5m:   number;
    hasData:  boolean;
    buyVol5m: number;
    netVol5m: number;
  };
}

export interface ArmedEntry {
  armedAt:      number;
  ageMs:        number;
  price:        number;
  score:        number;
  flowPressure: string;
  symbol:       string | null;
  phase:        string | null;
  chain:        string | null;
}

export type WorkerSnapshot = PreflightWorkerSnapshot;

export interface MarketRegime {
  regime:            string;
  buyingPctAll:      number;
  sellingPctAll:     number;
  noWsPct:           number;
  flowCoveragePct:   number;
  hotCount:          number;
  armedCount:        number;
  wsConnectedChains: string[];
  scanOnlyChains:    string[];
  trackedPairs:      number;
  pairsWithWsFlow:   number;
  calculatedAt:      number;
}

export interface PipelineEvent {
  type:        string;
  symbol:      string;
  chain:       string;
  pairAddress: string;
  from:        string;
  to:          string;
  reason?:     string;
  ts:          number;
}

// RecentDrop (previousState/reason) used to be a separate legacy shape
// parsed from the same Redis key as pfDrops (wasIn/dropReason) — two
// incompatible interfaces cast over one JSON blob that actually only ever
// contained the PreflightDrop shape. Removed; drops below is PreflightDrop[]
// now, parsed once in redis-reader.ts and reused for both fields.

export interface RedisContext {
  now:      number;
  states:   Record<string, PairState>;
  watch:    Record<string, WatchEntry>;
  hot:      Record<string, HotEntry>;
  armed:    Record<string, ArmedEntry>;
  snapshot: WorkerSnapshot | null;
  regime:   MarketRegime | null;
  events:   PipelineEvent[];
  drops:    PreflightDrop[];
  // Canonical shapes, from @preflight/schema — matches what workers/evm
  // actually writes (packages/preflight-schema, aligned producer-side in
  // prior batches).
  pfMarket:    PreflightMarketContext | null;
  pfMomentum:  PreflightMomentumEvent[]      | null;
  pfPipeline:  PreflightSignalPipelineEntry[] | null;
  pfQualified: PreflightQualifiedSignal[]    | null;
  pfDrops:          PreflightDrop[] | null;
  pipelineCoverage: any | null;
  scannerStats:     any | null;
  pfLifecycle:      any[] | null;
  keyExists: {
    pair_states:     boolean;
    active_watch:    boolean;
    hot_candidates:  boolean;
    armed_entries:   boolean;
    worker_snapshot: boolean;
    market_regime:   boolean;
    pipeline_events: boolean;
    recent_drops:    boolean;
    pf_market:       boolean;
    pf_momentum:     boolean;
    pf_pipeline:     boolean;
    pf_qualified:    boolean;
    pf_drops:             boolean;
    pf_pipeline_coverage: boolean;
    pf_scanner_stats:     boolean;
    pf_lifecycle:         boolean;
  };
}

// ── GoPlus ────────────────────────────────────────────────────────────────────

export interface GoPlusSafety {
  sellability:          "PASS" | "FAIL" | "UNKNOWN";
  taxRisk:              "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  ownerRisk:            "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  isHoneypot:           boolean | null;
  buyTaxPct:            number | null;
  sellTaxPct:           number | null;
  ownerRenounced:       boolean | null;
  canChangeTax:         boolean | null;
  canBlacklist:         boolean | null;
  canMint:              boolean | null;
  canPauseTrading:      boolean | null;
  canChangeBalance:     boolean | null;
  canTakeBackOwnership: boolean | null;
  tokenAgeMinutes:      number | null;
  agentVerdict:         "BLOCK" | "HIGH_CAUTION" | "OK_TO_INVESTIGATE" | "UNKNOWN_CHECK_MANUALLY";
  missingData:          string[];
  cachedAt:             number;
  source:               "goplus" | "cache" | "unavailable";
}