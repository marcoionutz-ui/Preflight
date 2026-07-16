/**
 * @preflight/schema
 * Contractul comun între workers și MCP.
 * Tipuri, constante Redis keys, și nimic altceva.
 */

import type { RiskResult } from "@preflight/risk-layer";

// Slim risk snapshot as actually embedded in pair_states — no raw GoPlus
// payload. Mirrors workers/evm/src/state/pairStates.ts's local
// RiskStateSnapshot (now sourced from here instead of duplicated).
export type PreflightRiskSnapshot = Omit<RiskResult, "raw">;

// ── Chains ────────────────────────────────────────────────────────────────────

// "ethereum", not "eth" — matches the chain.id value workers/evm actually
// writes to Redis (workers/evm/src/config/chains.ts). "eth" is only the
// GeckoTerminal API slug for that chain, a separate concern; using it here
// would make every real "ethereum" pair state fail to type-check against
// this union.
export type PreflightChain =
  | "base"
  | "arbitrum"
  | "ethereum"
  | "bsc"
  | "solana";

export type DexType = "V2" | "V3" | "V4" | "UNKNOWN";

// Sursă de adevăr pentru workers/evm/src/lib/engines/phaseDetector.ts —
// written into both pair_states (PreflightPairState.phase) and
// worker_snapshot (PreflightMemoryEntry.phase), so it's wire contract too.
export type Phase =
  | "NEW"
  | "TRENDING"
  | "PUMPING"
  | "DUMPING"
  | "RECOVERING"
  | "SECOND_WAVE"
  | "ZOMBIE"
  | "DEAD";

// ── Pipeline states ───────────────────────────────────────────────────────────

export type PipelineState =
  | "NONE"
  | "OBSERVED"
  | "WATCHING"
  | "HOT"
  | "ARMED"
  | "QUALIFIED"
  | "DROPPED"
  | "REJECTED";

// ── Risk / flow types ─────────────────────────────────────────────────────────
// Sursă de adevăr — importate și în workers/evm/src/lib/observation.ts

export type FlowStatus      = "NO_DATA" | "WEAK" | "BUYING" | "STRONG" | "ONE_SIDED";
export type LiquidityStatus = "THIN" | "OK" | "CONFIRMED" | "DEEP";
export type EntryRisk       = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
export type MomentumLevel   = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
export type MoveType        = "ORGANIC" | "VERTICAL" | "LATE" | "SECOND_WAVE" | "NEW_POOL" | "UNKNOWN";

// Sursă de adevăr pentru workers/evm/src/risk/momentum.ts — odată scris în
// Redis și citit de MCP, valorile astea sunt parte din wire contract, nu
// doar un detaliu intern de algoritm. Un typo aici (ex. "VERTCAL_WATCH")
// trebuie prins la compilare pe producer, nu doar tolerat ca string liber.
export type MomentumVerdict =
  | "VERTICAL_WATCH"       // +30-100% 5m, V3/V4, reserve ok → urmărește
  | "CONFIRMED_MOMENTUM"   // vertical + WS flow deja activ → priority watch
  | "LATE_WATCH"           // +200-800% 24h, flow activ → urmărește
  | "UNCONFIRMED_VERTICAL" // vertical dar fără WS / fără reserve suficient
  | "LOW_LIQ_NOISE"        // reserve prea mică → probabil noise
  | "EXTREME_LATE"         // +500%+ 24h → prea târziu
  | "NO_MOMENTUM"          // sub threshold-uri → nu e momentum event
  | "NO_CHASE";            // momentum real dar criterii Preflight neîndeplinite
export type Confidence      = "LOW" | "MEDIUM" | "HIGH";
export type MarketRegime    = "RISK_ON" | "RISK_OFF" | "MIXED" | "DEAD" | "LOW_COVERAGE";

// Sursă de adevăr pentru workers/evm/src/risk/attention.ts — written into
// mem.attentionScore/monitoringTier/patternTags (pipeline/scan.ts) and from
// there into both pair_states and worker_snapshot, so wire contract too.
export type MonitoringTier =
  | "EVENT_WATCH"        // major market event: liq mare + move extrem
  | "FRESH_WATCH"        // mișcare activă recentă, prima apariție
  | "CONTINUATION_WATCH" // mișcare susținută, repeated sightings
  | "SHORT_WATCH"        // mișcare violentă low-liq, TTL scurt
  | "MARKET_ONLY";       // facts only, fără WS

