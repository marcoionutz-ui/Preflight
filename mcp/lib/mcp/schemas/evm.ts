/**
 * lib/mcp/schemas/evm.ts — E8b (scheme Zod la granițele Redis EVM/worker — restul lui safeJson).
 *
 * Continuă E8a pe cele 6 citiri NON-Solana din redis-reader.ts. Politică (întărită după review varu):
 * - root = OBIECT (un JSON array/primitiv/null → schema pică → `fallback`);
 * - hărțile (`z.object({}).catchall(<valoare>)`): root `{}` valid (hartă goală = chain viu fără intrări),
 *   DAR fiecare VALOARE prezentă e validată pe CONTRACTUL CANONIC COMPLET din `@preflight/schema` — TOATE
 *   câmpurile `required` reflectate (missing/wrong-type → fallback), doar cele realmente `?` sunt `.optional()`;
 * - câmpurile pe care reader-ele/tool-urile fac BRANCHING (phase/pipelineState/dexType/lp.status/flow.pressure/
 *   status-uri/source) sunt `z.enum(...)` — un typo nu mai poate ocoli caution-uri sau altera clasificarea;
 * - `.passthrough()` (inclusiv nested) păstrează forward-compat.
 */
import { z } from "zod";

// Enum-uri canonice (branching) — oglindesc uniunile din @preflight/schema.
const PHASES          = ["NEW", "TRENDING", "PUMPING", "DUMPING", "RECOVERING", "SECOND_WAVE", "ZOMBIE", "DEAD"] as const;
const PIPELINE_STATES = ["NONE", "OBSERVED", "WATCHING", "HOT", "ARMED", "QUALIFIED", "DROPPED", "REJECTED"] as const;
const DEX_TYPES       = ["V2", "V3", "V4", "UNKNOWN"] as const;
const LP_STATUSES     = ["ADDED", "REMOVED", "STABLE"] as const;

// PreflightRiskSnapshot = Omit<RiskResult, "raw"> — contract COMPLET (un `risk:{}` truthy ar face
// `dataReadyForReasoning` să creadă că riskCache e prezent deși toate câmpurile sunt undefined).
const RiskSnapshotSchema = z.object({
  chain:                z.string(),
  tokenAddress:         z.string(),
  checkedAt:            z.number(),
  source:               z.enum(["goplus", "unavailable"]),
  riskLevel:            z.string(),
  confidence:           z.string(),
  flags:                z.array(z.string()),
  summary:              z.string(),
  isHoneypot:           z.boolean().nullable(),
  buyTaxPct:            z.number().nullable(),
  sellTaxPct:           z.number().nullable(),
  cannotSell:           z.boolean().nullable(),
  ownerRenounced:       z.boolean().nullable(),
  canChangeTax:         z.boolean().nullable(),
  canBlacklist:         z.boolean().nullable(),
  canMint:              z.boolean().nullable(),
  canPauseTrading:      z.boolean().nullable(),
  canChangeBalance:     z.boolean().nullable(),
  canTakeBackOwnership: z.boolean().nullable(),
  tokenAgeMinutes:      z.number().nullable(),
  missingData:          z.array(z.string()),
}).passthrough();

// ── Valori de hartă (pairKey → entry) ──────────────────────────────────────────

