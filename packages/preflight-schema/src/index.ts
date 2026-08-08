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
export type PreflightEvmChain =
  | "base"
  | "arbitrum"
  | "ethereum"
  | "bsc";

/**
 * Chain-urile EVM la runtime (pt. iterare/probe — ex. reader-ul MCP care caută
 * pair_context fără să știe chain-ul). Sursa de TIP rămâne PreflightEvmChain;
 * `satisfies` garantează că nu strecori un chain invalid aici.
 */
export const PREFLIGHT_EVM_CHAINS = ["ethereum", "base", "arbitrum", "bsc"] as const satisfies readonly PreflightEvmChain[];

// Global multichain union. EVM-only wire contracts (PreflightPairState,
// PreflightDrop, momentum/pipeline/qualified signals, ChainConfig.id, etc.)
// use PreflightEvmChain instead of this — narrower, so "solana" can never
// slip into a payload that only the EVM worker ever produces. This wider
// union exists for genuinely multichain fields (e.g.
// PreflightMarketContext.chainsActive once Solana is represented there).
export type PreflightChain = PreflightEvmChain | "solana";

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
// NF1: onestitatea flow-ului. "EVENT_ONLY" = pool V4 cu hook return-delta → Swap event-ul poate să NU reflecte
// input/output-ul final (buy/sell + volum posibil incomplete). "UNKNOWN" = V4 dar info hook indisponibilă (nu
// pretindem FULL fals). "FULL" = V2/V3, vanilla V4, sau hook fără return-delta.
export type FlowCoverage    = "FULL" | "EVENT_ONLY" | "UNKNOWN";
export type MomentumLevel   = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
export type MoveType        = "ORGANIC" | "VERTICAL" | "LATE" | "SECOND_WAVE" | "NEW_POOL" | "UNKNOWN";

/**
 * NF1 (varu): câmpul `hooks` din evidence-ul brief-ului — model tri-stare FĂRĂ colaps.
 * V4 + custom (string)   → { hooks: adresa }
 * V4 + vanilla (null)    → { hooks: null }
 * V4 fără info (undefined) SAU non-V4 → {} (PROPRIETATE ABSENTĂ, conditional spread).
 * Consumatorul spread-uiește rezultatul: `{ ...hooksEvidenceField(dexType, hooks) }`.
 * Un hook indisponibil NU apare în JSON (nu ca `null`, care ar minți „vanilla confirmat"),
 * iar non-V4 nu emite deloc câmpul. Sursă unică de adevăr partajată worker↔MCP↔teste.
 */
export function hooksEvidenceField(
  dexType: DexType | undefined,
  hooks: string | null | undefined,
): { hooks?: string | null } {
  if (dexType !== "V4") return {};
  if (typeof hooks === "string") return { hooks };
  if (hooks === null) return { hooks: null };
  return {};
}

// ── Reserve provenance (NF/U5) ─────────────────────────────────────────────────
// Sursa din care a fost derivat `reserveUsd`-ul unei perechi (oglindă a
// ReserveSource din workers/indexer-evm/src/infra/v2Pricing.ts, extinsă cu sursele
// DEX-reported ale worker-ului). Doar `V4_STATE_LIQUIDITY` e un ESTIMAT din virtual
// reserves (StateView.getLiquidity × sqrtPrice × 2) — NU TVL real: supraestimează
// pool-urile cu lichiditate concentrată (o poziție îngustă arată virtual reserves
// uriașe față de TVL-ul real). Restul sunt rezerve reale on-chain (V2 getReserves,
// V3 balanceOf) sau lichiditate raportată de sursa DEX (Gecko/DexScreener).
export type ReserveSource =
  | "V2_RESERVES"          // V2: getReserves() — reale
  | "BALANCE_OF"           // V3: balanceOf(pool) pe ambele token-uri — reale
  | "V4_STATE_LIQUIDITY"   // V4: estimat din active liquidity (virtual reserves ×2) — POATE SUPRAESTIMA
  | "UNKNOWN_V4"           // V4: preț OK dar fără lichiditate activă → reserveUsd 0
  | "GECKO_REPORTED"       // Gecko reserve_in_usd — raportat de sursă
  | "DEXSCREENER_REPORTED" // DexScreener liquidity.usd — raportat de sursă
  | "UNKNOWN";