// ── Core pair state ───────────────────────────────────────────────────────────
// Real shape of preflight:pair_states entries, moved from a local interface
// in workers/evm/src/state/pairStates.ts (buildPairStates()). Unlike
// PreflightMarketContext/PreflightDrop/etc., these entries carry no
// schemaVersion/workerVersion fields — the producer never writes them here,
// so they're deliberately absent rather than assumed.
//
// The previous PreflightPairState draft in this file (schemaVersion,
// priceUsd, liquidity.status, risk:{entryRisk,riskFlags}, etc.) didn't match
// the real wire JSON at all and had zero importers anywhere in the repo —
// replaced outright rather than reshaped.

export interface PreflightPairState {
  symbol:        string;
  chain:         PreflightChain;
  pairAddress:   string;
  tokenAddress:  string;
  // Only ever "V4"|"V3"|"V2" from buildPairStates()'s own ternary — DexType
  // (which also allows "UNKNOWN") is a safe superset, not a guess.
  dexType:       DexType;

  currentPrice:  number;
  priceChange: {
    m5:  number;
    h1:  number;
    h24: number;
  };

  // mem.phase on the producer side is workers/evm's own Phase type — real,
  // not a guess (verified when adding PreflightMemoryEntry below, which
  // shares this exact field from the same PairMemoryEntry source).
  phase:             Phase;
  // Only ever "ARMED"|"HOT"|"WATCHING"|"NONE" from buildPairStates()'s own
  // ternary — PipelineState (used elsewhere in this file for the same
  // concept) is a safe superset.
  pipelineState:     PipelineState;
  seenCount:         number;
  totalEntries:      number;

  wins24h:           number;
  losses24h:         number;
  badExits24h:       number;
  consecutiveLosses: number;
  lastEntryTime:     number;

  flow: {
    // Verified against workers/evm/src/lib/engines/flowTypes.ts's
    // FlowPressure — a different concept from this file's own FlowStatus
    // (which happens to share the "BUYING" literal but isn't the same
    // union), so inlined rather than reusing that name.
    pressure:     "BUYING" | "SELLING" | "NEUTRAL";
    buys5m:       number;
    sells5m:      number;
    hasData:      boolean;
    buyVol5m:     number;
    sellVol5m:    number;
    netVol5m:     number;
    buyVol5mUsd:  number | null;
    sellVol5mUsd: number | null;
    netVol5mUsd:  number | null;
  };

  lp: {
    // Verified against workers/evm/src/lib/engines/flowTypes.ts's own
    // LiquidityStatus ("ADDED"|"REMOVED"|"STABLE") — NOT the same as this
    // file's LiquidityStatus ("THIN"|"OK"|"CONFIRMED"|"DEEP", a different
    // concept despite the identical name), so inlined to avoid colliding
    // with that existing export.
    status:           "ADDED" | "REMOVED" | "STABLE";
    lpNet5m:          number;
    hasData:          boolean;
    lpAdded5m:        number;
    lpRemoved5m:      number;
    removedPctOfPool: number | null;
  };

  reserveUsd:         number;
  reserveEth:         number;
  reserveNative:      number;
  // Verified against workers/evm/src/risk/liquidity.ts's
  // getLiquidityContext() return type — both fields below are its exact
  // literal signature, not a guess.
  nativeSymbol:       "ETH" | "BNB" | null;
  liqStatus:          "CONFIRMED" | "WEAK" | "MISSING";
  poolCountSameToken: number;

  firstSeenAt:         number | null;
  lastSeenAt:          number | null;
  pipelineEnteredAt:   number | null;
  currentStateAgeSec:  number | null;
  priceVsFirstSeenPct: number | null;

  hourUtc:              number;
  updatedAt:            number;
  // Not optional keys — buildPairStates() always writes all six of these
  // (each `?? null` on the producer side), never omits them. "Optional"
  // was describing the wrong axis: the VALUE can be null, but the KEY is
  // always present.
  lastMomentumVerdict: MomentumVerdict | null;
  lastMomentumAt:      number | null;
  attentionScore:      number | null;
  monitoringTier:      MonitoringTier | null;
  patternTags:         string[] | null;
  risk:                PreflightRiskSnapshot | null;

  discovery: {
    // mem.primaryDiscoverySource/discoverySources are typed DiscoverySource
    // on the producer's PairMemoryEntry (workers/evm/src/lib/engines/
    // pairMemory.ts) — narrowed here to match, not widened to string.
    primaryDiscoverySource: DiscoverySource | null;
    discoverySources:       DiscoverySource[];
    firstDiscoveredAt:      number | null;
    lastDiscoveryAt:        number | null;
  };
}

