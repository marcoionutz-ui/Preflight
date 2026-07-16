/**
 * lib/mcp/tools/tp_late_move_context.ts
 * Reports late-move evidence for a HOT, WATCHING, or recently dropped pair.
 *
 * Analizează:
 * - HOT flapping (promovat/dropat repetat în ultimele minute)
 * - Sell ratio în buying pressure
 * - Failed HOT promotions
 * - Drop reasons (distribution patterns)
 * - Phase + history context
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z }              from "zod";
import {
  readAllRedis,
  getPipelineState,
  formatVol,
  wsFlowQuality,
  combineConfidence,
} from "../redis-reader";
import { mcpErr, mcpResponse, ERR } from "../errors";

const FLAP_WINDOW_MS    = 10 * 60_000; // 10 minute
const SELL_RATIO_WARN   = 0.4;         // 40%+ sell vs buy = warning
const SELL_RATIO_HIGH   = 0.6;         // 60%+ sell vs buy = high risk

export function registerLateMoveContext(server: McpServer) {
  server.registerTool(
    "tp_late_move_context",
    {
      title: "Preflight Late Move Context",
      description: `Summarize late-move evidence for a HOT or WATCHING pair, including repeated drops, sell pressure, and failed confirmations.

Detects:
- HOT flapping (promoted and dropped repeatedly — distribution pattern)
- Elevated sell ratio during buying pressure
- Failed HOT confirmations
- Drop reason patterns (flow faded, gate fails, bad exits)

Returns: NO_ELEVATED_EVIDENCE | CAUTION | HIGH | EXTREME with full reasoning.

Use with tp_preflight_safety when the agent needs contract/security context next to flow evidence.
Best used on pairs currently HOT or recently dropped from HOT.

Args: pair_address (0x... EVM address)`,
      inputSchema: {
        pair_address: z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pair_address }: { pair_address: string }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot, events, drops, pfMarket, regime } = ctx;
        const coveragePct = pfMarket?.flowCoveragePct ?? regime?.flowCoveragePct ?? null;
        const addr = pair_address.toLowerCase().trim();

        const pipeState  = getPipelineState(addr, watch, hot, armed);
        const pairState  = states[addr] ?? null;
        const snapMem    = snapshot?.memory?.[addr] ?? null;
        const data       = pairState ?? snapMem;
        const symbol     = data?.symbol ?? hot[addr]?.symbol ?? watch[addr]?.symbol ?? addr.slice(0, 10);
        const chain      = hot[addr]?.chain ?? watch[addr]?.chain ?? armed[addr]?.chain ?? "unknown";

        // ── Analiză HOT flapping ──────────────────────────────────────────────
        const recentEvents = events.filter(e =>
          e.pairAddress === addr && now - e.ts < FLAP_WINDOW_MS
        );

        const hotPromotions = recentEvents.filter(e => e.to === "HOT").length;
        const hotDrops      = recentEvents.filter(e => e.from === "HOT").length;

        // ── Analiză drop reasons ──────────────────────────────────────────────
        const recentDrops = drops.filter(d =>
          d.pairAddress === addr && now - d.droppedAt < FLAP_WINDOW_MS
        );

        const dropReasons      = recentDrops.map(d => (d.dropReason ?? "").toLowerCase());
        const hasFlowFade      = dropReasons.some(r => r.includes("flow faded") || r.includes("neutral"));
        const hasGateFail      = dropReasons.some(r => r.includes("gate") || r.includes("bad exits") || r.includes("score"));
        const hasDistribution  = dropReasons.some(r => r.includes("distribution") || r.includes("sell"));

        // ── Analiză sell ratio ────────────────────────────────────────────────
        const flow          = pairState?.flow ?? null;
        const buyVol        = flow?.buyVol5m  ?? 0;
        const sellVol       = flow?.sellVol5m ?? 0;
        const totalVol      = buyVol + sellVol;
        const sellRatio     = totalVol > 0 ? sellVol / totalVol : null;
        const buys5m        = flow?.buys5m  ?? 0;
        const sells5m       = flow?.sells5m ?? 0;
        const swapSellRatio = (buys5m + sells5m) > 0 ? sells5m / (buys5m + sells5m) : null;

        // ── HOT stability ─────────────────────────────────────────────────────
        const currentHotEntry  = hot[addr] ?? null;
        const hotAgeMs         = currentHotEntry ? now - currentHotEntry.promotedAt : null;
        const hotIsStable      = hotAgeMs !== null && hotAgeMs > 60_000; // HOT > 1 min = stable

        // ── Scoring ───────────────────────────────────────────────────────────
        const signals: string[]  = [];
        const cautions: string[] = [];
        let evidenceScore = 0;

        // Flapping
        if (hotDrops >= 4) {
          evidenceScore += 40;
          signals.push(`Extreme flapping: promoted and dropped ${hotDrops}x in last 10m`);
        } else if (hotDrops >= 2) {
          evidenceScore += 25;
          signals.push(`HOT flapping: promoted and dropped ${hotDrops}x in last 10m`);
        } else if (hotDrops === 1) {
          evidenceScore += 10;
          cautions.push(`Previously dropped from HOT once in last 10m`);
        }

        // Sell ratio
        if (sellRatio !== null) {
          if (sellRatio >= SELL_RATIO_HIGH) {
            evidenceScore += 25;
            signals.push(`High sell ratio: ${Math.round(sellRatio * 100)}% of volume is selling`);
          } else if (sellRatio >= SELL_RATIO_WARN) {
            evidenceScore += 10;
            cautions.push(`Elevated sell ratio: ${Math.round(sellRatio * 100)}% of volume is selling`);
          }
        }

        if (swapSellRatio !== null && swapSellRatio >= 0.5 && (buys5m + sells5m) > 5) {
          evidenceScore += 10;
          cautions.push(`Sell-heavy swap count: ${sells5m} sells vs ${buys5m} buys in 5m`);
        }

        // Drop reasons
        if (hasGateFail) {
          evidenceScore += 15;
          signals.push(`Qualification criteria not met: bad exits or low score prevented HOT confirmation`);
        }
        if (hasDistribution) {
          evidenceScore += 20;
          signals.push(`Distribution pattern detected in drop reasons`);
        }
        if (hasFlowFade && hotDrops >= 2) {
          evidenceScore += 10;
          cautions.push(`Flow repeatedly fades after initial buying — not sustained`);
        }

        // HOT instability
        if (currentHotEntry && !hotIsStable) {
          evidenceScore += 5;
          cautions.push(`Current HOT is only ${Math.round((hotAgeMs ?? 0) / 1000)}s old — not yet stable`);
        }

        // Phase
        if (data?.phase === "RECOVERING" || data?.phase === "ZOMBIE") {
          evidenceScore += 10;
          cautions.push(`Phase ${data.phase} — weak historical continuation`);
        }

        // ── Verdict ───────────────────────────────────────────────────────────
        type EvidenceLevel = "NO_ELEVATED_EVIDENCE" | "CAUTION" | "HIGH" | "EXTREME";
        const level: EvidenceLevel =
          evidenceScore >= 60 ? "EXTREME" :
          evidenceScore >= 35 ? "HIGH"    :
          evidenceScore >= 15 ? "CAUTION" : "NO_ELEVATED_EVIDENCE";

        const emoji =
          level === "EXTREME" ? "🚨" :
          level === "HIGH"    ? "⚠️" :
          level === "CAUTION" ? "🟡" : "🟢";

        // ── Build response ────────────────────────────────────────────────────
        const lines: string[] = [];
        lines.push(`LATE MOVE CONTEXT: ${symbol} / ${chain.toUpperCase()}`);
        lines.push(`Address: ${addr}`);
        lines.push(`Pipeline: ${pipeState}`);
        lines.push("");
        lines.push(`${emoji} Evidence Level: ${level} (score: ${evidenceScore}/100)`);
        lines.push("");

        if (signals.length) {
          lines.push("OBSERVATIONS:");
          signals.forEach(s => lines.push(`  🔴 ${s}`));
          lines.push("");
        }

        if (cautions.length) {
          lines.push("CAUTIONS:");
          cautions.forEach(c => lines.push(`  🟡 ${c}`));
          lines.push("");
        }

        // HOT history summary
        if (hotPromotions > 0 || hotDrops > 0) {
          lines.push(`HOT HISTORY (last 10m): ${hotPromotions} promotions, ${hotDrops} drops`);
          if (recentDrops.length) {
            recentDrops.slice(0, 3).forEach(d => {
              const ageSec = Math.round((now - d.droppedAt) / 1000);
              lines.push(`  ${ageSec}s ago: dropped — ${d.dropReason ?? "unknown"}`);
            });
          }
          lines.push("");
        }

        // Flow summary
        if (flow?.hasData) {
          lines.push(`FLOW (5m): buy ${formatVol(flow.buyVol5mUsd, buyVol)} (${buys5m} swaps) | sell ${formatVol(flow.sellVol5mUsd, sellVol)} (${sells5m} swaps) | net ${formatVol(flow.netVol5mUsd, flow.netVol5m)}`);
          lines.push("");
        }

        // Data available
        lines.push("DATA_AVAILABLE:");
        if (level === "EXTREME" || level === "HIGH") {
          lines.push("  tp_preflight_safety — contract/token safety check");
        } else {
          lines.push("  tp_preflight_safety — contract/token safety check");
          lines.push("  tp_candidate_brief — full drilldown on this pair");
        }

        const dataAgeSec = pairState?.updatedAt
  ? Math.round((now - pairState.updatedAt) / 1000)
  : null;

const hasDirectFlow = !!flow?.hasData;
const confidence    = combineConfidence(dataAgeSec, coveragePct, hasDirectFlow);

return mcpResponse({
  text:         lines.join("\n"),
  freshnessSec: dataAgeSec,
  confidence,
  dataQuality: {
    wsFlow:    wsFlowQuality(hasDirectFlow, coveragePct),
    liquidity: pairState?.lp?.hasData ? "confirmed" : pairState ? "estimated" : "unknown",
  },
  evidence: {
    evidenceLevel: level,
    evidenceScore,
    pipelineState: pipeState,
    hotFlaps:      hotDrops,
    hotPromotions,
    hasFlowData:   !!flow?.hasData,
   },
});
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
