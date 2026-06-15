import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis, freshnessLabel, getPipelineState, readPairContext } from "../redis-reader";
import type { PairState, MemoryEntry } from "../types";
import { mcpResponse, mcpErr, ERR } from "../errors";
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

export function registerPairContext(server: McpServer, exposePerformance: boolean) {
  server.registerTool(
    "tp_pair_context",
    {
      title: "Preflight Pair Context",
      description: `Get everything the worker knows about a specific pair.

Combines pair_states (live, TTL 120s) + worker_snapshot (24h) + all pipeline maps.

pipelineState: WATCHING = subscribed via WS, accumulating flow
               HOT      = confirmed buying flow observed
			   ARMED    = qualification criteria observed, awaiting 30s price confirmation
               NONE     = not currently tracked in pipeline

contextQuality: fresh (<45s), aging (<90s), stale (>90s), snapshot_only, unknown

Args: pair_address (0x... EVM address or V4 pool ID), chain (optional: base/arbitrum/bsc)`,
      inputSchema: {
        pair_address: z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
        chain:        z.string().optional().describe("Chain hint: 'base', 'arbitrum', or 'bsc'"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pair_address, chain }: { pair_address: string; chain?: string }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot } = ctx;
        const addr = pair_address.toLowerCase().trim();
		
		// Try preflight:pair_context first — richest data
        const pfCtx = await readPairContext(addr);

        const watchEntry    = watch[addr] ?? null;
        const hotEntry      = hot[addr]   ?? null;
        const armedEntry    = armed[addr] ?? null;
        const pipelineState = getPipelineState(addr, watch, hot, armed);

        const watchOut = watchEntry ? { ...watchEntry, ageMs: now - watchEntry.addedAt }  : null;
        const hotOut   = hotEntry   ? { ...hotEntry,   ageMs: now - hotEntry.promotedAt } : null;
        const armedOut = armedEntry ? { ...armedEntry, ageMs: now - armedEntry.armedAt }  : null;

        const pairState  = states[addr]             ?? null;
        const snapMem    = snapshot?.memory?.[addr] ?? null;
        const reserveEth = snapshot?.poolReserveEth?.[addr] ?? null;

        if (!pairState && !snapMem) {
          if (pfCtx) {
            const pfFreshnessSec = pfCtx.updatedAt ? Math.round((now - pfCtx.updatedAt) / 1000) : null;
            const pfPayload = {
              found: true, pairAddress: addr,
              symbol: pfCtx.symbol,
              chain:  pfCtx.chain,
              preflightContext: pfCtx,
              pipeline: { state: pfCtx.pipelineState ?? "NONE", watch: watchOut, hot: hotOut, armed: armedOut },
              contextQuality: pfCtx.contextQuality ?? "fresh",
              dataSource: "preflight_pair_context",
              freshnessSec: pfFreshnessSec,
            };
            return mcpResponse({
              text: JSON.stringify(pfPayload, null, 2),
              freshnessSec: pfFreshnessSec,
              confidence:
                pfFreshnessSec !== null && pfFreshnessSec < 45 ? "HIGH" :
                pfFreshnessSec !== null && pfFreshnessSec < 90 ? "MEDIUM" :
                "LOW",
            });
          }
          return mcpResponse({
            text: JSON.stringify({
              found: false, pairAddress: addr,
              symbol: watchOut?.symbol ?? hotOut?.symbol ?? armedOut?.symbol ?? null,
              pipeline: { state: pipelineState, watch: watchOut, hot: hotOut, armed: armedOut },
              contextQuality: "unknown", dataSource: "none", freshnessSec: null,
              preflightContext: pfCtx ?? null,
            }, null, 2),
            freshnessSec: null,
            confidence: "LOW",
            warnings: ["pair not found in worker context"],
          });
        }

        const data = pairState ?? snapMem!;
        const freshnessSec = pairState
          ? Math.round((now - pairState.updatedAt) / 1000)
          : snapshot?.savedAt ? Math.round((now - snapshot.savedAt) / 1000) : null;

        const mainPayload = {
          found: true, pairAddress: addr,
          symbol: data.symbol,
          chain:  chain ?? pairState?.chain ?? watchOut?.chain ?? hotOut?.chain ?? armedOut?.chain ?? null,
          phase: data.phase, seenCount: data.seenCount, currentPrice: data.currentPrice,
          priceChange: (pairState as PairState)?.priceChange ?? null,
          timing: {
            firstSeenAt:        (pairState as any)?.firstSeenAt  ?? (snapMem as any)?.firstSeen  ?? null,
            lastSeenAt:         (pairState as any)?.lastSeenAt   ?? (snapMem as any)?.lastSeen   ?? null,
            pipelineEnteredAt:  (pairState as any)?.pipelineEnteredAt  ?? null,
            lastMomentumAt:      (pairState as any)?.lastMomentumAt      ?? null,
            attentionScore:      (pairState as any)?.attentionScore      ?? null,
            monitoringTier:      (pairState as any)?.monitoringTier      ?? null,
            patternTags:         (pairState as any)?.patternTags         ?? null,
          },
          risk: (pairState as any)?.risk ? {
            riskLevel:            (pairState as any).risk.riskLevel,
            confidence:           (pairState as any).risk.confidence,
            flags:                (pairState as any).risk.flags,
            summary:              (pairState as any).risk.summary,
            isHoneypot:           (pairState as any).risk.isHoneypot,
            cannotSell:           (pairState as any).risk.cannotSell,
            buyTaxPct:            (pairState as any).risk.buyTaxPct,
            sellTaxPct:           (pairState as any).risk.sellTaxPct,
            ownerRenounced:       (pairState as any).risk.ownerRenounced,
            canMint:              (pairState as any).risk.canMint,
            canBlacklist:         (pairState as any).risk.canBlacklist,
            canPauseTrading:      (pairState as any).risk.canPauseTrading,
            canChangeTax:         (pairState as any).risk.canChangeTax,
            canChangeBalance:     (pairState as any).risk.canChangeBalance,
            canTakeBackOwnership: (pairState as any).risk.canTakeBackOwnership,
            missingData:          (pairState as any).risk.missingData,
            checkedAt:            (pairState as any).risk.checkedAt,
            checkedAgeSec:        Math.round((Date.now() - (pairState as any).risk.checkedAt) / 1000),
          } : null,
          riskCacheStatus: (() => {
            const r = (pairState as any)?.risk;
            if (!pairState) return "unavailable";
            if (!r) return "missing";
            const checkedAt = Number(r.checkedAt ?? 0);
            if (!checkedAt) return "unavailable";
            const ageSec = Math.round((now - checkedAt) / 1000);
            if (ageSec > 6 * 3600) return "stale";
            return "available";
          })(),
          history: exposePerformance ? {
            totalEntries:      data.totalEntries,
            wins24h:           data.wins24h,
            losses24h:         data.losses24h,
            badExits24h:       data.badExits24h,
            consecutiveLosses: data.consecutiveLosses,
          } : undefined,
          pipeline: { state: pipelineState, watch: watchOut, hot: hotOut, armed: armedOut },
          reserveEth,
          preflightContext: pfCtx ?? null,
          contextQuality: pfCtx ? "fresh" : pairState ? freshnessLabel(now - pairState.updatedAt) : "snapshot_only",
          dataSource: pfCtx ? "preflight_pair_context" : pairState ? "pair_states" : "worker_snapshot",
          dataReadyForReasoning: (() => {
            const missingCritical: string[] = [];
            const missingNonCritical: string[] = [];
            if (!pairState?.flow?.hasData) missingCritical.push("wsFlow");
            if (!(pairState as any)?.risk) missingCritical.push("riskCache");
            if (freshnessSec === null || freshnessSec > 90) missingCritical.push("dataStale");
            if (!pairState?.lp?.hasData) missingNonCritical.push("lpHistory");
            if (!(pairState as any)?.pipelineEnteredAt) missingNonCritical.push("pipelineTiming");
            const ready = missingCritical.length === 0;
            return { ready, missingCritical, missingNonCritical };
          })(),
          freshnessSec,
          lifecycle: (() => {
            const lc = (ctx.pfLifecycle ?? []).find((l: any) => l.pairAddress?.toLowerCase() === addr) ?? null;
            if (!lc) return null;
            return {
              lastOutcome:   lc.lastOutcome,
              lastOutcomeAt: lc.lastOutcomeAt,
              ageSec:        Math.round((now - lc.lastOutcomeAt) / 1000),
              fromState:     lc.fromState,
              reason:        lc.reason,
              candidateActive: false,
            };
          })(),
        };

        const riskQuality =
          mainPayload.riskCacheStatus === "available" ? "cached" :
          mainPayload.riskCacheStatus === "stale"     ? "stale"  :
          "missing";

        return mcpResponse({
          text: JSON.stringify(mainPayload, null, 2),
          freshnessSec,
          confidence:
            freshnessSec !== null && freshnessSec < 45 ? "HIGH" :
            freshnessSec !== null && freshnessSec < 90 ? "MEDIUM" :
            "LOW",
          dataQuality: {
            wsFlow: pairState?.flow?.hasData ? "present" : "absent",
            risk:   riskQuality,
          },
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