// pair_states value = PreflightPairState (contract COMPLET — TOATE câmpurile required, inclusiv risk/discovery/patternTags).
const PairStateEntrySchema = z.object({
  symbol:            z.string(),
  chain:             z.string(),
  pairAddress:       z.string(),
  tokenAddress:      z.string(),
  dexType:           z.enum(DEX_TYPES),
  // NF1: V4 hooks tri-stare — adresă 0x+40hex (custom) / null (vanilla) / absent (indisponibil). Regex STRICT
  // (nu orice string): workerul scrie doar normalizeHooks (adresă validă lowercase) sau null.
  hooks:             z.string().regex(/^0x[0-9a-fA-F]{40}$/).nullable().optional(),
  currentPrice:      z.number(),
  priceChange:       z.object({ m5: z.number(), h1: z.number(), h24: z.number() }).passthrough(),
  phase:             z.enum(PHASES),
  pipelineState:     z.enum(PIPELINE_STATES),
  seenCount:         z.number(),
  totalEntries:      z.number(),
  wins24h:           z.number(),
  losses24h:         z.number(),
  badExits24h:       z.number(),
  consecutiveLosses: z.number(),
  lastEntryTime:     z.number(),
  flow: z.object({
    pressure:     z.enum(["BUYING", "SELLING", "NEUTRAL"]),
    buys5m:       z.number(),
    sells5m:      z.number(),
    hasData:      z.boolean(),
    buyVol5m:     z.number(),
    sellVol5m:    z.number(),
    netVol5m:     z.number(),
    buyVol5mUsd:  z.number().nullable(),
    sellVol5mUsd: z.number().nullable(),
    netVol5mUsd:  z.number().nullable(),
    // NF1: FULL / EVENT_ONLY (V4 hook return-delta) / UNKNOWN (V4 hooks indisponibil). Opțional (snapshot-uri vechi nu-l au).
    flowCoverage: z.enum(["FULL", "EVENT_ONLY", "UNKNOWN"]).optional(),
  }).passthrough(),
  lp: z.object({
    status:           z.enum(LP_STATUSES),
    lpNet5m:          z.number(),
    hasData:          z.boolean(),
    lpAdded5m:        z.number(),
    lpRemoved5m:      z.number(),
    removedPctOfPool: z.number().nullable(),
  }).passthrough(),
  reserveUsd:          z.number(),
  reserveEth:          z.number(),
  reserveNative:       z.number(),
  nativeSymbol:        z.string().nullable(),
  liqStatus:           z.string(),
  poolCountSameToken:  z.number(),
  firstSeenAt:         z.number().nullable(),
  lastSeenAt:          z.number().nullable(),
  pipelineEnteredAt:   z.number().nullable(),
  currentStateAgeSec:  z.number().nullable(),
  priceVsFirstSeenPct: z.number().nullable(),
  hourUtc:             z.number(),
  updatedAt:           z.number(),
  // Chei mereu prezente (buildPairStates le scrie pe toate), valoare nullable.
  lastMomentumVerdict: z.string().nullable(),
  lastMomentumAt:      z.number().nullable(),
  attentionScore:      z.number().nullable(),
  monitoringTier:      z.string().nullable(),
  patternTags:         z.array(z.string()).nullable(),
  risk:                RiskSnapshotSchema.nullable(),
  discovery: z.object({
    primaryDiscoverySource: z.string().nullable(),
    discoverySources:       z.array(z.string()),
    firstDiscoveredAt:      z.number().nullable(),
    lastDiscoveryAt:        z.number().nullable(),
  }).passthrough(),
}).passthrough();
export const PairStatesRecordSchema = z.object({}).catchall(PairStateEntrySchema);

// active_watch value = WatchEntry (toate câmpurile required; unele nullable).
const WatchEntrySchema = z.object({
  chain:           z.string(),
  addedAt:         z.number(),
  ageMs:           z.number(),
  kind:            z.string(),
  entryPrice:      z.number().nullable(),
  reason:          z.string().nullable(),
  symbol:          z.string().nullable(),
  phase:           z.string().nullable(),
  priceVsEntryPct: z.number().nullable(),
  flowAgeMs:       z.number().nullable(),
  largestBuyEth:   z.number(),
  avgBuyEth:       z.number(),
  buySwapCount5m:  z.number(),
  sellSwapCount5m: z.number(),
}).passthrough();
export const WatchRecordSchema = z.object({}).catchall(WatchEntrySchema);