/**
 * NF/U5: `reserveUsd` provine dintr-un ESTIMAT care poate supraestima (V4 virtual
 * reserves), nu dintr-o rezervă reală/măsurată? Sursă unică de adevăr partajată
 * worker (clasificare liqStatus) ↔ MCP (caveat de raportare) ↔ teste. Doar
 * `V4_STATE_LIQUIDITY` califică — restul sunt reale sau raportate de DEX.
 */
export function isEstimatedReserve(src: ReserveSource | null | undefined): boolean {
  return src === "V4_STATE_LIQUIDITY";
}

/**
 * NF/U5 (R3, varu): flag TRI-STARE pt. output-urile structurate — `true` = estimat (V4_STATE_LIQUIDITY),
 * `false` = rezervă reală/raportată cunoscută, `null` = proveniență NECUNOSCUTĂ (source lipsă sau "UNKNOWN").
 * `false` ar minți „sigur NU e estimat" când de fapt nu știm — deci sursă necunoscută → `null`, nu `false`.
 * (Markerul textual folosește `isEstimatedReserve`: se afișează DOAR când e sigur estimat; absența ≠ afirmație.)
 */
export function reserveEstimatedFlag(src: ReserveSource | null | undefined): boolean | null {
  if (src == null || src === "UNKNOWN") return null; // proveniență necunoscută → onest necunoscut
  return isEstimatedReserve(src);
}

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
  chain:         PreflightEvmChain;
  pairAddress:   string;
  tokenAddress:  string;
  // Only ever "V4"|"V3"|"V2" from buildPairStates()'s own ternary — DexType
  // (which also allows "UNKNOWN") is a safe superset, not a guess.
  dexType:       DexType;
  // NF1: V4 hooks (tri-stare) — `string` custom hook confirmat / `null` vanilla (zero-address) / absent
  // (undefined) = info indisponibilă. Doar pt. V4; V2/V3 îl lasă absent. Coverage-ul din `flow.flowCoverage`.
  hooks?:        string | null;

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
    // NF1: opțional pt. compat cu snapshot-uri vechi; buildPairStates îl scrie mereu ("FULL"/"EVENT_ONLY").
    flowCoverage?: FlowCoverage;
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
  // NF/U5: proveniența lui `reserveUsd` — optional (absent pe snapshot-uri vechi;
  // buildPairStates îl scrie când e cunoscut). `V4_STATE_LIQUIDITY` = estimat din
  // virtual reserves (poate supraestima poziții concentrate) → consumatorii MCP pun
  // caveat, iar liqStatus e clasificat cu prag mai conservator (vezi isEstimatedReserve).
  reserveSource?:     ReserveSource | null;
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
  // (e.g. newly created before its first scan pass completes).
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
  chain:              PreflightEvmChain;
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
  chain:            PreflightEvmChain;
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
  chain:             PreflightEvmChain;
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
  chain:             PreflightEvmChain;
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
  // EVM-only today (workers/evm/src/lib/preflight-redis.ts writes this from
  // its own CHAINS config) — narrow like the other EVM producer fields. If
  // Solana ever merges into a genuinely multichain market context, widen
  // deliberately then.
  chainsActive:          PreflightEvmChain[];
  momentumEventsLast10m: number;
  // Always "fresh" today (workers/evm/src/lib/preflight-redis.ts never
  // computes a different value) — kept as string rather than a narrower
  // literal/enum since it's evidently meant to vary, just doesn't yet.
  contextQuality:        string;
  updatedAt:             number;
}

// B4d-2: fapt de runtime per-chain publicat de fiecare worker. MCP-ul îl citește ca să
// deriveze wsConnectedChains/scanOnlyChains în market_regime (starea WS e per-worker,
// nu e în pair_states). market_context/market_regime NU se mai scriu în Redis — MCP-ul
// le derivă la read-time din pair_states-urile per-chain + acest heartbeat.
export interface PreflightWorkerRuntime {
  chain:       PreflightEvmChain;
  wsConnected: boolean;
  updatedAt:   number;
}

// ── Drop ──────────────────────────────────────────────────────────────────────

export interface PreflightDrop {
  schemaVersion:    string;
  workerVersion:    string;
  chain:            PreflightEvmChain;
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
  chain:         string;
  pairAddress:   string;
  lastOutcome:   LifecycleOutcome;
  lastOutcomeAt: number;
  reason:        string;
  fromState:     "WATCHING" | "HOT" | "ARMED";
}

