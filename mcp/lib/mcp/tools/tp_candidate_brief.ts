import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pairAddressSchema } from "./pairAddressSchema";
import { readAllRedis, getPipelineState, resolvePairChain, findLastEventForPair, formatEth, formatVol, formatPct, wsFlowQuality, combineConfidence } from "../redis-reader";
import { mcpErr, mcpResponse, ERR, sanitizeToolError } from "../errors";
import type { SourceAgreement } from "@preflight/schema";
import { hooksEvidenceField, isEstimatedReserve, reserveEstimatedFlag } from "@preflight/schema";

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

export function registerCandidateBrief(server: McpServer) {
  server.registerTool(
    "tp_candidate_brief",
    {
      title: "Preflight Candidate Brief",
      description: `Get a narrative case file for a specific pair — written for AI agent reasoning.

Returns a structured text brief covering:
- Why this pair matters right now
- Current pipeline state and timing
- Flow analysis (buy concentration and buy pressure quality)
- Liquidity and risk observations
- What evidence would weaken the current context
- Related diagnostic routes

Use this after tp_situation_report identifies a HOT or ARMED candidate.

Args: pair_address (0x... EVM address or V4 pool ID)`,
      inputSchema: {
        pair_address: pairAddressSchema.describe("EVM pair address (0x...) or V4 pool ID"),
        chain:        z.enum(["base", "arbitrum", "bsc", "eth"]).optional().describe("Optional chain hint — needed only if the same address exists on multiple chains"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pair_address, chain }: { pair_address: string; chain?: "base" | "arbitrum" | "bsc" | "eth" }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot, events, pfMarket, regime } = ctx;
        const coveragePct = pfMarket?.flowCoveragePct ?? regime?.flowCoveragePct ?? null;
        const addr = pair_address.toLowerCase().trim();
        // B3f: hărțile sunt keyed pe pairKey(chain, addr). Rezolvăm chain-ul
        // (hint arg > probe pe live maps). Ambiguu (>1 chain) → cerem chain.
        const { chain: resolvedChain, key: pk, ambiguousChains } =
          resolvePairChain(addr, [states, watch, hot, armed, snapshot?.memory], chain);
        if (ambiguousChains.length > 1) {
          return mcpErr(ERR.INVALID_INPUT, `Pair ${addr} exists on multiple chains: ${ambiguousChains.join(", ")}. Specify chain.`);
        }
        const lookup = pk ?? "";

        const pairState  = states[lookup]             ?? null;
        const snapMem    = snapshot?.memory?.[lookup] ?? null;
        const data       = pairState ?? snapMem;
        const watchEntry = watch[lookup] ?? null;
        const hotEntry   = hot[lookup]   ?? null;
        const armedEntry = armed[lookup] ?? null;
        const pipeState  = getPipelineState(lookup, watch, hot, armed);

        const symbol = data?.symbol ?? watchEntry?.symbol ?? hotEntry?.symbol ?? armedEntry?.symbol ?? addr.slice(0, 10);

        if (!data && pipeState === "NONE") {
          return mcpResponse({
            text: `${symbol} — not found in worker context.\nThe worker has no data for this pair.`,
            confidence: "LOW",
            warnings: ["pair not found in worker context"],
          });
        }

        const lines: string[] = [];
        const displayChain = pairState?.chain ?? watchEntry?.chain ?? hotEntry?.chain ?? armedEntry?.chain ?? resolvedChain ?? "unknown";
        lines.push(`═══ CANDIDATE BRIEF: ${symbol} / ${displayChain.toUpperCase()} ═══`);
        lines.push(`Address: ${addr}`);
        lines.push(`Pipeline: ${pipeState}${watchEntry?.kind ? ` (${watchEntry.kind})` : ""}`);
		lines.push(`Chain: ${displayChain}`);
        lines.push("");

        lines.push("WHY IT WAS SURFACED:");
        if (pipeState === "ARMED") {
          const ageSec = Math.round((now - (armedEntry?.armedAt ?? now)) / 1000);
          lines.push(`  • ARMED ${ageSec}s ago — qualification criteria observed, awaiting 30s price confirmation`);
          lines.push(`  • Qualification score: ${armedEntry?.score ?? "?"} | flow: ${armedEntry?.flowPressure ?? "?"}`);
        } else if (pipeState === "HOT") {
          const ageSec = Math.round((now - (hotEntry?.promotedAt ?? now)) / 1000);
          lines.push(`  • Promoted to HOT ${ageSec}s ago from source: ${hotEntry?.source ?? "WS"}`);
          const hotFlow = pairState?.flow ?? hotEntry?.flow;
          lines.push(`  • Flow: ${hotFlow?.pressure ?? "?"} | buys: ${hotFlow?.buys5m ?? 0} | buyVol: ${formatVol((hotFlow as unknown as { buyVol5mUsd?: number } | undefined)?.buyVol5mUsd, hotFlow?.buyVol5m ?? 0)}`);
          if ((hotEntry?.largestBuyEth ?? 0) > (hotEntry?.avgBuyEth ?? 0) * 4) {
            lines.push(`  ⚠️ Concentrated buy pattern: largest buy ${formatEth(hotEntry?.largestBuyEth ?? 0, displayChain)} vs avg ${formatEth(hotEntry?.avgBuyEth ?? 0, displayChain)} (exceeds 4× concentration threshold)`);
          } else {
            lines.push(`  • Flow distribution: avg buy ${formatEth(hotEntry?.avgBuyEth ?? 0, displayChain)} across ${hotEntry?.buySwapCount5m ?? 0} swaps; no buy exceeded the 4× concentration threshold`);
          }
        } else if (pipeState === "WATCHING") {
          const ageMin = Math.round((now - (watchEntry?.addedAt ?? now)) / 60_000 * 10) / 10;
          lines.push(`  • In watch for ${ageMin}m (kind: ${watchEntry?.kind ?? "NORMAL"})`);
          if (watchEntry?.priceVsEntryPct !== null && watchEntry?.priceVsEntryPct !== undefined) {
            lines.push(`  • Price vs entry: ${watchEntry.priceVsEntryPct > 0 ? "+" : ""}${watchEntry.priceVsEntryPct}%`);
          }
        }

        if (data) {
          lines.push(`  • Phase: ${data.phase} | seen: ${data.seenCount}x`);
        }

        lines.push("");
        lines.push("LIQUIDITY:");
        if (pairState) {
          // NF/U5: reserveUsd-ul V4 (V4_STATE_LIQUIDITY) e ESTIMAT din virtual reserves — poate supraestima
          // pozițiile concentrate → marchează-l ca estimat, nu ca TVL confirmat.
          const reserveEstimated = isEstimatedReserve(pairState.reserveSource);
          lines.push(`  • Reserve: $${Math.round((pairState.reserveUsd ?? 0) / 1000)}K (${pairState.liqStatus ?? "?"})${reserveEstimated ? " ⚠️ V4 est." : ""}`);
          if (reserveEstimated) {
            lines.push("  • ⚠️ Reserve is a V4 estimate (virtual reserves from active liquidity — may overstate concentrated positions; not confirmed TVL)");
          }
          lines.push(`  • DEX type: ${pairState.dexType ?? "?"} | LP coverage: ${getLpCoverage(pairState.dexType, pairState.lp?.hasData ?? false)}`);
          // NF1: pt. V4, raportează starea hook-ului (tri-stare) + coverage-ul de flow.
          if (pairState.dexType === "V4") {
            const hk = pairState.hooks;
            const hookDesc = hk === null ? "vanilla (no hook)"
              : typeof hk === "string" ? `custom hook ${hk.slice(0, 10)}…`
              : "unknown (hook info unavailable)";
            lines.push(`  • V4 hooks: ${hookDesc} | flow coverage: ${pairState.flow?.flowCoverage ?? "?"}`);
          }
          if ((pairState.poolCountSameToken ?? 1) > 1) {
            lines.push(`  ⚠️ ${pairState.poolCountSameToken} pools for same token — fragmentation/clone risk`);
          }
          if (pairState.lp?.hasData && pairState.lp.status === "REMOVED") {
            lines.push(`  🚨 LP being removed: ${formatEth(pairState.lp.lpRemoved5m ?? 0, displayChain)} in 5m`);
          }
        } else {
          lines.push(`  • No live liquidity data — using snapshot only`);
        }
		
		if (pairState?.priceChange) {
		const pc = pairState.priceChange;
	    lines.push("");
	    lines.push("PRICE CHANGE:");
	    lines.push(`  • m5: ${formatPct(pc.m5)} | h1: ${formatPct(pc.h1)} | h24: ${formatPct(pc.h24)}`);
	    }
		
        if (pairState?.flow?.hasData) {
          lines.push("");
          lines.push("FLOW (5m):");
          lines.push(`  • Pressure: ${pairState.flow.pressure}`);
          lines.push(`  • Buy: ${formatVol(pairState.flow.buyVol5mUsd, pairState.flow.buyVol5m)} (${pairState.flow.buys5m} swaps) | Sell: ${formatVol(pairState.flow.sellVol5mUsd, pairState.flow.sellVol5m)} (${pairState.flow.sells5m} swaps)`);
          lines.push(`  • Net: ${formatVol(pairState.flow.netVol5mUsd, pairState.flow.netVol5m)}`);
          // NF1: pt. pool-uri V4 cu hook return-delta, buy/sell + volumul vin doar din Swap events, care pot
          // să NU reflecte input/output-ul final → marchează explicit că flow-ul e event-only (posibil incomplet).
          if (pairState.flow.flowCoverage === "EVENT_ONLY") {
            lines.push("  • ⚠️ Coverage: EVENT_ONLY (V4 return-delta hook — buy/sell & volume may not reflect final swap)");
          } else if (pairState.flow.flowCoverage === "UNKNOWN") {
            lines.push("  • ⚠️ Coverage: UNKNOWN (V4 hook info unavailable — flow may be incomplete)");
          }
        }

        const cautions: string[] = [];
        // NF1: caveat vizibil chiar și fără swap-uri observate încă (coverage e proprietate a pool-ului).
        if (pairState?.flow?.flowCoverage === "EVENT_ONLY") cautions.push("V4 return-delta hook — flow is event-only (buy/sell may be incomplete)");
        else if (pairState?.flow?.flowCoverage === "UNKNOWN" && pairState?.dexType === "V4") cautions.push("V4 hook info unavailable — flow coverage unknown");
        // NF/U5: rezerva V4 e un estimat (virtual reserves) — poate supraestima lichiditatea.
        if (isEstimatedReserve(pairState?.reserveSource)) cautions.push("V4 reserve is an estimate (virtual reserves — may overstate liquidity, not confirmed TVL)");
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
        lines.push("EVIDENCE WOULD WEAKEN IF:");
        lines.push("  • Flow turns SELLING or netVol drops below 0.03 nativeEq");
        lines.push("  • LP removal detected (any significant burn event)");
        if ((pairState?.poolCountSameToken ?? 1) >= 2) lines.push("  • Liquidity migrating to another pool for same token");
        if (data?.phase === "RECOVERING") lines.push("  • Phase stays RECOVERING with no BUYING confirmation");

        const lastEvent = resolvedChain ? findLastEventForPair(resolvedChain, addr, events) : null;
        if (lastEvent) {
          const ageSec = Math.round((now - lastEvent.ts) / 1000);
          lines.push("");
          lines.push(`LAST PIPELINE EVENT (${ageSec}s ago): ${lastEvent.from} → ${lastEvent.to}${lastEvent.reason ? ` — ${lastEvent.reason}` : ""}`);
        }

        // ── Discovery ────────────────────────────────────────────────────────
        const RETENTION_SOURCES = new Set(["MARKET_FOLLOW_LIST"]);
        const LOOKUP_SOURCES    = new Set(["DEXSCREENER_PAIR_FALLBACK"]);

        const allSources: string[] =
          pairState?.discovery?.discoverySources ??
          snapMem?.discoverySources ??
          [];

        const discoverySources = allSources.filter(s => !RETENTION_SOURCES.has(s) && !LOOKUP_SOURCES.has(s));
        const retainedVia      = allSources.filter(s => RETENTION_SOURCES.has(s));
        const resolvedVia      = allSources.filter(s => LOOKUP_SOURCES.has(s));

        const rawPrimary =
          pairState?.discovery?.primaryDiscoverySource ??
          snapMem?.primaryDiscoverySource ??
          null;

        const primaryDiscoverySource =
          rawPrimary && discoverySources.includes(rawPrimary)
            ? rawPrimary
            : discoverySources[0] ?? null;

        const firstDiscoveredAt =
          pairState?.discovery?.firstDiscoveredAt ??
          snapMem?.firstDiscoveredAt ?? null;

        const lastDiscoveryAt =
          pairState?.discovery?.lastDiscoveryAt ??
          snapMem?.lastDiscoveryAt ?? null;

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
        lines.push(`  • tp_late_move_context — late-move evidence`);
        lines.push(`  • tp_preflight_safety — contract/token safety check`);
        lines.push(`  • tp_why_not — pipeline rejection reasons`);
        lines.push(`  • tp_pair_context — raw worker context (advanced/read:all)`);
 
const hasDirectFlow = !!pairState?.flow?.hasData;
const confidence    = combineConfidence(dataAgeSec, coveragePct, hasDirectFlow);

// NF1 (varu blocker #2): `hooks` în evidence respectă modelul schemei — custom → adresă,
// vanilla (zero-address) → null, necunoscut/non-V4 → PROPRIETATE ABSENTĂ (conditional spread).
// Decizia trăiește în @preflight/schema (hooksEvidenceField), partajată worker↔MCP↔teste.
const hooksEvidence = hooksEvidenceField(pairState?.dexType, pairState?.hooks);

return mcpResponse({
  text:         lines.join("\n"),
  freshnessSec: dataAgeSec,
  confidence,
  dataQuality: {
    wsFlow:    wsFlowQuality(hasDirectFlow, coveragePct),
    // NF/U5 (R3): un reserveUsd V4 estimat NU poate fi „confirmed" din LP events — ar contrazice caveatul din text.
    liquidity: isEstimatedReserve(pairState?.reserveSource) ? "estimated"
             : pairState?.lp?.hasData ? "confirmed"
             : pairState?.reserveUsd ? "estimated" : "unknown",
  },
  evidence: {
    pipelineState: pipeState,
    chain:         displayChain,
    symbol,
    pairAddress:   addr,
    hasFlowData:   !!pairState?.flow?.hasData,
    flowCoverage:  pairState?.flow?.flowCoverage ?? null,
    ...hooksEvidence,
    // NF/U5: proveniența rezervei + flag de estimat, ca agentul să nu trateze un reserveUsd V4 ca TVL confirmat.
    reserveSource:    pairState?.reserveSource ?? null,
    reserveEstimated: reserveEstimatedFlag(pairState?.reserveSource), // tri-stare: true/false/null(necunoscut)
    lpCoverage:    pairState ? getLpCoverage(pairState.dexType, pairState.lp?.hasData ?? false) : "NO_PAIR_STATE",
  },
});
      } catch (e) { return mcpErr(ERR.INTERNAL, sanitizeToolError(e)); }
    },
  );
}