// ── Worker memory / snapshot ────────────────────────────────────────────────
// Real shape of preflight:worker_snapshot:latest, moved from a local
// interface in workers/evm/src/lib/engines/pairMemory.ts (PairMemoryEntry)
// and workers/evm/src/state/memory.ts (saveMemoryToRedis()). This is a
// DIFFERENT, smaller contract than PreflightPairState above — worker_snapshot
// is accounting/history memory (win/loss counters, price extremes, discovery
// provenance), not live pair state. It carries no flow/lp/reserve/risk/
// pipelineState fields; a pair can legitimately exist only in worker_snapshot
// and not in pair_states (or vice versa). mcp's MemoryEntry used to
// `extends PairState`, silently promising flow/lp/reserveUsd/risk/etc. that
// never actually exist on this shape — a real bug, not just a style choice.
export interface PreflightMemoryEntry {
  pairAddress:       string;
  symbol:            string;
  tokenAddress:      string;
  firstSeen:         number;
  lastSeen:          number;
  seenCount:         number;
  priceAtFirstSeen:  number;
  highPrice:         number;
  lowPrice:          number;
  currentPrice:      number;
  totalEntries:      number;
  lastEntryTime:     number;
  lastEntryPrice:    number;
  wins24h:           number;
  losses24h:         number;
  badExits24h:       number;
  consecutiveLosses: number;
  lastExitReason:    string | null;
  lastExitTime:      number | null;
  phase:             Phase;
  // All of the below are optional on the producer's PairMemoryEntry too —
  // legitimately absent for pairs that never had the corresponding event
  // (e.g. never got a momentum verdict), and JSON.stringify drops undefined
  // fields rather than writing null. Keep them optional here to match —
  // making any of these required would make a strict parse reject real,
  // valid snapshot data on restore.
  // Loose string, not PreflightChain — sourced from workers/evm's own
  // SourcePool.chain, which is itself untyped at that layer (flagged
  // elsewhere as deferred future work, not tackled here). Tightening this
  // would require a trust-boundary cast for a field that's optional and
  // not currently validated anywhere upstream — different risk profile
  // than PreflightPairState.chain (required, already guarded).
  chain?:                  string;
  priceChange?:            { m5: number; h1: number; h24: number };
  lastMomentumVerdict?:    MomentumVerdict | null;
  lastMomentumAt?:         number | null;
  primaryDiscoverySource?: DiscoverySource;
  discoverySources?:       DiscoverySource[];
  firstDiscoveredAt?:      number;
  lastDiscoveryAt?:        number;
  // Real fields, not dead — set in workers/evm/src/pipeline/scan.ts on
  // every scanned pool ("attentionScore salvat pe TOATE pool-urile —
  // inclusiv NO_MOMENTUM"), read back a few lines later in the same file.
  // Absent only for pairs that haven't been through a scan pass yet
  // (e.g. just loaded from Supabase via loadPairStats()).
  attentionScore?:         number;
  monitoringTier?:         MonitoringTier;
  patternTags?:            string[];
}

export interface PreflightWorkerSnapshot {
  version:        string;
  savedAt:        number;
  memory:         Record<string, PreflightMemoryEntry>;
  poolReserveEth: Record<string, number>;
}

// ── Signal types ──────────────────────────────────────────────────────────────

export interface PreflightSignal {
  schemaVersion:      string;
  workerVersion:      string;
  chain:              PreflightChain;
  pairAddress:        string;
  symbol:             string;
  pipelineState:      PipelineState;
  confidence:         Confidence;
  entryRisk:          EntryRisk;
  flow: {
    status:    FlowStatus;
    buyVol5m:  number;
    netVol5m:  number;
    buys5m:    number;
  };
  riskFlags:          string[];
  opportunitySignals: string[];
  workerObservation:  string;
  detectedAt:         number;
  updatedAt:          number;
}

// ── Momentum / signal pipeline / qualified signal ──────────────────────────────
// These three ship as their own real shapes — PreflightSignal above doesn't
// match any of them, so it's left alone rather than forced to fit. Moved
// from a local, drifted copy in workers/evm/src/lib/preflight-redis.ts
// (chain: string there, PreflightChain here — same trust-boundary cast
// pattern as PreflightDrop).