// ── Pipeline coverage ─────────────────────────────────────────────────────────
// Sursă de adevăr: workers/evm/src/pipeline/coverageSnapshot.ts's
// writeCoverageSnapshot() — observability only (nu schimbă logică de
// watch/pipeline). `states` param acolo e de fapt Record<string,
// PreflightPairState> (buildPairStates()'s own return type, doar netipat
// la call site) — de-a lungul cast-urilor `any` din acest fișier nu era
// nicio formă reală de shape necunoscut, doar lene de tipare.
export interface PreflightChainCoverage {
  trackedPairs:   number;
  observedMovers: number;
  pipeline: {
    watching:  number;
    hot:       number;
    armed:     number;
    // Was `gatePassed` — misleading, this counts qualifiedSignalsBuffer
    // entries (a distinct downstream stage), not "passed the gate" as a
    // generic pipeline concept.
    qualified: number;
  };
  ws: {
    // Estimare, NU un set real de WS subscriptions active — numele vechi
    // (înainte de fix-ul producer-side) sugera greșit contrariul.
    expectedWsSubscriptions: number;
    watchingWithFlow:        number;
    hotWithFlow:              number;
    armedWithFlow:            number;
    coverageOnWatchPct:       number;
    coverageOnPipelinePct:    number;
  };
  observedMoverCoverage: {
    total:         number;
    inPipeline:    number;
    withFlow:      number;
    notInPipeline: number;
  };
  topMoversNotWatched: {
    symbol:      string;
    pairAddress: string;
    m5:          number;
    h1:          number;
    h24:         number;
    reserveUsd:  number;
    phase:       Phase;
    reason:      "not_in_pipeline";
  }[];
}

export interface PreflightPipelineCoverage {
  workerVersion: string;
  savedAt:       number;
  chains:        Record<string, PreflightChainCoverage>;
}

// ── Scanner stats ─────────────────────────────────────────────────────────────
// Sursă de adevăr: workers/evm/src/pipeline/scan.ts's writeScannerStats() +
// state/stores.ts's geckoSourceHealth (Map) / dexscreenerSourceHealth
// (plain object). GeckoHealthStatus moved here from state/stores.ts — same
// re-export pattern as Phase/MonitoringTier — it's written into
// scannerStats.chains[x].status, wire contract too.
export type GeckoHealthStatus = "OK" | "DEGRADED" | "RATE_LIMITED" | "STANDBY_INDEXER_PRIMARY";

export interface PreflightGeckoChainHealth {
  lastResultCount:  number;
  emptyStreak:      number;
  lastFetchAt:      number;
  last429At:        number | null;
  consecutiveEmpty: number;
  status:           GeckoHealthStatus;
}

export interface PreflightDexscreenerHealth {
  lastFetchAgeSec: number | null;
  lastResultCount: number;
  last429AgeSec:   number | null;
  // "STARTING" — worker just booted, no DexScreener request has happened
  // yet. Was defaulting to "OK", which falsely claimed health before any
  // evidence existed.
  status:          "STARTING" | "OK" | "DEGRADED" | "RATE_LIMITED";
}

// Verified against workers/evm/src/pipeline/scan.ts's own FetchResult —
// reason/indexedCount/geckoCount/indexedHealth are optional there too (not
// every field is set on every source branch); fallbackUsed is always set.
export interface PreflightSourceByChainEntry {
  source:         "INDEXER_PRIMARY" | "INDEXER_FORCED" | "GECKO_FALLBACK";
  reason?:        string;
  indexedCount?:  number;
  geckoCount?:    number;
  indexedHealth?: { status: string; blocksBehind: number | null };
  fallbackUsed:   boolean;
}

export interface PreflightScannerStats {
  savedAt:         number;
  discoverySource: string;
  scan: {
    durationMs:     number;
    totalFetched:   number;
    processedPools: number;
  };
  chains:        Record<string, PreflightGeckoChainHealth>;
  sourceByChain: Record<string, PreflightSourceByChainEntry>;
  dexscreener:   PreflightDexscreenerHealth;
}

