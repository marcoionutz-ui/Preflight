import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis, freshnessLabel, getPipelineState, readPairContext } from "../redis-reader";
import type { PairState, MemoryEntry } from "../types";
import { mcpOk, mcpErr, ERR } from "../errors";

export function registerPairContext(server: McpServer, exposePerformance: boolean) {
  server.registerTool(
    "tp_pair_context",
    {
      title: "Preflight Pair Context",
      description: `Get everything the worker knows about a specific pair.

Combines pair_states (live, TTL 120s) + worker_snapshot (24h) + all pipeline maps.

pipelineState: WATCHING = subscribed via WS, accumulating flow
               HOT      = confirmed buying flow, about to enter
               ARMED    = passed entry gate, awaiting 30s price confirmation
               NONE     = not currently tracked in pipeline

contextQuality: fresh (<45s), aging (<90s), stale (>90s), snapshot_only, unknown

Args: pair_address (0x... EVM address or V4 pool ID), chain (optional: base/arbitrum)`,
      inputSchema: {
        pair_address: z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
        chain:        z.string().optional().describe("Chain hint: 'base' or 'arbitrum'"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pair_address, chain }: { pair_address: string; chain?: string }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot } = ctx;
        const addr = pair_address.toLowerCase().trim();
		
		// Try preflight:pair_context first — richest data
        const pfCtx = await readPairContext(addr);

        const watchEntry    = watch[addr] ?? null;
        const hotEntry      = hot[addr]   ?? null;
        const armedEntry    = armed[addr] ?? null;
        const pipelineState = getPipelineState(addr, watch, hot, armed);

        const watchOut = watchEntry ? { ...watchEntry, ageMs: now - watchEntry.addedAt }  : null;
        const hotOut   = hotEntry   ? { ...hotEntry,   ageMs: now - hotEntry.promotedAt } : null;
        const armedOut = armedEntry ? { ...armedEntry, ageMs: now - armedEntry.armedAt }  : null;

        const pairState  = states[addr]             ?? null;
        const snapMem    = snapshot?.memory?.[addr] ?? null;
        const reserveEth = snapshot?.poolReserveEth?.[addr] ?? null;

        if (!pairState && !snapMem) {
          if (pfCtx) {
            return mcpOk({
              found: true, pairAddress: addr,
              symbol: pfCtx.symbol,
              chain:  pfCtx.chain,
              preflightContext: pfCtx,
              pipeline: { state: pfCtx.pipelineState ?? "NONE", watch: watchOut, hot: hotOut, armed: armedOut },
              contextQuality: pfCtx.contextQuality ?? "fresh",
              dataSource: "preflight_pair_context",
              freshnessSec: pfCtx.updatedAt ? Math.round((now - pfCtx.updatedAt) / 1000) : null,
            });
          }
          return mcpOk({
            found: false, pairAddress: addr,
            symbol: watchOut?.symbol ?? hotOut?.symbol ?? armedOut?.symbol ?? null,
            pipeline: { state: pipelineState, watch: watchOut, hot: hotOut, armed: armedOut },
            contextQuality: "unknown", dataSource: "none", freshnessSec: null,
			preflightContext: pfCtx ?? null,
          });
        }

        const data = pairState ?? snapMem!;
        const freshnessSec = pairState
          ? Math.round((now - pairState.updatedAt) / 1000)
          : snapshot?.savedAt ? Math.round((now - snapshot.savedAt) / 1000) : null;

        return mcpOk({
          found: true, pairAddress: addr,
          symbol: data.symbol,
          chain:  chain ?? pairState?.chain ?? watchOut?.chain ?? hotOut?.chain ?? armedOut?.chain ?? null,
          phase: data.phase, seenCount: data.seenCount, currentPrice: data.currentPrice,
          priceChange: (pairState as PairState)?.priceChange ?? null,
          dexType:            (pairState as PairState)?.dexType            ?? null,
          reserveUsd:         (pairState as PairState)?.reserveUsd         ?? null,
          liqStatus:          (pairState as PairState)?.liqStatus          ?? null,
          poolCountSameToken: (pairState as PairState)?.poolCountSameToken ?? null,
          flow: pairState?.flow ?? null,
          lp:   pairState?.lp  ?? null,
          dataAvailability: (() => {
            const hasWsFlow  = !!pairState?.flow?.hasData;
            const hasLpData  = !!pairState?.lp?.hasData;
            const liveMonitored = pipelineState === "WATCHING" ||
              pipelineState === "HOT" || pipelineState === "ARMED";
            return {
              marketData: pairState ? "available" : "not_available",
              wsFlow:    hasWsFlow  ? "available"
                : liveMonitored     ? "not_available_no_ws_events_yet"
                :                    "not_available_market_only",
              lpSignal:  hasLpData  ? "available"
                : liveMonitored     ? "not_available_no_lp_events_yet"
                :                    "not_available_market_only",
            };
          })(),
          marketPattern: {
            lastMomentumVerdict: (pairState as any)?.lastMomentumVerdict ?? null,
            lastMomentumAt:      (pairState as any)?.lastMomentumAt      ?? null,
            attentionScore:      (pairState as any)?.attentionScore      ?? null,
            monitoringTier:      (pairState as any)?.monitoringTier      ?? null,
            patternTags:         (pairState as any)?.patternTags         ?? null,
          },
          history: exposePerformance ? {
            totalEntries:      data.totalEntries,
            wins24h:           data.wins24h,
            losses24h:         data.losses24h,
            badExits24h:       data.badExits24h,
            consecutiveLosses: data.consecutiveLosses,
          } : undefined,
          pipeline: { state: pipelineState, watch: watchOut, hot: hotOut, armed: armedOut },
          reserveEth,
          preflightContext: pfCtx ?? null,
          contextQuality: pfCtx ? "fresh" : pairState ? freshnessLabel(now - pairState.updatedAt) : "snapshot_only",
          dataSource: pfCtx ? "preflight_pair_context" : pairState ? "pair_states" : "worker_snapshot",
          freshnessSec,
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