export interface PreflightMomentumEvent {
  schemaVersion:    string;
  workerVersion:    string;
  symbol:           string;
  chain:            PreflightChain;
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
  dexType:          DexType;
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
  chain:             PreflightChain;
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
  chain:             PreflightChain;
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

// ── Market context ────────────────────────────────────────────────────────────

export interface PreflightMarketContext {
  schemaVersion:         string;
  workerVersion:         string;
  regime:                MarketRegime;
  buyingPct:             number;
  sellingPct:            number;
  flowCoveragePct:       number;
  trackedPairs:          number;
  chainsActive:          PreflightChain[];
  momentumEventsLast10m: number;
  // Always "fresh" today (workers/evm/src/lib/preflight-redis.ts never
  // computes a different value) — kept as string rather than a narrower
  // literal/enum since it's evidently meant to vary, just doesn't yet.
  contextQuality:        string;
  updatedAt:             number;
}

// ── Drop ──────────────────────────────────────────────────────────────────────

export interface PreflightDrop {
  schemaVersion:    string;
  workerVersion:    string;
  chain:            PreflightChain;
  pairAddress:      string;
  symbol:           string;
  droppedAt:        number;
  wasIn:            PipelineState;
  dropReason:       string;
  timeInPipelineMs: number;
  priceAtDrop?: number | null;
  scoreAtDrop?: number | null;
  flowAtDrop: {
    status:   FlowStatus;
    buys5m:   number;
    sells5m:  number;
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
// Sursă de adevăr: workers/evm/src/state/lifecycle.ts's PairLifecycle — already
// a clean, real interface there (not a drifted/any-typed copy), just never
// shared with mcp. preflight:lifecycle stores JSON.stringify(getRecentLifecycles()),
// a plain array of these, most recent first.

export type LifecycleOutcome =
  | "QUALIFIED_EMITTED"
  | "DROPPED"
  | "EXPIRED"
  | "FAILED_CONFIRMATION";

export interface PreflightLifecycleEntry {
  pairAddress:   string;
  lastOutcome:   LifecycleOutcome;
  lastOutcomeAt: number;
  reason:        string;
  fromState:     "WATCHING" | "HOT" | "ARMED";
}

// ── Redis key constants ───────────────────────────────────────────────────────
// Un singur loc unde trăiesc key names.
// Workers scriu, MCP citește — nimeni nu scrie strings hardcodate.

// ── Discovery Sources ─────────────────────────────────────────────────────────

export type DiscoverySource =
  | "GECKO_TRENDING_P1"
  | "GECKO_TRENDING_P2"
  | "GECKO_TRENDING_P3"
  | "GECKO_NEW_POOL"
  | "DEXSCREENER_BOOSTED"
  | "DEXSCREENER_PROFILE"
  | "DEXSCREENER_PAIR_FALLBACK"
  | "MARKET_FOLLOW_LIST"
  | "AGENT_SUPPLIED"
  | "INDEXER";            // Faza 6.3 — pool descoperit de indexer-evm

export type SourceAgreement =
  | "MULTI_DISCOVERY_SOURCES"
  | "RETAINED_BY_FOLLOW_LIST"
  | "SINGLE_DISCOVERY_SOURCE"
  | "STALE_DISCOVERY"
  | "NO_DISCOVERY_DATA";  

export const REDIS_KEYS = {
    
  // Pipeline state
  pairStates:      "preflight:pair_states",
  activeWatch:     "preflight:active_watch",
  hotCandidates:   "preflight:hot_candidates",
  armedEntries:    "preflight:armed_entries",
  workerSnapshot:  "preflight:worker_snapshot:latest",
  marketRegime:    "preflight:market_regime",
  recentDrops:     "preflight:recent_drops",
  pipelineEvents:  "preflight:pipeline_events",

  // Context
  marketContext:      "preflight:market_context",
  momentumEvents:     "preflight:momentum_events",
  signalPipeline:     "preflight:signal_pipeline",
  qualifiedSignals:   "preflight:qualified_signals",
  pipelineCoverage:   "preflight:pipeline_coverage",
  scannerStats:       "preflight:scanner_stats",
  agentWatchRequests: "preflight:agent_watch_requests",
  lifecycle:          "preflight:lifecycle",

  // Per-pair
  pairContext:       (addr: string) => `preflight:pair_context:${addr.toLowerCase()}`,
  risk:              (chain: string, token: string) => `preflight:risk:${chain}:${token.toLowerCase()}`,

  // 6.10 — Own trending
  trendingSnapshot:  (chain: string, addr: string) => `preflight:trending:snapshot:${chain}:${addr.toLowerCase()}`,
  trendingMovers:    (chain: string) => `preflight:trending:movers:${chain}`,
} as const;

export const SCHEMA_VERSION = "preflight-schema-v1";