// ── Solana ────────────────────────────────────────────────────────────────────
// workers/solana e un worker complet separat de workers/evm (nu portăm EVM pe
// Solana — arhitectură diferită: pool discovery via logsSubscribe, nu
// trending/new_pools scan). Solana are propriul namespace de Redis keys
// (workers/solana/src/config/constants.ts, KEY_* locale, nu REDIS_KEYS de
// aici) — item 6 mută doar shape-urile wire, NU unifică key naming, ca să nu
// atingă zeci de call site-uri neconexe cu riscul acestui batch.
//
// "solana" e reprezentat prin PreflightChain (= PreflightEvmChain | "solana",
// vezi secțiunea Chains) — dar niciunul dintre contractele EVM-only de mai
// sus (PreflightPairState, momentum/pipeline/qualified, PreflightDrop,
// chainsActive) nu-l acceptă, fiindcă sunt toate narrowed la
// PreflightEvmChain. Tipurile de mai jos folosesc literalul "solana" direct.

// Sursă de adevăr: workers/solana/src/discovery/quoteNormalizer.ts.
// NOTĂ: observedPool.ts avea o redefinire LOCALĂ, neexportată, a acestui tip
// cu doar 3 din 4 membri ("WSOL"|"STABLE"|"UNKNOWN", lipsea "AMBIGUOUS") —
// drift real, consolidat aici pe forma completă din quoteNormalizer.ts.
export type PreflightSolanaQuoteType = "WSOL" | "STABLE" | "AMBIGUOUS" | "UNKNOWN";

// Programele Raydium care pot fi sursa unui pool în registry. D4c a adăugat `raydium_amm_v4`
// (creare directă de pool via `Initialize2` → discovery pipeline). NOTĂ: `priceTracker.ts`/
// `swapActivity.ts`/`observedPool.ts` produc încă doar cpmm/clmm (sunt scoped pe swap-uri, nu pe
// creare) — widening-ul e sigur (adaugă un caz), nu forțează schimbări acolo.
export type PreflightSolanaProgram = "raydium_cpmm" | "raydium_clmm" | "raydium_amm_v4";

// Sursă de adevăr: workers/solana/src/discovery/pairWriter.ts's SolanaPool —
// DAR wire-ul real e o uniune DISCRIMINATĂ a două write path-uri pe aceeași
// cheie (preflight:indexed:pair:solana:{poolAddress}), nu un singur shape cu
// câmpuri opționale (asta ar fi permis stări imposibile în runtime, ex. un
// record fără `source` ȘI fără `discoveryReason`):
//   1. PreflightIndexedSolanaPool — pairWriter.ts's writeSolanaPool(), calea
//      normală de discovery (LIVE/BACKFILL), `source` mereu prezent.
//   2. PreflightObservedSolanaPool — observedPool.ts's
//      maybeRecordObservedCandidate(), scrie DIRECT un obiect inline
//      (JSON.stringify, fără interfață, fără buildSolanaPool()) pe aceeași
//      cheie când un pool neindexat e promovat din swap samples — `slot`
//      mereu 0 (nu are slot real la promovare), `discoveryReason`/
//      `registrySource`/`registryConfidence`/`sampleCount` mereu prezente.
// Nedocumentat nicăieri altundeva — găsit prin citirea ambelor fișiere, nu
// asumat.
interface PreflightSolanaPoolBase {
  chain:          "solana";
  poolAddress:    string;
  mint0:          string;
  mint1:          string;
  baseMint:       string;
  quoteMint:      string;
  quoteType:      PreflightSolanaQuoteType;
  program:        PreflightSolanaProgram;
  signature:      string;
  discoveredAt:   string;
  indexerVersion: string;
  // Metadata token — populată async după insert, pe ambele write path-uri.
  baseSymbol?:    string;
  quoteSymbol?:   string;
  baseDecimals?:  number | null;
  quoteDecimals?: number | null;
  metaSource?:    string;
}

// `never` fields on each variant exclude the other variant's fields — without
// them this is a plain union of two optional-bag shapes, and TS would accept
// hybrid objects with both `source` AND `discoveryReason` set (impossible in
// real wire JSON: `slot: 0` alone can't discriminate, BACKFILL also uses it).
export interface PreflightIndexedSolanaPool extends PreflightSolanaPoolBase {
  slot:   number;
  source: "BACKFILL" | "LIVE";

  discoveryReason?:    never;
  registrySource?:     never;
  registryConfidence?: never;
  sampleCount?:        never;
}

export interface PreflightObservedSolanaPool extends PreflightSolanaPoolBase {
  slot: 0;

  source?: never;

