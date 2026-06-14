/**
 * lib/mcp/tools/tp_chase_risk.ts
 * Detectează dacă un pair e chase risk — HOT dar nu enterable.
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
  formatEth,
  formatVol,
} from "../redis-reader";
import { mcpErr, mcpResponse, ERR } from "../errors";

const FLAP_WINDOW_MS    = 10 * 60_000; // 10 minute
const FLAP_THRESHOLD    = 2;           // 2+ HOT→NONE în window = flapping
const SELL_RATIO_WARN   = 0.4;         // 40%+ sell vs buy = warning
const SELL_RATIO_HIGH   = 0.6;         // 60%+ sell vs buy = high risk

export function registerChaseRisk(server: McpServer) {
  server.registerTool(
    "tp_chase_risk",
    {
      title: "Preflight Chase Risk",
      description: `Summarize execution-risk evidence for a HOT or WATCHING pair, including late-chase conditions.

Detects:
- HOT flapping (promoted and dropped repeatedly — distribution pattern)
- Elevated sell ratio during buying pressure
- Failed HOT confirmations
- Drop reason patterns (flow faded, gate fails, bad exits)

Returns: CLEAR | CAUTION | HIGH | EXTREME with full reasoning.

Use with tp_preflight_safety when the agent needs contract/security context next to flow evidence.
Best used on pairs currently HOT or recently dropped from HOT.

Args: pair_address (0x... EVM address)`,
      inputSchema: {
        pair_address: z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ pair_address }: { pair_address: string }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot, events, drops } = ctx;
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
        const isFlapping    = hotDrops >= FLAP_THRESHOLD;

        // ── Analiză drop reasons ──────────────────────────────────────────────
        const recentDrops = drops.filter(d =>
          d.pairAddress === addr && now - d.droppedAt < FLAP_WINDOW_MS
        );

        const dropReasons      = recentDrops.map(d => ((d as any).dropReason ?? d.reason ?? "").toLowerCase());
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
        let riskScore = 0;

        // Flapping
        if (hotDrops >= 4) {
          riskScore += 40;
          signals.push(`Extreme flapping: promoted and dropped ${hotDrops}x in last 10m`);
        } else if (hotDrops >= 2) {
          riskScore += 25;
          signals.push(`HOT flapping: promoted and dropped ${hotDrops}x in last 10m`);
        } else if (hotDrops === 1) {
          riskScore += 10;
          cautions.push(`Previously dropped from HOT once in last 10m`);
        }

        // Sell ratio
        if (sellRatio !== null) {
          if (sellRatio >= SELL_RATIO_HIGH) {
            riskScore += 25;
            signals.push(`High sell ratio: ${Math.round(sellRatio * 100)}% of volume is selling`);
          } else if (sellRatio >= SELL_RATIO_WARN) {
            riskScore += 10;
            cautions.push(`Elevated sell ratio: ${Math.round(sellRatio * 100)}% of volume is selling`);
          }
        }

        if (swapSellRatio !== null && swapSellRatio >= 0.5 && (buys5m + sells5m) > 5) {
          riskScore += 10;
          cautions.push(`Sell-heavy swap count: ${sells5m} sells vs ${buys5m} buys in 5m`);
        }

        // Drop reasons
        if (hasGateFail) {
          riskScore += 15;
          signals.push(`Qualification criteria not met: bad exits or low score prevented HOT confirmation`);
        }
        if (hasDistribution) {
          riskScore += 20;
          signals.push(`Distribution pattern detected in drop reasons`);
        }
        if (hasFlowFade && hotDrops >= 2) {
          riskScore += 10;
          cautions.push(`Flow repeatedly fades after initial buying — not sustained`);
        }

        // HOT instability
        if (currentHotEntry && !hotIsStable) {
          riskScore += 5;
          cautions.push(`Current HOT is only ${Math.round((hotAgeMs ?? 0) / 1000)}s old — not yet stable`);
        }

        // Phase
        if (data?.phase === "RECOVERING" || data?.phase === "ZOMBIE") {
          riskScore += 10;
          cautions.push(`Phase ${data.phase} — historically weak entry quality`);
        }

        // ── Verdict ───────────────────────────────────────────────────────────
        type RiskLevel = "CLEAR" | "CAUTION" | "HIGH" | "EXTREME";
        const level: RiskLevel =
          riskScore >= 60 ? "EXTREME" :
          riskScore >= 35 ? "HIGH"    :
          riskScore >= 15 ? "CAUTION" : "CLEAR";

        const emoji =
          level === "EXTREME" ? "🚨" :
          level === "HIGH"    ? "⚠️" :
          level === "CAUTION" ? "🟡" : "🟢";

        // ── Build response ────────────────────────────────────────────────────
        const lines: string[] = [];
        lines.push(`CHASE RISK: ${symbol} / ${chain.toUpperCase()}`);
        lines.push(`Address: ${addr}`);
        lines.push(`Pipeline: ${pipeState}`);
        lines.push("");
        lines.push(`${emoji} Risk Level: ${level} (score: ${riskScore}/100)`);
        lines.push("");

        if (signals.length) {
          lines.push("RISK SIGNALS:");
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
              lines.push(`  ${ageSec}s ago: dropped — ${(d as any).dropReason ?? d.reason ?? "unknown"}`);
            });
          }
          lines.push("");
        }

        // Flow summary
        if (flow?.hasData) {
          lines.push(`FLOW (5m): buy ${formatVol((flow as any).buyVol5mUsd, buyVol)} (${buys5m} swaps) | sell ${formatVol((flow as any).sellVol5mUsd, sellVol)} (${sells5m} swaps) | net ${formatVol((flow as any).netVol5mUsd, flow.netVol5m)}`);
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

const confidence =
  flow?.hasData && dataAgeSec !== null && dataAgeSec <= 120 ? "HIGH" :
  flow?.hasData                                              ? "MEDIUM" :
  "LOW";

return mcpResponse({
  text:         lines.join("\n"),
  freshnessSec: dataAgeSec,
  confidence,
  dataQuality: {
    wsFlow:    flow?.hasData ? "present" : "absent",
    liquidity: pairState?.lp?.hasData ? "confirmed" : pairState ? "estimated" : "unknown",
  },
  evidence: {
    riskLevel:     level,
    riskScore,
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