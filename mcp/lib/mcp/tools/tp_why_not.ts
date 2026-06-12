import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis, getPipelineState, findLastEventForPair, findLastDropForPair, formatEth } from "../redis-reader";
import type { PairState } from "../types";
import { mcpOk, mcpErr, ERR } from "../errors";

export function registerWhyNot(server: McpServer, exposePerformance: boolean) {
  server.registerTool(
    "tp_why_not",
    {
      title: "Preflight Why Not",
      description: `Explains why a specific pair is NOT currently HOT or ARMED.

Absence of a signal is information. This tool tells you:
- If it's still WATCHING: how long, what's missing
- If it was recently dropped: exactly why
- If it's tracked but not in pipeline: phase/history context
- If the worker has never seen it: says so clearly

Args: pair_address (0x... EVM address or V4 pool ID)`,
      inputSchema: {
        pair_address: z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pair_address }: { pair_address: string }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot, events, drops } = ctx;
        const addr = pair_address.toLowerCase().trim();

        const pipeState = getPipelineState(addr, watch, hot, armed);
        const data      = states[addr] ?? snapshot?.memory?.[addr] ?? null;
        const symbol    = data?.symbol ?? watch[addr]?.symbol ?? hot[addr]?.symbol ?? armed[addr]?.symbol ?? addr.slice(0, 10);

        const lines: string[] = [];
        lines.push(`WHY NOT HOT/ARMED: ${symbol}`);
        lines.push(`Address: ${addr}`);
        lines.push(`Current pipeline state: ${pipeState}`);
        lines.push("");

        if (pipeState === "HOT" || pipeState === "ARMED") {
          lines.push(`This pair IS currently ${pipeState} — use tp_candidate_brief for details.`);
          return mcpOk(lines.join("\n"));
        }

        if (pipeState === "WATCHING") {
          const w      = watch[addr];
          const ageMin = w ? Math.round((now - w.addedAt) / 60_000 * 10) / 10 : 0;
          lines.push(`Currently WATCHING (${ageMin}m, kind: ${w?.kind ?? "NORMAL"})`);
          lines.push(`Waiting for WS buying flow confirmation before promotion to HOT.`);
          if (w?.priceVsEntryPct !== null && w?.priceVsEntryPct !== undefined) {
            lines.push(`Price vs entry: ${w.priceVsEntryPct > 0 ? "+" : ""}${w.priceVsEntryPct}%`);
          }
          return mcpOk(lines.join("\n"));
        }

        const lastDrop = findLastDropForPair(addr, drops);
        if (lastDrop) {
          const ageSec = Math.round((now - lastDrop.droppedAt) / 1000);
          const fromState = (lastDrop as any).wasIn ?? lastDrop.previousState ?? "UNKNOWN";
          const reason    = (lastDrop as any).dropReason ?? lastDrop.reason ?? "unknown";
          lines.push(`Recently dropped from ${fromState} (${ageSec}s ago):`);
          lines.push(`• Reason: ${reason}`);
          lines.push("");
        }

        const lastEvent = findLastEventForPair(addr, events);
        if (lastEvent && !lastDrop) {
          const ageSec = Math.round((now - lastEvent.ts) / 1000);
          lines.push(`Last pipeline event (${ageSec}s ago): ${lastEvent.from} → ${lastEvent.to}`);
          if (lastEvent.reason) lines.push(`• Reason: ${lastEvent.reason}`);
          lines.push("");
        }

        if (data) {
          lines.push(`Worker context:`);
          lines.push(`• Phase: ${data.phase} | seen: ${data.seenCount}x`);
          if (exposePerformance) {
            lines.push(`• Entries: ${data.totalEntries} | W${data.wins24h}/L${data.losses24h}/bad:${data.badExits24h}`);
          }

          const flow = states[addr]?.flow;
          if (flow) {
            lines.push(`• Current flow: ${flow.hasData ? `${flow.pressure} (buys:${flow.buys5m} buyVol:${formatEth(flow.buyVol5m ?? 0)})` : "no WS data"}`);
          }

          const pc = states[addr]?.priceChange;
          if (pc) {
            const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
            lines.push(`• priceChange: m5:${fmt(pc.m5)} h1:${fmt(pc.h1)} h24:${fmt(pc.h24)}`);
          }

          const reasons: string[] = [];
          if (data.phase === "RECOVERING" && data.seenCount > 20) reasons.push("phase RECOVERING with long history — entry blocked by default");
          if (exposePerformance && data.consecutiveLosses >= 3) reasons.push(`${data.consecutiveLosses} consecutive losses — score heavily penalised`);
          if (exposePerformance && data.badExits24h >= 2 && data.wins24h === 0) reasons.push("bad exits only, zero wins — entry gate blocks");
          if (exposePerformance && data.seenCount > 40 && data.totalEntries === 0) reasons.push("seen 40+ times with no entry — marked as stale loser");
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

        return mcpOk(lines.join("\n"));
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
