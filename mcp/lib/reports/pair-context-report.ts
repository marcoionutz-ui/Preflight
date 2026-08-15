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
  resolvePairChain, wsFlowQuality, combineConfidence, readSolanaPoolContext,
} from "../mcp/redis-reader";
import type { PairRiskSummary } from "../mcp/types";
import { sanitizeToolError, type McpConfidence, type McpDataQuality } from "../mcp/errors";
import { normalizeChainId, reserveEstimatedFlag, type SourceAgreement } from "@preflight/schema";
import { safeAgeSec, safeAgeMs } from "../mcp/freshness";

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

  const staleSec = safeAgeSec(now, lastDiscoveryAt); // E13: clamp ≥0 (skew nu maschează stale ca negativ)
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
}

/**
 * View local peste `pair_context` (readPairContext întoarce `Record<string, unknown>` — validat de
 * PairContextSchema, dar fără tip nominal). Enumeră DOAR câmpurile citite aici; index signature-ul
 * `unknown` păstrează restul (fwd-compat) și permite `Record<string, unknown> as PfContextView`.
 * `reserveSource` = exact tipul acceptat de `reserveEstimatedFlag` → fără cast la call-site.
 */
interface PfContextView {
  [key: string]:    unknown;
  updatedAt?:       number | null;
  symbol?:          string | null;
  chain?:           string | null;
  reserveUsd?:      number | null;
  reserveSource?:   Parameters<typeof reserveEstimatedFlag>[0];
  pipelineState?:   string | null;
  contextQuality?:  unknown;
}

