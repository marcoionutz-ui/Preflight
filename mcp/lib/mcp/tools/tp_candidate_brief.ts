import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis, getPipelineState, findLastEventForPair, formatEth } from "../redis-reader";
import type { PairState } from "../types";
import { mcpOk, mcpErr, ERR } from "../errors";

export function registerCandidateBrief(server: McpServer, exposePerformance: boolean) {
  server.registerTool(
    "tp_candidate_brief",
    {
      title: "Preflight Candidate Brief",
      description: `Get a narrative case file for a specific pair — written for AI agent reasoning.

Returns a structured text brief covering:
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
        if (!ctx) return mcpOk("❌ Redis not connected.");

        const { now, states, watch, hot, armed, snapshot, events } = ctx;
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
          return mcpOk(`${symbol} — not found in worker context.\nThe worker has no data for this pair.`);
        }

        const lines: string[] = [];
        lines.push(`═══ CANDIDATE BRIEF: ${symbol} / ${chain.toUpperCase()} ═══`);
        lines.push(`Address: ${addr}`);
        lines.push(`Pipeline: ${pipeState}`);
        lines.push("");

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
          lines.push(exposePerformance
            ? `  • Phase: ${data.phase} | seen: ${data.seenCount}x | entries: ${data.totalEntries}`
            : `  • Phase: ${data.phase} | seen: ${data.seenCount}x`);
          if (exposePerformance && (data.wins24h > 0 || data.losses24h > 0 || data.badExits24h > 0)) {
            lines.push(`  • History: ${data.wins24h}W / ${data.losses24h}L / ${data.badExits24h} bad exits`);
          }
        }

        lines.push("");
        lines.push("LIQUIDITY:");
        if (pairState) {
          lines.push(`  • Reserve: $${Math.round((pairState.reserveUsd ?? 0) / 1000)}K (${pairState.liqStatus ?? "?"})`);
          lines.push(`  • DEX type: ${pairState.dexType ?? "?"}`);
          if ((pairState.poolCountSameToken ?? 1) > 1) {
            lines.push(`  ⚠️ ${pairState.poolCountSameToken} pools for same token — fragmentation/clone risk`);
          }
          if (pairState.lp?.hasData && pairState.lp.status === "REMOVED") {
            lines.push(`  🚨 LP being removed: ${formatEth(pairState.lp.lpRemoved5m ?? 0)} in 5m`);
          }
        } else {
          lines.push(`  • No live liquidity data — using snapshot only`);
        }

        if (pairState?.flow?.hasData) {
          lines.push("");
          lines.push("FLOW (5m):");
          lines.push(`  • Pressure: ${pairState.flow.pressure}`);
          lines.push(`  • Buy: ${formatEth(pairState.flow.buyVol5m)} (${pairState.flow.buys5m} swaps) | Sell: ${formatEth(pairState.flow.sellVol5m)} (${pairState.flow.sells5m} swaps)`);
          lines.push(`  • Net: ${formatEth(pairState.flow.netVol5m)}`);
        }

        const cautions: string[] = [];
        if (exposePerformance && data && data.consecutiveLosses >= 2) cautions.push(`${data.consecutiveLosses} consecutive losses`);
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

        lines.push("");
        lines.push("INVALIDATE IF:");
        lines.push("  • Flow turns SELLING or netVol drops below 0.03 ETH");
        lines.push("  • LP removal detected (any significant burn event)");
        if ((pairState?.poolCountSameToken ?? 1) >= 2) lines.push("  • Liquidity migrating to another pool for same token");
        if (data?.phase === "RECOVERING") lines.push("  • Phase stays RECOVERING with no BUYING confirmation");

        const lastEvent = findLastEventForPair(addr, events);
        if (lastEvent) {
          const ageSec = Math.round((now - lastEvent.ts) / 1000);
          lines.push("");
          lines.push(`LAST PIPELINE EVENT (${ageSec}s ago): ${lastEvent.from} → ${lastEvent.to}${lastEvent.reason ? ` — ${lastEvent.reason}` : ""}`);
        }

        lines.push("");
        lines.push("SUGGESTED NEXT STEP:");
        if (pipeState === "ARMED") {
          lines.push("  Worker is about to enter. Run tp_preflight_safety before treating this as actionable.");
        } else if (pipeState === "HOT") {
          lines.push("  Run tp_preflight_safety to verify contract safety. Re-check flow in 30s.");
        } else {
          lines.push("  Monitor — not yet in active pipeline. Call again in 60s or check tp_why_not.");
        }

        return mcpOk(lines.join("\n"));
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
