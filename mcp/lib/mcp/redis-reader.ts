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