export async function buildPairContextReport(
  input: BuildPairContextInput,
): Promise<PairContextReport> {
  const { pairAddress, chain } = input;

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

    // Formă canonică (eth→ethereum, trim). Schema + worker scriu "ethereum",
    // deci acceptăm forma canonică, nu aliasul extern "eth".
    const normalizedChain = chain ? normalizeChainId(chain) : undefined;
    const ALLOWED_CHAINS  = new Set(["base", "arbitrum", "bsc", "ethereum", "solana"]);
    if (normalizedChain && !ALLOWED_CHAINS.has(normalizedChain)) {
      return {
        ok: false, payload: {}, freshnessSec: null, confidence: "LOW",
        errorCode: "INVALID_INPUT", errorMessage: "Unsupported chain",
      };
    }

    const evmAddr = rawAddr.toLowerCase();

    // ── 8.0l: Solana branch (runs before readAllRedis — avoids EVM reads) ──
    // Solana addresses are base58 and case-sensitive — preserve original case.
    // Un chain EVM explicit bate euristica: doar când chain-ul LIPSEȘTE ghicim
    // Solana din forma adresei (base58, fără 0x). Altfel `chain:"base"` + adresă
    // lungă non-0x ar cădea greșit pe ramura Solana.
    const isSolana =
      normalizedChain === "solana" ||
      (normalizedChain === undefined && !rawAddr.startsWith("0x") && rawAddr.length >= 32);

    if (isSolana) {
      const poolAddress = rawAddr; // preserve case — Redis keys are case-sensitive
      const now         = Date.now();
      const poolCtx = await readSolanaPoolContext(poolAddress, now);
      const { registry, priceSnapshot, activity, recentHistory, observedCandidate, dataAgeSec } = poolCtx;
      const found  = Boolean(registry || priceSnapshot || observedCandidate);
      // priceSnapshot tipat PreflightSolanaPriceSnapshot (item 6c); registry
      // e PreflightSolanaPool (item 6a).
      const symbol = priceSnapshot?.baseSymbol ?? registry?.baseSymbol ?? null;
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

    // Try preflight:pair_context first — richest data.
    // Faza B2: cheie chain-scoped. normalizedChain e hint-ul EVM (poate fi
    // undefined → readPairContext probează chain-urile EVM cunoscute).
    const pfLookup = await readPairContext(addr, normalizedChain);
    // Aceeași adresă pe >1 chain EVM fără hint → NU alegem tăcut primul chain;
    // cerem chain explicit (altfel B2 doar ar ascunde iar coliziunea).
    if (pfLookup.ambiguousChains.length > 1) {
      return {
        ok: false,
        payload: { found: false, pairAddress: addr, matchingChains: pfLookup.ambiguousChains },
        freshnessSec: null,
        confidence: "LOW",
        errorCode: "AMBIGUOUS_PAIR",
        errorMessage: "Pair address exists on multiple chains; specify chain",
      };
    }
    const pfCtx = pfLookup.context as PfContextView | null;

    // B3f: hărțile live (watch/hot/armed/states/snapshot.memory/poolReserveEth)
    // sunt keyed pe pairKey(chain, addr). Precedență chain: hint explicit >
    // match din pair_context > probe pe hărțile live. Ambiguitate în live-state
    // fără hint → cerem chain explicit, la fel ca pair_context.
    const liveHint = normalizedChain ?? pfLookup.matchedChain ?? undefined;
    const live = resolvePairChain(addr, [states, watch, hot, armed, snapshot?.memory], liveHint);
    if (live.ambiguousChains.length > 1) {
      return {
        ok: false,
        payload: { found: false, pairAddress: addr, matchingChains: live.ambiguousChains },
        freshnessSec: null,
        confidence: "LOW",
        errorCode: "AMBIGUOUS_PAIR",
        errorMessage: "Pair address exists on multiple chains; specify chain",
      };
    }
    const lookup = live.key ?? "";

    const watchEntry    = watch[lookup] ?? null;
    const hotEntry      = hot[lookup]   ?? null;
    const armedEntry    = armed[lookup] ?? null;
    const pipelineState = getPipelineState(lookup, watch, hot, armed);

    // E13: clamp ageMs la ≥0 (clock skew → 0, nu ms negativi de afișare).
    const watchOut = watchEntry ? { ...watchEntry, ageMs: safeAgeMs(now, watchEntry.addedAt) }  : null;
    const hotOut   = hotEntry   ? { ...hotEntry,   ageMs: safeAgeMs(now, hotEntry.promotedAt) } : null;
    const armedOut = armedEntry ? { ...armedEntry, ageMs: safeAgeMs(now, armedEntry.armedAt) }  : null;

    const pairState  = states[lookup]             ?? null;
    const snapMem    = snapshot?.memory?.[lookup] ?? null;
    const reserveEth = snapshot?.poolReserveEth?.[lookup] ?? null;

    if (!pairState && !snapMem) {
      if (pfCtx) {
        const pfFreshnessSec = safeAgeSec(now, pfCtx.updatedAt); // E13
        // E13: derivă calitatea MEREU din vârsta CURENTĂ, nu din `pfCtx.contextQuality` stocat — altfel un
        // updatedAt din viitor dă freshnessSec:null/LOW dar contextQuality:"fresh" (valoare veche), contradictoriu.
        const pfContextQuality = freshnessLabel(pfFreshnessSec !== null ? pfFreshnessSec * 1000 : null);
        const pfPayload = {
          found: true, pairAddress: addr,
          symbol: pfCtx.symbol,
          chain:  pfCtx.chain,
          preflightContext: pfCtx,
          // NF/U5 (R4): în fallback-ul pe pair_context (fără pair_states) provenance-ul se pierdea complet →
          // îl expunem explicit la top-level (liquidityStatus din pfCtx e deja plafonat pt. estimat V4).
          reserveUsd:       pfCtx.reserveUsd ?? null,
          reserveSource:    pfCtx.reserveSource ?? null,
          reserveEstimated: reserveEstimatedFlag(pfCtx.reserveSource),
          pipeline: { state: pfCtx.pipelineState ?? "NONE", watch: watchOut, hot: hotOut, armed: armedOut },
          contextQuality: pfContextQuality,
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
    // E13: clamp ≥0 — freshnessSec negativ (skew) intra în `combineConfidence` ca `< 45` → fals HIGH.
    const freshnessSec = pairState
      ? safeAgeSec(now, pairState.updatedAt)
      : safeAgeSec(now, snapshot?.savedAt ?? null);

    const mainPayload = {
      found: true, pairAddress: addr,
      symbol: data.symbol,
      chain:  normalizedChain ?? pfLookup.matchedChain ?? live.chain ?? pairState?.chain ?? watchOut?.chain ?? hotOut?.chain ?? armedOut?.chain ?? null,
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
          return checkedAtNum > 0 ? safeAgeSec(Date.now(), checkedAtNum) : null; // E13: clamp ≥0
        })(),
      } satisfies PairRiskSummary : null,
      riskCacheStatus: (() => {
        const r = pairState?.risk;
        if (!pairState) return "unavailable";
        if (!r) return "missing";
        const checkedAt = Number(r.checkedAt ?? 0);
        if (!checkedAt) return "unavailable";
        const ageSec = safeAgeSec(now, checkedAt); // E13
        if (ageSec === null) return "unavailable"; // ts corupt/viitor → NU „available/cached" fals
        if (ageSec > 6 * 3600) return "stale";
        return "available";
      })(),
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
      // NF/U5: proveniența rezervei — reserveUsd V4 (V4_STATE_LIQUIDITY) e estimat din virtual reserves
      // (poate supraestima concentrat), NU TVL confirmat. `reserveEstimated` = flag explicit pt. agent/UI.
      // NF/U5 (R4): cade pe pfCtx.reserveSource când nu avem pair_states (altfel provenance-ul dispare).
      reserveSource:      pairState?.reserveSource      ?? pfCtx?.reserveSource ?? null,
      reserveEstimated:   reserveEstimatedFlag(pairState?.reserveSource ?? pfCtx?.reserveSource), // tri-stare
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
      // E13: derivă MEREU calitatea din freshness-ul CURENT ales, nu din `pfCtx.contextQuality` stocat —
      // altfel un preflight context vechi (LOW/stale acum) purta eticheta "fresh" scrisă la momentul indexării.
      // Valoarea stocată rămâne expusă separat ca `storedContextQuality` pentru diagnostic, fără a decide honesty.
      contextQuality: pairState ? freshnessLabel(freshnessSec !== null ? freshnessSec * 1000 : null) : "snapshot_only",
      storedContextQuality: pfCtx?.contextQuality ?? null,
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
        const lc = (ctx.pfLifecycle ?? []).find(l =>
          l.pairAddress?.toLowerCase() === addr &&
          (!live.chain || (l.chain ?? "").toLowerCase() === live.chain),
        ) ?? null;
        if (!lc) return null;
        return {
          lastOutcome:   lc.lastOutcome,
          lastOutcomeAt: lc.lastOutcomeAt,
          ageSec:        safeAgeSec(now, lc.lastOutcomeAt), // E13: viitor serios → null, NU „0s = acum"
          fromState:     lc.fromState,
          reason:        lc.reason,
          // Was hardcoded `false` — a pair can have a past lifecycle outcome
          // and be back in the live pipeline (re-watched/re-armed since),
          // in which case this claimed "not active" incorrectly.
          candidateActive: pipelineState === "WATCHING" || pipelineState === "HOT" || pipelineState === "ARMED",
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
      // PH-7: sanitizează AICI, la sursă — excepția prinsă în report NU mai trece prin catch-ul sanitizat din
      // middleware (tp_pair_context o primește deja ca `report.errorMessage` și o pasează în mcpErr), iar demo-ul
      // public (app/demo/pair/.../page.tsx) o redă direct. `sanitizeToolError` logează real server-side, întoarce
      // mesaj generic → nici MCP nici demo nu scurg internals.
      ok: false, payload: {}, freshnessSec: null, confidence: "LOW",
      errorCode: "INTERNAL", errorMessage: sanitizeToolError(e),
    };
  }
}