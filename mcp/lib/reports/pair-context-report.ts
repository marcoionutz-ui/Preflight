/**
 * lib/reports/pair-context-report.ts
 *
 * Single source of truth for "everything the worker knows about a pair".
 * Extracted out of lib/mcp/tools/tp_pair_context.ts so the MCP tool AND the
 * /demo/pair UI compute the exact same payload/confidence/freshness — no
 * risk of the agent seeing "MEDIUM" while the demo page shows "HIGH".
 *
 * Pure function: Redis reads only (readAllRedis / readPairContext /
 * readSolanaPoolContext are all plain GETs). No live RPC, no GoPlus, no
 * force refresh, no backfill. Safe to call from a public, unauthenticated
 * demo page.
 */

import {
  readAllRedis, freshnessLabel, getPipelineState, readPairContext,
  wsFlowQuality, combineConfidence, readSolanaPoolContext,
} from "../mcp/redis-reader";
import type { PairRiskSummary } from "../mcp/types";
import type { McpConfidence, McpDataQuality } from "../mcp/errors";
import type { SourceAgreement } from "@preflight/schema";

export interface PairContextReport {
  ok:            boolean;
  payload:       Record<string, unknown>;
  freshnessSec:  number | null;
  confidence:    McpConfidence;
  warnings?:     string[];
  dataQuality?:  McpDataQuality;
  errorCode?:    string;
  errorMessage?: string;
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

export interface BuildPairContextInput {
  pairAddress:        string;
  chain?:              string;
  exposePerformance?: boolean;
}

export async function buildPairContextReport(
  input: BuildPairContextInput,
): Promise<PairContextReport> {
  const { pairAddress, chain, exposePerformance = false } = input;

  try {
    const rawAddr = pairAddress.trim();

    // Cheap guard for the public /demo surface — MCP already validates via zod,
    // but buildPairContextReport is also called directly from the demo page,
    // which is unauthenticated and takes the address straight from the URL.
    if (rawAddr.length < 10 || rawAddr.length > 120) {
      return {
        ok: false, payload: {}, freshnessSec: null, confidence: "LOW",
        errorCode: "INVALID_INPUT", errorMessage: "Invalid pair address length",
      };
    }

    const normalizedChain = chain?.toLowerCase();
    const ALLOWED_CHAINS  = new Set(["base", "arbitrum", "bsc", "eth", "solana"]);
    if (normalizedChain && !ALLOWED_CHAINS.has(normalizedChain)) {
      return {
        ok: false, payload: {}, freshnessSec: null, confidence: "LOW",
        errorCode: "INVALID_INPUT", errorMessage: "Unsupported chain",
      };
    }

    const evmAddr = rawAddr.toLowerCase();

    // ── 8.0l: Solana branch (runs before readAllRedis — avoids EVM reads) ──
    // Solana addresses are base58 and case-sensitive — preserve original case.
    const isSolana = normalizedChain === "solana" ||
      (!rawAddr.startsWith("0x") && rawAddr.length >= 32);

    if (isSolana) {
      const poolAddress = rawAddr; // preserve case — Redis keys are case-sensitive
      const now         = Date.now();
      const poolCtx = await readSolanaPoolContext(poolAddress, now);
      const { registry, priceSnapshot, activity, recentHistory, observedCandidate, dataAgeSec } = poolCtx;
      const found  = Boolean(registry || priceSnapshot || observedCandidate);
      const symbol = (priceSnapshot as any)?.baseSymbol ?? (registry as any)?.baseSymbol ?? null;
      const confidence: "HIGH" | "MEDIUM" | "LOW" =
        dataAgeSec !== null && dataAgeSec < 45 ? "HIGH" :
        dataAgeSec !== null && dataAgeSec < 90 ? "MEDIUM" : "LOW";

      const payload = {
        found, pairAddress: poolAddress, chain: "solana", symbol,
        dataSource:     registry ? "solana_registry" : priceSnapshot ? "solana_price_snapshot" : observedCandidate ? "solana_observed_candidate" : "none",
        contextQuality: dataAgeSec !== null
          ? (dataAgeSec < 45 ? "fresh" : dataAgeSec < 90 ? "aging" : "stale")
          : (recentHistory.length > 0 ? "history_only" : "unknown"),
        registry, priceSnapshot, activity,
        recentHistory:  recentHistory.slice(0, 10),
        observedCandidate, dataAgeSec,
      };

      return {
        ok: true,
        payload,
        freshnessSec: dataAgeSec,
        confidence,
        warnings: found ? undefined : ["Solana pool not found in registry or price snapshots"],
      };
    }

    // ── EVM path ─────────────────────────────────────────────────────────
    const addr = evmAddr; // EVM addresses are lowercase hex
    const ctx = await readAllRedis();
    if (!ctx) {
      return {
        ok: false, payload: {}, freshnessSec: null, confidence: "LOW",
        errorCode: "REDIS_DOWN", errorMessage: "Redis not connected",
      };
    }

    const { now, states, watch, hot, armed, snapshot, pfMarket, regime } = ctx;
    const coveragePct = pfMarket?.flowCoveragePct ?? regime?.flowCoveragePct ?? null;

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
          contextQuality: pfCtx.contextQuality ?? freshnessLabel(pfFreshnessSec !== null ? pfFreshnessSec * 1000 : null),
          dataSource: "preflight_pair_context",
          freshnessSec: pfFreshnessSec,
        };
        return {
          ok: true,
          payload: pfPayload,
          freshnessSec: pfFreshnessSec,
          confidence:
            pfFreshnessSec !== null && pfFreshnessSec < 45 ? "HIGH" :
            pfFreshnessSec !== null && pfFreshnessSec < 90 ? "MEDIUM" :
            "LOW",
        };
      }
      return {
        ok: true,
        payload: {
          found: false, pairAddress: addr,
          symbol: watchOut?.symbol ?? hotOut?.symbol ?? armedOut?.symbol ?? null,
          pipeline: { state: pipelineState, watch: watchOut, hot: hotOut, armed: armedOut },
          contextQuality: "unknown", dataSource: "none", freshnessSec: null,
          preflightContext: pfCtx ?? null,
        },
        freshnessSec: null,
        confidence: "LOW",
        warnings: ["pair not found in worker context"],
      };
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
      priceChange: pairState?.priceChange ?? null,
      timing: {
        firstSeenAt:        pairState?.firstSeenAt  ?? snapMem?.firstSeen  ?? null,
        lastSeenAt:         pairState?.lastSeenAt   ?? snapMem?.lastSeen   ?? null,
        pipelineEnteredAt:  pairState?.pipelineEnteredAt  ?? null,
        currentStateAgeSec: pairState?.currentStateAgeSec ?? null,
        seenCount:          data.seenCount,
      },
      risk: pairState?.risk ? {
        riskLevel:            pairState.risk.riskLevel,
        confidence:           pairState.risk.confidence,
        flags:                pairState.risk.flags,
        summary:              pairState.risk.summary,
        isHoneypot:           pairState.risk.isHoneypot,
        cannotSell:           pairState.risk.cannotSell,
        buyTaxPct:            pairState.risk.buyTaxPct,
        sellTaxPct:           pairState.risk.sellTaxPct,
        ownerRenounced:       pairState.risk.ownerRenounced,
        canMint:              pairState.risk.canMint,
        canBlacklist:         pairState.risk.canBlacklist,
        canPauseTrading:      pairState.risk.canPauseTrading,
        canChangeTax:         pairState.risk.canChangeTax,
        canChangeBalance:     pairState.risk.canChangeBalance,
        canTakeBackOwnership: pairState.risk.canTakeBackOwnership,
        missingData:          pairState.risk.missingData,
        checkedAt:            pairState.risk.checkedAt,
        checkedAgeSec:        (() => {
          const checkedAtNum = Number(pairState.risk?.checkedAt ?? 0);
          return checkedAtNum > 0 ? Math.round((Date.now() - checkedAtNum) / 1000) : null;
        })(),
      } satisfies PairRiskSummary : null,
      riskCacheStatus: (() => {
        const r = pairState?.risk;
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
      discovery: (() => {
        const allSources: string[] =
          pairState?.discovery?.discoverySources ??
          snapMem?.discoverySources ?? [];
        const RETENTION_SOURCES = new Set(["MARKET_FOLLOW_LIST"]);
        const LOOKUP_SOURCES    = new Set(["DEXSCREENER_PAIR_FALLBACK"]);
        const discoverySources  = allSources.filter(s => !RETENTION_SOURCES.has(s) && !LOOKUP_SOURCES.has(s));
        const retainedVia       = allSources.filter(s => RETENTION_SOURCES.has(s));
        const resolvedVia       = allSources.filter(s => LOOKUP_SOURCES.has(s));
        const rawPrimary =
          pairState?.discovery?.primaryDiscoverySource ??
          snapMem?.primaryDiscoverySource ?? null;
        const primaryDiscoverySource =
          rawPrimary && discoverySources.includes(rawPrimary) ? rawPrimary : discoverySources[0] ?? null;
        const firstDiscoveredAt =
          pairState?.discovery?.firstDiscoveredAt ?? snapMem?.firstDiscoveredAt ?? null;
        const lastDiscoveryAt =
          pairState?.discovery?.lastDiscoveryAt ?? snapMem?.lastDiscoveryAt ?? null;
        return {
          primaryDiscoverySource, discoverySources, retainedVia, resolvedVia,
          agreement: getSourceAgreement(allSources, lastDiscoveryAt, now),
          firstDiscoveredAt, lastDiscoveryAt,
        };
      })(),
      priceVsFirstSeenPct: pairState?.priceVsFirstSeenPct ?? null,
      dexType:            pairState?.dexType            ?? null,
      reserveUsd:         pairState?.reserveUsd         ?? null,
      liqStatus:          pairState?.liqStatus          ?? null,
      poolCountSameToken: pairState?.poolCountSameToken ?? null,
      reserveNative:      pairState?.reserveNative      ?? reserveEth,
      nativeSymbol:       pairState?.nativeSymbol       ?? null,
      flow: pairState?.flow ?? null,
      lp:   pairState?.lp  ?? null,
      dataAvailability: (() => {
        const hasWsFlow = !!pairState?.flow?.hasData;
        const hasLpData = !!pairState?.lp?.hasData;
        const liveMonitored = pipelineState === "WATCHING" || pipelineState === "HOT" || pipelineState === "ARMED";
        return {
          marketData: pairState ? "available" : "not_available",
          wsFlow:    hasWsFlow  ? "available" : liveMonitored ? "not_available_no_ws_events_yet" : "not_available_market_only",
          lpSignal:  hasLpData  ? "available" : liveMonitored ? "not_available_no_lp_events_yet" : "not_available_market_only",
          lpCoverage: getLpCoverage(pairState?.dexType, hasLpData),
        };
      })(),
      marketPattern: {
        lastMomentumVerdict: pairState?.lastMomentumVerdict ?? null,
        lastMomentumAt:      pairState?.lastMomentumAt      ?? null,
        attentionScore:      pairState?.attentionScore      ?? null,
        monitoringTier:      pairState?.monitoringTier      ?? null,
        patternTags:         pairState?.patternTags         ?? null,
      },
      pipeline: { state: pipelineState, watch: watchOut, hot: hotOut, armed: armedOut },
      reserveEth,
      preflightContext: pfCtx ?? null,
      contextQuality: pfCtx?.contextQuality ?? (pairState ? freshnessLabel(now - pairState.updatedAt) : "snapshot_only"),
      dataSource: pfCtx ? "preflight_pair_context" : pairState ? "pair_states" : "worker_snapshot",
      dataReadyForReasoning: (() => {
        const missingCritical: string[] = [];
        const missingNonCritical: string[] = [];
        if (!pairState?.flow?.hasData) missingCritical.push("wsFlow");
        if (!pairState?.risk) missingCritical.push("riskCache");
        if (freshnessSec === null || freshnessSec > 90) missingCritical.push("dataStale");
        if (!pairState?.lp?.hasData) missingNonCritical.push("lpHistory");
        if (!pairState?.pipelineEnteredAt) missingNonCritical.push("pipelineTiming");
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

    // rawRisk accesat direct din pairState — mainPayload.risk nu expune source
    const rawRisk    = pairState?.risk;
    const riskQuality =
      rawRisk?.source === "unavailable"             ? "missing" :
      mainPayload.riskCacheStatus === "available"   ? "cached"  :
      mainPayload.riskCacheStatus === "stale"       ? "stale"   :
      "missing";

    const hasDirectFlow = !!pairState?.flow?.hasData;

    return {
      ok: true,
      payload: mainPayload,
      freshnessSec,
      confidence: combineConfidence(freshnessSec, coveragePct, hasDirectFlow),
      dataQuality: {
        wsFlow: wsFlowQuality(hasDirectFlow, coveragePct),
        risk:   riskQuality,
      },
    };
  } catch (e) {
    return {
      ok: false, payload: {}, freshnessSec: null, confidence: "LOW",
      errorCode: "INTERNAL", errorMessage: e instanceof Error ? e.message : String(e),
    };
  }
}