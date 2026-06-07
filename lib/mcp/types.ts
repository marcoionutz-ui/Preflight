/**
 * lib/mcp/types.ts
 * Toate interfețele pentru datele din Redis — extrase din route.ts
 */

export interface PairState {
  symbol:             string;
  phase:              string;
  seenCount:          number;
  totalEntries:       number;
  wins24h:            number;
  losses24h:          number;
  badExits24h:        number;
  consecutiveLosses:  number;
  currentPrice:       number;
  lastEntryTime:      number;
  reserveUsd:         number;
  reserveEth:         number;
  liqStatus:          string;
  dexType:            string;
  poolCountSameToken: number;
  hourUtc:            number;
  flow: {
    pressure:  string;
    buys5m:    number;
    sells5m:   number;
    hasData:   boolean;
    buyVol5m:  number;
    sellVol5m: number;
    netVol5m:  number;
  };
  lp: {
    status:           string;
    lpNet5m:          number;
    hasData:          boolean;
    lpAdded5m:        number;
    lpRemoved5m:      number;
    removedPctOfPool: number | null;
  };
  updatedAt: number;
}

export interface MemoryEntry extends PairState {
  tokenAddress:     string;
  pairAddress:      string;
  firstSeen:        number;
  lastSeen:         number;
  lastExitReason:   string | null;
  lastExitTime:     number | null;
  lastEntryTime:    number;
  lastEntryPrice:   number;
  priceAtFirstSeen: number;
  highPrice:        number;
  lowPrice:         number;
}

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

export interface WorkerSnapshot {
  version:        string;
  savedAt:        number;
  memory:         Record<string, MemoryEntry>;
  poolReserveEth: Record<string, number>;
}

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

export interface RecentDrop {
  symbol:        string;
  chain:         string;
  pairAddress:   string;
  previousState: string;
  reason:        string;
  droppedAt:     number;
}

export interface RedisContext {
  now:      number;
  states:   Record<string, PairState>;
  watch:    Record<string, WatchEntry>;
  hot:      Record<string, HotEntry>;
  armed:    Record<string, ArmedEntry>;
  snapshot: WorkerSnapshot | null;
  regime:   MarketRegime | null;
  events:   PipelineEvent[];
  drops:    RecentDrop[];
  keyExists: {
    pair_states:     boolean;
    active_watch:    boolean;
    hot_candidates:  boolean;
    armed_entries:   boolean;
    worker_snapshot: boolean;
    market_regime:   boolean;
    pipeline_events: boolean;
    recent_drops:    boolean;
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