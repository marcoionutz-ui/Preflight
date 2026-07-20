/**
 * lib/mcp/redis-reader.ts
 * Redis reads + helper functions — preflight:* first, supreme:* fallback
 */

import { getRedis }  from "@/lib/db/redis";
import type {
  PairState, MemoryEntry, WatchEntry, HotEntry,
  ArmedEntry, WorkerSnapshot, MarketRegime,
  PipelineEvent, RedisContext, LifecycleEntry, PipelineCoverage, ScannerStats,
} from "./types";
import {
  REDIS_KEYS,
  PREFLIGHT_EVM_CHAINS,
  normalizeChainId,
  pairKey,
  type PreflightMarketContext, type PreflightDrop,
  type PreflightMomentumEvent, type PreflightSignalPipelineEntry, type PreflightQualifiedSignal,
  type PreflightSolanaPool, type PreflightObservedCandidate, type PreflightSolanaQuoteType,
  type PreflightSolanaLaunch,
  type PreflightSolanaPriceSnapshot, type PreflightSolanaPricePoint,
  type PreflightSolanaProgram, type PreflightSolanaHistoryStatus,
  type PreflightSolanaMover, type PreflightSolanaMoversSnapshot,
  type PreflightSolanaHealth, type PreflightSolanaPoolActivity,
} from "@preflight/schema";

function safeJson<T>(raw: string | null, fallback: T, key?: string): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    if (key) {
      console.warn(
        `[REDIS PARSE ERROR] key:${key} — invalid JSON, using fallback`,
        err instanceof Error ? err.message : err,
      );
    }
    return fallback;
  }
}

// ── Redis read ────────────────────────────────────────────────────────────────

