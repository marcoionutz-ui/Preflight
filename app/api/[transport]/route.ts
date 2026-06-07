/**
 * TradePreflight MCP Server v0.3
 * Live DEX context layer for AI agents — powered by Supreme Trader Worker
 *
 * Endpoint: /api/[transport]  (Streamable HTTP)
 *           /api/sse  (SSE — if needed later)
 * Auth:     x-api-key header (MCP_API_KEY env var)
 *
 * Tools v0.1 (data layer):
 *   tp_health_check        → worker status + data freshness
 *   tp_pair_context        → full context for a specific pair
 *   tp_worker_pipeline     → activeWatch + hotCandidates + armedEntries
 *   tp_worker_snapshot     → filterable pair memory list
 *   tp_market_overview     → phase distribution + flow stats
 *
 * Tools v0.2 (narrative layer):
 *   tp_situation_report    → front door: what's happening right now
 *   tp_candidate_brief     → case file for a specific pair
 *   tp_why_not             → why a pair is not HOT/ARMED
 *   tp_do_not_chase        → anti-FOMO list: what to avoid
 *
 * Tools v0.3 (safety layer):
 *   tp_preflight_safety    → GoPlus contract safety check: honeypot/tax/owner/age
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createMcpHandler } from "mcp-handler";
import { getRedis }         from "@/lib/db/redis";
import { z }                from "zod";
import type { NextRequest } from "next/server";

const EXPOSE_PERFORMANCE = process.env.MCP_EXPOSE_PERFORMANCE === "true";

// ── Auth ──────────────────────────────────────────────────────────────────────

function validateApiKey(req: NextRequest): boolean {
  const expected = process.env.MCP_API_KEY;
  if (!expected) return process.env.NODE_ENV !== "production";
  const key =
    req.headers.get("x-api-key") ??
    req.headers.get("authorization")?.replace("Bearer ", "");
  return key === expected;
}

// ── Types ─────────────────────────────────────────────────────────────────────

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
  // v0.2 additions
  reserveUsd:        number;
  reserveEth:        number;
  liqStatus:         string;
  dexType:           string;
  poolCountSameToken: number;
  hourUtc:           number;
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
  chain:           string;
  addedAt:         number;
  ageMs:           number;
  kind:            string;
  entryPrice:      number | null;
  reason:          string | null;
  symbol:          string | null;
  phase:           string | null;
  // v0.2
  priceVsEntryPct: number | null;
  flowAgeMs:       number | null;
  largestBuyEth:   number;
  avgBuyEth:       number;
  buySwapCount5m:  number;
  sellSwapCount5m: number;
}

interface HotEntry {
  chain:      string;
  promotedAt: number;
  ageMs:      number;
  source:     string | null;
  symbol:     string | null;
  phase:      string | null;
  // v0.2
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

interface ArmedEntry {
  armedAt:      number;
  ageMs:        number;
  price:        number;
  score:        number;
  flowPressure: string;
  symbol:       string | null;
  phase:        string | null;
  chain:        string | null; // v0.2
}

interface WorkerSnapshot {
  version:        string;
  savedAt:        number;
  memory:         Record<string, MemoryEntry>;
  poolReserveEth: Record<string, number>;
}

interface MarketRegime {
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

interface PipelineEvent {
  type:        string;
  symbol:      string;
  chain:       string;
  pairAddress: string;
  from:        string;
  to:          string;
  reason?:     string;
  ts:          number;
}

interface RecentDrop {
  symbol:        string;
  chain:         string;
  pairAddress:   string;
  previousState: string;
  reason:        string;
  droppedAt:     number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshnessLabel(ageMs: number | null): "fresh" | "aging" | "stale" | "unknown" {
  if (ageMs === null) return "unknown";
  if (ageMs < 45_000) return "fresh";
  if (ageMs < 90_000) return "aging";
  return "stale";
}

function safeMinAge(entries: number[]): number | null {
  if (!entries.length) return null;
  return Date.now() - Math.max(...entries);
}

function formatAge(ms: number): string {
  if (ms < 60_000)  return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3600_000)}h`;
}

function formatEth(val: number): string {
  return val.toFixed(3) + " ETH";
}

async function readAllRedis() {
  const r = getRedis();
  if (!r) return null;
  const [statesRaw, watchRaw, hotRaw, armedRaw, snapshotRaw, regimeRaw, eventsRaw, dropsRaw] =
    await Promise.all([
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

function getPipelineState(addr: string, watch: Record<string, WatchEntry>, hot: Record<string, HotEntry>, armed: Record<string, ArmedEntry>): "WATCHING" | "HOT" | "ARMED" | "NONE" {
  if (armed[addr]) return "ARMED";
  if (hot[addr])   return "HOT";
  if (watch[addr]) return "WATCHING";
  return "NONE";
}

function findLastEventForPair(addr: string, events: PipelineEvent[]): PipelineEvent | null {
  return events.find(e => e.pairAddress === addr) ?? null;
}

function findLastDropForPair(addr: string, drops: RecentDrop[]): RecentDrop | null {
  return drops.find(d => d.pairAddress === addr) ?? null;
}

// ── GoPlus Safety ─────────────────────────────────────────────────────────────

const GOPLUS_CHAIN_IDS: Record<string, string> = {
  base:     "8453",
  arbitrum: "42161",
};

interface GoPlusSafety {
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

function cleanTokenAddress(raw: string): string {
  return raw.replace(/^[a-z]+_/i, "").toLowerCase().trim();
}

function deriveChainFromTokenAddress(raw: string): string | null {
  const match = raw.match(/^([a-z]+)_0x/i);
  return match ? match[1].toLowerCase() : null;
}

function parseTaxPct(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round((n <= 1 ? n * 100 : n) * 100) / 100;
}

const GOPLUS_UNAVAILABLE: GoPlusSafety = {
  sellability: "UNKNOWN", taxRisk: "UNKNOWN", ownerRisk: "UNKNOWN",
  isHoneypot: null, buyTaxPct: null, sellTaxPct: null,
  ownerRenounced: null, canChangeTax: null, canBlacklist: null,
  canMint: null, canPauseTrading: null, canChangeBalance: null,
  canTakeBackOwnership: null, tokenAgeMinutes: null,
  agentVerdict: "UNKNOWN_CHECK_MANUALLY",
  missingData: ["GoPlus API unavailable — check manually"],
  cachedAt: 0, source: "unavailable",
};

async function fetchGoPlusSafety(
  tokenAddr: string,
  chainId:   string,
): Promise<GoPlusSafety> {
  const missing: string[] = [];

  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${tokenAddr}`;
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), 8_000);

    const headers: Record<string, string> = { accept: "application/json" };
    if (process.env.GOPLUS_API_KEY) {
      headers.Authorization = `Bearer ${process.env.GOPLUS_API_KEY}`;
    }

    let raw: any;
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers });
      clearTimeout(t);
      if (!res.ok) throw new Error(`GoPlus HTTP ${res.status}`);
      const json = await res.json();
      raw = json?.result?.[tokenAddr.toLowerCase()] ?? json?.result?.[tokenAddr] ?? null;
    } finally {
      clearTimeout(t);
    }

    if (!raw) {
      return {
        ...GOPLUS_UNAVAILABLE,
        missingData: ["GoPlus returned no data for this token"],
        cachedAt: Date.now(),
      };
    }

    // ── Parse fields ──────────────────────────────────────────────────────

    const isHoneypot = raw.is_honeypot === "1" ? true : raw.is_honeypot === "0" ? false : null;
    const cannotSell = raw.cannot_sell_all === "1";
    const buyTax     = parseTaxPct(raw.buy_tax);
    const sellTax    = parseTaxPct(raw.sell_tax);

    const ZERO = "0x0000000000000000000000000000000000000000";
    const DEAD = "0x000000000000000000000000000000000000dead";
    const ownerAddr = typeof raw.owner_address === "string"
      ? raw.owner_address.toLowerCase()
      : null;
    const ownerRenounced =
      ownerAddr === ZERO || ownerAddr === DEAD ? true :
      ownerAddr !== null                        ? false :
      null;

    const canChangeTax         = raw.slippage_modifiable === "1" || raw.personal_slippage_modifiable === "1";
    const canChangeBalance     = raw.owner_change_balance === "1";
    const canTakeBackOwnership = raw.can_take_back_ownership === "1";
    const canBlacklist         = raw.is_blacklisted === "1";
    const canMint              = raw.is_mintable === "1";
    const canPause             = raw.trading_pausable === "1";
    const tokenAgeMins         = raw.token_age_in_minutes != null
      ? Math.round(Number(raw.token_age_in_minutes))
      : null;

    // ── Missing data ──────────────────────────────────────────────────────

    if (isHoneypot === null)     missing.push("honeypot check unavailable");
    if (sellTax === null)        missing.push("sell tax unavailable");
    if (ownerRenounced === null) missing.push("owner renounced status unavailable");
    if (tokenAgeMins === null)   missing.push("token age unavailable");

    // ── Derived risk levels ───────────────────────────────────────────────

    const sellability: GoPlusSafety["sellability"] =
      isHoneypot === true || cannotSell ? "FAIL"    :
      isHoneypot === false              ? "PASS"    : "UNKNOWN";

    const taxRisk: GoPlusSafety["taxRisk"] =
      sellTax === null                      ? "UNKNOWN" :
      sellTax >= 20                         ? "HIGH"    :
      sellTax > 10 || (buyTax ?? 0) > 10   ? "MEDIUM"  : "LOW";

    const ownerRisk: GoPlusSafety["ownerRisk"] =
      canMint || canPause || canTakeBackOwnership || canChangeBalance ? "HIGH"   :
      canChangeTax || canBlacklist || ownerRenounced === false        ? "MEDIUM" :
      ownerRenounced === true                                         ? "LOW"    : "UNKNOWN";

    // ── Agent verdict ─────────────────────────────────────────────────────

    const agentVerdict: GoPlusSafety["agentVerdict"] =
      sellability === "FAIL" || (sellTax ?? 0) >= 20
        ? "BLOCK" :
      ownerRisk === "HIGH" || (sellTax ?? 0) > 10 || canMint || canPause
        ? "HIGH_CAUTION" :
      sellability === "PASS" && taxRisk === "LOW"
        ? "OK_TO_INVESTIGATE" :
      "UNKNOWN_CHECK_MANUALLY";

    return {
      sellability, taxRisk, ownerRisk,
      isHoneypot, buyTaxPct: buyTax, sellTaxPct: sellTax,
      ownerRenounced, canChangeTax, canBlacklist, canMint,
      canPauseTrading: canPause, canChangeBalance, canTakeBackOwnership,
      tokenAgeMinutes: tokenAgeMins,
      agentVerdict, missingData: missing,
      cachedAt: Date.now(), source: "goplus",
    };

  } catch {
    return { ...GOPLUS_UNAVAILABLE, cachedAt: Date.now() };
  }
}

async function getTokenSafety(
  rawTokenAddress: string,
  chain:           string,
  redis:           ReturnType<typeof getRedis>,
): Promise<GoPlusSafety> {
  const tokenAddr = cleanTokenAddress(rawTokenAddress);
  const chainId   = GOPLUS_CHAIN_IDS[chain] ?? null;

  if (!chainId) {
    return {
      ...GOPLUS_UNAVAILABLE,
      missingData: [`Chain '${chain}' not supported by GoPlus integration`],
      cachedAt: Date.now(),
    };
  }

  const cacheKey = `supreme:token_safety:${chain}:${tokenAddr}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as GoPlusSafety;
        return { ...parsed, source: "cache" };
      }
    } catch { /* cache miss, proceed */ }
  }

  const result = await fetchGoPlusSafety(tokenAddr, chainId);

  if (redis && result.source === "goplus") {
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", 30 * 60);
    } catch { /* non-fatal */ }
  }

  return result;
}

