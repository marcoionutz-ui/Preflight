/**
 * lib/mcp/redis-reader.ts
 * Redis reads + helper functions — extrase din route.ts
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
  ] = await Promise.all([
    r.get("supreme:pair_states"),
    r.get("supreme:active_watch"),
    r.get("supreme:hot_candidates"),
    r.get("supreme:armed_entries"),
    r.get("supreme:worker_snapshot:latest"),
    r.get("supreme:market_regime"),
    r.get("supreme:pipeline_events"),
    r.get("supreme:recent_drops"),
  ]);

  const now = Date.now();
  return {
    now,
    states:   statesRaw   ? JSON.parse(statesRaw)   as Record<string, PairState>  : {},
    watch:    watchRaw    ? JSON.parse(watchRaw)    as Record<string, WatchEntry>  : {},
    hot:      hotRaw      ? JSON.parse(hotRaw)      as Record<string, HotEntry>    : {},
    armed:    armedRaw    ? JSON.parse(armedRaw)    as Record<string, ArmedEntry>  : {},
    snapshot: snapshotRaw ? JSON.parse(snapshotRaw) as WorkerSnapshot              : null,
    regime:   regimeRaw   ? JSON.parse(regimeRaw)   as MarketRegime                : null,
    events:   eventsRaw   ? JSON.parse(eventsRaw)   as PipelineEvent[]             : [],
    drops:    dropsRaw    ? JSON.parse(dropsRaw)    as RecentDrop[]                : [],
    keyExists: {
      pair_states:     statesRaw   !== null,
      active_watch:    watchRaw    !== null,
      hot_candidates:  hotRaw      !== null,
      armed_entries:   armedRaw    !== null,
      worker_snapshot: snapshotRaw !== null,
      market_regime:   regimeRaw   !== null,
      pipeline_events: eventsRaw   !== null,
      recent_drops:    dropsRaw    !== null,
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

export { type MemoryEntry, type PairState };