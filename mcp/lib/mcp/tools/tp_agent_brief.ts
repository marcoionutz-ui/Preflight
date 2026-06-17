/**
 * lib/mcp/tools/tp_agent_brief.ts
 * tp_next_action — routes agent reasoning based on current pipeline state.
 * Reports what to look at next. Does not advise on trades.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readAllRedis, formatPct, combineConfidence, dedupeByPair } from "../redis-reader";
import { mcpResponse, mcpErr, ERR } from "../errors";

export function registerNextAction(server: McpServer) {
  server.registerTool(
    "tp_next_action",
    {
      title: "Preflight Next Action",
      description: `Routes agent reasoning to the most relevant Preflight tool based on current pipeline state.

Call this when you're not sure where to start, or after tp_situation_report to get a focused next step.

Returns:
- priority: what deserves attention right now
- diagnosticRoute: which Preflight tool provides the next relevant context
- context: brief state summary that informed the routing
- coverage_note: data confidence caveat if relevant

Does not advise on trades. Routes to data, not to decisions.`,
      inputSchema: {},
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

        const r          = pfMarket ?? regime as any;
        const coverage   = r?.flowCoveragePct ?? 0;
        const marketDead = coverage < 5;

        // Freshness din cel mai recent pair state
        const stateVals     = Object.values(states) as any[];
        const newestStateAt = stateVals.length
          ? Math.max(...stateVals.map((s: any) => s.updatedAt ?? 0))
          : null;
        const freshnessSec  = newestStateAt
          ? Math.round((now - newestStateAt) / 1000)
          : null;

        // Recent drops in last 5m — deduped
        const dropsSource = (pfDrops && pfDrops.length > 0 ? pfDrops : drops) ?? [];
        const recentDrops = dedupeByPair(
          (dropsSource as any[]).filter((d: any) => now - d.droppedAt < 5 * 60_000),
          "droppedAt",
        );
        const hotDrops = recentDrops.filter((d: any) =>
          (d.wasIn ?? d.previousState) === "HOT" ||
          (d.wasIn ?? d.previousState) === "ARMED"
        );

        // Coverage note — LOW sub 20%, nu "moderate"
        const coverageNote = coverage < 20
          ? `WS coverage is ${coverage}% — flow signals are LOW confidence. Treat flow-derived context with caution.`
          : coverage < 50
          ? `WS coverage is ${coverage}% — MEDIUM confidence on flow signals.`
          : null;

        // Chain with most activity
        const chainCounts: Record<string, number> = {};
        for (const v of Object.values(watch)) {
          const c = (v as any).chain ?? "unknown";
          chainCounts[c] = (chainCounts[c] ?? 0) + 1;
        }
        const topChain = Object.entries(chainCounts)
          .sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;

        const lines: string[] = [];
        lines.push("NEXT CHECK:");
        lines.push("");

        // ── Priority routing ──────────────────────────────────────────────
        if (armedCount > 0) {
          const armedList = Object.entries(armed).map(([addr, a]: any) =>
            `${a.symbol ?? addr.slice(0, 8)} [${a.chain ?? "?"}] pair:${addr} score:${a.score} age:${Math.round((now - a.armedAt) / 1000)}s`
          );
          lines.push(`FOCUS: ARMED — qualification criteria observed`);
          lines.push(`ARMED (${armedCount}):`);
          armedList.forEach(l => lines.push(`  → ${l}`));
          lines.push("");
          lines.push(`NEXT_CHECK:`);
          lines.push(`  1. tp_candidate_brief(pair) — full context on armed pair`);
          lines.push(`  2. tp_preflight_safety(pair) — contract/token safety check`);
          lines.push(`  3. tp_chase_risk(pair) — verify not a chase trap`);

        } else if (hotCount > 0) {
          const hotList = Object.entries(hot).map(([addr, h]: any) =>
            `${h.symbol ?? addr.slice(0, 8)} [${h.chain}] pair:${addr} flow:${h.flow?.pressure} buys:${h.flow?.buys5m}`
          );
          lines.push(`PRIORITY: HOT — confirmed buying flow`);
          lines.push(`HOT (${hotCount}):`);
          hotList.forEach(l => lines.push(`  → ${l}`));
          lines.push("");
         lines.push(`NEXT_CHECK:`);
          lines.push(`  1. tp_candidate_brief(pair) — narrative case file`);
          lines.push(`  2. tp_chase_risk(pair) — flap/distribution check`);

        } else if (hotDrops.length > 0) {
          const dropList = hotDrops.slice(0, 3).map((d: any) =>
            `${d.symbol} [${d.chain}] pair:${d.pairAddress} — ${d.dropReason ?? d.reason ?? "?"} ${Math.round((now - d.droppedAt) / 1000)}s ago`
          );
          lines.push(`PRIORITY: RECENT HOT/ARMED DROPS — check if chase risk`);
          lines.push(`DROPPED (${hotDrops.length}):`);
          dropList.forEach((l: string) => lines.push(`  → ${l}`));
          lines.push("");
         lines.push(`NEXT_CHECK:`);
          lines.push(`  1. tp_do_not_chase — anti-FOMO list`);
          lines.push(`  2. tp_why_not(pair) — pipeline rejection reasons`);

        } else if (marketDead && watchCount > 0) {
          lines.push(`PRIORITY: COVERAGE LOW — flow signals unreliable`);
          lines.push(`coverage:${coverage}% watching:${watchCount}${topChain ? ` top_chain:${topChain}` : ""}`);
          lines.push("");
         lines.push(`NEXT_CHECK:`);
          lines.push(`  1. tp_health_check — verify worker + WS connections`);
          if (topChain) lines.push(`  2. tp_chain_report(${topChain}) — inspect highest activity chain`);

        } else if (watchCount > 0) {
          lines.push(`PRIORITY: WATCHING — pipeline accumulating, no candidates yet`);
          lines.push(`watching:${watchCount}${topChain ? ` top_chain:${topChain}` : ""} coverage:${coverage}%`);
          lines.push("");
         lines.push(`NEXT_CHECK:`);
          if (topChain) lines.push(`  1. tp_chain_report(${topChain}) — check movers on most active chain`);
          lines.push(`  ${topChain ? "2" : "1"}. tp_situation_report — full pipeline overview`);

        } else {
          lines.push(`PRIORITY: PIPELINE EMPTY — worker scanning`);
          lines.push("");
         lines.push(`NEXT_CHECK:`);
          lines.push(`  1. tp_health_check — verify worker is online`);
          lines.push(`  2. tp_market_overview — market regime context`);
        }

        // ── Momentum events sidebar ────────────────────────────────────────
        if (pfMomentum && pfMomentum.length > 0) {
          const recent = pfMomentum.filter((m: any) => now - m.detectedAt < 5 * 60_000);
          if (recent.length > 0) {
            lines.push("");
            lines.push(`MOMENTUM SIDEBAR (${recent.length} events <5m):`);
            recent.slice(0, 3).forEach((m: any) => {
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
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}