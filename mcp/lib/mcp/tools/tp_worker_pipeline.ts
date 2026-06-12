import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis } from "../redis-reader";
import { mcpOk, mcpErr, ERR } from "../errors";

export function registerWorkerPipeline(server: McpServer) {
  server.registerTool(
    "tp_worker_pipeline",
    {
      title: "Preflight Worker Pipeline",
      description: `Get the live internal pipeline of the worker.

Shows all pairs moving through the worker's decision flow:
- WATCHING: subscribed via WS, accumulating flow (kind: NORMAL/FOMO/VERTICAL/LATE)
- HOT: promoted candidates with confirmed buying flow
- ARMED: passed entry gate, awaiting 30s price confirmation — may enter imminently

Args: chain (filter: 'base', 'arbitrum', or 'bsc')`,
      inputSchema: {
        chain: z.string().optional().describe("Filter by chain: 'base' or 'arbitrum'"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ chain }: { chain?: string }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, watch, hot, armed, states, pfPipeline, pfQualified } = ctx;
        const filterChain  = (c: string | null | undefined) => !chain || c === chain;
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
            reason: v.reason, phase: v.phase,
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
          .filter(([, v]) => filterChain(v.chain ?? ""))
          .map(([addr, v]) => ({
            pairAddress: addr, symbol: v.symbol ?? addr.slice(0, 10) + "...",
            ageSec:       Math.round((now - v.armedAt) / 1000),
            price: v.price, score: v.score, flowPressure: v.flowPressure,
            phase: v.phase, chain: v.chain,
          }))
          .sort((a, b) => a.ageSec - b.ageSec);
		
		// Preflight pipeline entries (richer context)
        const pfEntries = pfPipeline && pfPipeline.length > 0
          ? pfPipeline
              .filter((e: any) => filterChain(e.chain))
              .map((e: any) => ({
              symbol:            e.symbol,
              chain:             e.chain,
              pairAddress:       e.pairAddress,
              pipelineState:     e.pipelineState,
              watchKind:         e.watchKind,
              watchAgeMin:       Math.round(e.watchAgeMs / 60_000 * 10) / 10,
              confidence:        e.confidence,
              entryRisk:         e.entryRisk,
              flow:              e.flow,
              riskFlags:         e.riskFlags,
              opportunitySignals: e.opportunitySignals,
              priceVsEntryPct:   e.priceVsEntryPct,
              workerObservation: e.workerObservation,
            }))
          : null;

        return mcpOk({
          pipeline: pfEntries ?? null,
          legacy: { activeWatch, hotCandidates, armedEntries },
          summary: pfEntries
            ? {
                watching:   pfEntries.filter((e: any) => e.pipelineState === "WATCHING").length,
                hot:        pfEntries.filter((e: any) => e.pipelineState === "HOT").length,
                confirming: pfEntries.filter((e: any) => e.pipelineState === "HOT").length, // legacy alias
                qualified:  pfQualified?.filter((q: any) => filterChain(q.chain)).length ?? 0,
              }
            : { watching: activeWatch.length, hot: hotCandidates.length, armed: armedEntries.length },
          freshnessSec,
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
