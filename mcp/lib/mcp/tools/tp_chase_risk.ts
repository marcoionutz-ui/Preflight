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
}                         from "../redis-reader";
import { mcpOk, mcpErr, ERR } from "../errors";

const FLAP_WINDOW_MS    = 10 * 60_000; // 10 minute
const FLAP_THRESHOLD    = 2;           // 2+ HOT→NONE în window = flapping
const SELL_RATIO_WARN   = 0.4;         // 40%+ sell vs buy = warning
const SELL_RATIO_HIGH   = 0.6;         // 60%+ sell vs buy = high risk

export function registerChaseRisk(server: McpServer) {
  server.registerTool(
    "tp_chase_risk",
    {
      title: "Preflight Chase Risk",
      description: `Assess whether a HOT or WATCHING pair is safe to act on, or a chase trap.

Detects:
- HOT flapping (promoted and dropped repeatedly — distribution pattern)
- Elevated sell ratio during buying pressure
- Failed HOT confirmations
- Drop reason patterns (flow faded, gate fails, bad exits)

Returns: CLEAR | CAUTION | HIGH | EXTREME with full reasoning.

Use before tp_preflight_safety to filter out FOMO traps early.
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

        const dropReasons      = recentDrops.map(d => d.reason.toLowerCase());
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
          signals.push(`Failed entry gate: bad exits or low score prevented HOT confirmation`);
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
              lines.push(`  ${ageSec}s ago: dropped — ${d.reason}`);
            });
          }
          lines.push("");
        }

        // Flow summary
        if (flow?.hasData) {
          lines.push(`FLOW (5m): buy ${formatEth(buyVol)} (${buys5m} swaps) | sell ${formatEth(sellVol)} (${sells5m} swaps) | net ${formatEth(flow.netVol5m)}`);
          lines.push("");
        }

        // Action recommendation
        lines.push("ACTION:");
        if (level === "EXTREME") {
          lines.push("  Do NOT chase. This pair shows strong distribution pattern.");
          lines.push("  HOT signal is unreliable — flow appears manufactured or fading.");
          lines.push("  Wait for clean reset: stable HOT > 2 min with low sell ratio.");
        } else if (level === "HIGH") {
          lines.push("  Avoid entry now. Multiple risk signals present.");
          lines.push("  If still watching, require: stable HOT > 90s + sell ratio < 35%.");
        } else if (level === "CAUTION") {
          lines.push("  Proceed with caution. Some risk signals present.");
          lines.push("  Verify with tp_preflight_safety before treating as actionable.");
        } else {
          lines.push("  No significant chase risk detected.");
          lines.push("  Proceed to tp_preflight_safety for contract safety check.");
        }

        return mcpOk(lines.join("\n"));
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}