/**
 * @preflight/schema
 * Contractul comun între workers și MCP.
 * Tipuri, constante Redis keys, și nimic altceva.
 */

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
export type Confidence      = "LOW" | "MEDIUM" | "HIGH";
export type MarketRegime    = "RISK_ON" | "RISK_OFF" | "MIXED" | "DEAD" | "LOW_COVERAGE";

// ── Core pair state ───────────────────────────────────────────────────────────

export interface PreflightPairState {
  schemaVersion:  string;
  workerVersion:  string;
  chain:          PreflightChain;
  pairAddress:    string;
  tokenAddress:   string | null;
  symbol:         string;
  dexType:        DexType;
  reserveUsd:     number;
  priceUsd:       number;
  priceChange: {
    m5:  number;
    h1:  number;
    h24: number;
  };
  pipelineState:  PipelineState;
  flow: {
    status:    FlowStatus;
    pressure:  string;
    hasData:   boolean;
    buyVol5m:  number;
    sellVol5m: number;
    netVol5m:  number;
    buys5m:    number;
    sells5m:   number;
  };
  liquidity: {
    status:     LiquidityStatus;
    reserveUsd: number;
  };
  risk: {
    entryRisk:  EntryRisk;
    riskFlags:  string[];
  };
  seenCount:    number;
  updatedAt:    number;
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