  discoveryReason:    "OBSERVED_SWAP";
  registrySource:     "SWAP_SAMPLED";
  registryConfidence: "OBSERVED";
  sampleCount:        number;
}

export type PreflightSolanaPool =
  | PreflightIndexedSolanaPool
  | PreflightObservedSolanaPool;

// Sursă de adevăr: workers/solana/src/discovery/observedPool.ts's
// ObservedCandidate — record intermediar (preflight:solana:observed_candidate:
// {pool}, TTL 2h) înainte de promovare în pool registry de mai sus.
export interface PreflightObservedCandidate {
  poolAddress:      string;
  program:          PreflightSolanaProgram;
  baseMint:         string;
  quoteMint:        string;
  baseSymbol:       string;
  quoteSymbol:      string;
  firstSeenAt:      number;
  lastSeenAt:       number;
  sampleCount:      number;
  signatures:       string[];
  lastPriceInQuote: number;
  lastPriceUsd:     number | null;
  promoted:         boolean;
}

// Sursă de adevăr: workers/solana/src/discovery/launchWriter.ts — link către
// un pool Raydium găsit ulterior pentru un launch pump.fun (graduation).
// `program` era `string` local; narrowed aici la fel ca peste tot altundeva —
// linkLaunchToPool() primește mereu `pool.program` din buildSolanaPool(),
// deja tipat PreflightSolanaProgram (item 6a), niciodată un string liber.
export interface PreflightRaydiumPoolLink {
  poolAddress: string;
  program:     PreflightSolanaProgram;
  slot:        number;
  signature:   string;
  linkedAt:    string;
}

// Sursă de adevăr: workers/solana/src/discovery/launchWriter.ts's SolanaLaunch.
// Namespace separat de pool registry de mai sus — launch-urile pump.fun nu
// sunt pool-uri (preflight:indexed:launch:solana:{mint}, fără TTL). Pot
// "graduate" ulterior într-un pool Raydium via linkLaunchToPool(), apelat
// non-blocking din pairWriter.ts's writeSolanaPool() ȘI din
// observedPool.ts's maybeRecordObservedCandidate() (al doilea write path pe
// pool registry — nu apela linkLaunchToPool() deloc înainte de item 6b,
// deci un launch promovat prin OBSERVED_SWAP putea rămâne veșnic
// PUMPFUN_LAUNCHED chiar dacă pool-ul lui era deja în registry).
//
// lifecycleStage/graduated/raydiumPools erau opționale (un "optional bag") —
// dar buildLaunchRecord() nu scria niciodată explicit PUMPFUN_LAUNCHED/
// graduated:false, doar graduation path-ul scria RAYDIUM_POOL_FOUND/true.
// Union discriminată (același pattern ca PreflightSolanaPool, item 6a)
// pentru a exclude combinații imposibile (ex. lifecycleStage:
// PUMPFUN_LAUNCHED + graduated: true simultan).
interface PreflightSolanaLaunchBase {
  chain:                  "solana";
  recordType:             "TOKEN_LAUNCH";
  launchSource:           "PUMPFUN";
  mint:                   string;
  bondingCurveAddress:    string;
  associatedBondingCurve: string;
  creatorAddress:         string;
  slot:                   number;
  signature:              string;
  discoveredAt:           string;
  indexerVersion:         string;
  metadataStatus:         "PENDING" | "ENRICHED" | "FAILED";
  // Metadata token — populată async (enrichLaunchRecord, Jupiter, delay
  // 30s/2m/10m înainte de fiecare încercare).
  symbol?:                string;
  name?:                  string;
  decimals?:              number | null;
  metaSource?:            string;
}

export interface PreflightPumpfunLaunch extends PreflightSolanaLaunchBase {
  lifecycleStage: "PUMPFUN_LAUNCHED";
  graduated:      false;
  graduatedAt?:   never;
  // Tuple gol — un launch nu poate fi PUMPFUN_LAUNCHED și avea deja
  // raydiumPools populat (graduation e ce schimbă ambele simultan).
  raydiumPools:   [];
}