export async function readAllRedis(): Promise<RedisContext | null> {
  const r = getRedis();
  if (!r) return null;

  // B4: pair_states/active_watch/hot_candidates/armed_entries/worker_snapshot sunt
  // chain-scoped (o cheie per-chain) → MGET peste PREFLIGHT_EVM_CHAINS + merge mai jos.
  const evmChains = PREFLIGHT_EVM_CHAINS;
  const [
    statesRaws, watchRaws, hotRaws, armedRaws, snapshotRaws,
    regimeRaw, eventsRaw, dropsRaw,
    pfMarketRaw, pfMomentumRaw, pfPipelineRaw, pfQualifiedRaw,
    pfCoverageRaw, pfScannerStatsRaw, pfLifecycleRaw,
  ] = await Promise.all([
    r.mget(...evmChains.map(c => REDIS_KEYS.pairStates(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.activeWatch(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.hotCandidates(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.armedEntries(c))),
    r.mget(...evmChains.map(c => REDIS_KEYS.workerSnapshot(c))),
    r.get(REDIS_KEYS.marketRegime),
    r.get(REDIS_KEYS.pipelineEvents),
    r.get(REDIS_KEYS.recentDrops),
    r.get(REDIS_KEYS.marketContext),
    r.get(REDIS_KEYS.momentumEvents),
    r.get(REDIS_KEYS.signalPipeline),
    r.get(REDIS_KEYS.qualifiedSignals),
    r.get(REDIS_KEYS.pipelineCoverage),
    r.get(REDIS_KEYS.scannerStats),
    r.get(REDIS_KEYS.lifecycle),
  ]);

  const now = Date.now();

  // B4: merge cheile per-chain. Keysets-urile sunt pairKey (B3) → chain-disjuncte,
  // deci Object.assign nu pierde nimic. `any` = a existat vreo cheie (keyExists).
  const mergeChainObjects = <T,>(raws: (string | null)[], label: string): { merged: Record<string, T>; any: boolean } => {
    const merged: Record<string, T> = {};
    let any = false;
    for (const raw of raws) {
      if (raw == null) continue;
      any = true;
      Object.assign(merged, safeJson<Record<string, T>>(raw, {}, label));
    }
    return { merged, any };
  };
  const statesM = mergeChainObjects<PairState>(statesRaws, "pair_states");
  const watchM  = mergeChainObjects<WatchEntry>(watchRaws, "active_watch");
  const hotM    = mergeChainObjects<HotEntry>(hotRaws, "hot_candidates");
  const armedM  = mergeChainObjects<ArmedEntry>(armedRaws, "armed_entries");

  // worker_snapshot: {memory, poolReserveEth, savedAt, version} → merge sub-obiectele
  // (savedAt = cel mai recent între chain-uri).
  const mergeSnapshot = (raws: (string | null)[]): WorkerSnapshot | null => {
    const memory:         Record<string, unknown> = {};
    const poolReserveEth: Record<string, unknown> = {};
    let savedAt: number | null = null;
    let version: string | null = null;
    let any = false;
    for (const raw of raws) {
      if (raw == null) continue;
      const snap = safeJson<WorkerSnapshot | null>(raw, null, "worker_snapshot");
      if (!snap) continue;
      any = true;
      Object.assign(memory,         (snap as any).memory ?? {});
      Object.assign(poolReserveEth, (snap as any).poolReserveEth ?? {});
      const sv = (snap as any).savedAt;
      if (typeof sv === "number" && (savedAt === null || sv > savedAt)) {
        savedAt = sv;
        version = (snap as any).version ?? null; // versiunea vine din snapshot-ul cel mai NOU
      } else if (savedAt === null) {
        version = version ?? (snap as any).version ?? null; // fallback: niciun savedAt numeric
      }
    }
    return any ? ({ memory, poolReserveEth, savedAt, version } as unknown as WorkerSnapshot) : null;
  };
  const snapshotMerged = mergeSnapshot(snapshotRaws);

  const eventsFinal   = eventsRaw; // pipeline_events rămâne supreme pentru acum

  // drops and pfDrops used to each JSON.parse() the same recentDrops blob
  // into two incompatible interfaces (RecentDrop's previousState/reason vs
  // PreflightDrop's wasIn/dropReason) — only the latter ever matched what's
  // actually written. Parse once, share the result; pfDrops stays null when
  // the key itself is genuinely missing (vs. drops' [] fallback), since
  // some consumers use pfDrops' nullability to distinguish "no key" from
  // "key present but empty".
  const parsedDrops = safeJson<PreflightDrop[]>(dropsRaw, [], REDIS_KEYS.recentDrops);

  return {
    now,
    states:   statesM.merged,
    watch:    watchM.merged,
    hot:      hotM.merged,
    armed:    armedM.merged,
    snapshot: snapshotMerged,
    // Was `pfMarketRaw ?? regimeRaw` — pfMarketRaw is preflight:market_context
    // JSON (schemaVersion/regime/buyingPct/chainsActive/...), a completely
    // different shape from the legacy MarketRegime interface
    // (buyingPctAll/hotCount/wsConnectedChains/...) this field claims to be.
    // Whenever market_context existed (i.e. almost always), `regime` here
    // silently held a mistyped PreflightMarketContext instead of a
    // MarketRegime — harmless in practice only because every consumer used
    // to merge `pfMarket ?? regime as any` and prefer pfMarket first. Now
    // parses only its own key, and every consumer reads per-field fallbacks
    // (`pfMarket?.x ?? regime?.x`) instead of merging the two shapes.
    regime:   safeJson<MarketRegime | null>        (regimeRaw, null, "market_regime"),
    events:   safeJson<PipelineEvent[]>            (eventsFinal, [],   "pipeline_events"),
    drops:   parsedDrops,
    pfMarket:         safeJson<PreflightMarketContext | null>(pfMarketRaw, null, "pf_market"),
    pfMomentum:       safeJson<PreflightMomentumEvent[] | null>(pfMomentumRaw, null, "pf_momentum"),
    pfPipeline:       safeJson<PreflightSignalPipelineEntry[] | null>(pfPipelineRaw, null, "pf_pipeline"),
    pfQualified:      safeJson<PreflightQualifiedSignal[] | null>(pfQualifiedRaw, null, "pf_qualified"),
    pfDrops: dropsRaw !== null ? parsedDrops : null,
    pipelineCoverage: safeJson<PipelineCoverage | null>(pfCoverageRaw, null, "pf_pipeline_coverage"),
    scannerStats:     safeJson<ScannerStats | null>(pfScannerStatsRaw, null, "pf_scanner_stats"),
    pfLifecycle:      safeJson<LifecycleEntry[] | null>(pfLifecycleRaw, null, "pf_lifecycle"),
    keyExists: {
      pair_states:          statesM.any,
      active_watch:         watchM.any,
      hot_candidates:       hotM.any,
      armed_entries:        armedM.any,
      worker_snapshot:      snapshotMerged !== null,
      market_regime:        regimeRaw   !== null,
      pipeline_events:      eventsRaw   !== null,
      recent_drops:         dropsRaw    !== null,
      pf_market:            pfMarketRaw    !== null,
      pf_momentum:          pfMomentumRaw  !== null,
      pf_pipeline:          pfPipelineRaw  !== null,
      pf_qualified:         pfQualifiedRaw !== null,
      pf_drops:             dropsRaw    !== null,
      pf_pipeline_coverage: pfCoverageRaw     !== null,
      pf_scanner_stats:     pfScannerStatsRaw !== null,
      pf_lifecycle:         pfLifecycleRaw    !== null,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function freshnessLabel(ageMs: number | null): "fresh" | "aging" | "stale" | "unknown" {
  if (ageMs === null) return "unknown";
  if (ageMs < 45_000) return "fresh";
  if (ageMs < 90_000) return "aging";
  return "stale";
}

export function safeMinAge(entries: number[]): number | null {
  if (!entries.length) return null;
  return Date.now() - Math.max(...entries);
}

export function formatAge(ms: number): string {
  if (ms < 60_000)   return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3600_000)}h`;
}

// Native currency symbol pe chain — folosit de formatEth() ca să nu mai
// afișeze " ETH" hardcodat pe chain-uri non-Ethereum (ex: BSC arată BNB).
export function nativeSymbolForChain(chain: string | null | undefined): string {
  switch (chain?.toLowerCase()) {
    case "bsc":      return "BNB";
    case "eth":
    case "ethereum":
    case "base":
    case "arbitrum": return "ETH";
    // Chain necunoscut/nenormalizat — "native" în loc de a eticheta greșit
    // cu ETH; consistent cu restul aplicației care preferă "nu știu" în loc
    // de o afirmație falsă (vezi coverage=SAMPLED, confidence LOW etc).
    default:         return "native";
  }
}

export function formatEth(val: number, chain?: string | null): string {
  return `${val.toFixed(3)} ${nativeSymbolForChain(chain)}`;
}

export function formatVol(usd: number | null | undefined, legacyNativeEq: number): string {
  if (typeof usd === "number" && Number.isFinite(usd)) {
    const sign = usd < 0 ? "-" : "";
    const abs  = Math.abs(usd);
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000)     return `${sign}$${(abs / 1_000).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(0)}`;
  }
  return `${legacyNativeEq.toFixed(3)} nativeEq`;
}

export function getPipelineState(
  // B3f: `key` e `pairKey(chain, addr)` — hărțile sunt keyed pe pairKey.
  // Callerii cu adresă brută rezolvă cheia întâi (resolvePairChain); callerii
  // care iterează pasează cheia iterată (care ESTE pairKey).
  key:   string,
  watch: Record<string, WatchEntry>,
  hot:   Record<string, HotEntry>,
  armed: Record<string, ArmedEntry>,
): "WATCHING" | "HOT" | "ARMED" | "NONE" {
  if (armed[key]) return "ARMED";
  if (hot[key])   return "HOT";
  if (watch[key]) return "WATCHING";
  return "NONE";
}

// B3f: events/drops sunt ARRAY-uri multi-chain — un match pe adresă brută poate
// prinde evenimentul de pe alt chain (aceeași adresă pe base ȘI arbitrum). Ambele
// tipuri au `.chain` (required), deci matchuim pe identitatea completă pairKey.
export function findLastEventForPair(chain: string, addr: string, events: PipelineEvent[]): PipelineEvent | null {
  const key = pairKey(chain, addr);
  return events.find(e => e.chain != null && pairKey(e.chain, e.pairAddress) === key) ?? null;
}

export function findLastDropForPair(chain: string, addr: string, drops: PreflightDrop[]): PreflightDrop | null {
  const key = pairKey(chain, addr);
  return drops.find(d => d.chain != null && pairKey(d.chain, d.pairAddress) === key) ?? null;
}

/**
 * B3f: rezolvă chain-ul unei adrese din array-uri istorice (events/drops/
 * lifecycle) — folosit când adresa NU mai e în live maps (ex. pair dropat, pt.
 * care `resolvePairChain` pe hărți nu găsește chain-ul). Întoarce chain-urile
 * canonice DISTINCTE care conțin adresa; caller-ul decide: 1 → îl folosește,
 * >1 → ambiguu (cere chain), 0 → not-found. Items fără `.chain` sunt ignorate.
 */
export function chainsForAddressInArrays(
  addr: string,
  arrays: Array<ReadonlyArray<{ pairAddress?: string | null; chain?: string | null }> | null | undefined>,
): string[] {
  const norm  = addr.toLowerCase();
  const found = new Set<string>();
  for (const arr of arrays) {
    for (const item of arr ?? []) {
      if (item.chain && (item.pairAddress ?? "").toLowerCase() === norm) {
        found.add(normalizeChainId(item.chain));
      }
    }
  }
  return [...found];
}

/**
 * Rezultatul căutării pair_context. Faza B2: cheile sunt chain-scoped, deci
 * lookup-ul fără chain poate găsi aceeași adresă pe >1 chain EVM. În loc să
 * alegem tăcut primul (coliziunea exact pe care B2 o elimină), raportăm
 * ambiguitatea ca să cerem chain explicit.
 */
export interface PairContextLookup {
  context:         any | null;
  matchedChain:    string | null;
  ambiguousChains: string[];
}

export async function readPairContext(addr: string, chain?: string): Promise<PairContextLookup> {
  const r = getRedis();
  if (!r) return { context: null, matchedChain: null, ambiguousChains: [] };
  try {
    // Cu chain (hint din tool) → GET direct pe cheia chain-scoped.
    if (chain) {
      const canonicalChain = normalizeChainId(chain);
      const raw = await r.get(REDIS_KEYS.pairContext(canonicalChain, addr));
      return {
        context:         raw ? JSON.parse(raw) : null,
        matchedChain:    raw ? canonicalChain : null,
        ambiguousChains: [],
      };
    }
    // Fără chain → probăm chain-urile EVM cunoscute printr-un singur MGET
    // (pair_context e scris DOAR de worker-evm pt. perechi EVM).
    const keys = PREFLIGHT_EVM_CHAINS.map(c => REDIS_KEYS.pairContext(c, addr));
    const raws = await r.mget(...keys);
    const hits = raws
      .map((raw, i) => ({ raw, chain: PREFLIGHT_EVM_CHAINS[i] }))
      .filter((x): x is { raw: string; chain: typeof PREFLIGHT_EVM_CHAINS[number] } => x.raw !== null);

    if (hits.length === 0) return { context: null, matchedChain: null, ambiguousChains: [] };
    if (hits.length > 1)   return { context: null, matchedChain: null, ambiguousChains: hits.map(h => h.chain) };
    return { context: JSON.parse(hits[0].raw), matchedChain: hits[0].chain, ambiguousChains: [] };
  } catch {
    return { context: null, matchedChain: null, ambiguousChains: [] };
  }
}

/**
 * B3f: hărțile live in-process (states/watch/hot/armed/snapshot.memory/
 * poolReserveEth) sunt acum keyed pe `pairKey(chain, addr)`. Un lookup cu
 * adresă brută (de la user sau dintr-un array cu pairAddress) trebuie să
 * cunoască chain-ul ca să construiască cheia.
 *
 * - Cu `hint` (chain din tool) → construim direct `pairKey(hint, addr)`.
 * - Fără hint → probăm chain-urile EVM: construim `pairKey(c, addr)` și
 *   verificăm prezența în oricare din hărțile date. Dacă adresa apare pe
 *   >1 chain raportăm ambiguitatea (NU alegem tăcut primul — aceeași regulă
 *   ca `readPairContext`). Fără hit → `key: null` (lookup-urile cad pe
 *   not-found, exact ca înainte).
 *
 * `maps` = hărțile pairKey-keyed pe care se va face lookup (indexate cu cheia
 * întoarsă); e suficient să dai câteva (ex. states/watch/hot/armed/memory).
 */
export function resolvePairChain(
  addr: string,
  maps: Array<Record<string, unknown> | null | undefined>,
  hint?: string | null,
): { chain: string | null; key: string | null; ambiguousChains: string[] } {
  if (hint) {
    const c = normalizeChainId(hint);
    return { chain: c, key: pairKey(c, addr), ambiguousChains: [] };
  }
  const found: string[] = [];
  for (const c of PREFLIGHT_EVM_CHAINS) {
    const k = pairKey(c, addr);
    if (maps.some(m => m != null && m[k] !== undefined)) found.push(c);
  }
  if (found.length === 1) return { chain: found[0], key: pairKey(found[0], addr), ambiguousChains: [] };
  if (found.length > 1)   return { chain: null,     key: null,                    ambiguousChains: found };
  return { chain: null, key: null, ambiguousChains: [] };
}

// ── Pas 7B helpers ────────────────────────────────────────────────────────────

/**
 * Formatează un procent cu cap și protecție NaN/Infinity/null.
 */
export function formatPct(
  v:   number | null | undefined,
  cap = 9999,
): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "N/A";
  if (v >  cap) return `>${cap}%`;
  if (v < -cap) return `<-${cap}%`;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/**
 * Derivă calitatea WS flow pentru un tool — pair-level sau global.
 * hasPairFlow: true dacă pair-ul specific are flow.hasData
 * coveragePct: flowCoveragePct global (0-100)
 */
export function wsFlowQuality(
  hasPairFlow: boolean,
  coveragePct: number | null | undefined,
): "present" | "partial" | "absent" {
  if (hasPairFlow) return "present";
  if ((coveragePct ?? 0) > 0) return "partial";
  return "absent";
}

/**
 * Combină freshness + coverage în confidence.
 * hasDirectFlow = true: pair-ul are WS flow real → nu penaliza pentru coverage global mic.
 */
export function combineConfidence(
  freshnessSec:  number | null,
  coveragePct:   number | null | undefined,
  hasDirectFlow = false,
): "LOW" | "MEDIUM" | "HIGH" {
  const freshnessConfidence: "LOW" | "MEDIUM" | "HIGH" =
    freshnessSec !== null && freshnessSec < 45 ? "HIGH"   :
    freshnessSec !== null && freshnessSec < 90 ? "MEDIUM" :
    "LOW";

  // Pair cu flow direct — nu penaliza pentru coverage global mic
  if (hasDirectFlow) return freshnessConfidence;

  const cov = coveragePct ?? null;
  if (cov === null) return freshnessConfidence;
  if (cov < 20) return "LOW";
  if (cov < 50 && freshnessConfidence === "HIGH") return "MEDIUM";
  return freshnessConfidence;
}

/**
 * Dedupe un array by pairAddress, păstrând cel mai recent entry.
 * Atașează `_eventCount` cu numărul total de intrări pentru același pair.
 * tsField: câmpul timestamp folosit pentru comparație (droppedAt, detectedAt, etc.)
 */
export function dedupeByPair<T extends { pairAddress?: string | null; chain?: string | null }>(
  arr:     T[] | null | undefined,
  tsField: keyof T,
): Array<T & { _eventCount: number }> {
  const map = new Map<string, T & { _eventCount: number }>();

  for (const item of arr ?? []) {
    const rawAddr = item.pairAddress?.trim();
    if (!rawAddr) continue;

    // B3f: identitatea de dedupe e chain-scoped când itemul are `.chain` — altfel
    // un drop pe base:0xabc și unul pe arbitrum:0xabc s-ar comprima într-unul.
    // Fallback la adresă lowercase pt. items fără chain (ex. momentum legacy).
    const identity = typeof item.chain === "string" && item.chain
      ? pairKey(item.chain, rawAddr)
      : rawAddr.toLowerCase();

    const ts       = Number(item[tsField] ?? 0);
    const existing = map.get(identity);

    if (!existing) {
      map.set(identity, { ...item, _eventCount: 1 });
    } else if (ts >= Number(existing[tsField] ?? 0)) {
      map.set(identity, { ...item, _eventCount: existing._eventCount + 1 });
    } else {
      existing._eventCount += 1;
    }
  }

  return [...map.values()];
}

export { type MemoryEntry, type PairState };

// ── 6.11: Quote price health readers ─────────────────────────────────────────

// ── Oracle freshness (Chainlink cache keys) ───────────────────────────────────

export interface QuoteOracleEntry {
  price:   number;
  ageSec:  number;
  fresh:   boolean;   // ageSec < 300 (TTL Chainlink cache)
  source:  "CHAINLINK" | "MISSING";
}

const CHAINLINK_CHAINS: Array<{ chain: string; symbol: string }> = [
  { chain: "ethereum", symbol: "ETH" },
  { chain: "base",     symbol: "ETH" },
  { chain: "arbitrum", symbol: "ETH" },
  { chain: "bsc",      symbol: "BNB" },
];

/**
 * Citește Chainlink cache keys și raportează oracle freshness per chain.
 * Nu spune câte pairs folosesc sursa asta — pentru aia e readQuotePriceHealth().
 */
export async function readQuoteOracleHealth(): Promise<Record<string, Record<string, QuoteOracleEntry>>> {
  const r = getRedis();
  if (!r) return {};
  const now    = Date.now();
  const result: Record<string, Record<string, QuoteOracleEntry>> = {};
  try {
    const keys = CHAINLINK_CHAINS.map(({ chain, symbol }) =>
      `preflight:indexer:quoteprice:${chain}:${symbol}`,
    );
    const values = await r.mget(...keys);
    for (let i = 0; i < CHAINLINK_CHAINS.length; i++) {
      const { chain, symbol } = CHAINLINK_CHAINS[i];
      const raw = values[i];
      if (!result[chain]) result[chain] = {};
      if (!raw) {
        result[chain][symbol] = { price: 0, ageSec: -1, fresh: false, source: "MISSING" };
        continue;
      }
      try {
        const p = JSON.parse(raw) as { price: number; updatedAt: number };
        const ageSec = Math.round((now - Number(p.updatedAt ?? 0)) / 1000);
        result[chain][symbol] = { price: p.price, ageSec, fresh: ageSec >= 0 && ageSec < 300, source: "CHAINLINK" };
      } catch {
        result[chain][symbol] = { price: 0, ageSec: -1, fresh: false, source: "MISSING" };
      }
    }
  } catch { /* ignoră Redis errors */ }
  return result;
}

// ── Pair-level quote source distribution ─────────────────────────────────────

export interface QuotePriceChainHealth {
  sampleSize:    number;
  sources:       Record<string, number>;  // CHAINLINK/STATIC_STABLE/ENV_FALLBACK/UNKNOWN → count
  priceStatuses: Record<string, number>;  // OK/NO_QUOTE/QUOTE_PRICE_UNKNOWN/... → count
  maxAgeSec:     number | null;           // max quotePriceAgeSec din sample
  warnings:      string[];
}

const QUOTE_HEALTH_CHAINS = ["ethereum", "base", "arbitrum", "bsc"] as const;
const QUOTE_SAMPLE_SIZE   = 500;

/**
 * Samplez top QUOTE_SAMPLE_SIZE pairs din indexer registry per chain (by ts ZSET).
 * Numără distribuția quotePriceSource și priceStatus — fără SCAN, safe.
 */
export async function readQuotePriceHealth(): Promise<Record<string, QuotePriceChainHealth>> {
  const r = getRedis();
  if (!r) return {};
  const result: Record<string, QuotePriceChainHealth> = {};

  for (const chain of QUOTE_HEALTH_CHAINS) {
    try {
      const addrs = await r.zrevrange(`preflight:indexed:pairs:ts:${chain}`, 0, QUOTE_SAMPLE_SIZE - 1);
      if (!addrs.length) continue;

      const pipe = r.pipeline();
      for (const addr of addrs) pipe.get(`preflight:indexed:pair:${chain}:${addr}`);
      const results = await pipe.exec();
      if (!results) continue;

      const sources:       Record<string, number> = {};
      const priceStatuses: Record<string, number> = {};
      let maxAgeSec:     number | null = null;
      let parsed         = 0;
      let unknownOkCount = 0;

      for (const [err, raw] of results) {
        if (err || !raw) continue;
        try {
          const p = JSON.parse(raw as string) as {
            quotePriceSource?: string;
            quotePriceAgeSec?: number;
            priceStatus?:      string;
          };
          parsed++;
          const src = p.quotePriceSource ?? "UNKNOWN";
          const ps  = p.priceStatus ?? "MISSING";
          sources[src]       = (sources[src] ?? 0) + 1;
          priceStatuses[ps]  = (priceStatuses[ps] ?? 0) + 1;
          if (src === "UNKNOWN" && ps === "OK") unknownOkCount++;
          if (typeof p.quotePriceAgeSec === "number") {
            maxAgeSec = maxAgeSec === null ? p.quotePriceAgeSec : Math.max(maxAgeSec, p.quotePriceAgeSec);
          }
        } catch { /* skip malformed */ }
      }

      const warnings: string[] = [];
      const envCount        = sources["ENV_FALLBACK"] ?? 0;
      if (unknownOkCount > 0)                           warnings.push(`${unknownOkCount} OK-priced pairs with UNKNOWN quote source`);
      if (envCount > parsed * 0.1 && parsed > 10)      warnings.push(`${envCount} pairs using ENV_FALLBACK (>${Math.round(envCount / parsed * 100)}%)`);
      if (maxAgeSec !== null && maxAgeSec > 600)        warnings.push(`max quotePriceAgeSec=${maxAgeSec}s — possible stale prices`);

      result[chain] = { sampleSize: parsed, sources, priceStatuses, maxAgeSec, warnings };
    } catch { /* ignoră chain errors */ }
  }

  return result;
}

// ── 6.10: Trending movers reader ─────────────────────────────────────────────

export interface MoverEntry {
  chain:          string;
  pairAddress:    string;
  tokenAddress:   string | null;
  symbol:         string;
  dexType:        string;
  priceUsd:       number;
  reserveUsd:     number;
  priceChange5m:  number | null;
  priceChange1h:  number | null;
  priceChange24h: number | null;
  direction:      "UP" | "DOWN" | "FLAT";
  historyStatus:  "WARMING_UP" | "PARTIAL" | "READY";
  snapshotCount:  number;
  ts:             number;
}

/**
 * Citește movers per chain din preflight:trending:movers:{chain}.
 * Returnează [] dacă nu există date (shadow mode sau primul ciclu).
 */
export async function readTrendingMovers(chain: string): Promise<MoverEntry[]> {
  const r = getRedis();
  if (!r) return [];
  try {
    const raw = await r.get(REDIS_KEYS.trendingMovers(chain));
    if (!raw) return [];
    return JSON.parse(raw) as MoverEntry[];
  } catch { return []; }
}

// ── 8.0i: Solana indexer readers ─────────────────────────────────────────────

export interface SolanaHealthData {
  workerOnline:   boolean;
  slot:           number | null;
  cursor:         number | null;
  blocksBehind:   number | null;
  status:         "OK" | "DEGRADED" | "BEHIND" | "STARTING" | "OFFLINE";
  indexerVersion: string | null;
  ageSec:         number | null;
}

export interface SolanaIndexerStats {
  health:              SolanaHealthData;
  indexedPools:        number;
  indexedLaunches:     number;
  trackedPricePools:   number;
  moversStatus:        "READY" | "EMPTY" | "STALE";
  moversCount:         number;
  moversComputedAgeSec: number | null;
  coverage:            "SAMPLED";
}

export interface SolanaMoverItem {
  poolAddress:      string;
  // "unknown"/"UNKNOWN" sunt fallback-uri defensive de coercion (Redis poate
  // avea date malformate dintr-o versiune veche de worker) — nu valori reale
  // scrise vreodată de moversTracker.ts.
  program:          PreflightSolanaProgram | "unknown";
  baseSymbol:       string;
  quoteSymbol:      string;
  priceInQuote:     number;
  priceUsd:         number | null;
  priceChange5mPct: number | null;
  priceChange1hPct: number | null;
  sampleCount:      number;
  historyStatus:    PreflightSolanaHistoryStatus | "UNKNOWN";
  knownPool:        boolean;
  currentAgeSec:    number;
}

export interface SolanaMoversData {
  computedAgeSec: number;
  totalTracked:   number;
  coverage:       "SAMPLED";
  source:         "SWAP_VAULT_DELTA";
  items:          SolanaMoverItem[];
}

export interface SolanaRecentPool {
  poolAddress: string;
  program:     string;
  baseSymbol:  string | null;
  quoteSymbol: string | null;
  quoteType:   PreflightSolanaQuoteType | null;
  discoveredAt: number;
}

export interface SolanaRecentLaunch {
  mint:        string;
  symbol:      string | null;
  bondingCurve: string | null;
  discoveredAt: number;
}

/**
 * Citeste health + stats indexer Solana fara KEYS scan.
 * Toate citirile sunt ZCARD / GET directe.
 */
export async function readSolanaIndexerStats(now: number): Promise<SolanaIndexerStats> {
  const r = getRedis();
  if (!r) {
    return {
      health: { workerOnline: false, slot: null, cursor: null, blocksBehind: null, status: "OFFLINE", indexerVersion: null, ageSec: null },
      indexedPools: 0, indexedLaunches: 0, trackedPricePools: 0,
      moversStatus: "EMPTY", moversCount: 0, moversComputedAgeSec: null,
      coverage: "SAMPLED",
    };
  }

  const [healthRaw, indexedPools, indexedLaunches, trackedPricePools, moversRaw] = await Promise.all([
    r.get("preflight:indexer:health:solana"),
    r.zcard("preflight:indexed:pairs:solana"),
    r.zcard("preflight:indexed:launches:solana"),
    r.zcard("preflight:solana:price:pools"),
    r.get("preflight:trending:movers:solana"),
  ]);

  let health: SolanaHealthData;
  if (!healthRaw) {
    health = { workerOnline: false, slot: null, cursor: null, blocksBehind: null, status: "OFFLINE", indexerVersion: null, ageSec: null };
  } else {
    // fallback null => tratat identic cu !healthRaw mai jos (un blob corupt
    // nu trebuie să crape tot chain report-ul, doar să arate Solana OFFLINE).
    // Partial<> — nominal shape e PreflightSolanaHealth, dar tratăm fiecare
    // câmp ca posibil lipsă/malformat (safeJson validează doar sintaxa JSON).
    const h = safeJson<Partial<PreflightSolanaHealth> | null>(healthRaw, null, "preflight:indexer:health:solana");
    if (!h) {
      health = { workerOnline: false, slot: null, cursor: null, blocksBehind: null, status: "OFFLINE", indexerVersion: null, ageSec: null };
    } else {
      // safeJson garantează JSON valid, nu forma obiectului — dacă updatedAt
      // lipsește sau e un timestamp invalid, Date.parse/getTime dă NaN, care
      // altfel s-ar fi scurs în ageSec/workerOnline/status fără avertisment.
      const rawUpdatedAt = h.updatedAt;
      const updatedAtMs  = typeof rawUpdatedAt === "number"
        ? rawUpdatedAt
        : Date.parse(String(rawUpdatedAt ?? ""));
      const ageSec = Number.isFinite(updatedAtMs)
        ? Math.max(0, Math.round((now - updatedAtMs) / 1000))
        : null;

      // Redis poate conține orice string pe `status` — safeJson validează
      // doar sintaxa JSON, nu forma/enum-ul. Fără asta, o valoare stray
      // (ex: dintr-o versiune veche de worker) s-ar scurge mai departe ca
      // "status" invalid în raport.
      const validStatuses = new Set<SolanaHealthData["status"]>(
        ["OK", "DEGRADED", "BEHIND", "STARTING", "OFFLINE"],
      );
      const rawStatus    = String(h.status ?? "STARTING");
      const parsedStatus = validStatuses.has(rawStatus as SolanaHealthData["status"])
        ? (rawStatus as SolanaHealthData["status"])
        : "STARTING";

      health = {
        workerOnline:   ageSec !== null && ageSec < 5 * 60,
        slot:           h.latestSlot  ?? null,
        cursor:         h.cursorSlot  ?? null,
        blocksBehind:   h.behindSlots ?? null,
        status:         ageSec === null || ageSec >= 5 * 60 ? "OFFLINE" : parsedStatus,
        indexerVersion: h.indexerVersion ?? null,
        ageSec,
      };
    }
  }

  let moversStatus: "READY" | "EMPTY" | "STALE" = "EMPTY";
  let moversCount = 0;
  let moversComputedAgeSec: number | null = null;

  if (moversRaw) {
    const snap = safeJson<{ computedAt?: number; movers?: unknown[] } | null>(
      moversRaw, null, "preflight:trending:movers:solana",
    );
    if (snap) {
      // computedAt lipsă/invalid nu trebuie să dea o vârstă falsă de ~56 ani
      // (now - 0) — tratăm asta la fel ca "fără date", nu ca "extrem de stale".
      const computedAt = typeof snap.computedAt === "number" && Number.isFinite(snap.computedAt)
        ? snap.computedAt
        : null;

      moversComputedAgeSec = computedAt !== null
        ? Math.max(0, Math.round((now - computedAt) / 1000))
        : null;
      moversCount   = Array.isArray(snap.movers) ? snap.movers.length : 0;
      moversStatus  = moversComputedAgeSec === null
        ? "EMPTY"
        : moversComputedAgeSec > 10 * 60 ? "STALE" : moversCount > 0 ? "READY" : "EMPTY";
    }
  }

  return { health, indexedPools, indexedLaunches, trackedPricePools, moversStatus, moversCount, moversComputedAgeSec, coverage: "SAMPLED" };
}

/**
 * Citeste sampled Solana movers din preflight:trending:movers:solana.
 * Returneaza null daca nu exista date sau sunt stale (>10m).
 */
export async function readSolanaMovers(now: number, topN = 5): Promise<SolanaMoversData | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get("preflight:trending:movers:solana");
    if (!raw) return null;
    // Partial<> — nominal shape e PreflightSolanaMoversSnapshot, dar tratăm
    // fiecare câmp ca posibil lipsă/malformat (Redis poate avea date scrise
    // de o versiune veche de worker) — de-a asta coercion-ul manual de mai
    // jos rămâne, chiar tipat; safeJson validează doar sintaxa JSON, nu shape-ul.
    const snap = safeJson<Partial<PreflightSolanaMoversSnapshot> | null>(raw, null, "preflight:trending:movers:solana");
    if (!snap) return null;
    // computedAt lipsă/invalid → NaN s-ar fi scurs mai departe fără să
    // treacă de verificarea de staleness de mai jos (NaN > 600 e false).
    // Tratăm ca "fără date", la fel ca healthRaw lipsă.
    if (typeof snap.computedAt !== "number" || !Number.isFinite(snap.computedAt)) return null;
    const computedAgeSec = Math.max(0, Math.round((now - snap.computedAt) / 1000));
    if (computedAgeSec > 10 * 60) return null;

    return {
      computedAgeSec,
      totalTracked: snap.totalTracked ?? 0,
      coverage:     "SAMPLED",
      source:       "SWAP_VAULT_DELTA",
      items: (snap.movers ?? []).slice(0, topN).map((m: Partial<PreflightSolanaMover>) => ({
        poolAddress:      String(m.poolAddress ?? ""),
        program:          m.program ?? "unknown",
        baseSymbol:       String(m.baseSymbol  ?? "?"),
        quoteSymbol:      String(m.quoteSymbol ?? "?"),
        priceInQuote:     Number(m.priceInQuote ?? 0),
        priceUsd:         typeof m.priceUsd         === "number" ? m.priceUsd         : null,
        priceChange5mPct: typeof m.priceChange5mPct === "number" ? m.priceChange5mPct : null,
        priceChange1hPct: typeof m.priceChange1hPct === "number" ? m.priceChange1hPct : null,
        sampleCount:      Number(m.sampleCount   ?? 0),
        historyStatus:    m.historyStatus ?? "UNKNOWN",
        knownPool:        Boolean(m.knownPool),
        currentAgeSec:    Number(m.currentAgeSec ?? 0),
      })),
    };
  } catch { return null; }
}

/**
 * Citeste ultimele N pooluri + launche-uri indexate pe Solana.
 * Foloseste ZREVRANGE (score = discoveredAt ms) — fara KEYS.
 */
export async function readSolanaRecentActivity(topN = 5): Promise<{
  recentPools:   SolanaRecentPool[];
  recentLaunches: SolanaRecentLaunch[];
}> {
  const r = getRedis();
  if (!r) return { recentPools: [], recentLaunches: [] };
  try {
    const [poolAddrs, launchMints] = await Promise.all([
      r.zrevrange("preflight:indexed:pairs:ts:solana",   0, topN - 1, "WITHSCORES"),
      r.zrevrange("preflight:indexed:launches:ts:solana", 0, topN - 1, "WITHSCORES"),
    ]);

    // WITHSCORES returneaza [addr, score, addr, score, ...] alternating
    const poolPairs:   [string, number][] = [];
    const launchPairs: [string, number][] = [];
    for (let i = 0; i < poolAddrs.length;   i += 2) poolPairs.push([poolAddrs[i],   Number(poolAddrs[i + 1])]);
    for (let i = 0; i < launchMints.length; i += 2) launchPairs.push([launchMints[i], Number(launchMints[i + 1])]);

    // Fetch metadata in parallel
    const [poolRaws, launchRaws] = await Promise.all([
      poolPairs.length   ? r.mget(poolPairs.map(([addr])  => `preflight:indexed:pair:solana:${addr}`))   : Promise.resolve([]),
      launchPairs.length ? r.mget(launchPairs.map(([mint]) => `preflight:indexed:launch:solana:${mint}`)) : Promise.resolve([]),
    ]);

    const recentPools: SolanaRecentPool[] = poolPairs.map(([addr, ts], i) => {
      const meta = poolRaws[i] ? safeJson<PreflightSolanaPool | null>(poolRaws[i], null, `preflight:indexed:pair:solana:${addr}`) : null;
      return {
        poolAddress:  addr,
        program:      meta?.program     ?? "unknown",
        baseSymbol:   meta?.baseSymbol  ?? null,
        quoteSymbol:  meta?.quoteSymbol ?? null,
        quoteType:    meta?.quoteType   ?? null,
        discoveredAt: ts,
      };
    });

    const recentLaunches: SolanaRecentLaunch[] = launchPairs.map(([mint, ts], i) => {
      const meta = launchRaws[i] ? safeJson<PreflightSolanaLaunch | null>(launchRaws[i], null, `preflight:indexed:launch:solana:${mint}`) : null;
      return {
        mint,
        symbol:       meta?.symbol ?? null,
        // `bondingCurve` (fără sufix) nu a fost niciodată scris de launchWriter.ts —
        // doar `bondingCurveAddress`. Fallback-ul vechi (`?? meta?.bondingCurve`)
        // era cod mort; eliminat. Cu meta acum tipat, un `bondingCurve` inexistent
        // ar da eroare tsc, nu o valoare `undefined` tăcută.
        bondingCurve: meta?.bondingCurveAddress ?? null,
        discoveredAt: ts,
      };
    });

    return { recentPools, recentLaunches };
  } catch { return { recentPools: [], recentLaunches: [] }; }
}

// ── 8.0l: Solana per-pool context ────────────────────────────────────────────

export interface SolanaPoolContext {
  poolAddress:       string;
  // Toate câmpurile tipate acum contra @preflight/schema — registry/
  // observedCandidate (6a), priceSnapshot/recentHistory (6c), activity (6d).
  registry:          PreflightSolanaPool | null;
  priceSnapshot:     PreflightSolanaPriceSnapshot | null;
  activity:          PreflightSolanaPoolActivity | null;
  recentHistory:     PreflightSolanaPricePoint[];
  observedCandidate: PreflightObservedCandidate | null;
  dataAgeSec:        number | null;
}

/**
 * Citeste tot ce stim despre un pool Solana: registry + price snapshot + activity + history.
 * Toate citirile sunt GET directe - fara KEYS scan.
 */
export async function readSolanaPoolContext(
  poolAddress: string,
  now:         number,
): Promise<SolanaPoolContext> {
  const r = getRedis();
  if (!r) {
    return {
      poolAddress, registry: null, priceSnapshot: null,
      activity: null, recentHistory: [], observedCandidate: null, dataAgeSec: null,
    };
  }

  const [regRaw, snapRaw, actRaw, histRaws, candRaw] = await Promise.all([
    r.get(`preflight:indexed:pair:solana:${poolAddress}`),
    r.get(`preflight:solana:price:${poolAddress}`),
    r.get(`preflight:solana:activity:${poolAddress}`),
    r.lrange(`preflight:solana:price:history:${poolAddress}`, 0, 9),
    r.get(`preflight:solana:observed_candidate:${poolAddress}`),
  ]);

  const registry      = regRaw  ? safeJson<PreflightSolanaPool | null>(regRaw,  null) : null;
  const priceSnapshot = snapRaw ? safeJson<PreflightSolanaPriceSnapshot | null>(snapRaw, null) : null;
  const activity       = actRaw ? safeJson<PreflightSolanaPoolActivity | null>(actRaw, null) : null;
  const recentHistory = histRaws
    .map(h => safeJson<PreflightSolanaPricePoint | null>(h, null))
    .filter((h): h is PreflightSolanaPricePoint => h !== null);
  const observedCandidate = candRaw ? safeJson<PreflightObservedCandidate | null>(candRaw, null) : null;

  const lastUpdatedAt =
    typeof priceSnapshot?.lastUpdatedAt === "number" &&
    Number.isFinite(priceSnapshot.lastUpdatedAt)
      ? priceSnapshot.lastUpdatedAt
      : null;
  // clamp la 0 — un timestamp accidental în viitor (clock skew, bug de
  // scriere) nu trebuie să producă vârstă negativă, care ar trece drept
  // "HIGH" confidence în pair-context-report.ts (`dataAgeSec < 45`).
  const dataAgeSec = lastUpdatedAt !== null
    ? Math.max(0, Math.round((now - lastUpdatedAt) / 1000))
    : null;

  return { poolAddress, registry, priceSnapshot, activity, recentHistory, observedCandidate, dataAgeSec };
}
