/**
 * lib/mcp/redis-reader.ts
 * Redis reads + helper functions — preflight:* first, supreme:* fallback
 */

import { getRedis }  from "@/lib/db/redis";
import type {
  PairState, MemoryEntry, WatchEntry, HotEntry,
  ArmedEntry, WorkerSnapshot, MarketRegime,
  PipelineEvent, RecentDrop, RedisContext,
} from "./types";
import { REDIS_KEYS } from "@preflight/schema";

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

  const [
    statesRaw, watchRaw, hotRaw, armedRaw,
    snapshotRaw, regimeRaw, eventsRaw, dropsRaw,
    pfMarketRaw, pfMomentumRaw, pfPipelineRaw, pfQualifiedRaw,
    pfCoverageRaw, pfScannerStatsRaw, pfLifecycleRaw,
  ] = await Promise.all([
    r.get(REDIS_KEYS.pairStates),
    r.get(REDIS_KEYS.activeWatch),
    r.get(REDIS_KEYS.hotCandidates),
    r.get(REDIS_KEYS.armedEntries),
    r.get(REDIS_KEYS.workerSnapshot),
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

  // preflight:* first, supreme:* fallback
  const regimeFinal   = pfMarketRaw   ?? regimeRaw;
  const eventsFinal   = eventsRaw; // pipeline_events rămâne supreme pentru acum

  return {
    now,
    states:   safeJson<Record<string, PairState>> (statesRaw,   {},   "pair_states"),
    watch:    safeJson<Record<string, WatchEntry>>(watchRaw,    {},   "active_watch"),
    hot:      safeJson<Record<string, HotEntry>>  (hotRaw,      {},   "hot_candidates"),
    armed:    safeJson<Record<string, ArmedEntry>>(armedRaw,    {},   "armed_entries"),
    snapshot: safeJson<WorkerSnapshot | null>     (snapshotRaw, null, "worker_snapshot"),
    regime:   safeJson<MarketRegime | null>        (regimeFinal, null, "market_regime"),
    events:   safeJson<PipelineEvent[]>            (eventsFinal, [],   "pipeline_events"),
    drops:   safeJson<RecentDrop[]>(dropsRaw, [], REDIS_KEYS.recentDrops),
    pfMarket:         safeJson(pfMarketRaw,        null, "pf_market"),
    pfMomentum:       safeJson(pfMomentumRaw,      null, "pf_momentum"),
    pfPipeline:       safeJson(pfPipelineRaw,      null, "pf_pipeline"),
    pfQualified:      safeJson(pfQualifiedRaw,     null, "pf_qualified"),
    pfDrops: safeJson(dropsRaw, null, REDIS_KEYS.recentDrops),
    pipelineCoverage: safeJson(pfCoverageRaw,      null, "pf_pipeline_coverage"),
    scannerStats:     safeJson(pfScannerStatsRaw,  null, "pf_scanner_stats"),
    pfLifecycle:      safeJson(pfLifecycleRaw,     null, "pf_lifecycle"),
    keyExists: {
      pair_states:          statesRaw   !== null,
      active_watch:         watchRaw    !== null,
      hot_candidates:       hotRaw      !== null,
      armed_entries:        armedRaw    !== null,
      worker_snapshot:      snapshotRaw !== null,
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

export function formatEth(val: number): string {
  return val.toFixed(3) + " ETH";
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
  addr:  string,
  watch: Record<string, WatchEntry>,
  hot:   Record<string, HotEntry>,
  armed: Record<string, ArmedEntry>,
): "WATCHING" | "HOT" | "ARMED" | "NONE" {
  if (armed[addr]) return "ARMED";
  if (hot[addr])   return "HOT";
  if (watch[addr]) return "WATCHING";
  return "NONE";
}

export function findLastEventForPair(addr: string, events: PipelineEvent[]): PipelineEvent | null {
  return events.find(e => e.pairAddress === addr) ?? null;
}

export function findLastDropForPair(addr: string, drops: RecentDrop[]): RecentDrop | null {
  return drops.find(d => d.pairAddress === addr) ?? null;
}

export async function readPairContext(addr: string): Promise<any | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    const raw = await r.get(REDIS_KEYS.pairContext(addr));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
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
export function dedupeByPair<T extends { pairAddress?: string | null }>(
  arr:     T[] | null | undefined,
  tsField: keyof T,
): Array<T & { _eventCount: number }> {
  const map = new Map<string, T & { _eventCount: number }>();

  for (const item of arr ?? []) {
    const addr = item.pairAddress?.toLowerCase();
    if (!addr) continue;

    const ts       = Number(item[tsField] ?? 0);
    const existing = map.get(addr);

    if (!existing) {
      map.set(addr, { ...item, _eventCount: 1 });
    } else if (ts >= Number(existing[tsField] ?? 0)) {
      map.set(addr, { ...item, _eventCount: existing._eventCount + 1 });
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

const QUOTE_HEALTH_CHAINS = ["base", "arbitrum", "bsc"] as const;
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