export interface PreflightGraduatedSolanaLaunch extends PreflightSolanaLaunchBase {
  lifecycleStage: "RAYDIUM_POOL_FOUND";
  graduated:      true;
  graduatedAt:    string;
  // NU un tuple non-gol ([X, ...X[]]) — deși graduation garantează runtime
  // cel puțin un pool, `linkLaunchToPool()` construiește array-ul din
  // `[...existing, link]` unde `existing` e deja lărgit la `X[]` simplu (de
  // la `launch.raydiumPools ?? []` peste o uniune) — TS nu poate demonstra
  // static lungimea ≥1 din acel spread, deci ar forța fie reordonarea
  // array-ului (prepend în loc de append, schimbă semantica cronologică),
  // fie un cast care anulează exact ce vrem să garantăm. Non-empty rămâne
  // garantat doar de logica de business (linkLaunchToPool), nu de tip.
  raydiumPools:   PreflightRaydiumPoolLink[];
}

export type PreflightSolanaLaunch =
  | PreflightPumpfunLaunch
  | PreflightGraduatedSolanaLaunch;

// Sursă de adevăr: workers/solana/src/discovery/priceTracker.ts's PriceSnapshot.
// Preț aproximativ per pool din vault deltas (SWAP_VAULT_DELTA sampling, nu
// firehose) — scris pentru ORICE pool cu flow cunoscut, indiferent dacă e
// deja în registry (`knownPool` distinge cele două cazuri; observedPool.ts
// citește exact acest semnal ca să decidă promovarea).
export interface PreflightSolanaPriceSnapshot {
  poolAddress:   string;
  program:       PreflightSolanaProgram;
  baseMint:      string;
  quoteMint:     string;
  baseSymbol:    string;
  quoteSymbol:   string;
  priceInQuote:  number;
  priceUsd:      number | null;
  usdSource:     "STABLE_QUOTE" | "SOL_USD_ORACLE" | null;
  solUsdPrice?:  number;
  lastUpdatedAt: number;
  lastSignature: string;
  source:        "SWAP_VAULT_DELTA";
  coverage:      "SAMPLED";
  knownPool:     boolean;
}

// Ring buffer entry — preflight:solana:price:history:{pool}, max 60, TTL 2h.
export interface PreflightSolanaPricePoint {
  p:  number; // priceInQuote la momentul ts
  ts: number; // Unix ms
}

// Sursă de adevăr: workers/solana/src/discovery/moversTracker.ts.
// NOTĂ: acest `historyStatus` NU are legătură cu `historyStatus` EVM
// ("WARMING_UP"|"PARTIAL"|"READY", din trending movers EVM — alt fișier,
// alt shape) — nume similar, concepte diferite, la fel ca
// LiquidityStatus/FlowStatus (item 5c). Nu unifica.
export type PreflightSolanaHistoryStatus = "READY" | "PARTIAL" | "INSUFFICIENT" | "STALE";

export interface PreflightSolanaMover {
  chain:               "solana";
  poolAddress:         string;
  program:             PreflightSolanaProgram;
  baseMint:            string;
  quoteMint:           string;
  baseSymbol:          string;
  quoteSymbol:         string;
  priceInQuote:        number;
  priceUsd:            number | null;
  priceChange5mPct:    number | null;
  priceChange1hPct:    number | null;
  sampleCount:         number;
  currentAgeSec:       number;
  oldestSampleAgeSec:  number;
  historyStatus:       PreflightSolanaHistoryStatus;
  coverage:            "SAMPLED";
  source:              "SWAP_VAULT_DELTA";
  knownPool:           boolean;
  lastUpdatedAt:       number;
  computedAt:          number;
}

export interface PreflightSolanaMoversSnapshot {
  chain:        "solana";
  computedAt:   number;
  windowMs:     number;
  totalTracked: number;
  movers:       PreflightSolanaMover[];
}

// Sursă de adevăr: workers/solana/src/discovery/swapActivity.ts's PoolActivity.
// Doar pentru pool-uri knownPool:true (guard strict, zero writes altfel) —
// fereastră rolling 5min, resetată pe boundary. `sampledQuoteIn5m`/
// `sampledQuoteOut5m` sunt BigInt serializate ca string (JSON.stringify nu
// suportă BigInt nativ).
export interface PreflightSolanaPoolActivity {
  poolAddress:       string;
  program:           PreflightSolanaProgram;
  sampledSwaps5m:    number;
  sampledQuoteIn5m:  string;
  sampledQuoteOut5m: string;
  coverage:          "SAMPLED";
  windowStart:       number;
  lastSwapAt:        number;
  lastFlow:          "QUOTE_IN" | "QUOTE_OUT" | "UNKNOWN";
  lastSignature:     string;
}