// hot_candidates value = HotEntry (toate required, inclusiv sub-obiectul flow).
const HotEntrySchema = z.object({
  chain:           z.string(),
  promotedAt:      z.number(),
  ageMs:           z.number(),
  source:          z.string().nullable(),
  symbol:          z.string().nullable(),
  phase:           z.string().nullable(),
  flowAgeMs:       z.number().nullable(),
  largestBuyEth:   z.number(),
  avgBuyEth:       z.number(),
  buySwapCount5m:  z.number(),
  sellSwapCount5m: z.number(),
  flow: z.object({
    pressure: z.string(),
    buys5m:   z.number(),
    hasData:  z.boolean(),
    buyVol5m: z.number(),
    netVol5m: z.number(),
  }).passthrough(),
}).passthrough();
export const HotRecordSchema = z.object({}).catchall(HotEntrySchema);

// armed_entries value = ArmedEntry (toate required; unele nullable).
const ArmedEntrySchema = z.object({
  armedAt:      z.number(),
  ageMs:        z.number(),
  price:        z.number(),
  score:        z.number(),
  flowPressure: z.string(),
  symbol:       z.string().nullable(),
  phase:        z.string().nullable(),
  chain:        z.string().nullable(),
}).passthrough();
export const ArmedRecordSchema = z.object({}).catchall(ArmedEntrySchema);

// worker_snapshot.memory value = PreflightMemoryEntry (required până la `phase`; restul opțional-real,
// dar VALIDAT când e prezent — `discoverySources:"oops"` ar ajunge la allSources.filter → INTERNAL fals).
const MemoryEntrySchema = z.object({
  pairAddress:       z.string(),
  symbol:            z.string(),
  tokenAddress:      z.string(),
  firstSeen:         z.number(),
  lastSeen:          z.number(),
  seenCount:         z.number(),
  priceAtFirstSeen:  z.number(),
  highPrice:         z.number(),
  lowPrice:          z.number(),
  currentPrice:      z.number(),
  totalEntries:      z.number(),
  lastEntryTime:     z.number(),
  lastEntryPrice:    z.number(),
  wins24h:           z.number(),
  losses24h:         z.number(),
  badExits24h:       z.number(),
  consecutiveLosses: z.number(),
  lastExitReason:    z.string().nullable(),
  lastExitTime:      z.number().nullable(),
  phase:             z.enum(PHASES),
  // Opționale reale (absente legitim, JSON.stringify le omite) — DAR validate când prezente.
  chain:                  z.string().optional(),
  priceChange:            z.object({ m5: z.number(), h1: z.number(), h24: z.number() }).passthrough().optional(),
  lastMomentumVerdict:    z.string().nullable().optional(),
  lastMomentumAt:         z.number().nullable().optional(),
  primaryDiscoverySource: z.string().optional(),
  discoverySources:       z.array(z.string()).optional(),
  firstDiscoveredAt:      z.number().optional(),
  lastDiscoveryAt:        z.number().optional(),
  attentionScore:         z.number().optional(),
  monitoringTier:         z.string().optional(),
  patternTags:            z.array(z.string()).optional(),
}).passthrough();
export const MemoryRecordSchema = z.object({}).catchall(MemoryEntrySchema);

// ── Snapshot-uri per-worker ─────────────────────────────────────────────────────

// worker_snapshot = PreflightWorkerSnapshot — TOATE câmpurile required.
export const WorkerSnapshotSchema = z.object({
  version:        z.string(),
  savedAt:        z.number(),
  memory:         MemoryRecordSchema,
  poolReserveEth: z.object({}).catchall(z.number()),
}).passthrough();