// ── Handler ───────────────────────────────────────────────────────────────────

const handler = createMcpHandler(
  (server: any) => {

    // ── Tool 1: tp_health_check ──────────────────────────────────────────────

    server.registerTool(
      "tp_health_check",
      {
        title: "TradePreflight Health Check",
        description: `Check if the Supreme Trader Worker is online and how fresh the Redis data is.

Returns worker version, data freshness for all Redis keys, and high-level stats:
total pairs tracked, phase distribution, active watch/hot/armed counts.

Use this first to verify the worker is running before calling other tools.
If contextQuality is 'stale' the worker may be down or Redis data has expired.`,
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        try {
          const ctx = await readAllRedis();
          if (!ctx) return { content: [{ type: "text" as const, text: JSON.stringify({ workerOnline: false, error: "Redis not connected" }) }] };

          const { now, states, watch, hot, armed, snapshot } = ctx;
          const snapshotAge   = snapshot?.savedAt ? now - snapshot.savedAt : null;
          const stateVals     = Object.values(states);
          const newestStateAt = stateVals.length ? Math.max(...stateVals.map(s => s.updatedAt)) : null;
          const statesAge     = newestStateAt ? now - newestStateAt : null;

          function keyInfo(raw: boolean, ageMs: number | null) {
            return { exists: raw, ageSec: ageMs !== null ? Math.round(ageMs / 1000) : null, quality: freshnessLabel(ageMs) };
          }

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
              pair_states:     keyInfo(ctx.keyExists.pair_states,     statesAge),
              worker_snapshot: keyInfo(ctx.keyExists.worker_snapshot, snapshotAge),
              active_watch:    keyInfo(ctx.keyExists.active_watch,    safeMinAge(Object.values(watch).map(w => w.addedAt))),
              hot_candidates:  keyInfo(ctx.keyExists.hot_candidates,  safeMinAge(Object.values(hot).map(h => h.promotedAt))),
              armed_entries:   keyInfo(ctx.keyExists.armed_entries,   safeMinAge(Object.values(armed).map(a => a.armedAt))),
            },
            stats: {
              totalPairs:    stateVals.length || Object.keys(snapshot?.memory ?? {}).length,
              activeWatch:   Object.keys(watch).length,
              hotCandidates: Object.keys(hot).length,
              armedEntries:  Object.keys(armed).length,
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

Combines pair_states (live, TTL 120s) + worker_snapshot (24h) + all pipeline maps.

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
          const ctx = await readAllRedis();
          if (!ctx) return { content: [{ type: "text" as const, text: JSON.stringify({ found: false, error: "Redis not connected" }) }] };

          const { now, states, watch, hot, armed, snapshot } = ctx;
          const addr = pair_address.toLowerCase().trim();

          const watchEntry = watch[addr] ?? null;
          const hotEntry   = hot[addr]   ?? null;
          const armedEntry = armed[addr] ?? null;
          const pipelineState = getPipelineState(addr, watch, hot, armed);

          const watchOut = watchEntry ? { ...watchEntry, ageMs: now - watchEntry.addedAt }  : null;
          const hotOut   = hotEntry   ? { ...hotEntry,   ageMs: now - hotEntry.promotedAt } : null;
          const armedOut = armedEntry ? { ...armedEntry, ageMs: now - armedEntry.armedAt }  : null;

          const pairState  = states[addr]              ?? null;
          const snapMem    = snapshot?.memory?.[addr]  ?? null;
          const reserveEth = snapshot?.poolReserveEth?.[addr] ?? null;

          if (!pairState && !snapMem) {
            return { content: [{ type: "text" as const, text: JSON.stringify({
              found: false, pairAddress: addr,
              symbol: watchOut?.symbol ?? hotOut?.symbol ?? armedOut?.symbol ?? null,
              chain:  chain ?? watchOut?.chain ?? hotOut?.chain ?? null,
              pipeline: { state: pipelineState, watch: watchOut, hot: hotOut, armed: armedOut },
              contextQuality: "unknown", dataSource: "none", freshnessSec: null,
            }, null, 2) }] };
          }

          const data = pairState ?? snapMem!;
          const freshnessSec = pairState
            ? Math.round((now - pairState.updatedAt) / 1000)
            : snapshot?.savedAt ? Math.round((now - snapshot.savedAt) / 1000) : null;

          const result = {
            found: true, pairAddress: addr,
            symbol: data.symbol,
            chain:  chain ?? watchOut?.chain ?? hotOut?.chain ?? null,
            phase: data.phase, seenCount: data.seenCount, currentPrice: data.currentPrice,
            dexType: (pairState as PairState)?.dexType ?? null,
            reserveUsd: (pairState as PairState)?.reserveUsd ?? null,
            liqStatus:  (pairState as PairState)?.liqStatus  ?? null,
            poolCountSameToken: (pairState as PairState)?.poolCountSameToken ?? null,
            flow: pairState?.flow ?? null,
            lp:   pairState?.lp  ?? null,
            history: EXPOSE_PERFORMANCE ? {
              totalEntries:      data.totalEntries,
              wins24h:           data.wins24h,
              losses24h:         data.losses24h,
              badExits24h:       data.badExits24h,
              consecutiveLosses: data.consecutiveLosses,
            } : undefined,
            pipeline: { state: pipelineState, watch: watchOut, hot: hotOut, armed: armedOut },
            reserveEth,
            contextQuality: pairState ? freshnessLabel(now - pairState.updatedAt) : "snapshot_only",
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

Shows all pairs moving through the worker's decision flow:
- WATCHING: subscribed via WS, accumulating flow (kind: NORMAL/FOMO/VERTICAL/LATE)
- HOT: promoted candidates with confirmed buying flow
- ARMED: passed entry gate, awaiting 30s price confirmation — may enter imminently

Args: chain (optional filter: 'base' or 'arbitrum')`,
        inputSchema: {
          chain: z.string().optional().describe("Filter by chain: 'base' or 'arbitrum'"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ chain }: { chain?: string }) => {
        try {
          const ctx = await readAllRedis();
          if (!ctx) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Redis not connected" }) }] };

          const { now, watch, hot, armed, states } = ctx;
          const filterChain = (c: string | null | undefined) => !chain || c === chain;
          const firstState   = Object.values(states)[0];
          const freshnessSec = firstState ? Math.round((now - firstState.updatedAt) / 1000) : null;

          const activeWatch = Object.entries(watch)
            .filter(([, v]) => filterChain(v.chain))
            .map(([addr, v]) => ({
              pairAddress: addr, symbol: v.symbol ?? addr.slice(0, 10) + "...",
              chain: v.chain, kind: v.kind,
              ageMin:          Math.round((now - v.addedAt) / 60_000 * 10) / 10,
              entryPrice:      v.entryPrice,
              priceVsEntryPct: v.priceVsEntryPct ?? null,
              reason:          v.reason, phase: v.phase,
              buySwapCount5m:  v.buySwapCount5m,
              sellSwapCount5m: v.sellSwapCount5m,
              largestBuyEth:   v.largestBuyEth,
            }))
            .sort((a, b) => a.ageMin - b.ageMin);

          const hotCandidates = Object.entries(hot)
            .filter(([, v]) => filterChain(v.chain))
            .map(([addr, v]) => ({
              pairAddress: addr, symbol: v.symbol ?? addr.slice(0, 10) + "...",
              chain: v.chain, source: v.source ?? "WS",
              ageSec:         Math.round((now - v.promotedAt) / 1000),
              phase:          v.phase, flow: v.flow,
              largestBuyEth:  v.largestBuyEth,
              buySwapCount5m: v.buySwapCount5m,
            }))
            .sort((a, b) => a.ageSec - b.ageSec);

          const armedEntries = Object.entries(armed)
            .map(([addr, v]) => ({
              pairAddress: addr, symbol: v.symbol ?? addr.slice(0, 10) + "...",
              ageSec:       Math.round((now - v.armedAt) / 1000),
              price: v.price, score: v.score, flowPressure: v.flowPressure,
              phase: v.phase, chain: v.chain,
            }))
            .sort((a, b) => a.ageSec - b.ageSec);

          return { content: [{ type: "text" as const, text: JSON.stringify({
            activeWatch, hotCandidates, armedEntries,
            summary: { watching: activeWatch.length, hot: hotCandidates.length, armed: armedEntries.length },
            freshnessSec,
          }, null, 2) }] };
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

Args:
  phase (optional): TRENDING, SECOND_WAVE, RECOVERING, PUMPING, ZOMBIE, DEAD
  flow_pressure (optional): BUYING, SELLING, NEUTRAL
  chain (optional): base, arbitrum
  min_seen_count (default 0), limit (default 20, max 100), offset (default 0)`,
        inputSchema: {
          phase:          z.string().optional(),
          flow_pressure:  z.string().optional(),
          chain:          z.string().optional(),
          min_seen_count: z.number().int().min(0).default(0),
          limit:          z.number().int().min(1).max(100).default(20),
          offset:         z.number().int().min(0).default(0),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ phase, flow_pressure, chain, min_seen_count, limit, offset }: {
        phase?: string; flow_pressure?: string; chain?: string;
        min_seen_count: number; limit: number; offset: number;
      }) => {
        try {
          const ctx = await readAllRedis();
          if (!ctx) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Redis not connected" }) }] };

          const { now, states, snapshot } = ctx;
          const allAddrs = new Set([...Object.keys(states), ...Object.keys(snapshot?.memory ?? {})]);

          let pairs = [...allAddrs].map(addr => {
            const data = states[addr] ?? snapshot?.memory?.[addr];
            return data ? { addr, data } : null;
          }).filter((x): x is { addr: string; data: PairState | MemoryEntry } => x !== null);

          if (phase)              pairs = pairs.filter(p => p.data.phase === phase.toUpperCase());
          if (flow_pressure)      pairs = pairs.filter(p => states[p.addr]?.flow?.pressure === flow_pressure.toUpperCase());
          if (min_seen_count > 0) pairs = pairs.filter(p => p.data.seenCount >= min_seen_count);
          if (chain)              pairs = pairs.filter(p => (snapshot?.memory?.[p.addr] as MemoryEntry)?.tokenAddress?.startsWith(chain) ?? false);

          const total     = pairs.length;
          const paginated = pairs.slice(offset, offset + limit);

          return { content: [{ type: "text" as const, text: JSON.stringify({
            total, count: paginated.length, offset,
            has_more: total > offset + paginated.length,
            pairs: paginated.map(({ addr, data }) => ({
              pairAddress: addr, symbol: data.symbol, phase: data.phase,
              seenCount: data.seenCount, currentPrice: data.currentPrice,
              dexType:    (states[addr] as PairState)?.dexType    ?? null,
              reserveUsd: (states[addr] as PairState)?.reserveUsd ?? null,
              liqStatus:  (states[addr] as PairState)?.liqStatus  ?? null,
              flow:    states[addr]?.flow ?? null,
            history: EXPOSE_PERFORMANCE ? {
                totalEntries:      data.totalEntries,
                wins24h:           data.wins24h,
                losses24h:         data.losses24h,
                badExits24h:       data.badExits24h,
                consecutiveLosses: data.consecutiveLosses,
              } : undefined,
              updatedAt: states[addr]?.updatedAt ?? null,
            })),
            snapshotAgeSec: snapshot?.savedAt ? Math.round((now - snapshot.savedAt) / 1000) : null,
            workerVersion:  snapshot?.version ?? null,
          }, null, 2) }] };
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

Shows phase distribution, flow pressure, top buying pairs, pipeline counts.
Args: chain (optional), top_n (default 5, max 20)`,
        inputSchema: {
          chain: z.string().optional(),
          top_n: z.number().int().min(1).max(20).default(5),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ chain, top_n }: { chain?: string; top_n: number }) => {
        try {
          const ctx = await readAllRedis();
          if (!ctx) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Redis not connected" }) }] };

          const { now, states, watch, hot, armed, snapshot } = ctx;
          let entries = Object.entries(states);
          if (chain) entries = entries.filter(([addr]) => (snapshot?.memory?.[addr] as MemoryEntry)?.tokenAddress?.startsWith(chain) ?? false);

          const phases: Record<string, number> = {};
          const flowPressure = { buying: 0, selling: 0, neutral: 0, noWsData: 0 };
          for (const [, p] of entries) {
            phases[p.phase] = (phases[p.phase] ?? 0) + 1;
            if (!p.flow.hasData)                    flowPressure.noWsData++;
            else if (p.flow.pressure === "BUYING")  flowPressure.buying++;
            else if (p.flow.pressure === "SELLING") flowPressure.selling++;
            else                                    flowPressure.neutral++;
          }

          const newestStateAt = entries.length ? Math.max(...entries.map(([, p]) => p.updatedAt)) : null;

          return { content: [{ type: "text" as const, text: JSON.stringify({
            phases, flowPressure,
            topBuyingPairs: entries
              .filter(([, p]) => p.flow.hasData && p.flow.pressure === "BUYING")
              .sort(([, a], [, b]) => b.flow.buyVol5m - a.flow.buyVol5m)
              .slice(0, top_n)
              .map(([addr, p]) => ({
                symbol: p.symbol, pairAddress: addr, phase: p.phase,
                dexType: p.dexType, reserveUsd: p.reserveUsd,
                buyVol5m: p.flow.buyVol5m, netVol5m: p.flow.netVol5m, buys5m: p.flow.buys5m,
              })),
            pipeline: { watching: Object.keys(watch).length, hot: Object.keys(hot).length, armed: Object.keys(armed).length },
            totalTracked: entries.length,
            freshnessSec: newestStateAt ? Math.round((now - newestStateAt) / 1000) : null,
          }, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }
    );

    // ── Tool 6: tp_situation_report ──────────────────────────────────────────

    server.registerTool(
      "tp_situation_report",
      {
        title: "TradePreflight Situation Report",
        description: `Front door for AI agents. Call this first to get a human-readable summary of what the Supreme Trader Worker is seeing right now.

Returns a concise narrative covering:
- Market regime (RISK_ON / RISK_OFF / MIXED / DEAD) + WS coverage
- Pipeline status (watching/hot/armed counts + top candidates)
- Recent transitions (what just got promoted, dropped, armed)
- Data freshness

No arguments needed. Returns plain text, not JSON.
Use this before deciding which other tools to call.`,
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async () => {
        try {
          const ctx = await readAllRedis();
          if (!ctx) return { content: [{ type: "text" as const, text: "❌ Redis not connected — worker context unavailable." }] };

          const { now, states, watch, hot, armed, snapshot, regime, events, drops } = ctx;

          // Freshness
          const stateVals     = Object.values(states);
          const newestStateAt = stateVals.length ? Math.max(...stateVals.map(s => s.updatedAt)) : null;
          const freshnessSec  = newestStateAt ? Math.round((now - newestStateAt) / 1000) : null;
          const workerOnline  = !!snapshot && snapshot.savedAt ? (now - snapshot.savedAt) < 5 * 60_000 : false;

          const lines: string[] = [];

          // Worker status
          lines.push(`WORKER: ${workerOnline ? `✅ online (${snapshot?.version ?? "?"})` : "⚠️ offline or stale"} | data: ${freshnessSec !== null ? `${freshnessSec}s ago` : "unknown"}`);

          // Market regime
          if (regime) {
            const regimeEmoji = regime.regime === "RISK_ON" ? "🟢" : regime.regime === "RISK_OFF" ? "🔴" : regime.regime === "DEAD" ? "⚫" : "🟡";
            const chains = regime.wsConnectedChains.length ? regime.wsConnectedChains.join("+") : "none";
            lines.push(`MARKET: ${regimeEmoji} ${regime.regime} | buying:${regime.buyingPctAll}% selling:${regime.sellingPctAll}% | WS coverage:${regime.flowCoveragePct}% | chains:${chains}`);
          } else {
            // Fallback from pair_states
            const withFlow   = stateVals.filter(s => s.flow.hasData);
            const buying     = withFlow.filter(s => s.flow.pressure === "BUYING").length;
            const total      = stateVals.length;
            const buyingPct  = total ? Math.round(buying / total * 100) : 0;
            const coverage   = total ? Math.round(withFlow.length / total * 100) : 0;
            lines.push(`MARKET: ${buyingPct > 30 ? "🟢 RISK_ON" : coverage < 20 ? "⚫ DEAD" : "🟡 MIXED"} | buying:${buyingPct}% | WS coverage:${coverage}%`);
          }

          // Pipeline
          const watchCount = Object.keys(watch).length;
          const hotCount   = Object.keys(hot).length;
          const armedCount = Object.keys(armed).length;
          lines.push(`PIPELINE: watching:${watchCount} | hot:${hotCount} | armed:${armedCount}`);

          // Top HOT candidates
          if (hotCount > 0) {
            const hotList = Object.entries(hot)
              .sort(([, a], [, b]) => a.promotedAt - b.promotedAt)
              .slice(0, 3)
              .map(([addr, h]) => {
                const ageSec = Math.round((now - h.promotedAt) / 1000);
                const flow   = h.flow;
                return `  → ${h.symbol ?? addr.slice(0, 8)} [${h.chain}] source:${h.source ?? "WS"} age:${ageSec}s flow:${flow.pressure} buys:${flow.buys5m} buyVol:${formatEth(flow.buyVol5m)}`;
              });
            lines.push(`HOT CANDIDATES:\n${hotList.join("\n")}`);
          }

          // Armed
          if (armedCount > 0) {
            const armedList = Object.entries(armed)
              .map(([addr, a]) => {
                const ageSec = Math.round((now - a.armedAt) / 1000);
                return `  → ${a.symbol ?? addr.slice(0, 8)} score:${a.score} age:${ageSec}s — confirmation ${ageSec < 30 ? `in ~${30 - ageSec}s` : "imminent"}`;
              });
            lines.push(`⚡ ARMED (may enter soon):\n${armedList.join("\n")}`);
          }

          // Recent pipeline events (last 5 minutes)
          const recentEvents = events.filter(e => now - e.ts < 5 * 60_000).slice(0, 5);
          if (recentEvents.length) {
            const evLines = recentEvents.map(e => {
              const ageSec = Math.round((now - e.ts) / 1000);
              return `  ${ageSec}s ago: ${e.symbol} ${e.from}→${e.to}${e.reason ? ` (${e.reason})` : ""}`;
            });
            lines.push(`RECENT TRANSITIONS:\n${evLines.join("\n")}`);
          }

          // Recent drops (last 5 minutes)
          const recentDrops = drops.filter(d => now - d.droppedAt < 5 * 60_000).slice(0, 3);
          if (recentDrops.length) {
            const dropLines = recentDrops.map(d => {
              const ageSec = Math.round((now - d.droppedAt) / 1000);
              return `  ${ageSec}s ago: ${d.symbol} dropped from ${d.previousState} — ${d.reason}`;
            });
            lines.push(`DROPPED:\n${dropLines.join("\n")}`);
          }

          if (!hotCount && !armedCount && watchCount === 0) {
            lines.push(`NOTE: Pipeline is empty — worker may be scanning but no candidates qualify yet.`);
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }
    );

    // ── Tool 7: tp_candidate_brief ───────────────────────────────────────────

    server.registerTool(
      "tp_candidate_brief",
      {
        title: "TradePreflight Candidate Brief",
        description: `Get a narrative case file for a specific pair — written for AI agent reasoning.

Instead of raw JSON, returns a structured text brief covering:
- Why this pair matters right now
- Current pipeline state and timing
- Flow analysis (organic vs whale, buy pressure quality)
- Liquidity and risk signals
- What would invalidate the setup
- Suggested next verification step

Use this after tp_situation_report identifies a HOT or ARMED candidate.

Args: pair_address (0x... EVM address or V4 pool ID)`,
        inputSchema: {
          pair_address: z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ pair_address }: { pair_address: string }) => {
        try {
          const ctx = await readAllRedis();
          if (!ctx) return { content: [{ type: "text" as const, text: "❌ Redis not connected." }] };

          const { now, states, watch, hot, armed, snapshot, events, drops } = ctx;
          const addr = pair_address.toLowerCase().trim();

          const pairState  = states[addr]             ?? null;
          const snapMem    = snapshot?.memory?.[addr] ?? null;
          const data       = pairState ?? snapMem;
          const watchEntry = watch[addr] ?? null;
          const hotEntry   = hot[addr]   ?? null;
          const armedEntry = armed[addr] ?? null;
          const pipeState  = getPipelineState(addr, watch, hot, armed);

          const symbol = data?.symbol ?? watchEntry?.symbol ?? hotEntry?.symbol ?? armedEntry?.symbol ?? addr.slice(0, 10);
          const chain  = watchEntry?.chain ?? hotEntry?.chain ?? armedEntry?.chain ?? "unknown";

          if (!data && pipeState === "NONE") {
            return { content: [{ type: "text" as const, text: `${symbol} — not found in worker context.\nThe worker has no data for this pair. It may not have been seen in recent scans.` }] };
          }

          const lines: string[] = [];
          lines.push(`═══ CANDIDATE BRIEF: ${symbol} / ${chain.toUpperCase()} ═══`);
          lines.push(`Address: ${addr}`);
          lines.push(`Pipeline: ${pipeState}`);
          lines.push("");

          // Why it matters
          lines.push("WHY IT MATTERS:");
          if (pipeState === "ARMED") {
            const ageSec = Math.round((now - (armedEntry?.armedAt ?? now)) / 1000);
            lines.push(`  • ARMED ${ageSec}s ago — entry gate passed, awaiting 30s price confirmation`);
            lines.push(`  • Entry score: ${armedEntry?.score ?? "?"} | flow: ${armedEntry?.flowPressure ?? "?"}`);
          } else if (pipeState === "HOT") {
            const ageSec = Math.round((now - (hotEntry?.promotedAt ?? now)) / 1000);
            lines.push(`  • Promoted to HOT ${ageSec}s ago from source: ${hotEntry?.source ?? "WS"}`);
            lines.push(`  • Flow: ${hotEntry?.flow?.pressure ?? "?"} | buys: ${hotEntry?.flow?.buys5m ?? 0} | buyVol: ${formatEth(hotEntry?.flow?.buyVol5m ?? 0)}`);
            if ((hotEntry?.largestBuyEth ?? 0) > (hotEntry?.avgBuyEth ?? 0) * 4) {
              lines.push(`  ⚠️ Whale pattern: largest buy ${formatEth(hotEntry?.largestBuyEth ?? 0)} vs avg ${formatEth(hotEntry?.avgBuyEth ?? 0)}`);
            } else {
              lines.push(`  • Flow looks organic: avg buy ${formatEth(hotEntry?.avgBuyEth ?? 0)}, ${hotEntry?.buySwapCount5m ?? 0} swaps`);
            }
          } else if (pipeState === "WATCHING") {
            const ageMin = Math.round((now - (watchEntry?.addedAt ?? now)) / 60_000 * 10) / 10;
            lines.push(`  • In watch for ${ageMin}m (kind: ${watchEntry?.kind ?? "NORMAL"})`);
            if (watchEntry?.priceVsEntryPct !== null && watchEntry?.priceVsEntryPct !== undefined) {
              lines.push(`  • Price vs entry: ${watchEntry.priceVsEntryPct > 0 ? "+" : ""}${watchEntry.priceVsEntryPct}%`);
            }
          }

          if (data) {
            lines.push(
              EXPOSE_PERFORMANCE
                ? `  • Phase: ${data.phase} | seen: ${data.seenCount}x | entries: ${data.totalEntries}`
                : `  • Phase: ${data.phase} | seen: ${data.seenCount}x`
            );
            if (EXPOSE_PERFORMANCE && (data.wins24h > 0 || data.losses24h > 0 || data.badExits24h > 0)) {
              lines.push(`  • History: ${data.wins24h}W / ${data.losses24h}L / ${data.badExits24h} bad exits`);
            }
          }

          // Liquidity
          lines.push("");
          lines.push("LIQUIDITY:");
          if (pairState) {
            lines.push(`  • Reserve: $${Math.round((pairState.reserveUsd ?? 0) / 1000)}K (${pairState.liqStatus ?? "?"})`);
            lines.push(`  • DEX type: ${pairState.dexType ?? "?"}`);
            if ((pairState.poolCountSameToken ?? 1) > 1) {
              lines.push(`  ⚠️ ${pairState.poolCountSameToken} pools for same token — fragmentation/clone risk`);
            }
            if (pairState.lp?.hasData && pairState.lp.status === "REMOVED") {
              lines.push(`  🚨 LP being removed: ${formatEth(pairState.lp.lpRemoved5m ?? 0)} in 5m${pairState.lp.removedPctOfPool ? ` (${pairState.lp.removedPctOfPool}% of pool)` : ""}`);
            }
          } else {
            lines.push(`  • No live liquidity data — using snapshot only`);
          }

          // Flow
          if (pairState?.flow?.hasData) {
            lines.push("");
            lines.push("FLOW (5m):");
            lines.push(`  • Pressure: ${pairState.flow.pressure}`);
            lines.push(`  • Buy: ${formatEth(pairState.flow.buyVol5m)} (${pairState.flow.buys5m} swaps) | Sell: ${formatEth(pairState.flow.sellVol5m)} (${pairState.flow.sells5m} swaps)`);
            lines.push(`  • Net: ${formatEth(pairState.flow.netVol5m)}`);
          }

          // Cautions
          const cautions: string[] = [];
          if (EXPOSE_PERFORMANCE && data && data.consecutiveLosses >= 2) cautions.push(`${data.consecutiveLosses} consecutive losses`);
          if (EXPOSE_PERFORMANCE && data && data.badExits24h >= 2 && data.wins24h === 0) cautions.push(`bad exits only (${data.badExits24h} bad, 0 wins)`);
          if (data && (pairState?.poolCountSameToken ?? 1) >= 3) cautions.push(`clone/fragmentation risk (${pairState?.poolCountSameToken} pools)`);
          if (pairState?.lp?.status === "REMOVED") cautions.push("LP currently being removed");
          const dataAgeSec = pairState ? Math.round((now - pairState.updatedAt) / 1000) : null;
          if (dataAgeSec !== null && dataAgeSec > 60) cautions.push(`data is ${dataAgeSec}s old`);
          if (hotEntry && (now - hotEntry.promotedAt) > 3 * 60_000) cautions.push(`HOT for ${Math.round((now - hotEntry.promotedAt) / 60_000)}m — nearing expiry`);

          if (cautions.length) {
            lines.push("");
            lines.push("CAUTIONS:");
            cautions.forEach(c => lines.push(`  ⚠️ ${c}`));
          }

          // Invalidation
          lines.push("");
          lines.push("INVALIDATE IF:");
          lines.push("  • Flow turns SELLING or netVol drops below 0.03 ETH");
          lines.push("  • LP removal detected (any significant burn event)");
          if ((pairState?.poolCountSameToken ?? 1) >= 2) lines.push("  • Liquidity migrating to another pool for same token");
          if (data?.phase === "RECOVERING") lines.push("  • Phase stays RECOVERING with no BUYING confirmation");

          // Last event for this pair
          const lastEvent = findLastEventForPair(addr, events);
          if (lastEvent) {
            const ageSec = Math.round((now - lastEvent.ts) / 1000);
            lines.push("");
            lines.push(`LAST PIPELINE EVENT (${ageSec}s ago): ${lastEvent.from} → ${lastEvent.to}${lastEvent.reason ? ` — ${lastEvent.reason}` : ""}`);
          }

          // Suggested next step
          lines.push("");
          lines.push("SUGGESTED NEXT STEP:");
          if (pipeState === "ARMED") {
            lines.push("  Worker is about to enter. Run tp_preflight_safety before treating this as actionable.");
          } else if (pipeState === "HOT") {
            lines.push("  Run tp_preflight_safety to verify contract safety. Re-check flow in 30s.");
          } else {
            lines.push("  Monitor — not yet in active pipeline. Call again in 60s or check tp_why_not.");
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }
    );

    // ── Tool 8: tp_why_not ───────────────────────────────────────────────────

    server.registerTool(
      "tp_why_not",
      {
        title: "TradePreflight Why Not",
        description: `Explains why a specific pair is NOT currently HOT or ARMED.

Absence of a signal is information. This tool tells you:
- If it's still WATCHING: how long, what's missing (flow, confirmation, etc.)
- If it was recently dropped: exactly why (flow faded, gate failed, expired, etc.)
- If it's tracked but not in pipeline: phase/history context
- If the worker has never seen it: says so clearly

Use this when you see a token elsewhere (social, chart) but it's not showing up as HOT.

Args: pair_address (0x... EVM address or V4 pool ID)`,
        inputSchema: {
          pair_address: z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ pair_address }: { pair_address: string }) => {
        try {
          const ctx = await readAllRedis();
          if (!ctx) return { content: [{ type: "text" as const, text: "❌ Redis not connected." }] };

          const { now, states, watch, hot, armed, snapshot, events, drops } = ctx;
          const addr    = pair_address.toLowerCase().trim();
          const data    = states[addr] ?? snapshot?.memory?.[addr] ?? null;
          const symbol  = data?.symbol ?? addr.slice(0, 10);
          const pipeState = getPipelineState(addr, watch, hot, armed);

          // If already HOT or ARMED, say so
          if (pipeState === "HOT") {
            const h = hot[addr];
            return { content: [{ type: "text" as const, text: `${symbol} IS currently HOT (promoted ${formatAge(now - h.promotedAt)} ago from ${h.source ?? "WS"}). Use tp_candidate_brief for full context.` }] };
          }
          if (pipeState === "ARMED") {
            const a = armed[addr];
            return { content: [{ type: "text" as const, text: `${symbol} IS currently ARMED (${formatAge(now - a.armedAt)} ago, score:${a.score}). Entry imminent. Use tp_candidate_brief for full context.` }] };
          }

          const lines: string[] = [];
          lines.push(`WHY ${symbol} IS NOT HOT/ARMED:`);
          lines.push("");

          // Currently watching
          if (pipeState === "WATCHING") {
            const w      = watch[addr]!;
            const ageMin = Math.round((now - w.addedAt) / 60_000 * 10) / 10;
            lines.push(`Status: WATCHING (${ageMin}m, kind: ${w.kind})`);
            if (w.buySwapCount5m === 0) {
              lines.push("• No WS swap events yet — waiting for buying activity");
            } else {
              lines.push(`• ${w.buySwapCount5m} buys / ${w.sellSwapCount5m} sells seen so far`);
              lines.push(`• Largest buy: ${formatEth(w.largestBuyEth)} — not enough to confirm`);
            }
            if (w.priceVsEntryPct !== null && w.priceVsEntryPct !== undefined) {
              lines.push(`• Price vs entry: ${w.priceVsEntryPct > 0 ? "+" : ""}${w.priceVsEntryPct}%`);
            }
            lines.push(`• Worker waiting for: confirmed BUYING flow (≥5 buys/5m, net vol ≥0.05 ETH)`);
            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          }

          // Not in pipeline — check recent drops
          const lastDrop = findLastDropForPair(addr, drops);
          if (lastDrop) {
            const ageSec = Math.round((now - lastDrop.droppedAt) / 1000);
            lines.push(`Recently dropped from ${lastDrop.previousState} (${ageSec}s ago):`);
            lines.push(`• Reason: ${lastDrop.reason}`);
            lines.push("");
          }

          // Check pipeline events for history
          const lastEvent = findLastEventForPair(addr, events);
          if (lastEvent && !lastDrop) {
            const ageSec = Math.round((now - lastEvent.ts) / 1000);
            lines.push(`Last pipeline event (${ageSec}s ago): ${lastEvent.from} → ${lastEvent.to}`);
            if (lastEvent.reason) lines.push(`• Reason: ${lastEvent.reason}`);
            lines.push("");
          }

          // Tracked but not in pipeline
          if (data) {
            lines.push(`Worker context:`);
            lines.push(`• Phase: ${data.phase} | seen: ${data.seenCount}x`);
            if (EXPOSE_PERFORMANCE) {
              lines.push(`• Entries: ${data.totalEntries} | W${data.wins24h}/L${data.losses24h}/bad:${data.badExits24h}`);
            }

            const flow = states[addr]?.flow;
            if (flow) {
              lines.push(`• Current flow: ${flow.hasData ? `${flow.pressure} (buys:${flow.buys5m} buyVol:${formatEth(flow.buyVol5m)})` : "no WS data"}`);
            }

            // Likely reasons it's not promoted
            const reasons: string[] = [];
            if (data.phase === "RECOVERING" && data.seenCount > 20) reasons.push("phase RECOVERING with long history — entry blocked by default");
            if (EXPOSE_PERFORMANCE && data.consecutiveLosses >= 3) reasons.push(`${data.consecutiveLosses} consecutive losses — score heavily penalised`);
            if (EXPOSE_PERFORMANCE && data.badExits24h >= 2 && data.wins24h === 0) reasons.push("bad exits only, zero wins — entry gate blocks");
            if (EXPOSE_PERFORMANCE && data.seenCount > 40 && data.totalEntries === 0) reasons.push("seen 40+ times with no entry — marked as stale loser");
            const pCount = (states[addr] as PairState)?.poolCountSameToken ?? 1;
            if (pCount >= 5) reasons.push(`${pCount} pools for same token — clone/fragmentation block`);

            if (reasons.length) {
              lines.push("");
              lines.push("Likely gate blockers:");
              reasons.forEach(r => lines.push(`  • ${r}`));
            } else if (!lastDrop && !lastEvent) {
              lines.push("");
              lines.push("Worker tracks it but hasn't promoted it yet.");
              lines.push("May need more scan cycles or stronger buying flow.");
            }
          } else {
            lines.push("Worker has no context for this pair.");
            lines.push("It may not have appeared in recent trending/new pool scans.");
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }
    );

    // ── Tool 9: tp_do_not_chase ──────────────────────────────────────────────

    server.registerTool(
      "tp_do_not_chase",
      {
        title: "TradePreflight Do Not Chase",
        description: `Anti-FOMO list: pairs that look active but the worker dropped or rejected.

Returns pairs recently dropped from HOT/ARMED/WATCHING with reasons — things that may appear
on social media or price charts as "movers" but the worker decided to skip.

Context for each entry:
- What state it was in before drop
- Why it was dropped (flow faded, price dump, gate failed, too late, no WS, etc.)
- How long ago it was dropped

Use this to avoid chasing tokens that already failed worker's quality check.

Args: limit (default 10, max 30), minutes_back (how far back to look, default 10, max 10 — Redis only keeps 10m of drop history)`,
        inputSchema: {
          limit:        z.number().int().min(1).max(30).default(10),
          minutes_back: z.number().int().min(1).max(10).default(10),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ limit, minutes_back }: { limit: number; minutes_back: number }) => {
        try {
          const ctx = await readAllRedis();
          if (!ctx) return { content: [{ type: "text" as const, text: "❌ Redis not connected." }] };

          const { now, drops, states } = ctx;
          const cutoff = now - minutes_back * 60_000;

          const recent = drops
            .filter(d => d.droppedAt >= cutoff)
            .slice(0, limit);

          if (!recent.length) {
            return { content: [{ type: "text" as const, text: `No drops in the last ${minutes_back} minutes. Pipeline has been stable.` }] };
          }

          const lines: string[] = [];
          lines.push(`DO NOT CHASE — dropped in last ${minutes_back}m (${recent.length} total):`);
          lines.push("");

          for (const d of recent) {
            const ageSec  = Math.round((now - d.droppedAt) / 1000);
            const pairData = states[d.pairAddress];
            const phase    = pairData?.phase ?? "?";

            let line = `${d.symbol} [${d.chain}] — dropped from ${d.previousState} ${ageSec}s ago`;
            line += `\n  Reason: ${d.reason}`;
            if (phase !== "?") line += ` | phase: ${phase}`;
            if (pairData?.flow?.hasData) {
              line += ` | flow now: ${pairData.flow.pressure}`;
            }

            // Categorize the drop for agent reasoning
            const r = d.reason.toLowerCase();
            if (r.includes("flow faded") || r.includes("flow turned") || r.includes("no buying flow")) {
              line += "\n  → Buying interest evaporated. Do not re-enter without fresh WS confirmation.";
            } else if (r.includes("too late") || r.includes("vertical")) {
              line += "\n  → Price already moved significantly. Entry now = buying the top.";
            } else if (r.includes("dump") || r.includes("-")) {
              line += "\n  → Price dumped after signal. Avoid until structure rebuilds.";
            } else if (r.includes("gate") || r.includes("score") || r.includes("evidence")) {
              line += "\n  → Failed quality check. Worker's criteria not met.";
            } else if (r.includes("no ws") || r.includes("no confirmation")) {
              line += "\n  → Never confirmed with live flow data. Signal was unverified.";
            } else if (r.includes("expired") || r.includes("5m")) {
              line += "\n  → Timed out without confirmation. Move may be over.";
            }

            lines.push(line);
            lines.push("");
          }

          return { content: [{ type: "text" as const, text: lines.join("\n").trim() }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
        }
      }
    );

 // ── Tool 10: tp_preflight_safety ────────────────────────────────────────

    server.registerTool(
      "tp_preflight_safety",
      {
        title: "TradePreflight Token Safety",
        description: `Run a GoPlus security check on a token before acting on a HOT or ARMED signal.

Checks: honeypot detection, buy/sell tax, owner permissions (mint/blacklist/pause/tax change),
owner renounced status, and token age.

Returns a structured safety brief with:
- agentVerdict: BLOCK | HIGH_CAUTION | OK_TO_INVESTIGATE | UNKNOWN_CHECK_MANUALLY
- sellability: can this token actually be sold?
- taxRisk: how much of your P&L disappears in tax?
- ownerRisk: can the owner change the rules after you enter?
- missingData: what could not be verified

Results are cached in Redis for 30 minutes (GoPlus free tier).

Args:
  pair_address   — EVM pair address (used to look up token address from worker context)
  token_address  — optional: pass directly if worker snapshot cannot resolve it
  chain          — optional: 'base' or 'arbitrum' (derived from context if omitted)`,
        inputSchema: {
          pair_address:  z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
          token_address: z.string().optional().describe("Optional token contract address — use if worker snapshot cannot resolve it automatically"),
          chain:         z.string().optional().describe("Chain: 'base' or 'arbitrum'"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ pair_address, token_address, chain }: { pair_address: string; token_address?: string; chain?: string }) => {
        try {
          const r   = getRedis();
          const ctx = await readAllRedis();
          const addr = pair_address.toLowerCase().trim();

          let rawTokenAddress: string | null = null;
          let resolvedChain   = chain ?? null;

         // Explicit token_address from caller takes priority
          if (token_address) {
            rawTokenAddress = token_address;
          }

          // Fallback: resolve from worker snapshot
          if (!rawTokenAddress && ctx) {
            const snapMem = ctx.snapshot?.memory?.[addr];
            if (snapMem?.tokenAddress) {
              rawTokenAddress = snapMem.tokenAddress;
            }
          }

          // Resolve chain — try token address prefix first, then pipeline maps
          if (!resolvedChain && rawTokenAddress) {
            resolvedChain = deriveChainFromTokenAddress(rawTokenAddress);
          }
          if (!resolvedChain && ctx) {
            resolvedChain =
              ctx.hot[addr]?.chain ??
              ctx.watch[addr]?.chain ??
              ctx.armed[addr]?.chain ??
              null;
          }
          if (resolvedChain) {
            resolvedChain = resolvedChain.toLowerCase().trim();
          }

          // No fallback from pair_address → token_address:
          // a pair address looks identical to a token address and would produce
          // a false GoPlus verdict on the pool contract, not the token.

          const symbol =
            ctx?.snapshot?.memory?.[addr]?.symbol ??
            ctx?.hot[addr]?.symbol ??
            ctx?.watch[addr]?.symbol ??
            addr.slice(0, 10);

          if (!rawTokenAddress || !resolvedChain) {
            const missing: string[] = [];
            if (!rawTokenAddress) missing.push("token address not found in worker context — pass token_address explicitly");
            if (!resolvedChain)   missing.push("chain could not be determined — pass chain: 'base' or 'arbitrum'");
            return { content: [{ type: "text" as const, text: [
              `PREFLIGHT SAFETY: ${symbol}`,
              ``,
              `⚠️ Cannot run safety check:`,
              ...missing.map(m => `  • ${m}`),
              ``,
              `agentVerdict: UNKNOWN_CHECK_MANUALLY`,
            ].join("\n") }] };
          }

          const safety    = await getTokenSafety(rawTokenAddress, resolvedChain, r);
          const tokenAddr = cleanTokenAddress(rawTokenAddress);

          const verdictEmoji =
            safety.agentVerdict === "BLOCK"             ? "🚫" :
            safety.agentVerdict === "HIGH_CAUTION"      ? "⚠️" :
            safety.agentVerdict === "OK_TO_INVESTIGATE" ? "🟢" : "❓";

          const lines: string[] = [];
          lines.push(`PREFLIGHT SAFETY: ${symbol} / ${resolvedChain.toUpperCase()}`);
          lines.push(`Token: ${tokenAddr}`);
          lines.push(`Source: ${safety.source === "cache" ? "cached (GoPlus)" : safety.source === "goplus" ? "GoPlus live" : "unavailable"}`);
          lines.push(``);
          lines.push(`${verdictEmoji} Agent Verdict: ${safety.agentVerdict}`);
          lines.push(``);

          // Sellability
          const sellEmoji = safety.sellability === "PASS" ? "✅" : safety.sellability === "FAIL" ? "🚫" : "❓";
          lines.push(`SELLABILITY: ${sellEmoji} ${safety.sellability}`);
          if (safety.isHoneypot === true)  lines.push(`  • Honeypot detected — cannot sell`);
          if (safety.isHoneypot === false) lines.push(`  • No honeypot detected`);
          if (safety.buyTaxPct  !== null)  lines.push(`  • Buy tax:  ${safety.buyTaxPct}%`);
          if (safety.sellTaxPct !== null)  lines.push(`  • Sell tax: ${safety.sellTaxPct}%`);
          lines.push(``);

          // Owner risk
          const ownerEmoji = safety.ownerRisk === "LOW" ? "✅" : safety.ownerRisk === "HIGH" ? "🚫" : safety.ownerRisk === "MEDIUM" ? "⚠️" : "❓";
          lines.push(`OWNER CONTROLS: ${ownerEmoji} ${safety.ownerRisk}`);
          if (safety.ownerRenounced === true)   lines.push(`  • Owner renounced ✅`);
          if (safety.ownerRenounced === false)  lines.push(`  • Owner NOT renounced ⚠️`);
          if (safety.canChangeTax)              lines.push(`  • Can change tax ⚠️`);
          if (safety.canMint)                   lines.push(`  • Can mint new tokens 🚫`);
          if (safety.canBlacklist)              lines.push(`  • Can blacklist wallets ⚠️`);
          if (safety.canPauseTrading)           lines.push(`  • Can pause trading 🚫`);
          if (safety.canChangeBalance)          lines.push(`  • Owner can change balances 🚫`);
          if (safety.canTakeBackOwnership)      lines.push(`  • Can take back ownership 🚫`);
          lines.push(``);

          // Token age
          if (safety.tokenAgeMinutes !== null) {
            const ageStr =
              safety.tokenAgeMinutes < 60   ? `${safety.tokenAgeMinutes}m` :
              safety.tokenAgeMinutes < 1440 ? `${Math.round(safety.tokenAgeMinutes / 60)}h` :
              `${Math.round(safety.tokenAgeMinutes / 1440)}d`;
            const ageWarn =
              safety.tokenAgeMinutes < 60  ? " ⚠️ very new" :
              safety.tokenAgeMinutes < 360 ? " ⚠️ new"      : "";
            lines.push(`TOKEN AGE: ${ageStr}${ageWarn}`);
            lines.push(``);
          }

          // Missing data
          if (safety.missingData.length > 0) {
            lines.push(`MISSING DATA:`);
            safety.missingData.forEach(m => lines.push(`  • ${m}`));
            lines.push(``);
          }

          // Verdict explanation
          lines.push(`VERDICT EXPLANATION:`);
          if (safety.agentVerdict === "BLOCK") {
            lines.push(`  Cannot safely exit this position. Do not act on HOT/ARMED signal.`);
          } else if (safety.agentVerdict === "HIGH_CAUTION") {
            lines.push(`  Structural risk detected. Owner controls or high tax may impact profitability.`);
            lines.push(`  Live flow may be real, but contract mechanics reduce edge.`);
          } else if (safety.agentVerdict === "OK_TO_INVESTIGATE") {
            lines.push(`  No critical contract risks detected. Flow signal can be treated as structurally valid.`);
          } else {
            lines.push(`  Safety data incomplete. Treat HOT signal with caution until verified manually.`);
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") }] };

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

// ── Route exports ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!validateApiKey(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  return handler(req);
}

export async function POST(req: NextRequest) {
  if (!validateApiKey(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  return handler(req);
}