import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis, readTrendingMovers, readSolanaMovers } from "../redis-reader";
import type { MemoryEntry } from "../types";
import { mcpResponse, mcpErr, ERR } from "../errors";

export function registerMarketOverview(server: McpServer) {
  server.registerTool(
    "tp_market_overview",
    {
      title: "Preflight Market Overview",
      description: `High-level view of current DEX market conditions from the worker's perspective.

Shows phase distribution, flow pressure, top buying pairs, pipeline counts, and own-source trending movers.
Args: chain (optional), top_n (default 5, max 20)`,
      inputSchema: {
        chain: z.string().optional(),
        top_n: z.number().int().min(1).max(20).default(5),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ chain, top_n }: { chain?: string; top_n: number }) => {
      try {
        // ── 8.0i-b/d: Solana branch — înainte de readAllRedis (EVM only) ──────
        // Normalize "eth" → "ethereum" (worker stochează "ethereum")
        const rawChainId = chain?.toLowerCase().trim();
        const chainId = rawChainId === "eth" ? "ethereum" : rawChainId;

        if (chainId === "solana") {
          const now = Date.now();
          const solanaMovers = await readSolanaMovers(now, top_n).catch(() => null);
          return mcpResponse({
            text: JSON.stringify({
              chain:  "solana",
              note:   "Solana movers are sampled from observed swap vault deltas, not full firehose.",
              solanaSampledMovers: solanaMovers,
            }, null, 2),
            freshnessSec: solanaMovers?.computedAgeSec ?? null,
            confidence:
              solanaMovers && solanaMovers.computedAgeSec < 120 ? "MEDIUM" :
              solanaMovers ? "LOW" :
              "LOW",
            dataQuality: { wsFlow: "absent" },
          });
        }

        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot } = ctx;

        // ── 6.10: trending movers per chain (EVM) ────────────────────────────
        // Solana are reader separat — exclude din EVM trending movers loop
        const evmChainId = chainId ?? null;
        const chains     = evmChainId ? [evmChainId] : ["base", "arbitrum", "bsc", "ethereum"];
        const moversByChain: Record<string, unknown[]> = {};
        for (const c of chains) {
          const movers = await readTrendingMovers(c); // EVM only
          if (movers.length) {
            moversByChain[c] = movers.slice(0, top_n).map(m => ({
              symbol:         m.symbol,
              dexType:        m.dexType,
              pairAddress:    m.pairAddress,
              tokenAddress:   m.tokenAddress,
              priceUsd:       m.priceUsd,
              reserveUsd:     m.reserveUsd,
              priceChange5m:  m.priceChange5m,
              priceChange1h:  m.priceChange1h,
              priceChange24h: m.priceChange24h,
              direction:      m.direction,
              historyStatus:  m.historyStatus,
              snapshotCount:  m.snapshotCount,
            }));
          }
        }

        let entries = Object.entries(states);
        if (chainId) {
          entries = entries.filter(([addr, p]) => {
            const mem = snapshot?.memory?.[addr] as MemoryEntry | undefined;
            return p.chain === chainId || mem?.chain === chainId;
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

        const newestStateAt = entries.length ? Math.max(...entries.map(([, p]) => p.updatedAt)) : null;

        const totalWithFlow = flowPressure.buying + flowPressure.selling + flowPressure.neutral;
        const wsFlowQuality: "present" | "partial" | "absent" =
          entries.length === 0  ? "absent" :
          totalWithFlow === 0   ? "absent" :
          totalWithFlow < entries.length ? "partial" :
          "present";

        const freshnessSec = newestStateAt ? Math.round((now - newestStateAt) / 1000) : null;

        return mcpResponse({
          text: JSON.stringify({
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
            totalTracked: entries.length,
            freshnessSec,
            trendingMovers: Object.keys(moversByChain).length ? moversByChain : null,
            // Solana sampled movers — incluse doar în global overview (fără chain filter)
            // chainId === "solana" e deja handled de branch-ul de mai sus
            solanaSampledMovers: !chainId
              ? await readSolanaMovers(now, top_n).catch(() => null)
              : undefined,
          }, null, 2),
          freshnessSec,
          confidence:
            newestStateAt && now - newestStateAt < 60_000     ? "HIGH" :
            newestStateAt && now - newestStateAt < 3 * 60_000 ? "MEDIUM" :
            "LOW",
          dataQuality: { wsFlow: wsFlowQuality },
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
