import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis, getPipelineState, findLastEventForPair, formatEth, formatVol } from "../redis-reader";
import type { PairState } from "../types";
import { mcpOk, mcpErr, ERR } from "../errors";
import type { SourceAgreement } from "@preflight/schema";

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

function getSourceAgreement(
  allSources:      string[],
  lastDiscoveryAt: number | null,
  now:             number,
): SourceAgreement {
  const RETENTION_SOURCES = new Set(["MARKET_FOLLOW_LIST"]);
  const LOOKUP_SOURCES    = new Set(["DEXSCREENER_PAIR_FALLBACK"]);

  const realSources = allSources.filter(
    s => !RETENTION_SOURCES.has(s) && !LOOKUP_SOURCES.has(s),
  );

  const isRetained = allSources.some(s => RETENTION_SOURCES.has(s));

  if (!realSources.length && !isRetained) return "NO_DISCOVERY_DATA";

  const staleSec = lastDiscoveryAt ? Math.round((now - lastDiscoveryAt) / 1_000) : null;
  const isStale  = staleSec !== null && staleSec > 30 * 60 && !isRetained;

  if (isStale) return "STALE_DISCOVERY";

  if (realSources.length >= 2) return "MULTI_DISCOVERY_SOURCES";

  if (isRetained) return "RETAINED_BY_FOLLOW_LIST";

  if (realSources.length === 1) return "SINGLE_DISCOVERY_SOURCE";

  return "NO_DISCOVERY_DATA";
}