// pf_pipeline_coverage.chains value = PreflightChainCoverage (contract COMPLET).
const TopMoverNotWatchedSchema = z.object({
  symbol:      z.string(),
  pairAddress: z.string(),
  m5:          z.number(),
  h1:          z.number(),
  h24:         z.number(),
  reserveUsd:  z.number(),
  phase:       z.enum(PHASES),
  reason:      z.string(),
}).passthrough();
const PipelineChainCoverageSchema = z.object({
  trackedPairs:   z.number(),
  observedMovers: z.number(),
  pipeline: z.object({
    watching: z.number(), hot: z.number(), armed: z.number(), qualified: z.number(),
  }).passthrough(),
  ws: z.object({
    expectedWsSubscriptions: z.number(),
    watchingWithFlow:        z.number(),
    hotWithFlow:             z.number(),
    armedWithFlow:           z.number(),
    coverageOnWatchPct:      z.number(),
    coverageOnPipelinePct:   z.number(),
  }).passthrough(),
  observedMoverCoverage: z.object({
    total: z.number(), inPipeline: z.number(), withFlow: z.number(), notInPipeline: z.number(),
  }).passthrough(),
  topMoversNotWatched: z.array(TopMoverNotWatchedSchema),
}).passthrough();
// pf_pipeline_coverage = PreflightPipelineCoverage — workerVersion/savedAt/chains required.
export const PipelineCoverageSchema = z.object({
  workerVersion: z.string(),
  savedAt:       z.number(),
  chains:        z.object({}).catchall(PipelineChainCoverageSchema),
}).passthrough();

// pf_scanner_stats.scan (reader adună Number(sc.*) + max(durationMs)).
const ScannerScanSchema = z.object({
  durationMs:     z.number(),
  totalFetched:   z.number(),
  processedPools: z.number(),
}).passthrough();
// pf_scanner_stats.chains value = PreflightGeckoChainHealth (contract COMPLET; `status` enum — health check).
const GeckoChainHealthSchema = z.object({
  lastResultCount:  z.number(),
  emptyStreak:      z.number(),
  lastFetchAt:      z.number(),
  last429At:        z.number().nullable(),
  consecutiveEmpty: z.number(),
  status:           z.enum(["OK", "DEGRADED", "RATE_LIMITED", "STANDBY_INDEXER_PRIMARY"]),
}).passthrough();
// pf_scanner_stats.sourceByChain value = PreflightSourceByChainEntry (source/fallbackUsed required, rest opțional).
const SourceByChainEntrySchema = z.object({
  source:        z.enum(["INDEXER_PRIMARY", "INDEXER_FORCED", "GECKO_FALLBACK"]),
  fallbackUsed:  z.boolean(),
  reason:        z.string().optional(),
  indexedCount:  z.number().optional(),
  geckoCount:    z.number().optional(),
  indexedHealth: z.object({ status: z.string(), blocksBehind: z.number().nullable() }).passthrough().optional(),
}).passthrough();
// pf_scanner_stats.dexscreener = PreflightDexscreenerHealth (reader: aritmetică pe age-uri + severitate pe status).
const DexscreenerHealthSchema = z.object({
  lastFetchAgeSec: z.number().nullable(),
  lastResultCount: z.number(),
  last429AgeSec:   z.number().nullable(),
  status:          z.enum(["STARTING", "OK", "DEGRADED", "RATE_LIMITED"]),
}).passthrough();
// pf_scanner_stats = PreflightScannerStats — toate câmpurile principale required.
export const ScannerStatsSchema = z.object({
  savedAt:         z.number(),
  discoverySource: z.string(),
  scan:            ScannerScanSchema,
  chains:          z.object({}).catchall(GeckoChainHealthSchema),
  sourceByChain:   z.object({}).catchall(SourceByChainEntrySchema),
  dexscreener:     DexscreenerHealthSchema,
}).passthrough();

// worker_runtime:{chain} = PreflightWorkerRuntime — chain/updatedAt/wsConnected TOATE required.
export const WorkerRuntimeSchema = z.object({
  chain:       z.string(),
  updatedAt:   z.number(),
  wsConnected: z.boolean(),
}).passthrough();
