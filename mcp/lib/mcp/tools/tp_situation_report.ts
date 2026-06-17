import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readAllRedis, formatEth, formatVol, formatPct, combineConfidence, dedupeByPair } from "../redis-reader";
import { mcpErr, mcpResponse, ERR } from "../errors";

export function registerSituationReport(server: McpServer) {
  server.registerTool(
    "tp_situation_report",
    {
      title: "Preflight Situation Report",
      description: `Primary situational overview for AI agents.

Returns a compact but complete picture:
- Worker health + data freshness
- Market regime + WS coverage
- Pipeline counts (watching/hot/armed/qualified)
- Qualified setups with pair addresses
- Observed movers (gainers/droppers) not yet in pipeline
- HOT candidates with addresses
- Recent drops + transitions
- Status summary

Pair addresses are included in every entry — no need to call tp_worker_snapshot just to get addresses.
Observed movers section shows tokens moving on market that haven't passed pipeline filters yet.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

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
        let globalCoverage = 0;
        if (r) {
          const chains  = (r.wsConnectedChains ?? r.chainsActive ?? []).join("+") || "none";
          const buying  = r.buyingPct ?? r.buyingPctAll ?? 0;
          const selling = r.sellingPct ?? r.sellingPctAll ?? 0;
          globalCoverage = r.flowCoveragePct ?? 0;
          lines.push(`MARKET: ${emoji} ${r.regime} | buying:${buying}% selling:${selling}% coverage:${globalCoverage}% chains:${chains}`);
        } else {
          const withFlow  = stateVals.filter((s: any) => s.flow?.hasData);
          const buying    = withFlow.filter((s: any) => s.flow?.pressure === "BUYING").length;
          const total     = stateVals.length;
          const buyingPct = total ? Math.round(buying / total * 100) : 0;
          globalCoverage  = total ? Math.round(withFlow.length / total * 100) : 0;
          lines.push(`MARKET: ${buyingPct > 30 ? "🟢 RISK_ON" : globalCoverage < 20 ? "⚫ DEAD" : "🟡 MIXED"} | buying:${buyingPct}% coverage:${globalCoverage}%`);
        }

        const coverageConfidence =
          globalCoverage >= 50 ? "HIGH" :
          globalCoverage >= 20 ? "MEDIUM" :
          "LOW";

        if (coverageConfidence === "LOW") {
          lines.push(`⚠️ COVERAGE_CONFIDENCE: LOW — only ${globalCoverage}% WS coverage globally. Flow-derived signals are partial and lower confidence.`);
        } else if (coverageConfidence === "MEDIUM") {
          lines.push(`ℹ️ COVERAGE_CONFIDENCE: MEDIUM — ${globalCoverage}% WS coverage globally.`);
        }

        // ── Pipeline counts ────────────────────────────────────────────────
        const watchCount  = Object.keys(watch).length;
        const hotCount    = Object.keys(hot).length;
        const armedCount  = Object.keys(armed).length;

        // Filter stale gate-passed setups — only show fresh + still active + not dropped after
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

        // ── Active gate-passed setups — top 5 con adrese ───────────────────
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
              const ageSec    = Math.round((now - h.promotedAt) / 1000);
              const watchKind = watch[addr]?.kind ?? null;
              const psFlow = states[addr]?.flow ?? h.flow;
              return `  → ${h.symbol ?? addr.slice(0, 8)} [${h.chain}] pair:${addr}${watchKind ? ` kind:${watchKind}` : ""} source:${h.source ?? "WS"} age:${ageSec}s flow:${psFlow?.pressure} buys:${psFlow?.buys5m} buyVol:${formatVol((psFlow as any)?.buyVol5mUsd, psFlow?.buyVol5m ?? 0)}`;
            });
          lines.push(`HOT:\n${hotList.join("\n")}`);
        }

		// ── ARMED — first-class, înainte de noise ─────────────────────────
        if (armedCount > 0) {
          const armedList = Object.entries(armed).map(([addr, a]: any) => {
            const ageSec   = Math.round((now - a.armedAt) / 1000);
            const ps       = states[addr] ?? null;
            const flowStr  = ps?.flow?.hasData
              ? `${ps.flow.pressure} buys:${ps.flow.buys5m} buyVol:${formatVol(ps.flow.buyVol5mUsd, ps.flow.buyVol5m ?? 0)}`
              : a.flowPressure ?? "?";
            const priceStr = a.price ? `price:${a.price.toPrecision(4)}` : "";
            return `  → ${a.symbol ?? addr.slice(0, 8)} [${a.chain ?? "?"}] pair:${addr} score:${a.score} age:${ageSec}s ${priceStr} flow:${flowStr}`;
          });
          lines.push(`⚡ ARMED:\n${armedList.join("\n")}`);
        }

        // ── Observed movers — split gainers / droppers ────────────────────
        const moverScore = (s: any) => Math.max(
          Math.abs(s.priceChange?.m5  ?? 0),
          Math.abs(s.priceChange?.h1  ?? 0) / 3,
          Math.abs(s.priceChange?.h24 ?? 0) / 8,
        );

        const moverLine = (s: any) =>
          `  → ${s.symbol} [${s.chain}] pair:${s.pairAddress} m5:${formatPct(s.priceChange.m5)} h1:${formatPct(s.priceChange.h1)} h24:${formatPct(s.priceChange.h24)} liq:$${Math.round((s.reserveUsd ?? 0) / 1000)}K`;

        const moverBase = stateVals.filter((s: any) =>
          s.pipelineState === "NONE" &&
          s.priceChange &&
          (
            Math.abs(s.priceChange.m5)  >= 5  ||
            Math.abs(s.priceChange.h1)  >= 15 ||
            Math.abs(s.priceChange.h24) >= 40
          ) &&
          (s.reserveUsd ?? 0) >= 5_000
        );

        const gainers = moverBase
          .filter((s: any) =>
            s.priceChange.m5  >= 5  ||
            s.priceChange.h1  >= 15 ||
            s.priceChange.h24 >= 40
          )
          .sort((a: any, b: any) => moverScore(b) - moverScore(a))
          .slice(0, 5);

        const droppers = moverBase
          .filter((s: any) =>
            s.priceChange.m5  <= -5  ||
            s.priceChange.h1  <= -15 ||
            s.priceChange.h24 <= -40
          )
          .sort((a: any, b: any) => moverScore(b) - moverScore(a))
          .slice(0, 3);

        if (gainers.length > 0 || droppers.length > 0) {
          const totalMovers = moverBase.length;
          lines.push(`OBSERVED MOVERS (${totalMovers} total):`);
          if (gainers.length > 0) {
            lines.push(`  GAINERS (${gainers.length}):`);
            gainers.forEach((s: any) => lines.push(moverLine(s)));
          }
          if (droppers.length > 0) {
            lines.push(`  DROPPERS (${droppers.length}):`);
            droppers.forEach((s: any) => lines.push(moverLine(s)));
          }
        }

        // ── Momentum events recente ────────────────────────────────────────
        if (pfMomentum && pfMomentum.length > 0) {
          const deduped = dedupeByPair(pfMomentum as any[], "detectedAt")
            .sort((a: any, b: any) => (b.detectedAt ?? 0) - (a.detectedAt ?? 0));
          const mLines  = deduped.slice(0, 5).map((m: any) => {
            const ageSec    = Math.round((now - m.detectedAt) / 1000);
            const countNote = m._eventCount > 1 ? ` (${m._eventCount}x)` : "";
            return `  ${ageSec}s: ${m.symbol} [${m.chain}] pair:${m.pairAddress} ${m.verdict} m5:${formatPct(m.m5Pct)}${countNote}`;
          });
          lines.push(`MOMENTUM EVENTS (last 10m, ${deduped.length} pairs):\n${mLines.join("\n")}`);
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

        // ── Status summary ─────────────────────────────────────────────────
		const qualCount = activeQualified.length;

		const status =
          armedCount > 0 && hotCount > 0 ? `HOT + ARMED candidates active. Next verification: tp_candidate_brief + tp_preflight_safety.` :
          armedCount > 0                 ? `ARMED candidate active. Next verification: tp_candidate_brief + tp_preflight_safety.` :
          hotCount > 0                   ? `HOT candidate active. Drilldown data available.` :
          qualCount > 0                  ? `Qualified setups present. Drilldown data available.` :
          moverBase.length > 0           ? `Observed movers detected. No pipeline candidates.` :
          watchCount > 0                 ? `Watching ${watchCount} pairs. Awaiting WS flow confirmation.` :
          `Pipeline empty. Worker scanning.`;

		lines.push(`STATUS: ${status}`);

        // ── Compression metric ─────────────────────────────────────────────
        const priorityCount = armedCount > 0 ? armedCount : hotCount;
        lines.push(`COMPRESSION: ${stateVals.length} tracked → ${watchCount} watching → ${hotCount} hot → ${priorityCount} priority`);

        const warnings = [
  !workerOnline ? "Worker snapshot offline or stale" : null,
  globalCoverage < 20 ? `WS coverage ${globalCoverage}% — flow signals partial` : null,
].filter((w): w is string => !!w);

return mcpResponse({
  text:         lines.join("\n"),
  freshnessSec: freshnessSec ?? null,
  confidence:   !workerOnline ? "LOW" : combineConfidence(freshnessSec, globalCoverage, false),
  coverageNote: globalCoverage < 20
    ? `WS coverage ${globalCoverage}% — flow signals partial`
    : null,
  warnings,
  dataQuality: {
    wsFlow: globalCoverage >= 50 ? "present" : globalCoverage > 0 ? "partial" : "absent",
  },
  evidence: {
    trackedPairs:    stateVals.length,
    watching:        watchCount,
    hot:             hotCount,
    armed:           armedCount,
    qualifiedActive: activeQualified.length,
    qualifiedStale:  staleCount,
    workerOnline,
    compression: {
      tracked:  stateVals.length,
      watching: watchCount,
      hot:      hotCount,
      priority: priorityCount,
    },
  },
});
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}