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

// ── Redis read ────────────────────────────────────────────────────────────────

export async function readAllRedis(): Promise<RedisContext | null> {
  const r = getRedis();
  if (!r) return null;

  const [
    statesRaw, watchRaw, hotRaw, armedRaw,
    snapshotRaw, regimeRaw, eventsRaw, dropsRaw,
    pfMarketRaw, pfMomentumRaw, pfPipelineRaw, pfQualifiedRaw, pfDropsRaw,
    pfCoverageRaw,
    pfScannerStatsRaw,
  ] = await Promise.all([
    r.get("supreme:pair_states"),
    r.get("supreme:active_watch"),
    r.get("supreme:hot_candidates"),
    r.get("supreme:armed_entries"),
    r.get("supreme:worker_snapshot:latest"),
    r.get("supreme:market_regime"),
    r.get("supreme:pipeline_events"),
    r.get("supreme:recent_drops"),
    r.get("preflight:market_context"),
    r.get("preflight:momentum_events"),
    r.get("preflight:signal_pipeline"),
    r.get("preflight:qualified_signals"),
    r.get("preflight:recent_drops"),
    r.get("preflight:pipeline_coverage"),
    r.get("preflight:scanner_stats"),
  ]);

  const now = Date.now();

  // preflight:* first, supreme:* fallback
  const regimeFinal   = pfMarketRaw   ?? regimeRaw;
  const dropsFinal    = pfDropsRaw    ?? dropsRaw;
  const eventsFinal   = eventsRaw; // pipeline_events rămâne supreme pentru acum

  return {
    now,
    states:   statesRaw   ? JSON.parse(statesRaw)   as Record<string, PairState>  : {},
    watch:    watchRaw    ? JSON.parse(watchRaw)    as Record<string, WatchEntry>  : {},
    hot:      hotRaw      ? JSON.parse(hotRaw)      as Record<string, HotEntry>    : {},
    armed:    armedRaw    ? JSON.parse(armedRaw)    as Record<string, ArmedEntry>  : {},
    snapshot: snapshotRaw ? JSON.parse(snapshotRaw) as WorkerSnapshot              : null,
    regime:   regimeFinal ? JSON.parse(regimeFinal) as MarketRegime                : null,
    events:   eventsFinal ? JSON.parse(eventsFinal) as PipelineEvent[]             : [],
    drops:    dropsFinal  ? JSON.parse(dropsFinal)  as RecentDrop[]                : [],
    // preflight:* keys
    pfMarket:    pfMarketRaw    ? JSON.parse(pfMarketRaw)    : null,
    pfMomentum:  pfMomentumRaw  ? JSON.parse(pfMomentumRaw)  : null,
    pfPipeline:  pfPipelineRaw  ? JSON.parse(pfPipelineRaw)  : null,
    pfQualified: pfQualifiedRaw ? JSON.parse(pfQualifiedRaw) : null,
    pfDrops:          pfDropsRaw    ? JSON.parse(pfDropsRaw)    : null,
    pipelineCoverage: pfCoverageRaw     ? JSON.parse(pfCoverageRaw)     : null,
    scannerStats:     pfScannerStatsRaw ? JSON.parse(pfScannerStatsRaw) : null,
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
      pf_drops:             pfDropsRaw    !== null,
      pf_pipeline_coverage: pfCoverageRaw     !== null,
      pf_scanner_stats:     pfScannerStatsRaw !== null,
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
    const raw = await r.get(`preflight:pair_context:${addr.toLowerCase()}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export { type MemoryEntry, type PairState };