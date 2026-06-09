/**
 * @preflight/schema
 * Contractul comun între workers și MCP.
 * Tipuri, constante Redis keys, și nimic altceva.
 */

// ── Chains ────────────────────────────────────────────────────────────────────

export type PreflightChain =
  | "base"
  | "arbitrum"
  | "eth"
  | "bsc"
  | "solana";

export type DexType = "V2" | "V3" | "V4" | "UNKNOWN";

// ── Pipeline states ───────────────────────────────────────────────────────────

export type PipelineState =
  | "NONE"
  | "OBSERVED"
  | "WATCHING"
  | "CONFIRMING"
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
  flowAtDrop: {
    status:   FlowStatus;
    buys5m:   number;
    sells5m:  number;
  };
}

// ── Redis key constants ───────────────────────────────────────────────────────
// Un singur loc unde trăiesc key names.
// Workers scriu, MCP citește — nimeni nu scrie strings hardcodate.

export const REDIS_KEYS = {
  // preflight:* — schema nouă (workers scriu asta)
  MARKET_CONTEXT:     "preflight:market_context",
  MOMENTUM_EVENTS:    "preflight:momentum_events",
  SIGNAL_PIPELINE:    "preflight:signal_pipeline",
  QUALIFIED_SIGNALS:  "preflight:qualified_signals",
  RECENT_DROPS:       "preflight:recent_drops",
  OBSERVED_MOVERS:    "preflight:observed_movers",
  PAIR_CONTEXT:       (addr: string) => `preflight:pair_context:${addr.toLowerCase()}`,

  // supreme:* — schema veche (fallback pentru MCP)
  SUPREME_PAIR_STATES:     "supreme:pair_states",
  SUPREME_ACTIVE_WATCH:    "supreme:active_watch",
  SUPREME_HOT_CANDIDATES:  "supreme:hot_candidates",
  SUPREME_ARMED_ENTRIES:   "supreme:armed_entries",
  SUPREME_WORKER_SNAPSHOT: "supreme:worker_snapshot:latest",
  SUPREME_MARKET_REGIME:   "supreme:market_regime",
  SUPREME_PIPELINE_EVENTS: "supreme:pipeline_events",
  SUPREME_RECENT_DROPS:    "supreme:recent_drops",
} as const;

export const SCHEMA_VERSION = "preflight-schema-v1";
