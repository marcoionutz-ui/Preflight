/**
 * lib/mcp/tools/tp_agent_brief.ts
 * tp_next_action — routes agent reasoning based on current pipeline state.
 * Reports what to look at next. Does not advise on trades.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readAllRedis, formatPct, combineConfidence, dedupeByPair } from "../redis-reader";
import { splitPairKey } from "@preflight/schema";
import { mcpResponse, mcpErr, ERR, sanitizeToolError, PREFLIGHT_OUTPUT_SCHEMA } from "../errors";

export function registerNextAction(server: McpServer) {
  server.registerTool(
    "tp_next_action",
    {
      title: "Preflight Next Action",
      description: `Routes agent reasoning to the most relevant Preflight tool based on current pipeline state.

Call this when you're not sure where to start, or after tp_situation_report to get a focused next step.

Returns:
- focus: what deserves attention right now
- diagnosticRoute: which Preflight tool provides the next relevant context
- context: brief state summary that informed the routing
- coverage_note: data confidence caveat if relevant

Does not advise on trades. Routes to data, not to decisions.`,
      inputSchema: {},
      outputSchema: PREFLIGHT_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, drops, pfDrops, pfMomentum, pfMarket, regime } = ctx;

        const armedCount = Object.keys(armed).length;
        const hotCount   = Object.keys(hot).length;
        const watchCount = Object.keys(watch).length;

        const coverage   = pfMarket?.flowCoveragePct ?? regime?.flowCoveragePct ?? 0;
        const marketDead = coverage < 5;

        // Freshness din cel mai recent pair state
        const stateVals     = Object.values(states);
        const newestStateAt = stateVals.length
          ? Math.max(...stateVals.map(s => s.updatedAt ?? 0))
          : null;
        const freshnessSec  = newestStateAt
          ? Math.round((now - newestStateAt) / 1000)
          : null;

        // Recent drops in last 5m — deduped
        const dropsSource = pfDrops && pfDrops.length > 0 ? pfDrops : drops;
        const recentDrops = dedupeByPair(
          dropsSource.filter(d => now - d.droppedAt < 5 * 60_000),
          "droppedAt",
        );
        const hotDrops = recentDrops.filter(d =>
          d.wasIn === "HOT" || d.wasIn === "ARMED"
        );

        // Coverage note — LOW sub 20%, nu "moderate"
        const coverageNote = coverage < 20
          ? `WS coverage is ${coverage}% — flow data is LOW confidence. Treat flow-derived context with caution.`
          : coverage < 50
          ? `WS coverage is ${coverage}% — MEDIUM confidence on flow data.`
          : null;

        // Chain with most activity
        const chainCounts: Record<string, number> = {};
        for (const v of Object.values(watch)) {
          const c = (v as { chain?: string }).chain ?? "unknown";
          chainCounts[c] = (chainCounts[c] ?? 0) + 1;
        }
        const topChainInternal = Object.entries(chainCounts)
          .sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;
        // tp_chain_report acceptă public "eth" (nu forma canonică "ethereum")
        const topChain = topChainInternal === "ethereum" ? "eth" : topChainInternal;

        const lines: string[] = [];
        lines.push("NEXT CHECK:");
        lines.push("");

        // ── Priority routing ──────────────────────────────────────────────
        if (armedCount > 0) {
          const armedList = Object.entries(armed).map(([key, av]) => {
            const a = av as { symbol?: string; chain?: string; score?: number; armedAt: number };
            const addr = splitPairKey(key).address; // cheia e pairKey → adresa brută
            return `${a.symbol ?? addr.slice(0, 8)} [${a.chain ?? "?"}] pair:${addr} score:${a.score} age:${Math.round((now - a.armedAt) / 1000)}s`;
          });
          lines.push(`FOCUS: ARMED — qualification criteria observed`);
          lines.push(`ARMED (${armedCount}):`);
          armedList.forEach(l => lines.push(`  → ${l}`));
          lines.push("");
          lines.push(`NEXT_CHECK:`);
          lines.push(`  1. tp_candidate_brief(pair, chain) — full context on armed pair`);
          lines.push(`  2. tp_preflight_safety(pair, chain) — contract/token safety check`);
          lines.push(`  3. tp_late_move_context(pair, chain) — check for late-move evidence`);

        } else if (hotCount > 0) {
          const hotList = Object.entries(hot).map(([key, hv]) => {
            const h = hv as { symbol?: string; chain?: string; flow?: { pressure?: string; buys5m?: number } };
            const addr = splitPairKey(key).address;
            return `${h.symbol ?? addr.slice(0, 8)} [${h.chain}] pair:${addr} flow:${h.flow?.pressure} buys:${h.flow?.buys5m}`;
          });
          lines.push(`FOCUS: HOT — confirmed buying flow`);
          lines.push(`HOT (${hotCount}):`);
          hotList.forEach(l => lines.push(`  → ${l}`));
          lines.push("");
         lines.push(`NEXT_CHECK:`);
          lines.push(`  1. tp_candidate_brief(pair, chain) — narrative case file`);
          lines.push(`  2. tp_late_move_context(pair, chain) — flap/distribution check`);

        } else if (hotDrops.length > 0) {
          const dropList = hotDrops.slice(0, 3).map(d =>
            `${d.symbol} [${d.chain}] pair:${d.pairAddress} — ${d.dropReason ?? "?"} ${Math.round((now - d.droppedAt) / 1000)}s ago`
          );
          lines.push(`FOCUS: RECENT HOT/ARMED DROPS — check for late-move evidence`);
          lines.push(`DROPPED (${hotDrops.length}):`);
          dropList.forEach((l: string) => lines.push(`  → ${l}`));
          lines.push("");
         lines.push(`NEXT_CHECK:`);
          lines.push(`  1. tp_recent_pipeline_drops — recently dropped pairs with reasons`);
          lines.push(`  2. tp_why_not(pair, chain) — pipeline rejection reasons`);

        } else if (marketDead && watchCount > 0) {
          lines.push(`FOCUS: COVERAGE LOW — flow data unreliable`);
          lines.push(`coverage:${coverage}% watching:${watchCount}${topChain ? ` top_chain:${topChain}` : ""}`);
          lines.push("");
         lines.push(`NEXT_CHECK:`);
          lines.push(`  1. tp_health_check — verify worker + WS connections`);
          if (topChain) lines.push(`  2. tp_chain_report(${topChain}) — inspect highest activity chain`);

        } else if (watchCount > 0) {
          lines.push(`FOCUS: WATCHING — pipeline accumulating, no candidates yet`);
          lines.push(`watching:${watchCount}${topChain ? ` top_chain:${topChain}` : ""} coverage:${coverage}%`);
          lines.push("");
         lines.push(`NEXT_CHECK:`);
          if (topChain) lines.push(`  1. tp_chain_report(${topChain}) — check movers on most active chain`);
          lines.push(`  ${topChain ? "2" : "1"}. tp_situation_report — full pipeline overview`);

        } else {
          lines.push(`FOCUS: PIPELINE EMPTY — worker scanning`);
          lines.push("");
         lines.push(`NEXT_CHECK:`);
          lines.push(`  1. tp_health_check — verify worker is online`);
          lines.push(`  2. tp_market_overview — market regime context`);
        }

        // ── Momentum events sidebar ────────────────────────────────────────
        if (pfMomentum && pfMomentum.length > 0) {
          const recent = pfMomentum.filter(m => now - m.detectedAt < 5 * 60_000);
          if (recent.length > 0) {
            lines.push("");
            lines.push(`MOMENTUM SIDEBAR (${recent.length} events <5m):`);
            recent.slice(0, 3).forEach(m => {
              lines.push(`  ${m.symbol} [${m.chain}] ${m.verdict} m5:${formatPct(m.m5Pct)} pair:${m.pairAddress}`);
            });
          }
        }

        // ── Coverage note ──────────────────────────────────────────────────
        if (coverageNote) {
          lines.push("");
          lines.push(`COVERAGE_NOTE: ${coverageNote}`);
        }

        // Confidence: pipeline state ca upper bound, coverage+freshness ca floor
        const baseConfidence: "LOW" | "MEDIUM" | "HIGH" =
          armedCount > 0      ? "HIGH"   :
          hotCount > 0        ? "MEDIUM" :
          hotDrops.length > 0 ? "MEDIUM" :
          watchCount > 0      ? "MEDIUM" :
          "LOW";
        const coverageConfidence = combineConfidence(freshnessSec, coverage, false);
        const finalConfidence: "LOW" | "MEDIUM" | "HIGH" =
          baseConfidence === "LOW" || coverageConfidence === "LOW" ? "LOW" :
          baseConfidence === "MEDIUM" || coverageConfidence === "MEDIUM" ? "MEDIUM" :
          "HIGH";

        return mcpResponse({
          text: lines.join("\n"),
          confidence: finalConfidence,
          coverageNote: coverageNote ?? undefined,
          evidence: {
            armed:          armedCount,
            hot:            hotCount,
            watching:       watchCount,
            recentHotDrops: hotDrops.length,
            coverage,
            topChain,
          },
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, sanitizeToolError(e)); }
    },
  );
}
