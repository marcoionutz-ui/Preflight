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

        const { now, states, watch, hot, armed, snapshot, regime, events, drops } = ctx;

        const stateVals     = Object.values(states);
        const newestStateAt = stateVals.length ? Math.max(...stateVals.map(s => s.updatedAt)) : null;
        const freshnessSec  = newestStateAt ? Math.round((now - newestStateAt) / 1000) : null;
        const workerOnline  = !!snapshot && !!snapshot.savedAt && (now - snapshot.savedAt) < 5 * 60_000;

        const lines: string[] = [];
        lines.push(`WORKER: ${workerOnline ? `✅ online (${snapshot?.version ?? "?"})` : "⚠️ offline or stale"} | data: ${freshnessSec !== null ? `${freshnessSec}s ago` : "unknown"}`);

        if (regime) {
          const emoji  = regime.regime === "RISK_ON" ? "🟢" : regime.regime === "RISK_OFF" ? "🔴" : regime.regime === "DEAD" ? "⚫" : "🟡";
          const chains = regime.wsConnectedChains.length ? regime.wsConnectedChains.join("+") : "none";
          lines.push(`MARKET: ${emoji} ${regime.regime} | buying:${regime.buyingPctAll}% selling:${regime.sellingPctAll}% | WS coverage:${regime.flowCoveragePct}% | chains:${chains}`);
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
        lines.push(`PIPELINE: watching:${watchCount} | hot:${hotCount} | armed:${armedCount}`);

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

        const recentDrops = drops.filter(d => now - d.droppedAt < 5 * 60_000).slice(0, 3);
        if (recentDrops.length) {
          const dropLines = recentDrops.map(d => {
            const ageSec = Math.round((now - d.droppedAt) / 1000);
            return `  ${ageSec}s ago: ${d.symbol} dropped from ${d.previousState} — ${d.reason}`;
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
