/**
 * TradePreflight MCP Server v0.1
 * Live DEX context layer for AI agents — powered by Supreme Trader Worker
 *
 * Endpoint: /api/mcp  (Streamable HTTP)
 *           /api/sse  (SSE — if needed later)
 * Auth:     x-api-key header (MCP_API_KEY env var)
 *
 * Tools:
 *   tp_health_check        → worker status + data freshness
 *   tp_pair_context        → full context for a specific pair
 *   tp_worker_pipeline     → activeWatch + hotCandidates + armedEntries
 *   tp_worker_snapshot     → filterable pair memory list
 *   tp_market_overview     → phase distribution + flow stats
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createMcpHandler } from "mcp-handler";
import { createClient }     from "@supabase/supabase-js";
import { getRedis }         from "@/lib/db/redis";
import { z }                from "zod";
import type { NextRequest } from "next/server";

// ── Auth ──────────────────────────────────────────────────────────────────────

function validateApiKey(req: NextRequest): boolean {
  const expected = process.env.MCP_API_KEY;
  if (!expected) {
    // In production, missing key = deny. In dev, allow.
    return process.env.NODE_ENV !== "production";
  }
  const key =
    req.headers.get("x-api-key") ??
    req.headers.get("authorization")?.replace("Bearer ", "");
  return key === expected;
}

// ── Supabase (read-only) ──────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// ── Types (mirrors worker Redis output) ──────────────────────────────────────

interface PairState {
  symbol:            string;
  phase:             string;
  seenCount:         number;
  totalEntries:      number;
  wins24h:           number;
  losses24h:         number;
  badExits24h:       number;
  consecutiveLosses: number;
  currentPrice:      number;
  lastEntryTime:     number;
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
    status:  string;
    lpNet5m: number;
    hasData: boolean;
  };
  updatedAt: number;
}

interface MemoryEntry extends PairState {
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

interface WatchEntry {
  chain:      string;
  addedAt:    number;
  ageMs:      number;
  kind:       string;
  entryPrice: number | null;
  reason:     string | null;
  symbol:     string | null;
  phase:      string | null;
}

interface HotEntry {
  chain:      string;
  promotedAt: number;
  ageMs:      number;
  source:     string | null;
  symbol:     string | null;
  phase:      string | null;
  flow: {
    pressure: string;
    buys5m:   number;
    hasData:  boolean;
    buyVol5m: number;
    netVol5m: number;
  };
}

interface ArmedEntry {
  armedAt:      number;
  ageMs:        number;
  price:        number;
  score:        number;
  flowPressure: string;
  symbol:       string | null;
  phase:        string | null;
}

interface WorkerSnapshot {
  version:        string;
  savedAt:        number;
  memory:         Record<string, MemoryEntry>;
  poolReserveEth: Record<string, number>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshnessLabel(ageMs: number | null): "fresh" | "aging" | "stale" | "unknown" {
  if (ageMs === null) return "unknown";
  if (ageMs < 45_000)  return "fresh";
  if (ageMs < 90_000)  return "aging";
  return "stale";
}

function safeMinAge(entries: number[]): number | null {
  if (!entries.length) return null;
  return Date.now() - Math.max(...entries); // most recently added = freshest
}

// ── Handler ───────────────────────────────────────────────────────────────────

const handler = createMcpHandler(
  (server) => {

    // ── Tool 1: tp_health_check ──────────────────────────────────────────────

    server.registerTool(
      "tp_health_check",
      {
        title: "TradePreflight Health Check",
        description: `Check if the Supreme Trader Worker is online and how fresh the Redis data is.

Returns worker version, data freshness for all Redis keys, and high-level stats:
total pairs tracked, phase distribution, active watch/hot/armed counts.

Use this first to verify the worker is running before calling other tools.
If contextQuality is 'stale' the worker may be down or Redis data has expired.

Returns: workerOnline, workerVersion, keys (freshness per Redis key), stats (phases, flowSummary, pipeline counts)`,
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        try {
          const r = getRedis();
          if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ workerOnline: false, error: "Redis not connected" }) }] };

          const now = Date.now();
          const [snapshotRaw, statesRaw, watchRaw, hotRaw, armedRaw] = await Promise.all([
            r.get("supreme:worker_snapshot:latest"),
            r.get("supreme:pair_states"),
            r.get("supreme:active_watch"),
            r.get("supreme:hot_candidates"),
            r.get("supreme:armed_entries"),
          ]);

          const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) as WorkerSnapshot             : null;
          const states   = statesRaw   ? JSON.parse(statesRaw)   as Record<string, PairState>  : null;
          const watch    = watchRaw    ? JSON.parse(watchRaw)    as Record<string, WatchEntry>  : null;
          const hot      = hotRaw      ? JSON.parse(hotRaw)      as Record<string, HotEntry>    : null;
          const armed    = armedRaw    ? JSON.parse(armedRaw)    as Record<string, ArmedEntry>  : null;

          const snapshotAge = snapshot?.savedAt ? now - snapshot.savedAt : null;

          // Freshness from most recent pair updatedAt
          const stateVals     = states ? Object.values(states) : [];
          const newestStateAt = stateVals.length ? Math.max(...stateVals.map(s => s.updatedAt)) : null;
          const statesAge     = newestStateAt ? now - newestStateAt : null;

          const watchAge = watch ? safeMinAge(Object.values(watch).map(w => w.addedAt)) : null;
          const hotAge   = hot   ? safeMinAge(Object.values(hot).map(h => h.promotedAt)) : null;
          const armedAge = armed ? safeMinAge(Object.values(armed).map(a => a.armedAt)) : null;

          function keyInfo(raw: string | null, ageMs: number | null) {
            return { exists: !!raw, ageSec: ageMs !== null ? Math.round(ageMs / 1000) : null, quality: freshnessLabel(ageMs) };
          }

          // Phase + flow distribution
          const phases: Record<string, number> = {};
          const flowSummary = { buying: 0, selling: 0, neutral: 0, noData: 0 };
          for (const p of stateVals) {
            phases[p.phase] = (phases[p.phase] ?? 0) + 1;
            if (!p.flow.hasData)                    flowSummary.noData++;
            else if (p.flow.pressure === "BUYING")  flowSummary.buying++;
            else if (p.flow.pressure === "SELLING") flowSummary.selling++;
            else                                    flowSummary.neutral++;
          }

          const result = {
            workerOnline:  !!snapshot && snapshotAge !== null && snapshotAge < 5 * 60_000,
            workerVersion: snapshot?.version ?? null,
            keys: {
              pair_states:     keyInfo(statesRaw,   statesAge),
              worker_snapshot: keyInfo(snapshotRaw, snapshotAge),
              active_watch:    keyInfo(watchRaw,    watchAge),
              hot_candidates:  keyInfo(hotRaw,      hotAge),
              armed_entries:   keyInfo(armedRaw,    armedAge),
            },
            stats: {
              totalPairs:    stateVals.length || Object.keys(snapshot?.memory ?? {}).length,
              activeWatch:   watch ? Object.keys(watch).length : 0,
              hotCandidates: hot   ? Object.keys(hot).length   : 0,
              armedEntries:  armed ? Object.keys(armed).length : 0,
              phases,
              flowSummary,
            },
          };

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }
    );

    // ── Tool 2: tp_pair_context ──────────────────────────────────────────────

    server.registerTool(
      "tp_pair_context",
      {
        title: "TradePreflight Pair Context",
        description: `Get everything the Supreme Trader Worker knows about a specific pair.

Combines pair_states (live, TTL 120s) + worker_snapshot (24h) + pipeline maps
(active_watch, hot_candidates, armed_entries) into a single response.

pipelineState: WATCHING = subscribed via WS, accumulating flow
               HOT      = confirmed buying flow, about to enter
               ARMED    = passed entry gate, awaiting 30s price confirmation
               NONE     = not currently tracked in pipeline

contextQuality: fresh (<45s), aging (<90s), stale (>90s), snapshot_only, unknown

Args: pair_address (0x... EVM address or V4 pool ID), chain (optional: base/arbitrum)`,
        inputSchema: {
          pair_address: z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
          chain: z.string().optional().describe("Chain hint: 'base' or 'arbitrum'"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ pair_address, chain }: { pair_address: string; chain?: string }) => {
        try {
          const addr = pair_address.toLowerCase().trim();
          const now  = Date.now();
          const r    = getRedis();
          if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ found: false, error: "Redis not connected" }) }] };

          const [statesRaw, snapshotRaw, watchRaw, hotRaw, armedRaw] = await Promise.all([
            r.get("supreme:pair_states"),
            r.get("supreme:worker_snapshot:latest"),
            r.get("supreme:active_watch"),
            r.get("supreme:hot_candidates"),
            r.get("supreme:armed_entries"),
          ]);

          const states   = statesRaw   ? JSON.parse(statesRaw)   as Record<string, PairState>  : {};
          const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) as WorkerSnapshot              : null;
          const watch    = watchRaw    ? JSON.parse(watchRaw)    as Record<string, WatchEntry>  : {};
          const hot      = hotRaw      ? JSON.parse(hotRaw)      as Record<string, HotEntry>    : {};
          const armed    = armedRaw    ? JSON.parse(armedRaw)    as Record<string, ArmedEntry>  : {};

          // Pipeline state
          const watchEntry = watch[addr]  ?? null;
          const hotEntry   = hot[addr]    ?? null;
          const armedEntry = armed[addr]  ?? null;
          const pipelineState =
            hotEntry   ? "HOT"      :
            armedEntry ? "ARMED"    :
            watchEntry ? "WATCHING" : "NONE";

          // Recalculate ageMs from source timestamps (not stale ageMs from Redis)
          const watchOut = watchEntry ? { ...watchEntry, ageMs: now - watchEntry.addedAt }   : null;
          const hotOut   = hotEntry   ? { ...hotEntry,   ageMs: now - hotEntry.promotedAt }  : null;
          const armedOut = armedEntry ? { ...armedEntry, ageMs: now - armedEntry.armedAt }   : null;

          const pairState = states[addr]           ?? null;
          const snapMem   = snapshot?.memory?.[addr] ?? null;
          const reserveEth = snapshot?.poolReserveEth?.[addr] ?? null;

          if (!pairState && !snapMem) {
            const result = {
              found: false, pairAddress: addr,
              symbol: watchOut?.symbol ?? hotOut?.symbol ?? armedOut?.symbol ?? null,
              chain:  chain ?? watchOut?.chain ?? hotOut?.chain ?? null,
              pipeline: { state: pipelineState, watch: watchOut, hot: hotOut, armed: armedOut },
              contextQuality: "unknown", dataSource: "none", freshnessSec: null,
            };
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
          }

          const data = pairState ?? snapMem!;
          const freshnessSec = pairState
            ? Math.round((now - pairState.updatedAt) / 1000)
            : snapshot?.savedAt ? Math.round((now - snapshot.savedAt) / 1000) : null;
          const quality = pairState ? freshnessLabel(now - pairState.updatedAt) : "snapshot_only";

          const result = {
            found: true, pairAddress: addr,
            symbol: data.symbol,
            chain:  chain ?? watchOut?.chain ?? hotOut?.chain ?? null,
            phase: data.phase, seenCount: data.seenCount, currentPrice: data.currentPrice,
            flow: pairState?.flow ?? null,
            lp:   pairState?.lp  ?? null,
            history: {
              totalEntries: data.totalEntries, wins24h: data.wins24h,
              losses24h: data.losses24h, badExits24h: data.badExits24h,
              consecutiveLosses: data.consecutiveLosses,
            },
            pipeline: { state: pipelineState, watch: watchOut, hot: hotOut, armed: armedOut },
            reserveEth,
            contextQuality: quality,
            dataSource: pairState ? "pair_states" : "worker_snapshot",
            freshnessSec,
          };

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }
    );

    // ── Tool 3: tp_worker_pipeline ───────────────────────────────────────────

    server.registerTool(
      "tp_worker_pipeline",
      {
        title: "TradePreflight Worker Pipeline",
        description: `Get the live internal pipeline of the Supreme Trader Worker.

Shows all pairs currently moving through the worker's decision flow:
- WATCHING: subscribed via WebSocket, accumulating flow data (kind: NORMAL/FOMO/VERTICAL/LATE)
- HOT: promoted candidates with confirmed buying flow, about to enter
- ARMED: passed entry gate, awaiting 30s price confirmation — may enter imminently

If a pair appears in 'armedEntries', the worker may enter a trade within 30 seconds.
ageMs is recalculated at read time, not taken from the stale Redis value.

Args: chain (optional filter: 'base' or 'arbitrum')`,
        inputSchema: {
          chain: z.string().optional().describe("Filter by chain: 'base' or 'arbitrum'"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ chain }: { chain?: string }) => {
        try {
          const r = getRedis();
          if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Redis not connected" }) }] };

          const now = Date.now();
          const [watchRaw, hotRaw, armedRaw, statesRaw] = await Promise.all([
            r.get("supreme:active_watch"),
            r.get("supreme:hot_candidates"),
            r.get("supreme:armed_entries"),
            r.get("supreme:pair_states"),
          ]);

          const watch  = watchRaw  ? JSON.parse(watchRaw)  as Record<string, WatchEntry>  : {};
          const hot    = hotRaw    ? JSON.parse(hotRaw)    as Record<string, HotEntry>    : {};
          const armed  = armedRaw  ? JSON.parse(armedRaw)  as Record<string, ArmedEntry>  : {};
          const states = statesRaw ? JSON.parse(statesRaw) as Record<string, PairState>   : {};

          const firstState = Object.values(states)[0];
          const freshnessSec = firstState ? Math.round((now - firstState.updatedAt) / 1000) : null;

          const filterChain = (c: string | null | undefined) => !chain || c === chain;

          const activeWatch = Object.entries(watch)
            .filter(([, v]) => filterChain(v.chain))
            .map(([addr, v]) => ({
              pairAddress: addr,
              symbol:      v.symbol ?? addr.slice(0, 10) + "...",
              chain:       v.chain,
              kind:        v.kind,
              ageMin:      Math.round((now - v.addedAt) / 60_000 * 10) / 10,
              entryPrice:  v.entryPrice,
              reason:      v.reason,
              phase:       v.phase,
            }))
            .sort((a, b) => a.ageMin - b.ageMin);

          const hotCandidates = Object.entries(hot)
            .filter(([, v]) => filterChain(v.chain))
            .map(([addr, v]) => ({
              pairAddress: addr,
              symbol:      v.symbol ?? addr.slice(0, 10) + "...",
              chain:       v.chain,
              source:      v.source ?? "WS",
              ageSec:      Math.round((now - v.promotedAt) / 1000),
              phase:       v.phase,
              flow:        v.flow,
            }))
            .sort((a, b) => a.ageSec - b.ageSec);

          const armedEntries = Object.entries(armed)
            .map(([addr, v]) => ({
              pairAddress:  addr,
              symbol:       v.symbol ?? addr.slice(0, 10) + "...",
              ageSec:       Math.round((now - v.armedAt) / 1000),
              price:        v.price,
              score:        v.score,
              flowPressure: v.flowPressure,
              phase:        v.phase,
            }))
            .sort((a, b) => a.ageSec - b.ageSec);

          const result = {
            activeWatch, hotCandidates, armedEntries,
            summary: { watching: activeWatch.length, hot: hotCandidates.length, armed: armedEntries.length },
            freshnessSec,
          };

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }
    );

    // ── Tool 4: tp_worker_snapshot ───────────────────────────────────────────

    server.registerTool(
      "tp_worker_snapshot",
      {
        title: "TradePreflight Worker Snapshot",
        description: `Query the worker's full pair memory with filters and pagination.

Returns all pairs the worker has seen, with accumulated stats.
Combines pair_states (live flow data) with worker_snapshot (full memory including history).

Useful queries:
  - phase=SECOND_WAVE → pairs the worker considers second wave opportunities
  - flow_pressure=BUYING → pairs with active buying flow right now
  - min_seen_count=5 → pairs seen at least 5 times (more established)

Args:
  phase (optional): TRENDING, SECOND_WAVE, RECOVERING, PUMPING, ZOMBIE, DEAD
  flow_pressure (optional): BUYING, SELLING, NEUTRAL
  chain (optional): base, arbitrum
  min_seen_count (default 0), limit (default 20, max 100), offset (default 0)`,
        inputSchema: {
          phase:          z.string().optional().describe("Filter by phase"),
          flow_pressure:  z.string().optional().describe("Filter by flow pressure: BUYING, SELLING, NEUTRAL"),
          chain:          z.string().optional().describe("Filter by chain: base, arbitrum"),
          min_seen_count: z.number().int().min(0).default(0).describe("Minimum seenCount"),
          limit:          z.number().int().min(1).max(100).default(20).describe("Max results"),
          offset:         z.number().int().min(0).default(0).describe("Pagination offset"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ phase, flow_pressure, chain, min_seen_count, limit, offset }: {
        phase?: string; flow_pressure?: string; chain?: string;
        min_seen_count: number; limit: number; offset: number;
      }) => {
        try {
          const r = getRedis();
          if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Redis not connected" }) }] };

          const now = Date.now();
          const [statesRaw, snapshotRaw] = await Promise.all([
            r.get("supreme:pair_states"),
            r.get("supreme:worker_snapshot:latest"),
          ]);

          const states   = statesRaw   ? JSON.parse(statesRaw)   as Record<string, PairState> : {};
          const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) as WorkerSnapshot             : null;

          const allAddrs = new Set([...Object.keys(states), ...Object.keys(snapshot?.memory ?? {})]);

          let pairs = [...allAddrs].map(addr => {
            const live = states[addr];
            const mem  = snapshot?.memory?.[addr];
            const data = live ?? mem;
            if (!data) return null;
            return { addr, data };
          }).filter((x): x is { addr: string; data: PairState | MemoryEntry } => x !== null);

          if (phase)              pairs = pairs.filter(p => p.data.phase === phase.toUpperCase());
          if (flow_pressure)      pairs = pairs.filter(p => states[p.addr]?.flow?.pressure === flow_pressure.toUpperCase());
          if (min_seen_count > 0) pairs = pairs.filter(p => p.data.seenCount >= min_seen_count);
          if (chain) {
            pairs = pairs.filter(p => {
              const mem = snapshot?.memory?.[p.addr];
              return mem ? mem.tokenAddress.startsWith(chain) : false;
            });
          }

          const total     = pairs.length;
          const paginated = pairs.slice(offset, offset + limit);
          const snapshotAgeSec = snapshot?.savedAt ? Math.round((now - snapshot.savedAt) / 1000) : null;

          const result = {
            total, count: paginated.length, offset,
            has_more: total > offset + paginated.length,
            pairs: paginated.map(({ addr, data }) => ({
              pairAddress:  addr,
              symbol:       data.symbol,
              phase:        data.phase,
              seenCount:    data.seenCount,
              currentPrice: data.currentPrice,
              flow:         states[addr]?.flow ?? null,
              history: {
                totalEntries: data.totalEntries, wins24h: data.wins24h,
                losses24h: data.losses24h, badExits24h: data.badExits24h,
                consecutiveLosses: data.consecutiveLosses,
              },
              updatedAt: states[addr]?.updatedAt ?? null,
            })),
            snapshotAgeSec,
            workerVersion: snapshot?.version ?? null,
          };

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }
    );

    // ── Tool 5: tp_market_overview ───────────────────────────────────────────

    server.registerTool(
      "tp_market_overview",
      {
        title: "TradePreflight Market Overview",
        description: `High-level view of current DEX market conditions from the worker's perspective.

Aggregates all tracked pairs to show market regime:
- Phase distribution: how many pairs in each phase
- Flow pressure: how many pairs have BUYING vs SELLING vs NEUTRAL vs no WS data
- Top buying pairs by buyVol5m (most active buying pressure right now)
- Pipeline counts: watching/hot/armed

Use this to understand current market conditions before drilling into specific pairs.

Args: chain (optional filter), top_n (how many top buying pairs, default 5, max 20)`,
        inputSchema: {
          chain: z.string().optional().describe("Filter by chain: 'base' or 'arbitrum'"),
          top_n: z.number().int().min(1).max(20).default(5).describe("Top buying pairs to return"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ chain, top_n }: { chain?: string; top_n: number }) => {
        try {
          const r = getRedis();
          if (!r) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Redis not connected" }) }] };

          const now = Date.now();
          const [statesRaw, watchRaw, hotRaw, armedRaw, snapshotRaw] = await Promise.all([
            r.get("supreme:pair_states"),
            r.get("supreme:active_watch"),
            r.get("supreme:hot_candidates"),
            r.get("supreme:armed_entries"),
            r.get("supreme:worker_snapshot:latest"),
          ]);

          const states   = statesRaw   ? JSON.parse(statesRaw)   as Record<string, PairState> : {};
          const watch    = watchRaw    ? JSON.parse(watchRaw)    as Record<string, WatchEntry> : {};
          const hot      = hotRaw      ? JSON.parse(hotRaw)      as Record<string, HotEntry>   : {};
          const armed    = armedRaw    ? JSON.parse(armedRaw)    as Record<string, ArmedEntry> : {};
          const snapshot = snapshotRaw ? JSON.parse(snapshotRaw) as WorkerSnapshot             : null;

          let entries = Object.entries(states);

          if (chain) {
            entries = entries.filter(([addr]) => {
              const mem = snapshot?.memory?.[addr];
              return mem ? mem.tokenAddress.startsWith(chain) : false;
            });
          }

          const phases: Record<string, number> = {};
          const flowPressure = { buying: 0, selling: 0, neutral: 0, noWsData: 0 };

          for (const [, p] of entries) {
            phases[p.phase] = (phases[p.phase] ?? 0) + 1;
            if (!p.flow.hasData)                    flowPressure.noWsData++;
            else if (p.flow.pressure === "BUYING")  flowPressure.buying++;
            else if (p.flow.pressure === "SELLING") flowPressure.selling++;
            else                                    flowPressure.neutral++;
          }

          const topBuyingPairs = entries
            .filter(([, p]) => p.flow.hasData && p.flow.pressure === "BUYING")
            .sort(([, a], [, b]) => b.flow.buyVol5m - a.flow.buyVol5m)
            .slice(0, top_n)
            .map(([addr, p]) => ({
              symbol: p.symbol, pairAddress: addr, phase: p.phase,
              buyVol5m: p.flow.buyVol5m, netVol5m: p.flow.netVol5m, buys5m: p.flow.buys5m,
            }));

          const newestStateAt = entries.length ? Math.max(...entries.map(([, p]) => p.updatedAt)) : null;
          const freshnessSec  = newestStateAt ? Math.round((now - newestStateAt) / 1000) : null;

          const result = {
            phases, flowPressure, topBuyingPairs,
            pipeline: {
              watching: Object.keys(watch).length,
              hot:      Object.keys(hot).length,
              armed:    Object.keys(armed).length,
            },
            totalTracked: entries.length,
            freshnessSec,
          };

          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }
    );

  },
  {},
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: process.env.NODE_ENV !== "production",
  }
);

// Auth wrapper
export async function GET(req: NextRequest) {
  if (!validateApiKey(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  return handler(req);
}

export async function POST(req: NextRequest) {
  if (!validateApiKey(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  return handler(req);
}