export function registerCandidateBrief(server: McpServer, exposePerformance: boolean) {
  server.registerTool(
    "tp_candidate_brief",
    {
      title: "Preflight Candidate Brief",
      description: `Get a narrative case file for a specific pair — written for AI agent reasoning.

Returns a structured text brief covering:
- Why this pair matters right now
- Current pipeline state and timing
- Flow analysis (organic vs whale, buy pressure quality)
- Liquidity and risk signals
- What would invalidate the setup
- Suggested next verification step

Use this after tp_situation_report identifies a HOT or ARMED candidate.

Args: pair_address (0x... EVM address or V4 pool ID)`,
      inputSchema: {
        pair_address: z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pair_address }: { pair_address: string }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot, events } = ctx;
        const addr = pair_address.toLowerCase().trim();

        const pairState  = states[addr]             ?? null;
        const snapMem    = snapshot?.memory?.[addr] ?? null;
        const data       = pairState ?? snapMem;
        const watchEntry = watch[addr] ?? null;
        const hotEntry   = hot[addr]   ?? null;
        const armedEntry = armed[addr] ?? null;
        const pipeState  = getPipelineState(addr, watch, hot, armed);

        const symbol = data?.symbol ?? watchEntry?.symbol ?? hotEntry?.symbol ?? armedEntry?.symbol ?? addr.slice(0, 10);
        const chain  = watchEntry?.chain ?? hotEntry?.chain ?? armedEntry?.chain ?? "unknown";

        if (!data && pipeState === "NONE") {
          return mcpOk(`${symbol} — not found in worker context.\nThe worker has no data for this pair.`);
        }

        const lines: string[] = [];
        const displayChain = pairState?.chain ?? chain ?? "unknown";
        lines.push(`═══ CANDIDATE BRIEF: ${symbol} / ${displayChain.toUpperCase()} ═══`);
        lines.push(`Address: ${addr}`);
        lines.push(`Pipeline: ${pipeState}${watchEntry?.kind ? ` (${watchEntry.kind})` : ""}`);
		lines.push(`Chain: ${displayChain}`);
        lines.push("");

        lines.push("WHY IT MATTERS:");
        if (pipeState === "ARMED") {
          const ageSec = Math.round((now - (armedEntry?.armedAt ?? now)) / 1000);
          lines.push(`  • ARMED ${ageSec}s ago — entry gate passed, awaiting 30s price confirmation`);
          lines.push(`  • Entry score: ${armedEntry?.score ?? "?"} | flow: ${armedEntry?.flowPressure ?? "?"}`);
        } else if (pipeState === "HOT") {
          const ageSec = Math.round((now - (hotEntry?.promotedAt ?? now)) / 1000);
          lines.push(`  • Promoted to HOT ${ageSec}s ago from source: ${hotEntry?.source ?? "WS"}`);
          const hotFlow = pairState?.flow ?? hotEntry?.flow;
          lines.push(`  • Flow: ${hotFlow?.pressure ?? "?"} | buys: ${hotFlow?.buys5m ?? 0} | buyVol: ${formatVol((hotFlow as any)?.buyVol5mUsd, hotFlow?.buyVol5m ?? 0)}`);
          if ((hotEntry?.largestBuyEth ?? 0) > (hotEntry?.avgBuyEth ?? 0) * 4) {
            lines.push(`  ⚠️ Whale pattern: largest buy ${formatEth(hotEntry?.largestBuyEth ?? 0)} vs avg ${formatEth(hotEntry?.avgBuyEth ?? 0)}`);
          } else {
            lines.push(`  • Flow looks organic: avg buy ${formatEth(hotEntry?.avgBuyEth ?? 0)}, ${hotEntry?.buySwapCount5m ?? 0} swaps`);
          }
        } else if (pipeState === "WATCHING") {
          const ageMin = Math.round((now - (watchEntry?.addedAt ?? now)) / 60_000 * 10) / 10;
          lines.push(`  • In watch for ${ageMin}m (kind: ${watchEntry?.kind ?? "NORMAL"})`);
          if (watchEntry?.priceVsEntryPct !== null && watchEntry?.priceVsEntryPct !== undefined) {
            lines.push(`  • Price vs entry: ${watchEntry.priceVsEntryPct > 0 ? "+" : ""}${watchEntry.priceVsEntryPct}%`);
          }
        }

        if (data) {
          lines.push(exposePerformance
            ? `  • Phase: ${data.phase} | seen: ${data.seenCount}x | entries: ${data.totalEntries}`
            : `  • Phase: ${data.phase} | seen: ${data.seenCount}x`);
          if (exposePerformance && (data.wins24h > 0 || data.losses24h > 0 || data.badExits24h > 0)) {
            lines.push(`  • History: ${data.wins24h}W / ${data.losses24h}L / ${data.badExits24h} bad exits`);
          }
        }

        lines.push("");
        lines.push("LIQUIDITY:");
        if (pairState) {
          lines.push(`  • Reserve: $${Math.round((pairState.reserveUsd ?? 0) / 1000)}K (${pairState.liqStatus ?? "?"})`);
          lines.push(`  • DEX type: ${pairState.dexType ?? "?"} | LP coverage: ${getLpCoverage(pairState.dexType, pairState.lp?.hasData ?? false)}`);
          if ((pairState.poolCountSameToken ?? 1) > 1) {
            lines.push(`  ⚠️ ${pairState.poolCountSameToken} pools for same token — fragmentation/clone risk`);
          }
          if (pairState.lp?.hasData && pairState.lp.status === "REMOVED") {
            lines.push(`  🚨 LP being removed: ${formatEth(pairState.lp.lpRemoved5m ?? 0)} in 5m`);
          }
        } else {
          lines.push(`  • No live liquidity data — using snapshot only`);
        }
		
		if (pairState?.priceChange) {
		const pc = pairState.priceChange;
	    const fmt = (n: number | null | undefined) =>
		  typeof n === "number" && Number.isFinite(n)
		    ? `${n > 0 ? "+" : ""}${n.toFixed(1)}%`
		    : "n/a";
	    lines.push("");
	    lines.push("PRICE CHANGE:");
	    lines.push(`  • m5: ${fmt(pc.m5)} | h1: ${fmt(pc.h1)} | h24: ${fmt(pc.h24)}`);
	    }	
		
        if (pairState?.flow?.hasData) {
          lines.push("");
          lines.push("FLOW (5m):");
          lines.push(`  • Pressure: ${pairState.flow.pressure}`);
          lines.push(`  • Buy: ${formatVol(pairState.flow.buyVol5mUsd, pairState.flow.buyVol5m)} (${pairState.flow.buys5m} swaps) | Sell: ${formatVol(pairState.flow.sellVol5mUsd, pairState.flow.sellVol5m)} (${pairState.flow.sells5m} swaps)`);
          lines.push(`  • Net: ${formatVol(pairState.flow.netVol5mUsd, pairState.flow.netVol5m)}`);
        }

        const cautions: string[] = [];
        if (exposePerformance && data && data.consecutiveLosses >= 2) cautions.push(`${data.consecutiveLosses} consecutive losses`);
        if (data && (pairState?.poolCountSameToken ?? 1) >= 3) cautions.push(`clone/fragmentation risk (${pairState?.poolCountSameToken} pools)`);
        if (pairState?.lp?.status === "REMOVED") cautions.push("LP currently being removed");
        const dataAgeSec = pairState ? Math.round((now - pairState.updatedAt) / 1000) : null;
        if (dataAgeSec !== null && dataAgeSec > 60) cautions.push(`data is ${dataAgeSec}s old`);
        if (hotEntry && (now - hotEntry.promotedAt) > 3 * 60_000) cautions.push(`HOT for ${Math.round((now - hotEntry.promotedAt) / 60_000)}m — nearing expiry`);

        if (cautions.length) {
          lines.push("");
          lines.push("CAUTIONS:");
          cautions.forEach(c => lines.push(`  ⚠️ ${c}`));
        }

        lines.push("");
        lines.push("INVALIDATE IF:");
        lines.push("  • Flow turns SELLING or netVol drops below 0.03 nativeEq");
        lines.push("  • LP removal detected (any significant burn event)");
        if ((pairState?.poolCountSameToken ?? 1) >= 2) lines.push("  • Liquidity migrating to another pool for same token");
        if (data?.phase === "RECOVERING") lines.push("  • Phase stays RECOVERING with no BUYING confirmation");

        const lastEvent = findLastEventForPair(addr, events);
        if (lastEvent) {
          const ageSec = Math.round((now - lastEvent.ts) / 1000);
          lines.push("");
          lines.push(`LAST PIPELINE EVENT (${ageSec}s ago): ${lastEvent.from} → ${lastEvent.to}${lastEvent.reason ? ` — ${lastEvent.reason}` : ""}`);
        }

        // ── Discovery ────────────────────────────────────────────────────────
        const RETENTION_SOURCES = new Set(["MARKET_FOLLOW_LIST"]);
        const LOOKUP_SOURCES    = new Set(["DEXSCREENER_PAIR_FALLBACK"]);

        const allSources: string[] =
          (pairState as any)?.discovery?.discoverySources ??
          (snapMem as any)?.discoverySources ??
          [];

        const discoverySources = allSources.filter(s => !RETENTION_SOURCES.has(s) && !LOOKUP_SOURCES.has(s));
        const retainedVia      = allSources.filter(s => RETENTION_SOURCES.has(s));
        const resolvedVia      = allSources.filter(s => LOOKUP_SOURCES.has(s));

        const rawPrimary =
          (pairState as any)?.discovery?.primaryDiscoverySource ??
          (snapMem as any)?.primaryDiscoverySource ??
          null;

        const primaryDiscoverySource =
          rawPrimary && discoverySources.includes(rawPrimary)
            ? rawPrimary
            : discoverySources[0] ?? null;

        const firstDiscoveredAt =
          (pairState as any)?.discovery?.firstDiscoveredAt ??
          (snapMem as any)?.firstDiscoveredAt ?? null;

        const lastDiscoveryAt =
          (pairState as any)?.discovery?.lastDiscoveryAt ??
          (snapMem as any)?.lastDiscoveryAt ?? null;

        if (allSources.length > 0 || primaryDiscoverySource) {
          lines.push("");
          lines.push("DISCOVERY:");
          lines.push(`  • primary: ${primaryDiscoverySource ?? "unknown"}`);
          if (discoverySources.length > 0) lines.push(`  • sources: ${discoverySources.join(", ")}`);
          if (retainedVia.length > 0)      lines.push(`  • retainedVia: ${retainedVia.join(", ")}`);
          if (resolvedVia.length > 0)      lines.push(`  • resolvedVia: ${resolvedVia.join(", ")}`);
          if (firstDiscoveredAt) {
            const firstMin = Math.max(0, Math.round((now - firstDiscoveredAt) / 60_000));
            lines.push(`  • firstDiscovered: ${firstMin}m ago`);
          }
          if (lastDiscoveryAt) {
            const lastSec = Math.max(0, Math.round((now - lastDiscoveryAt) / 1_000));
            lines.push(`  • lastDiscovery: ${lastSec}s ago`);
          }

          lines.push(`  • agreement: ${getSourceAgreement(allSources, lastDiscoveryAt, now)}`);
        }

        lines.push("");
        lines.push("DATA_AVAILABLE:");
        lines.push(`  • tp_chase_risk — full chase risk scoring`);
        lines.push(`  • tp_preflight_safety — contract/token safety check`);
        lines.push(`  • tp_why_not — pipeline rejection reasons`);
        lines.push(`  • tp_pair_context — raw worker context`);

        return mcpOk(lines.join("\n"));
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
