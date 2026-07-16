/**
 * lib/mcp/tools/tp_chain_report.ts
 * Raport focusat pe un singur chain — mai detaliat decât tp_situation_report.
 *
 * tp_situation_report = global overview, compressed
 * tp_chain_report     = per-chain drilldown, mai mult context per pereche
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis, formatEth, formatVol, formatPct, combineConfidence, getPipelineState, readSolanaIndexerStats, readSolanaMovers, readSolanaRecentActivity } from "../redis-reader";
import { mcpResponse, mcpErr, ERR } from "../errors";

// Timestamp fallback — events pot folosi ts, detectedAt, sau timestamp
const eventTs = (e: any): number => e.ts ?? e.detectedAt ?? e.timestamp ?? 0;

// Normalizeaza alias ETH → ethereum (worker stocheaza "ethereum", enum accepta "eth")
function normalizeChain(c: string): string {
  return c === "eth" ? "ethereum" : c;
}

function getLpCoverage(dexType: string | null | undefined, hasData: boolean): string {
  const d = (dexType ?? "").toUpperCase();

  if (d === "V4") return "V4_INVESTIGATING";

  if (hasData) {
    if (d === "V3") return "V3_FULL";
    if (d === "V2") return "V2_FULL";
    return "LP_EVENTS_OBSERVED";
  }

  if (d === "V3") return "V3_NO_EVENTS_5M";
  if (d === "V2") return "V2_NO_EVENTS_5M";

  return "NO_LP_COVERAGE";
}

export function registerChainReport(server: McpServer) {
  server.registerTool(
    "tp_chain_report",
    {
      title: "Preflight Chain Report",
      description: `Focused report for a single chain — more detail per pair than tp_situation_report.

Use when you want to drill into one chain specifically:
- Chain-level market regime (buying%, coverage, flow)
- Pipeline breakdown for this chain only (watching/hot/armed)
- HOT candidates with full flow detail
- Observed movers filtered to this chain
- Recent drops + transitions for this chain
- Top WATCHING pairs by flow activity

Args: chain — one of: base, arbitrum, eth, bsc, solana`,
      inputSchema: {
        chain: z.enum(["base", "arbitrum", "eth", "bsc", "solana"]),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ chain }: { chain: string }) => {
      try {
        // ── 8.0i-c/d: Solana — branch special înainte de readAllRedis() ──────
        // Nu are EVM pair states — citim direct din Solana readers
        if (chain === "solana") {
          const now = Date.now();
          const [solanaStats, solanaMovers, solanaActivity] = await Promise.all([
            readSolanaIndexerStats(now),
            readSolanaMovers(now, 10),
            readSolanaRecentActivity(5),
          ]);

          const { health } = solanaStats;
          const lines: string[] = [];
          lines.push("CHAIN REPORT: SOLANA");
          lines.push(`Worker: ${health.status} | ${health.indexerVersion ?? "?"} | behind:${health.blocksBehind ?? "?"} slots | healthAge:${health.ageSec !== null ? health.ageSec + "s" : "OFFLINE"}`);
          lines.push(`Indexed: ${solanaStats.indexedPools} pools | ${solanaStats.indexedLaunches} launches | ${solanaStats.trackedPricePools} price pools tracked`);
          lines.push(`Movers: ${solanaStats.moversStatus} (${solanaStats.moversCount} entries${solanaStats.moversComputedAgeSec !== null ? ", " + solanaStats.moversComputedAgeSec + "s old" : ""})`);
          lines.push("");

          // Recent indexed pools
          if (solanaActivity.recentPools.length > 0) {
            lines.push("RECENT RAYDIUM POOLS (indexed):");
            for (const p of solanaActivity.recentPools) {
              const ageSec = Math.round((now - p.discoveredAt) / 1000);
              lines.push(`  ${p.baseSymbol ?? "?"} / ${p.quoteSymbol ?? "?"} (${p.quoteType ?? "?"}) — pool:${p.poolAddress.slice(0, 8)}... ${ageSec}s ago`);
            }
            lines.push("");
          }

          // Recent pump.fun launches
          if (solanaActivity.recentLaunches.length > 0) {
            lines.push("RECENT PUMP.FUN LAUNCHES:");
            for (const l of solanaActivity.recentLaunches) {
              const ageSec = Math.round((now - l.discoveredAt) / 1000);
              lines.push(`  ${l.symbol ?? l.mint.slice(0, 8) + "..."} — mint:${l.mint.slice(0, 8)}... ${ageSec}s ago`);
            }
            lines.push("");
          }

          // Sampled movers
          if (solanaMovers && solanaMovers.items.length > 0) {
            lines.push(`OBSERVED SOLANA PRICE MOVERS (sampled, coverage: ${solanaMovers.coverage}):`);
            lines.push(`  ⚠️ Data from swap sampling, not full firehose. priceChange may be null until history accumulates.`);
            for (const m of solanaMovers.items) {
              const ch5m = m.priceChange5mPct !== null ? m.priceChange5mPct.toFixed(2) + "%" : "null";
              const ch1h = m.priceChange1hPct !== null ? m.priceChange1hPct.toFixed(2) + "%" : "null";
              const known = m.knownPool ? "✓indexed" : "unindexed";
              lines.push(`  ${m.baseSymbol}/${m.quoteSymbol} [${m.program}] price:${m.priceInQuote.toExponential(4)} | 5m:${ch5m} 1h:${ch1h} | samples:${m.sampleCount} ${m.historyStatus} | ${known}`);
            }
            lines.push("");
          } else {
            lines.push("No sampled price movers yet (history accumulating).");
            lines.push("");
          }

          lines.push(`STATUS: Solana indexer ${health.status}. Sampled coverage — not full firehose.`);

          return mcpResponse({
            text: lines.join("\n"),
            confidence: health.workerOnline ? "MEDIUM" : "LOW",
            freshnessSec: health.ageSec,
            dataQuality: { wsFlow: "absent" }, // Solana nu are WS flow ca EVM
          });
        }

        // ── EVM chains — citim Redis doar dacă nu e Solana ───────────────
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, events, drops, pfDrops } = ctx;

        // ── Filter everything to this chain ───────────────────────────────
        const chainKey    = normalizeChain(chain); // "eth" → "ethereum"
        const chainStates = Object.entries(states).filter(
          ([, s]) => (s.chain ?? "").toLowerCase() === chainKey
        );
        const chainWatch = Object.entries(watch).filter(([, w]) => w.chain?.toLowerCase() === chainKey);
        const chainHot   = Object.entries(hot).filter(([, h])   => h.chain?.toLowerCase() === chainKey);
        const chainArmed = Object.entries(armed).filter(([, a]) => (a.chain ?? "").toLowerCase() === chainKey);

        const dropsSource = pfDrops && pfDrops.length > 0 ? pfDrops : drops;
        const chainDrops  = dropsSource.filter(d =>
          d.chain?.toLowerCase() === chainKey && now - d.droppedAt < 10 * 60_000
        );
        // fix ChatGPT #1: timestamp fallback
        const chainEvents = events.filter((e: any) =>
          e.chain?.toLowerCase() === chainKey && now - eventTs(e) < 5 * 60_000
        );

        const stateVals = chainStates.map(([, s]) => s);

        const lines: string[] = [];
        lines.push(`CHAIN REPORT: ${chain.toUpperCase()}`);

        // ── Data freshness ─────────────────────────────────────────────────
        const newestStateAt = stateVals.length
          ? Math.max(...stateVals.map(s => s.updatedAt))
          : null;
        const dataAgeSec = newestStateAt ? Math.round((now - newestStateAt) / 1000) : null;
        lines.push(`tracked:${stateVals.length} pairs | dataAge:${dataAgeSec !== null ? `${dataAgeSec}s` : "?"}`);
        lines.push("");

        if (stateVals.length === 0) {
          lines.push(`No pairs tracked on ${chain.toUpperCase()} yet.`);
          return mcpResponse({
            text: lines.join("\n"),
            confidence: "LOW",
            freshnessSec: dataAgeSec,
            dataQuality: { wsFlow: "absent" },
          });
        }

        // ── Chain-level market context ─────────────────────────────────────
        const withFlow    = stateVals.filter(s => s.flow?.hasData);
        const buying      = withFlow.filter(s => s.flow?.pressure === "BUYING").length;
        const selling     = withFlow.filter(s => s.flow?.pressure === "SELLING").length;
        const total       = stateVals.length;
        const buyingPct   = total ? Math.round(buying  / total * 100) : 0;
        const sellingPct  = total ? Math.round(selling / total * 100) : 0;
        const coveragePct = total ? Math.round(withFlow.length / total * 100) : 0;

        const regimeEmoji =
          buyingPct >= 35  ? "🟢" :
          sellingPct >= 40 ? "🔴" :
          coveragePct < 20 ? "⚫" : "🟡";

        const regimeLabel =
          buyingPct >= 35  ? "RISK_ON"  :
          sellingPct >= 40 ? "RISK_OFF" :
          coveragePct < 20 ? "DEAD"     : "MIXED";

        const coverageConfidence =
          coveragePct >= 50 ? "HIGH" :
          coveragePct >= 20 ? "MEDIUM" :
          "LOW";

        lines.push(`MARKET: ${regimeEmoji} ${regimeLabel} | buying:${buyingPct}% selling:${sellingPct}% coverage:${coveragePct}%`);

        if (coverageConfidence === "LOW") {
          lines.push(`⚠️ COVERAGE_CONFIDENCE: LOW — only ${coveragePct}% of watched pairs have WS flow. Flow-derived context is partial and lower confidence for this chain.`);
        } else if (coverageConfidence === "MEDIUM") {
          lines.push(`ℹ️ COVERAGE_CONFIDENCE: MEDIUM — ${coveragePct}% WS coverage.`);
        }

        // ── Pipeline counts ────────────────────────────────────────────────
        lines.push(`PIPELINE: watching:${chainWatch.length} hot:${chainHot.length} armed:${chainArmed.length}`);
        lines.push("");

        // ── Armed ──────────────────────────────────────────────────────────
        if (chainArmed.length > 0) {
          const armedLines = chainArmed.map(([addr, a]) => {
            const ageSec = Math.round((now - a.armedAt) / 1000);
            return `  → ${a.symbol ?? addr.slice(0, 8)} pair:${addr} score:${a.score} age:${ageSec}s flow:${a.flowPressure}`;
          });
          lines.push(`⚡ ARMED:\n${armedLines.join("\n")}`);
          lines.push("");
        }

        // ── HOT — full detail ──────────────────────────────────────────────
        if (chainHot.length > 0) {
          const hotLines = chainHot
            .sort(([, a], [, b]) => a.promotedAt - b.promotedAt)
            .map(([addr, h]) => {
              const ageSec    = Math.round((now - h.promotedAt) / 1000);
              const pairState = states[addr];
              const pc   = pairState?.priceChange;
              let line   = `  → ${h.symbol ?? addr.slice(0, 8)} pair:${addr}`;
              line += `\n     source:${h.source ?? "WS"} age:${ageSec}s phase:${h.phase ?? "?"}`;
              // fix ChatGPT #3: ?? 0 pe formatEth
              const flow = pairState?.flow ?? h.flow;
              line += `\n     flow:${flow?.pressure} | buys:${flow?.buys5m} buyVol:${formatVol((flow as any)?.buyVol5mUsd, flow?.buyVol5m ?? 0)} netVol:${formatVol((flow as any)?.netVol5mUsd, flow?.netVol5m ?? 0)}`;
              if (pc) line += `\n     priceChange: m5:${formatPct(pc.m5)} h1:${formatPct(pc.h1)} h24:${formatPct(pc.h24)}`;
              if (pairState) {
                // fix ChatGPT #2: ?? 0 pe reserveUsd
                line += `\n     liq:$${Math.round((pairState.reserveUsd ?? 0) / 1000)}K lp:${pairState.lp?.status ?? "?"}(${getLpCoverage(pairState.dexType, pairState.lp?.hasData ?? false)})`;
              }
              return line;
            });
          lines.push(`HOT (${chainHot.length}):\n${hotLines.join("\n")}`);
          lines.push("");
        }

        // ── Observed movers — acest chain ──────────────────────────────────
        const moverScore = (s: (typeof stateVals)[0]) => Math.max(
          Math.abs(s.priceChange?.m5  ?? 0),
          Math.abs(s.priceChange?.h1  ?? 0) / 3,
          Math.abs(s.priceChange?.h24 ?? 0) / 8,
        );

        const observedMovers = chainStates
          .filter(([addr, s]) => {
            const pipe = getPipelineState(addr, watch, hot, armed);
            return pipe === "NONE" &&
              s.priceChange &&
              (
                Math.abs(s.priceChange.m5)  >= 5  ||
                Math.abs(s.priceChange.h1)  >= 15 ||
                Math.abs(s.priceChange.h24) >= 40
              ) &&
              // fix ChatGPT #2: ?? 0
              (s.reserveUsd ?? 0) >= 5_000;
          })
          .sort(([, a], [, b]) => moverScore(b) - moverScore(a))
          .slice(0, 10);

        if (observedMovers.length > 0) {
          const moverLines = observedMovers.map(([addr, s]) => {
            const pc = s.priceChange!;
            let line = `  → ${s.symbol ?? addr.slice(0, 8)} pair:${addr}`;
            line += `\n     m5:${formatPct(pc.m5)} h1:${formatPct(pc.h1)} h24:${formatPct(pc.h24)} liq:$${Math.round((s.reserveUsd ?? 0) / 1000)}K`;
            // fix ChatGPT #3: ?? 0 pe formatEth
            line += `\n     flow:${s.flow?.hasData ? `${s.flow.pressure} buys:${s.flow.buys5m} netVol:${formatVol((s.flow as any).netVol5mUsd, s.flow.netVol5m ?? 0)}` : "NO_WS_DATA"} lp:${s.lp?.status ?? "?"}(${getLpCoverage(s.dexType, s.lp?.hasData ?? false)})`;
            return line;
          });
          lines.push(`OBSERVED MOVERS (${observedMovers.length}):\n${moverLines.join("\n")}`);
          lines.push("");
        }

        // ── Top WATCHING by flow activity ──────────────────────────────────
        const watchingWithFlow = chainWatch
          .map(([addr, w]) => ({ addr, w, pairState: states[addr] ?? null }))
          .filter(({ pairState }) => pairState?.flow?.hasData && pairState.flow.pressure === "BUYING")
          .sort((a, b) => (b.pairState?.flow?.buyVol5m ?? 0) - (a.pairState?.flow?.buyVol5m ?? 0))
          .slice(0, 5);

        if (watchingWithFlow.length > 0) {
          const watchLines = watchingWithFlow.map(({ addr, w, pairState }) => {
            const pc = pairState?.priceChange;
            let line = `  → ${w.symbol ?? addr.slice(0, 8)} pair:${addr}`;
            // fix ChatGPT #3: ?? 0 pe formatEth
            line += `\n     flow:${pairState!.flow.pressure} buys:${pairState!.flow.buys5m} buyVol:${formatVol(pairState!.flow.buyVol5mUsd, pairState!.flow.buyVol5m ?? 0)} netVol:${formatVol(pairState!.flow.netVol5mUsd, pairState!.flow.netVol5m ?? 0)}`;
            if (pc) line += `\n     priceChange: m5:${formatPct(pc.m5)} h1:${formatPct(pc.h1)} h24:${formatPct(pc.h24)}`;
            line += `\n     liq:$${Math.round((pairState?.reserveUsd ?? 0) / 1000)}K lp:${pairState?.lp?.status ?? "?"}(${getLpCoverage(pairState?.dexType, pairState?.lp?.hasData ?? false)})`;
            return line;
          });
          lines.push(`WATCHING — active flow (${watchingWithFlow.length}):\n${watchLines.join("\n")}`);
          lines.push("");
        }

        // ── Recent drops ───────────────────────────────────────────────────
        if (chainDrops.length > 0) {
          const dropLines = chainDrops.slice(0, 5).map(d => {
            const ageSec    = Math.round((now - d.droppedAt) / 1000);
            const fromState = d.wasIn ?? "?";
            return `  ${ageSec}s: ${d.symbol} pair:${d.pairAddress} dropped from ${fromState} — ${d.dropReason ?? "?"}`;
          });
          lines.push(`DROPPED (last 10m):\n${dropLines.join("\n")}`);
          lines.push("");
        }

        // ── Recent transitions ─────────────────────────────────────────────
        if (chainEvents.length > 0) {
          const evLines = chainEvents.slice(0, 5).map((e: any) => {
            // fix : eventTs()
            const ageSec = Math.round((now - eventTs(e)) / 1000);
            return `  ${ageSec}s: ${e.symbol} ${e.from}→${e.to}${e.reason ? ` (${e.reason})` : ""}`;
          });
          lines.push(`TRANSITIONS (last 5m):\n${evLines.join("\n")}`);
          lines.push("");
        }

        // ── STATUS ─────────────────────────────────────────────────────────
        const status =
          chainArmed.length > 0     ? `ARMED candidate on ${chain.toUpperCase()}. Drilldown data available.` :
          chainHot.length > 0       ? `HOT candidate on ${chain.toUpperCase()}. Drilldown data available.`   :
          observedMovers.length > 0 ? `Observed movers on ${chain.toUpperCase()}. No pipeline candidates.`   :
          chainWatch.length > 0     ? `Watching ${chainWatch.length} pairs on ${chain.toUpperCase()}. Awaiting WS flow confirmation.` :
          `No active candidates on ${chain.toUpperCase()}. Worker scanning.`;

        lines.push(`STATUS: ${status}`);

        return mcpResponse({
          text: lines.join("\n"),
          confidence: combineConfidence(dataAgeSec, coveragePct, false),
          freshnessSec: dataAgeSec,
          dataQuality: {
            wsFlow: coveragePct >= 50 ? "present" : coveragePct > 0 ? "partial" : "absent",
          },
          evidence: {
            trackedPairs: stateVals.length,
            coveragePct,
            hot:      chainHot.length,
                  armed:    chainArmed.length,
            watching: chainWatch.length,
          },
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
