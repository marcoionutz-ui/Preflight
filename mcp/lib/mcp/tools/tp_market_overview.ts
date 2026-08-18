import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis, readTrendingMovers, readSolanaMovers } from "../redis-reader";
import { normalizeChainId, reserveEstimatedFlag, pairKey } from "@preflight/schema";
import type { MemoryEntry } from "../types";
import { mcpResponse, mcpErr, ERR, sanitizeToolError, PREFLIGHT_OUTPUT_SCHEMA } from "../errors";

export function registerMarketOverview(server: McpServer) {
  server.registerTool(
    "tp_market_overview",
    {
      title: "Preflight Market Overview",
      description: `High-level view of current DEX market conditions from the worker's perspective.

Shows phase distribution, flow pressure, top buying pairs, pipeline counts, and own-source trending movers.
Args: chain (optional), top_n (default 5, max 20)`,
      inputSchema: {
        chain: z.enum(["base", "arbitrum", "bsc", "eth", "solana"]).optional(),
        top_n: z.number().int().min(1).max(20).default(5),
      },
      outputSchema: PREFLIGHT_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ chain, top_n }: { chain?: string; top_n: number }) => {
      try {
        // ── 8.0i-b/d: Solana branch — înainte de readAllRedis (EVM only) ──────
        // Normalize "eth" → "ethereum" (worker stochează "ethereum")
        const chainId = chain ? normalizeChainId(chain) : undefined;

        if (chainId === "solana") {
          const now = Date.now();
          const solanaMovers = await readSolanaMovers(now, top_n).catch(() => null);
          const solanaPayload = {
            chain:  "solana",
            note:   "Solana movers are sampled from observed swap vault deltas, not full firehose.",
            solanaSampledMovers: solanaMovers,
          };
          return mcpResponse({
            text: JSON.stringify(solanaPayload, null, 2),
            data: solanaPayload,
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
            moversByChain[c] = movers.slice(0, top_n).map(m => {
              // NF/U5: trending movers nu poartă reserveSource în schema lor → asociem cu pair_states
              // înainte de output ca reserveUsd V4 (estimat) să nu apară drept certitudine.
              const ps = states[pairKey(c, m.pairAddress)];
              return {
                symbol:         m.symbol,
                dexType:        m.dexType,
                pairAddress:    m.pairAddress,
                tokenAddress:   m.tokenAddress,
                priceUsd:       m.priceUsd,
                reserveUsd:     m.reserveUsd,
                reserveSource:    ps?.reserveSource ?? null,
                reserveEstimated: reserveEstimatedFlag(ps?.reserveSource), // tri-stare: null când nu avem pair_state
                priceChange5m:  m.priceChange5m,
                priceChange1h:  m.priceChange1h,
                priceChange24h: m.priceChange24h,
                direction:      m.direction,
                historyStatus:  m.historyStatus,
                snapshotCount:  m.snapshotCount,
              };
            });
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

        // B3f-2: watch/hot/armed sunt globale (toate chain-urile) — la un raport
        // per-chain numărăm doar entries cu chain-ul cerut.
        const countPipelineEntries = (m: Record<string, { chain?: string | null }>): number =>
          !chainId ? Object.keys(m).length
                   : Object.values(m).filter(e => e.chain != null && normalizeChainId(e.chain) === chainId).length;

        const freshnessSec = newestStateAt ? Math.round((now - newestStateAt) / 1000) : null;

        // Solana sampled movers — incluse doar în global overview (fără chain filter)
        // chainId === "solana" e deja handled de branch-ul de mai sus
        const solanaSampledMovers = !chainId
          ? await readSolanaMovers(now, top_n).catch(() => null)
          : undefined;

        const payload = {
          phases, flowPressure,
          topBuyingPairs: entries
            .filter(([, p]) => p.flow.hasData && p.flow.pressure === "BUYING")
            .sort(([, a], [, b]) => b.flow.buyVol5m - a.flow.buyVol5m)
            .slice(0, top_n)
            // B3f-2: cheia e pairKey → expune adresa brută + chain din VALOARE (PairState).
            .map(([, p]) => ({
              symbol: p.symbol, pairAddress: p.pairAddress, chain: p.chain, phase: p.phase,
              dexType: p.dexType, reserveUsd: p.reserveUsd,
              // NF/U5: proveniența rezervei — reserveUsd V4 e estimat (virtual reserves, poate supraestima).
              reserveSource: p.reserveSource ?? null, reserveEstimated: reserveEstimatedFlag(p.reserveSource),
              buyVol5m: p.flow.buyVol5m, netVol5m: p.flow.netVol5m, buys5m: p.flow.buys5m,
            })),
          pipeline: {
            // B3f-2: numără doar entries pe chain-ul raportului (înainte era global —
            // un overview Base raporta watching-ul de pe toate chain-urile).
            watching: countPipelineEntries(watch),
            hot:      countPipelineEntries(hot),
            armed:    countPipelineEntries(armed),
          },
          totalTracked: entries.length,
          freshnessSec,
          trendingMovers: Object.keys(moversByChain).length ? moversByChain : null,
          solanaSampledMovers,
        };
        return mcpResponse({
          text: JSON.stringify(payload, null, 2),
          data: payload,
          freshnessSec,
          confidence:
            newestStateAt && now - newestStateAt < 60_000     ? "HIGH" :
            newestStateAt && now - newestStateAt < 3 * 60_000 ? "MEDIUM" :
            "LOW",
          dataQuality: { wsFlow: wsFlowQuality },
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, sanitizeToolError(e)); }
    },
  );
}
