import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readAllRedis, safeMinAge, readQuoteOracleHealth, readQuotePriceHealth, readSolanaIndexerStats } from "../redis-reader";
import { keyFreshness, aggregateKnownFreshness, completeOnKnownChains, isWsStreamStale, classifyWsSubs } from "../health-freshness";
import { mcpResponse, mcpErr, ERR, sanitizeToolError, PREFLIGHT_OUTPUT_SCHEMA } from "../errors";

export function registerHealthCheck(server: McpServer) {
  server.registerTool(
    "tp_health_check",
    {
      title: "Preflight Health Check",
      description: `Check if the worker is online and how fresh the Redis data is.

Returns worker version, data freshness for all Redis keys, and high-level stats:
total pairs tracked, phase distribution, active watch/hot/armed counts.

Use this first to verify the worker is running before calling other tools.`,
      inputSchema: {},
      outputSchema: PREFLIGHT_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const [ctx, quoteOracleHealth, quotePriceHealth] = await Promise.all([
          readAllRedis(),
          readQuoteOracleHealth(),
          readQuotePriceHealth(),
        ]);
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot, pipelineCoverage, scannerStats,
                snapshotSavedAtByChain, statesNewestAtByChain, keyPresentByChain, knownChains, liveChains, wsRuntimeByChain } = ctx;

        // E14 (varu R4): agregăm prospețimea pe cel mai SLAB chain CUNOSCUT (knownChains = orice amprentă worker),
        // NU pe max (care ascunde un chain mort) și NICI doar pe liveChains (un chain mort iese din live după ce
        // heartbeat-ul expiră → ar dispărea din calcul). Un chain cunoscut FĂRĂ snapshot valid → `complete=false`
        // → quality/agg = "unknown"/stale, nu ignorat.
        const snapAgg   = aggregateKnownFreshness(now, snapshotSavedAtByChain, knownChains);
        const statesAgg = aggregateKnownFreshness(now, statesNewestAtByChain,  knownChains);
        // Vârsta agregată intră în keyFreshness ca `null` când un chain cunoscut lipsește → quality "unknown".
        const snapAggAge   = snapAgg.complete   ? snapAgg.worstAgeMs   : null;
        const statesAge    = statesAgg.complete ? statesAgg.worstAgeMs : null;
        // worker „online"/„fresh" = toate chain-urile cunoscute au snapshot, iar cel mai slab e sub prag.
        const workerOnline = knownChains.length > 0 && snapAgg.complete && snapAgg.worstAgeMs !== null && snapAgg.worstAgeMs < 5 * 60_000;
        // E14 (varu R4 naming): cunoscute DAR fără heartbeat runtime proaspăt (120s). NU e „offline" absolut —
        // workerOnline tolerează snapshot până la 5min, deci un chain poate fi aici ȘI workerOnline=true 2-5min.
        // Nume explicit pe pragul de 120s ca să nu pară contradictoriu cu workerOnline (care e pe alt prag).
        const runtimeHeartbeatMissingChains = knownChains.filter(c => !liveChains.includes(c));
        // E14 (varu R4): completitudinea PER-CHEIE peste chain-urile cunoscute. Cheie lipsă pe un chain cunoscut →
        // quality "unknown" (nu fals „fresh" din snapshot global). pair_states e guvernată de proxy-ul snapshot din reader.
        const watchComplete = completeOnKnownChains(keyPresentByChain.active_watch,   knownChains);
        const hotComplete   = completeOnKnownChains(keyPresentByChain.hot_candidates, knownChains);
        const armedComplete = completeOnKnownChains(keyPresentByChain.armed_entries,  knownChains);

        // Praguri WS-liveness. WS_STREAM_STALE_SEC = tăcere considerată suspectă (per-chain ȘI per-sub).
        const WS_STREAM_STALE_SEC = 300;
        const WS_PONG_FRESH_SEC   = 90;

        // per-chain (peste TOATE chain-urile cunoscute, nu doar live) — vârstă snapshot + quality + live.
        type WsSubView = { confirmed: boolean; poolCount: number; lastMessageAgeSec: number | null; confirmedAgeSec: number | null } | null;
        type WsSubStateView = { v2: string | null; v3: string | null; v4: string | null };
        const perChainWorker: Record<string, { ageSec: number | null; quality: string; live: boolean; wsConnected: boolean; lastPongAgeSec: number | null; lastWsMessageAgeSec: number | null; subs: { v2: WsSubView; v3: WsSubView; v4: WsSubView } | null; subsState: WsSubStateView | null; subsSummary: string | null }> = {};
        // Part B: semnal SOFT la nivel de SUBSCRIPȚIE (chain:kind), din clasificarea CROSS-KIND — prinde
        // „V2 mort, V3/V4 curg" pe care agregatul per-chain (wsStreamStaleChains) îl ascunde.
        const wsStreamStaleSubs: string[] = [];
        for (const c of knownChains) {
          const sv    = snapshotSavedAtByChain[c];
          const ageMs = typeof sv === "number" && Number.isFinite(sv) && now - sv >= 0 ? now - sv : null;
          const wsrt  = wsRuntimeByChain[c];
          // Clasificare cross-kind: un kind stale e SUSPECTED_STALE doar dacă un FRATE livrează recent (data path
          // dovedit viu); dacă toți tac → QUIET_OR_UNKNOWN (onest); niciun kind activ → NO_ACTIVE_SUBSCRIPTIONS.
          const cls = classifyWsSubs(wsrt?.subs ?? null, { staleSec: WS_STREAM_STALE_SEC });
          for (const k of cls.suspectedStaleKinds) wsStreamStaleSubs.push(`${c}:${k}`);
          perChainWorker[c] = {
            ageSec:  ageMs !== null ? Math.round(ageMs / 1000) : null,
            quality: keyFreshness(true, ageMs).quality,
            live:    liveChains.includes(c),
            // D1 (health onestitate): pong = transport viu; lastWsMessage = data stream viu. wsConnected + pong
            // recent + lastWsMessageAgeSec mare = subscripții moarte tăcut (sau piață liniștită).
            wsConnected:         wsrt?.wsConnected ?? false,
            lastPongAgeSec:      wsrt?.lastPongAgeSec ?? null,
            lastWsMessageAgeSec: wsrt?.lastWsMessageAgeSec ?? null,
            // Part B: sănătatea RAW per-kind (confirmed + poolCount + vârste) + STAREA clasificată cross-kind
            // (subsState per kind + subsSummary rollup pe chain). `null` = worker vechi (fără wsSubs).
            subs:                wsrt?.subs ?? null,
            subsState:           wsrt?.subs ? cls.perKind : null,
            subsSummary:         wsrt?.subs ? cls.chain : null,
          };
        }
        // D1: chain conectat + transport viu (pong recent) DAR fără notificări de log de mult = data stream
        // POSIBIL mort (poate fi și piață liniștită) → semnal SOFT; vârstele exacte sunt în perChainWorker.
        // P3: un pong NECUNOSCUT (null) NU e dovadă de transport viu → nu raportăm stream-stale pe necunoscut.
        const wsStreamStaleChains = knownChains.filter(c =>
          isWsStreamStale(wsRuntimeByChain[c], WS_PONG_FRESH_SEC, WS_STREAM_STALE_SEC));

        // dexscreener.lastFetchAgeSec/last429AgeSec are baked in at scan
        // time (age-at-write), then cached in Redis for up to 5min — read
        // as-is they under-report age by however stale the snapshot is.
        // scannerAgeSec is added back on below so the reported age reflects
        // "now", not "when scan.ts wrote this".
        const scannerAgeSec = scannerStats
          ? Math.max(0, Math.round((now - scannerStats.savedAt) / 1000))
          : 0;
        const stateVals     = Object.values(states);

        const phases: Record<string, number> = {};
        const flowSummary = { buying: 0, selling: 0, neutral: 0, noData: 0 };
        for (const p of stateVals) {
          phases[p.phase] = (phases[p.phase] ?? 0) + 1;
          if (!p.flow.hasData)                    flowSummary.noData++;
          else if (p.flow.pressure === "BUYING")  flowSummary.buying++;
          else if (p.flow.pressure === "SELLING") flowSummary.selling++;
          else                                    flowSummary.neutral++;
        }

        const payload = {
		  // E14 (varu R4): online = există chain-uri cunoscute, TOATE au snapshot, iar cel mai SLAB e < 5min.
		  // Un chain cunoscut mort/lipsă → false (nu ascuns sub savedAt=max).
		  workerOnline,
		  workerVersion: snapshot?.version ?? null,
		  // E14 (varu R4): prospețimea agregată pe cel mai SLAB chain CUNOSCUT (un chain lipsă → "unknown").
		  // pair_states/worker_snapshot NU mai folosesc newest-wins (Base proaspăt masca BSC stale). watch/hot/
		  // armed poartă addedAt/... setate O DATĂ → quality = worker liveness agregat; newestEntry separat.
		  keys: {
			pair_states:     keyFreshness(ctx.keyExists.pair_states,     statesAge),
			worker_snapshot: keyFreshness(ctx.keyExists.worker_snapshot, snapAggAge),
			active_watch:    keyFreshness(ctx.keyExists.active_watch,    snapAggAge, safeMinAge(Object.values(watch).map(w => w.addedAt)),   watchComplete),
			hot_candidates:  keyFreshness(ctx.keyExists.hot_candidates,  snapAggAge, safeMinAge(Object.values(hot).map(h => h.promotedAt)),  hotComplete),
			armed_entries:   keyFreshness(ctx.keyExists.armed_entries,   snapAggAge, safeMinAge(Object.values(armed).map(a => a.armedAt)),   armedComplete),
		  },
		  // E14 (varu R4): transparență multichain. perChainWorker = vârsta+quality snapshot pt. FIECARE chain
		  // CUNOSCUT + dacă e live. knownChains/liveChains/runtimeHeartbeatMissingChains expuse explicit — un chain
		  // fără heartbeat runtime (120s) apare acolo, nu dispare. missingSnapshotChains = cunoscute fără snapshot valid.
		  perChainWorker,
		  knownChains,
		  liveChains,
		  runtimeHeartbeatMissingChains,
		  // D1: conectat dar data stream posibil mort (pong recent + fără notificări > prag). Vezi perChainWorker pt. vârste.
		  wsStreamStaleChains,
		  // Part B: același semnal la nivel de subscripție (chain:kind) — prinde „un tip a murit tăcut" pe care
		  // agregatul per-chain (wsStreamStaleChains) îl maschează dacă alt kind încă livrează. Vezi perChainWorker.subs.
		  wsStreamStaleSubs,
		  missingSnapshotChains: snapAgg.missing,
		  stats: {
			totalPairs:    stateVals.length || Object.keys(snapshot?.memory ?? {}).length,
			activeWatch:   Object.keys(watch).length,
			hotCandidates: Object.keys(hot).length,
			armedEntries:  Object.keys(armed).length,
			phases,
			flowSummary,
		  },
		  scannerStats: scannerStats ? {
			savedAgeSec:     Math.round((now - scannerStats.savedAt) / 1000),
			discoverySource: scannerStats.discoverySource ?? "auto",
			scan: {
			  durationMs:     scannerStats.scan?.durationMs     ?? null,
			  totalFetched:   scannerStats.scan?.totalFetched   ?? null,
			  processedPools: scannerStats.scan?.processedPools ?? null,
			},
			sourceByChain: Object.fromEntries(
			  Object.entries(scannerStats.sourceByChain).map(([chainId, s]) => [
				chainId,
				s.source === "INDEXER_PRIMARY" || s.source === "INDEXER_FORCED"
				  ? {
					  source:        s.source,
					  indexedCount:  s.indexedCount,
					  blocksBehind:  s.indexedHealth?.blocksBehind ?? null,
					  indexerStatus: s.indexedHealth?.status ?? null,
					  fallbackUsed:  false,
					}
				  : {
					  source:       s.source,
					  reason:       s.reason ?? null,
					  geckoCount:   s.geckoCount ?? null,
					  fallbackUsed: s.fallbackUsed ?? true,
					},
			  ])
			),
			geckoHealth: Object.fromEntries(
			  Object.entries(scannerStats.chains).map(([chainId, c]) => [
				chainId,
				c.status === "STANDBY_INDEXER_PRIMARY"
				  ? {
					  lastResultCount:  0,
					  emptyStreak:      0,
					  consecutiveEmpty: 0,
					  lastFetchAgeSec:  null,
					  last429AgeSec:    c.last429At ? Math.round((now - c.last429At) / 1000) : null,
					  status:           "STANDBY_INDEXER_PRIMARY",
					}
				  : {
					  lastResultCount:  c.lastResultCount,
					  emptyStreak:      c.emptyStreak,
					  consecutiveEmpty: c.consecutiveEmpty ?? c.emptyStreak ?? 0,
					  lastFetchAgeSec:  c.lastFetchAt ? Math.round((now - c.lastFetchAt) / 1000) : null,
					  last429AgeSec:    c.last429At   ? Math.round((now - c.last429At)   / 1000) : null,
					  status:           c.status ?? (
						c.emptyStreak >= 3 ? "DEGRADED" :
						c.emptyStreak >= 1 ? "DEGRADED" :
						"OK"
					  ),
					},
			  ])
			),
			dexscreenerHealth: scannerStats.dexscreener ? {
			  ...scannerStats.dexscreener,
			  lastFetchAgeSec: scannerStats.dexscreener.lastFetchAgeSec === null
				? null
				: scannerStats.dexscreener.lastFetchAgeSec + scannerAgeSec,
			  last429AgeSec: scannerStats.dexscreener.last429AgeSec === null
				? null
				: scannerStats.dexscreener.last429AgeSec + scannerAgeSec,
			} : null,
		  } : null,
		  quoteOracleHealth: Object.keys(quoteOracleHealth).length ? quoteOracleHealth : null,
		  quotePriceHealth:  Object.keys(quotePriceHealth).length  ? quotePriceHealth  : null,
		  solana: await readSolanaIndexerStats(now).catch(() => null),
		  pipelineCoverage: pipelineCoverage ? {
			savedAgeSec: Math.round((now - pipelineCoverage.savedAt) / 1000),
			chains: Object.fromEntries(
			  Object.entries(pipelineCoverage.chains).map(([chainId, c]) => [
				chainId,
				{
				  trackedPairs:   c.trackedPairs,
				  observedMovers: c.observedMovers,
				  pipeline:       c.pipeline,
				  ws:             c.ws,
				  moverCoverage:  c.observedMoverCoverage,
				  topNotWatched:  c.topMoversNotWatched.slice(0, 3),
				},
			  ])
			),
		  } : null,
		};

		const withFlow = flowSummary.buying + flowSummary.selling + flowSummary.neutral;
		const wsFlowQuality: "present" | "partial" | "absent" =
		  stateVals.length === 0 ? "absent" :
		  withFlow === 0         ? "absent" :
		  withFlow < stateVals.length ? "partial" :
		  "present";

		return mcpResponse({
		  text: JSON.stringify(payload, null, 2),
		  data: payload,
		  freshnessSec: statesAge !== null ? Math.round(statesAge / 1000) : null,
		  // E14 (varu R4): confidence din prospețimea celui mai SLAB chain CUNOSCUT (nu max). Un chain cunoscut
		  // lipsă/stale (snapAgg.complete=false → snapAggAge=null) → LOW.
		  confidence:
			snapAggAge !== null && snapAggAge < 60_000     ? "HIGH" :
			snapAggAge !== null && snapAggAge < 3 * 60_000 ? "MEDIUM" :
			"LOW",
		  dataQuality: {
			wsFlow: wsFlowQuality,
		  },
		  evidence: {
			workerOnline:  payload.workerOnline,
			totalPairs:    payload.stats.totalPairs,
			activeWatch:   payload.stats.activeWatch,
			hotCandidates: payload.stats.hotCandidates,
			armedEntries:  payload.stats.armedEntries,
		  },
		});
			} catch (e) { return mcpErr(ERR.INTERNAL, sanitizeToolError(e)); }
    },
  );
}
