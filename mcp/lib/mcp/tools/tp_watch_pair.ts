/**
 * lib/mcp/tools/tp_watch_pair.ts
 * tp_watch_pair — agent submits a pair for Preflight monitoring.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis } from "../redis-reader";
import { getRedis } from "@/lib/db/redis";
import { mcpResponse, mcpErr, ERR } from "../errors";
import { REDIS_KEYS, pairKey } from "@preflight/schema";

export function registerWatchPair(server: McpServer) {
  server.registerTool(
    "tp_watch_pair",
    {
      title: "Preflight Watch Pair",
      description: `Submit a pair address for Preflight monitoring.

Preflight will:
- Add the pair to the follow list with source AGENT_SUPPLIED
- Fetch pool data on next refresh cycle (~30-60s)
- Make it available via tp_pair_context and tp_candidate_brief

Use this when you have a candidate pair from an external source (social, news, own analysis)
and want Preflight to contextualize it.

Does not guarantee pipeline promotion — pair must still pass watch gates.
Returns current status if pair is already being monitored.`,
      inputSchema: {
        pair_address: z.string().min(10).describe("Pool/pair contract address or V4 pool ID"),
        chain:        z.enum(["base", "arbitrum", "bsc"]).describe("Chain"),
        reason:       z.string().max(160).optional().describe("Optional: why you're watching this pair"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pair_address, chain, reason }: { pair_address: string; chain: "base" | "arbitrum" | "bsc"; reason?: string }) => {
      try {
        const addr           = pair_address.toLowerCase().trim();
        const normalizedChain = chain.toLowerCase().trim();
        // B3f: hărțile live sunt keyed pe pairKey(chain, addr). Aici avem chain
        // garantat (arg obligatoriu) → construim direct cheia.
        const lookup = pairKey(normalizedChain, addr);

        const isEvmPoolId = /^0x[a-f0-9]{40}$/.test(addr) || /^0x[a-f0-9]{64}$/.test(addr);
        if (!isEvmPoolId) {
          return mcpErr(ERR.INVALID_INPUT, `Invalid pair address: ${pair_address}. Expected 0x + 40 or 64 hex chars.`);
        }

        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed } = ctx;

        const pairState  = states[lookup] ?? null;
        const inWatch    = !!watch[lookup];
        const inHot      = !!hot[lookup];
        const inArmed    = !!armed[lookup];
        const hasContext = !!pairState;

        const lines: string[] = [];
        lines.push(`WATCH REQUEST: ${addr} [${normalizedChain}]`);
        lines.push("");

        if (inArmed) {
          lines.push(`STATUS: already ARMED — use tp_candidate_brief for full context`);
          lines.push(`NEXT_CHECK: tp_candidate_brief(${addr})`);
          return mcpResponse({ text: lines.join("\n"), confidence: "HIGH" });
        }

        if (inHot) {
          lines.push(`STATUS: already HOT — use tp_candidate_brief for full context`);
          lines.push(`NEXT_CHECK: tp_candidate_brief(${addr})`);
          return mcpResponse({ text: lines.join("\n"), confidence: "HIGH" });
        }

        if (inWatch) {
          const watchInfo = watch[lookup] as any;
          const ageSec    = Math.round((now - watchInfo.addedAt) / 1_000);
          lines.push(`STATUS: already WATCHING`);
          lines.push(`  kind: ${watchInfo.kind ?? "?"} | age: ${ageSec}s | chain: ${watchInfo.chain}`);
          lines.push(`NEXT_CHECK: tp_pair_context(${addr}) in ~30s for flow data`);
          return mcpResponse({ text: lines.join("\n"), confidence: "MEDIUM" });
        }

        const r = getRedis();
        if (!r) return mcpErr(ERR.REDIS_DOWN, "Redis client not available");

        const request = JSON.stringify({
          pairAddress: addr,
          chain:       normalizedChain,
          reason:      reason?.slice(0, 160) ?? "AGENT_SUPPLIED",
          requestedAt: now,
        });

        await r
          .multi()
          .lpush(REDIS_KEYS.agentWatchRequests, request)
          .ltrim(REDIS_KEYS.agentWatchRequests, 0, 99)
          .expire(REDIS_KEYS.agentWatchRequests, 300)
          .exec();

        lines.push(`STATUS: queued for monitoring`);
        lines.push(`  chain: ${normalizedChain}${reason ? ` | reason: ${reason}` : ""}`);
        if (hasContext) {
          lines.push(`  known pair — ${pairState?.symbol ?? "?"} liq:$${Math.round((pairState?.reserveUsd ?? 0) / 1000)}K`);
        } else {
          lines.push(`  unknown pair — will fetch pool data on next refresh cycle`);
        }
        lines.push("");
        lines.push(`NEXT_CHECK: tp_pair_context(${addr}) in ~60s`);
        lines.push(`NOTE: pair must pass watch gates to enter pipeline — not guaranteed`);

        return mcpResponse({ text: lines.join("\n"), confidence: "MEDIUM" });
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}