// Sursă de adevăr: workers/solana/src/infra/health.ts. NOTĂ: mcp's
// `SolanaHealthData` (redis-reader.ts) adaugă un al 5-lea status,
// `"OFFLINE"`, ca stare derivată read-model (health lipsă/stale/corupt) —
// nu există niciodată pe wire-ul scris de worker, deci nu e parte din
// `PreflightSolanaSlotStatus`.
export type PreflightSolanaSlotStatus = "OK" | "DEGRADED" | "BEHIND" | "STARTING";

// ── D2: freshness per-program (per-subscripție WS) ──
// Un program de discovery a cărui subscripție onLogs moare tăcut nu mai apare aici ca proaspăt,
// chiar dacă `behindSlots` rămâne mic (alte programe avansează observed slot).
export interface PreflightSolanaProgramHealth {
  program:      string;         // ex. "pumpfun", "raydium_clmm"
  critical:     boolean;        // dacă staleness-ul lui poate degrada statusul (vs. doar diagnostic)
  lastLogAgeMs: number | null;  // ms de la ultimul log (null = niciodată văzut de la pornire)
  lastSlot:     number | null;  // cel mai mare slot văzut pt. program
  stale:        boolean;        // n-a mai livrat logs în fereastra așteptată
}

export interface PreflightSolanaHealth {
  chain:          "solana";
  version:        string;
  latestSlot:     number;
  cursorSlot:     number | null;   // C6: OBSERVED slot (liveness WS). Alias istoric „cursor".
  behindSlots:    number;          // C6: latest - observed (liveness), NU procesare.
  status:         PreflightSolanaSlotStatus;
  updatedAt:      string;
  indexerVersion: string;
  // ── C6: integritate write durabil (opționale — absente pe blob-uri pre-C6) ──
  processedSlot?:    number | null;  // cel mai mare slot cu record scris durabil
  lastProcessedAt?:  string | null;  // ISO — când a reușit ultima scriere durabilă
  pendingCount?:     number;         // candidați în așteptare în coada de discovery
  processingCount?:  number;         // candidați revendicați, în procesare (cu lease)
  deadCount?:        number;         // candidați picați definitiv (dead-letter) = pierdere reală
  // ── D2: freshness per-program (opționale — absente pe blob-uri pre-D2) ──
  programHealth?:             PreflightSolanaProgramHealth[]; // freshness per subscripție WS
  staleProgramCount?:         number;                          // TOATE programele stale (inclusiv diagnostic-only)
  staleCriticalProgramCount?: number;                          // doar cele CRITICE stale (>0 → status ≥ DEGRADED)
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

/**
 * Canonical chain id for Redis keys + worker state.
 * Workers store Ethereum mainnet as "ethereum"; external enums / URLs / Gecko
 * network ids use the short code "eth". Normalize so risk caches, lookups and
 * chain filters never split across the two spellings. Loose string in/out —
 * inputs cross a trust boundary (user args, Gecko token-id prefixes). Every
 * other chain passes through unchanged (lowercased + trimmed).
 */
export function normalizeChainId(chain: string): string {
  const c = chain.toLowerCase().trim();
  return c === "eth" ? "ethereum" : c;
}

/**
 * Cheia canonică de identitate a unei perechi: `${chain}:${address}` (chain
 * normalizat, adresă normalizată per-chain — EVM lowercase, Solana case-sensitiv).
 * Aceeași adresă pe chainuri diferite → chei DIFERITE — elimină coliziunea (P0-1)
 * din map-urile in-process și lookup-urile MCP. De folosit peste tot în locul
 * cheilor doar-adresă (Faza B).
 */
export type PairKey = `${string}:${string}`;

/**
 * Normalizează adresa în funcție de chain: EVM → lowercase (hex e
 * case-insensitive), Solana → case-PĂSTRAT (base58 e case-sensitive,
 * lowercasing corupe adresa). Mereu trim. Fără asta, pairKey("solana", "AeGB…")
 * ar produce o cheie care nu mai corespunde adresei reale on-chain.
 */
export function normalizePairAddress(chain: string, address: string): string {
  const trimmed = address.trim();
  return normalizeChainId(chain) === "solana" ? trimmed : trimmed.toLowerCase();
}

export function pairKey(chain: string, address: string): PairKey {
  const chainId = normalizeChainId(chain);
  return `${chainId}:${normalizePairAddress(chainId, address)}` as PairKey;
}

/** Referință decodată a unei perechi (rezultatul lui splitPairKey). */
export interface PairRef { chain: string; address: string; }

/**
 * Inversul lui pairKey: sparge `${chain}:${address}` în componente. Split pe
 * PRIMUL `:` — chain-ul e mereu un cuvânt fără `:`, iar adresele (hex EVM /
 * base58 Solana) nu conțin `:`, deci despărțirea e neambiguă. Folosit de
 * PairMap ca să itereze cu cheia decodată.
 */
// Acceptă `string` (nu doar `PairKey`) — cheile din `Object.entries(map)` sunt
// tipate `string` de TS, iar funcția suportă explicit chei legacy fără `:`.
export function splitPairKey(key: string): PairRef {
  const i = key.indexOf(":");
  return i < 0
    ? { chain: "", address: key }
    : { chain: key.slice(0, i), address: key.slice(i + 1) };
}

export const REDIS_KEYS = {
    
  // Pipeline state — B4: chain-scoped (chei per-chain, TTL/liveness independent).
  // Un worker per-chain scrie DOAR cheia lui; MCP citește toate PREFLIGHT_EVM_CHAINS
  // și agregă. Valorile sunt deja keyed pe pairKey (B3) → keysets chain-disjuncte.
  pairStates:      (chain: string) => `preflight:pair_states:${normalizeChainId(chain)}`,
  activeWatch:     (chain: string) => `preflight:active_watch:${normalizeChainId(chain)}`,
  hotCandidates:   (chain: string) => `preflight:hot_candidates:${normalizeChainId(chain)}`,
  armedEntries:    (chain: string) => `preflight:armed_entries:${normalizeChainId(chain)}`,
  workerSnapshot:  (chain: string) => `preflight:worker_snapshot:${normalizeChainId(chain)}:latest`,
  recentDrops:     (chain: string) => `preflight:recent_drops:${normalizeChainId(chain)}`,
  pipelineEvents:  (chain: string) => `preflight:pipeline_events:${normalizeChainId(chain)}`,

  // Context
  // ⚠️ B4d-2/B5: market_context/market_regime au fost ELIMINATE din REDIS_KEYS — MCP le
  // derivă la read-time din snapshot-urile per-chain. Tipurile MarketContext/MarketRegime
  // rămân (folosite de reader); doar cheile Redis au fost scoase (nimic nu le mai scrie).
  workerRuntime:      (chain: string) => `preflight:worker_runtime:${normalizeChainId(chain)}`,
  momentumEvents:     (chain: string) => `preflight:momentum_events:${normalizeChainId(chain)}`,
  signalPipeline:     (chain: string) => `preflight:signal_pipeline:${normalizeChainId(chain)}`,
  qualifiedSignals:   (chain: string) => `preflight:qualified_signals:${normalizeChainId(chain)}`,
  pipelineCoverage:   (chain: string) => `preflight:pipeline_coverage:${normalizeChainId(chain)}`,
  scannerStats:       (chain: string) => `preflight:scanner_stats:${normalizeChainId(chain)}`,
  agentWatchRequests: (chain: string) => `preflight:agent_watch_requests:${normalizeChainId(chain)}`,
  lifecycle:          (chain: string) => `preflight:lifecycle:${normalizeChainId(chain)}`,

  // Per-pair, chain-scoped (Faza B2). pairContext e EVM-only în practică, dar
  // trecem prin pairKey pt. consistență (elimină coliziunea cross-chain P0-1).
  // Reader-ul MCP probează PREFLIGHT_EVM_CHAINS când chain-ul nu e dat.
  pairContext:       (chain: string, addr: string) => `preflight:pair_context:${pairKey(chain, addr)}`,
  risk:              (chain: string, token: string) => `preflight:risk:${normalizeChainId(chain)}:${token.toLowerCase()}`,

  // 6.10 — Own trending (chain normalizat + Solana case-safe via pairKey)
  trendingSnapshot:  (chain: string, addr: string) => `preflight:trending:snapshot:${pairKey(chain, addr)}`,
  trendingMovers:    (chain: string) => `preflight:trending:movers:${normalizeChainId(chain)}`,
} as const;

export const SCHEMA_VERSION = "preflight-schema-v2";  // B5: bump — schema per-chain post-B4 (marker de observabilitate; NU e gated la citire)
