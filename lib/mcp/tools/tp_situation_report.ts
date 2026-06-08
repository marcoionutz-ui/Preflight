import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readAllRedis, formatEth } from "../redis-reader";
import { mcpOk, mcpErr, ERR } from "../errors";

export function registerSituationReport(server: McpServer) {
  server.registerTool(
    "tp_situation_report",
    {
      title: "Preflight Situation Report",
      description: `Front door for AI agents. Call this first to get a human-readable summary of what the worker is seeing right now.

Returns a concise narrative covering:
- Market regime (RISK_ON / RISK_OFF / MIXED / DEAD) + WS coverage
- Pipeline status (watching/hot/armed counts + top candidates)
- Recent transitions (what just got promoted, dropped, armed)
- Data freshness

No arguments needed. Returns plain text, not JSON.
Use this before deciding which other tools to call.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpOk("❌ Redis not connected — worker context unavailable.");

        const { now, states, watch, hot, armed, snapshot, regime, events, drops, pfMarket, pfPipeline, pfMomentum, pfQualified, pfDrops } = ctx;

        const stateVals     = Object.values(states);
        const newestStateAt = stateVals.length ? Math.max(...stateVals.map(s => s.updatedAt)) : null;
        const freshnessSec  = newestStateAt ? Math.round((now - newestStateAt) / 1000) : null;
        const workerOnline  = !!snapshot && !!snapshot.savedAt && (now - snapshot.savedAt) < 5 * 60_000;

        const lines: string[] = [];
        lines.push(`WORKER: ${workerOnline ? `✅ online (${snapshot?.version ?? "?"})` : "⚠️ offline or stale"} | data: ${freshnessSec !== null ? `${freshnessSec}s ago` : "unknown"}`);

       const marketCtx = pfMarket ?? regime;
        if (marketCtx) {
          const r      = pfMarket ?? regime as any;
          const emoji  = r.regime === "RISK_ON" ? "🟢" : r.regime === "RISK_OFF" ? "🔴" : r.regime === "DEAD" ? "⚫" : "🟡";
          const chains = (r.wsConnectedChains ?? r.chainsActive ?? []).join("+") || "none";
          const buying = r.buyingPct ?? r.buyingPctAll ?? 0;
          const selling = r.sellingPct ?? r.sellingPctAll ?? 0;
          lines.push(`MARKET: ${emoji} ${r.regime} | buying:${buying}% selling:${selling}% | WS coverage:${r.flowCoveragePct ?? 0}% | chains:${chains}`);
        } else {
          const withFlow  = stateVals.filter(s => s.flow.hasData);
          const buying    = withFlow.filter(s => s.flow.pressure === "BUYING").length;
          const total     = stateVals.length;
          const buyingPct = total ? Math.round(buying / total * 100) : 0;
          const coverage  = total ? Math.round(withFlow.length / total * 100) : 0;
          lines.push(`MARKET: ${buyingPct > 30 ? "🟢 RISK_ON" : coverage < 20 ? "⚫ DEAD" : "🟡 MIXED"} | buying:${buyingPct}% | WS coverage:${coverage}%`);
        }

        const watchCount = Object.keys(watch).length;
        const hotCount   = Object.keys(hot).length;
        const armedCount = Object.keys(armed).length;

        const pfCounts = pfPipeline?.reduce((acc: any, e: any) => {
          acc[e.pipelineState] = (acc[e.pipelineState] ?? 0) + 1;
          return acc;
        }, {}) ?? null;

        if (pfCounts) {
          lines.push(`PIPELINE: watching:${pfCounts.WATCHING ?? 0} | confirming:${pfCounts.CONFIRMING ?? 0} | qualified:${pfQualified?.length ?? 0}`);
        } else {
          lines.push(`PIPELINE: watching:${watchCount} | hot:${hotCount} | armed:${armedCount}`);
        }
		
		// Preflight qualified signals
        if (pfQualified && pfQualified.length > 0) {
          const qLines = pfQualified.slice(0, 3).map((q: any) =>
            `  → ${q.symbol} [${q.chain}] risk:${q.entryRisk} flow:${q.flow?.status} buys:${q.flow?.buys5m} | ${q.workerObservation?.slice(0, 80) ?? ""}`
          );
          lines.push(`QUALIFIED SIGNALS (passed all filters):\n${qLines.join("\n")}`);
        }

        // Preflight momentum events last 10m
        if (pfMomentum && pfMomentum.length > 0) {
          const mLines = pfMomentum.slice(0, 3).map((m: any) => {
            const ageSec = Math.round((now - m.detectedAt) / 1000);
            return `  ${ageSec}s ago: ${m.symbol} [${m.chain}] ${m.verdict} m5:${m.m5Pct?.toFixed(1)}% — ${m.reason}`;
          });
          lines.push(`MOMENTUM EVENTS (last 10m):\n${mLines.join("\n")}`);
        }

        if (hotCount > 0) {
          const hotList = Object.entries(hot)
            .sort(([, a], [, b]) => a.promotedAt - b.promotedAt)
            .slice(0, 3)
            .map(([addr, h]) => {
              const ageSec = Math.round((now - h.promotedAt) / 1000);
              return `  → ${h.symbol ?? addr.slice(0, 8)} [${h.chain}] source:${h.source ?? "WS"} age:${ageSec}s flow:${h.flow.pressure} buys:${h.flow.buys5m} buyVol:${formatEth(h.flow.buyVol5m)}`;
            });
          lines.push(`HOT CANDIDATES:\n${hotList.join("\n")}`);
        }

        if (armedCount > 0) {
          const armedList = Object.entries(armed)
            .map(([addr, a]) => {
              const ageSec = Math.round((now - a.armedAt) / 1000);
              return `  → ${a.symbol ?? addr.slice(0, 8)} score:${a.score} age:${ageSec}s — confirmation ${ageSec < 30 ? `in ~${30 - ageSec}s` : "imminent"}`;
            });
          lines.push(`⚡ ARMED (may enter soon):\n${armedList.join("\n")}`);
        }

        const recentEvents = events.filter(e => now - e.ts < 5 * 60_000).slice(0, 5);
        if (recentEvents.length) {
          const evLines = recentEvents.map(e => {
            const ageSec = Math.round((now - e.ts) / 1000);
            return `  ${ageSec}s ago: ${e.symbol} ${e.from}→${e.to}${e.reason ? ` (${e.reason})` : ""}`;
          });
          lines.push(`RECENT TRANSITIONS:\n${evLines.join("\n")}`);
        }

        const dropsSource = (pfDrops && pfDrops.length > 0 ? pfDrops : drops) as any[];
        const recentDrops = dropsSource.filter((d: any) => now - d.droppedAt < 5 * 60_000).slice(0, 3);
        if (recentDrops.length) {
          const dropLines = recentDrops.map((d: any) => {
            const ageSec    = Math.round((now - d.droppedAt) / 1000);
            const fromState = d.wasIn ?? d.previousState ?? "?";
            const reason    = d.dropReason ?? d.reason ?? "?";
            return `  ${ageSec}s ago: ${d.symbol} dropped from ${fromState} — ${reason}`;
          });
          lines.push(`DROPPED:\n${dropLines.join("\n")}`);
        }

        if (!hotCount && !armedCount && watchCount === 0) {
          lines.push(`NOTE: Pipeline is empty — worker may be scanning but no candidates qualify yet.`);
        }

        return mcpOk(lines.join("\n"));
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
