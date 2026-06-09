import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readAllRedis, formatEth } from "../redis-reader";
import { mcpOk, mcpErr, ERR } from "../errors";

export function registerSituationReport(server: McpServer) {
  server.registerTool(
    "tp_situation_report",
    {
      title: "Preflight Situation Report",
      description: `Front door for AI agents. Call this first to get a complete situational overview.

Returns a compact but complete picture:
- Worker health + data freshness
- Market regime + WS coverage
- Pipeline counts (watching/confirming/qualified)
- Qualified signals with pair addresses — no extra call needed
- Observed movers (+5%+ m5 or +15%+ h1) not yet in pipeline
- HOT candidates with addresses
- Recent drops + transitions
- NEXT suggested action

Pair addresses are included in every entry — no need to call tp_worker_snapshot just to get addresses.
Observed movers section shows tokens moving on market that haven't passed pipeline filters yet.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpOk("❌ Redis not connected — worker context unavailable.");

        const {
          now, states, watch, hot, armed,
          snapshot, regime, events, drops,
          pfMarket, pfPipeline, pfMomentum, pfQualified, pfDrops,
        } = ctx;

        const stateVals     = Object.values(states) as any[];
        const newestStateAt = stateVals.length ? Math.max(...stateVals.map((s: any) => s.updatedAt)) : null;
        const freshnessSec  = newestStateAt ? Math.round((now - newestStateAt) / 1000) : null;
        const workerOnline  = !!snapshot && !!snapshot.savedAt && (now - snapshot.savedAt) < 5 * 60_000;

        const lines: string[] = [];

        // ── Worker health ──────────────────────────────────────────────────
        lines.push(`WORKER: ${workerOnline ? `✅ ${snapshot?.version ?? "?"} | data:${freshnessSec !== null ? `${freshnessSec}s` : "?"}` : "⚠️ offline or stale"}`);

        // ── Market regime ──────────────────────────────────────────────────
        const r      = pfMarket ?? regime as any;
        const emoji  = !r ? "❓" : r.regime === "RISK_ON" ? "🟢" : r.regime === "RISK_OFF" ? "🔴" : r.regime === "DEAD" ? "⚫" : "🟡";
        if (r) {
          const chains  = (r.wsConnectedChains ?? r.chainsActive ?? []).join("+") || "none";
          const buying  = r.buyingPct ?? r.buyingPctAll ?? 0;
          const selling = r.sellingPct ?? r.sellingPctAll ?? 0;
          lines.push(`MARKET: ${emoji} ${r.regime} | buying:${buying}% selling:${selling}% coverage:${r.flowCoveragePct ?? 0}% chains:${chains}`);
        } else {
          const withFlow  = stateVals.filter((s: any) => s.flow?.hasData);
          const buying    = withFlow.filter((s: any) => s.flow?.pressure === "BUYING").length;
          const total     = stateVals.length;
          const buyingPct = total ? Math.round(buying / total * 100) : 0;
          const coverage  = total ? Math.round(withFlow.length / total * 100) : 0;
          lines.push(`MARKET: ${buyingPct > 30 ? "🟢 RISK_ON" : coverage < 20 ? "⚫ DEAD" : "🟡 MIXED"} | buying:${buyingPct}% coverage:${coverage}%`);
        }

        // ── Pipeline counts ────────────────────────────────────────────────
        const watchCount  = Object.keys(watch).length;
        const hotCount    = Object.keys(hot).length;
        const armedCount  = Object.keys(armed).length;

        // Filter stale qualified — only show fresh + still active + not dropped after
        const activeQualified = (pfQualified ?? []).filter((q: any) => {
          const addr = q.pairAddress?.toLowerCase();
          if (!addr) return false;
          const stillActive  = watch[addr] || hot[addr] || armed[addr];
          const droppedAfter = (pfDrops ?? drops ?? []).some((d: any) =>
            d.pairAddress?.toLowerCase() === addr &&
            d.droppedAt > (q.qualifiedAt ?? 0)
          );
          const fresh = now - (q.qualifiedAt ?? 0) < 60_000;
          return fresh && stillActive && !droppedAfter;
        });
        const staleCount = (pfQualified?.length ?? 0) - activeQualified.length;
        lines.push(`PIPELINE: watching:${watchCount} hot:${hotCount} armed:${armedCount} qualified:${activeQualified.length}${staleCount > 0 ? ` (${staleCount} stale)` : ""}`);

        // ── Active qualified signals — top 5 con adrese ───────────────────
        if (activeQualified.length > 0) {
          const qLines = activeQualified.slice(0, 5).map((q: any) =>
            `  → ${q.symbol} [${q.chain}] pair:${q.pairAddress ?? "?"} risk:${q.entryRisk} flow:${q.flow?.status} buys:${q.flow?.buys5m}`
          );
          lines.push(`QUALIFIED (active):\n${qLines.join("\n")}`);
        } else if (pfQualified && pfQualified.length > 0) {
          lines.push(`QUALIFIED: ${pfQualified.length} recent but all stale/dropped`);
        }

        // ── HOT candidates con adrese ──────────────────────────────────────
        if (hotCount > 0) {
          const hotList = Object.entries(hot)
            .sort(([, a]: any, [, b]: any) => a.promotedAt - b.promotedAt)
            .slice(0, 3)
            .map(([addr, h]: any) => {
              const ageSec = Math.round((now - h.promotedAt) / 1000);
              return `  → ${h.symbol ?? addr.slice(0, 8)} [${h.chain}] pair:${addr} source:${h.source ?? "WS"} age:${ageSec}s flow:${h.flow?.pressure} buys:${h.flow?.buys5m} buyVol:${formatEth(h.flow?.buyVol5m ?? 0)}`;
            });
          lines.push(`HOT:\n${hotList.join("\n")}`);
        }

        // ── Observed movers — derivat din pair_states ─────────────────────
        // Tokeni cu mișcări semnificative care nu sunt încă în pipeline
        const moverScore = (s: any) => Math.max(
          Math.abs(s.priceChange?.m5  ?? 0),
          Math.abs(s.priceChange?.h1  ?? 0) / 3,
          Math.abs(s.priceChange?.h24 ?? 0) / 8,
        );

        const observedMovers = stateVals
          .filter((s: any) =>
            s.pipelineState === "NONE" &&
            s.priceChange &&
            (
              Math.abs(s.priceChange.m5)  >= 5  ||
              Math.abs(s.priceChange.h1)  >= 15 ||
              Math.abs(s.priceChange.h24) >= 40
            ) &&
            s.reserveUsd >= 5_000
          )
          .sort((a: any, b: any) => moverScore(b) - moverScore(a))
          .slice(0, 8);

        if (observedMovers.length > 0) {
          const moverLines = observedMovers.map((s: any) =>
            `  → ${s.symbol} [${s.chain}] pair:${s.pairAddress} m5:${s.priceChange.m5 > 0 ? "+" : ""}${s.priceChange.m5.toFixed(1)}% h1:${s.priceChange.h1 > 0 ? "+" : ""}${s.priceChange.h1.toFixed(1)}% h24:${s.priceChange.h24 > 0 ? "+" : ""}${s.priceChange.h24.toFixed(1)}% liq:$${Math.round(s.reserveUsd / 1000)}K`
          );
          const totalMovers = stateVals.filter((s: any) =>
            s.pipelineState === "NONE" && s.priceChange &&
            (Math.abs(s.priceChange.m5) >= 5 || Math.abs(s.priceChange.h1) >= 15 || Math.abs(s.priceChange.h24) >= 40) &&
            s.reserveUsd >= 5_000
          ).length;
          lines.push(`OBSERVED MOVERS (${totalMovers} total, top 8):\n${moverLines.join("\n")}`);
        }

        // ── Momentum events recente ────────────────────────────────────────
        if (pfMomentum && pfMomentum.length > 0) {
          const mLines = pfMomentum.slice(0, 5).map((m: any) => {
            const ageSec = Math.round((now - m.detectedAt) / 1000);
            return `  ${ageSec}s: ${m.symbol} [${m.chain}] pair:${m.pairAddress} ${m.verdict} m5:${m.m5Pct?.toFixed(1)}%`;
          });
          lines.push(`MOMENTUM EVENTS (last 10m, ${pfMomentum.length} total):\n${mLines.join("\n")}`);
        }

        // ── Armed ──────────────────────────────────────────────────────────
        if (armedCount > 0) {
          const armedList = Object.entries(armed).map(([addr, a]: any) => {
            const ageSec = Math.round((now - a.armedAt) / 1000);
            return `  → ${a.symbol ?? addr.slice(0, 8)} pair:${addr} score:${a.score} age:${ageSec}s`;
          });
          lines.push(`⚡ ARMED:\n${armedList.join("\n")}`);
        }

        // ── Recent drops ───────────────────────────────────────────────────
        const dropsSource = (pfDrops && pfDrops.length > 0 ? pfDrops : drops) as any[];
        const recentDropsList = dropsSource.filter((d: any) => now - d.droppedAt < 5 * 60_000).slice(0, 3);
        if (recentDropsList.length) {
          const dropLines = recentDropsList.map((d: any) => {
            const ageSec    = Math.round((now - d.droppedAt) / 1000);
            const fromState = d.wasIn ?? d.previousState ?? "?";
            return `  ${ageSec}s: ${d.symbol} pair:${d.pairAddress} dropped from ${fromState} — ${d.dropReason ?? d.reason ?? "?"}`;
          });
          lines.push(`DROPPED:\n${dropLines.join("\n")}`);
        }

        // ── Recent transitions ─────────────────────────────────────────────
        const recentEvents = events.filter((e: any) => now - e.ts < 3 * 60_000).slice(0, 3);
        if (recentEvents.length) {
          const evLines = recentEvents.map((e: any) => {
            const ageSec = Math.round((now - e.ts) / 1000);
            return `  ${ageSec}s: ${e.symbol} ${e.from}→${e.to}${e.reason ? ` (${e.reason})` : ""}`;
          });
          lines.push(`TRANSITIONS:\n${evLines.join("\n")}`);
        }

        // ── NEXT action ────────────────────────────────────────────────────
		const qualCount = activeQualified.length;

        const nextAction =
          hotCount > 0         ? `HOT candidate active — call tp_candidate_brief or tp_chase_risk for drilldown.` :
          qualCount > 0        ? `Qualified signals present — call tp_candidate_brief(pair_address) for full analysis.` :
          observedMovers.length > 0 ? `Observed movers present but no pipeline candidates — market awareness only.` :
          watchCount > 0       ? `Watching ${watchCount} pairs — waiting for WS flow confirmation.` :
          `Pipeline empty — worker scanning, no candidates qualify yet.`;

        lines.push(`NEXT: ${nextAction}`);

        return mcpOk(lines.join("\n"));
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}