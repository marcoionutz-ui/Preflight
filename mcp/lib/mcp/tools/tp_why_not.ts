import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pairAddressSchema } from "./pairAddressSchema";
import { readAllRedis, getPipelineState, resolvePairChain, chainsForAddressInArrays, findLastEventForPair, findLastDropForPair, formatVol } from "../redis-reader";
import { mcpResponse, mcpErr, ERR } from "../errors";
import { pairKey } from "@preflight/schema";

export function registerWhyNot(server: McpServer) {
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
        pair_address: pairAddressSchema.describe("EVM pair address (0x...) or V4 pool ID"),
        chain:        z.enum(["base", "arbitrum", "bsc", "eth"]).optional().describe("Optional chain hint — needed only if the same address exists on multiple chains"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pair_address, chain }: { pair_address: string; chain?: "base" | "arbitrum" | "bsc" | "eth" }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot, events, drops, pfLifecycle } = ctx;
        const addr = pair_address.toLowerCase().trim();

        // B3f: rezolvă chain-ul — hint (arg) > live maps > array-uri istorice
        // (events/drops/lifecycle). Al treilea pas e esențial AICI: tool-ul e
        // pentru perechi IEȘITE din pipeline, care nu mai sunt în live maps dar
        // apar în drops/lifecycle. Ambiguu (>1 chain) → cerem chain explicit.
        const live = resolvePairChain(addr, [states, watch, hot, armed, snapshot?.memory], chain);
        let resolvedChain = live.chain;
        let ambiguous     = live.ambiguousChains;
        if (!resolvedChain && ambiguous.length === 0) {
          const histChains = chainsForAddressInArrays(addr, [events, drops, pfLifecycle]);
          if (histChains.length === 1)      resolvedChain = histChains[0];
          else if (histChains.length > 1)   ambiguous     = histChains;
        }
        if (ambiguous.length > 1) {
          return mcpErr(ERR.INVALID_INPUT, `Pair ${addr} exists on multiple chains: ${ambiguous.join(", ")}. Specify chain.`);
        }
        const lookup = resolvedChain ? pairKey(resolvedChain, addr) : "";

        // Lifecycle e un ARRAY cu pairAddress + chain (B3-lifecycle). Match pe
        // identitate: adresă + chain-ul rezolvat (dacă îl avem).
        const lifecycle =
          (pfLifecycle ?? []).find(l =>
            l.pairAddress?.toLowerCase() === addr &&
            (!resolvedChain || (l.chain ?? "").toLowerCase() === resolvedChain),
          ) ?? null;

        const pipeState = getPipelineState(lookup, watch, hot, armed);
        const data      = states[lookup] ?? snapshot?.memory?.[lookup] ?? null;
        const symbol    = data?.symbol ?? watch[lookup]?.symbol ?? hot[lookup]?.symbol ?? armed[lookup]?.symbol ?? addr.slice(0, 10);

        const lines: string[] = [];
        lines.push(`WHY NOT HOT/ARMED: ${symbol}`);
        lines.push(`Address: ${addr}`);
        lines.push(`Current pipeline state: ${pipeState}`);
        lines.push("");

        if (pipeState === "HOT" || pipeState === "ARMED") {
          lines.push(`This pair IS currently ${pipeState} — use tp_candidate_brief for details.`);
          return mcpResponse({ text: lines.join("\n"), confidence: "HIGH" });
        }

        if (pipeState === "WATCHING") {
          const w      = watch[lookup];
          const ageMin = w ? Math.round((now - w.addedAt) / 60_000 * 10) / 10 : 0;
          lines.push(`Currently WATCHING (${ageMin}m, kind: ${w?.kind ?? "NORMAL"})`);
          lines.push(`Waiting for WS buying flow confirmation before promotion to HOT.`);
          if (w?.priceVsEntryPct !== null && w?.priceVsEntryPct !== undefined) {
            lines.push(`Price vs entry: ${w.priceVsEntryPct > 0 ? "+" : ""}${w.priceVsEntryPct}%`);
          }
          return mcpResponse({ text: lines.join("\n"), confidence: "MEDIUM" });
        }

        const lastDrop = resolvedChain ? findLastDropForPair(resolvedChain, addr, drops) : null;
        if (lastDrop) {
          const ageSec = Math.round((now - lastDrop.droppedAt) / 1000);
          const fromState = lastDrop.wasIn ?? "UNKNOWN";
          const reason    = lastDrop.dropReason ?? "unknown";
          lines.push(`Recently dropped from ${fromState} (${ageSec}s ago):`);
          lines.push(`• Reason: ${reason}`);
          lines.push("");
        }

        const lastEvent = resolvedChain ? findLastEventForPair(resolvedChain, addr, events) : null;
        if (lastEvent && !lastDrop) {
          const ageSec = Math.round((now - lastEvent.ts) / 1000);
          lines.push(`Last pipeline event (${ageSec}s ago): ${lastEvent.from} → ${lastEvent.to}`);
          if (lastEvent.reason) lines.push(`• Reason: ${lastEvent.reason}`);
          lines.push("");
        }

        // Fallback when neither drops nor pipeline_events cover this pair —
        // lifecycle is the worker's own outcome record, so it's the last
        // resort for "what actually happened to this pair" before falling
        // through to plain worker-context reasons below.
        if (lifecycle && !lastDrop && !lastEvent) {
          const ageSec = Math.round((now - lifecycle.lastOutcomeAt) / 1000);
          lines.push(`Last lifecycle outcome (${ageSec}s ago): ${lifecycle.lastOutcome} from ${lifecycle.fromState}`);
          lines.push(`• Reason: ${lifecycle.reason}`);
          lines.push("");
        }

        if (data) {
          lines.push(`Worker context:`);
          lines.push(`• Phase: ${data.phase} | seen: ${data.seenCount}x`);

          const flow = states[lookup]?.flow;
          if (flow) {
            lines.push(`• Current flow: ${flow.hasData ? `${flow.pressure} (buys:${flow.buys5m} buyVol:${formatVol(flow.buyVol5mUsd, flow.buyVol5m ?? 0)})` : "no WS data"}`);
          }

          const pc = states[lookup]?.priceChange;
          if (pc) {
            const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
            lines.push(`• priceChange: m5:${fmt(pc.m5)} h1:${fmt(pc.h1)} h24:${fmt(pc.h24)}`);
          }

          const reasons: string[] = [];
          if (data.phase === "RECOVERING" && data.seenCount > 20) reasons.push("phase RECOVERING with long history — entry blocked by default");
          const pCount = states[lookup]?.poolCountSameToken ?? 1;
          if (pCount >= 5) reasons.push(`${pCount} pools for same token — clone/fragmentation block`);

          if (reasons.length) {
            lines.push("");
            lines.push("Likely gate blockers:");
            reasons.forEach(r => lines.push(`  • ${r}`));
          } else if (!lastDrop && !lastEvent && !lifecycle) {
            lines.push("");
            lines.push("Worker tracks it but hasn't promoted it yet.");
            lines.push("May need more scan cycles or stronger buying flow.");
          }
        } else {
          lines.push("Worker has no context for this pair.");
          lines.push("It may not have appeared in recent trending/new pool scans.");
        }

        return mcpResponse({ text: lines.join("\n"), confidence: "MEDIUM" });
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
