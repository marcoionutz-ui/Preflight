import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis } from "../redis-reader";
import type { MemoryEntry } from "../types";
import { mcpOk, mcpErr, ERR } from "../errors";

export function registerMarketOverview(server: McpServer) {
  server.registerTool(
    "tp_market_overview",
    {
      title: "Preflight Market Overview",
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
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot } = ctx;
        let entries = Object.entries(states);
        if (chain) entries = entries.filter(([addr]) =>
          (snapshot?.memory?.[addr] as MemoryEntry)?.tokenAddress?.startsWith(chain) ?? false
        );

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

        return mcpOk({
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
          pipeline: {
            watching: Object.keys(watch).length,
            hot:      Object.keys(hot).length,
            armed:    Object.keys(armed).length,
          },
          totalTracked:  entries.length,
          freshnessSec:  newestStateAt ? Math.round((now - newestStateAt) / 1000) : null,
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
