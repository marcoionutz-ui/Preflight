import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readAllRedis, freshnessLabel, safeMinAge, readQuoteOracleHealth, readQuotePriceHealth, readSolanaIndexerStats } from "../redis-reader";
import { mcpResponse, mcpErr, ERR } from "../errors";

export function registerHealthCheck(server: McpServer, exposePerformance: boolean) {
  server.registerTool(
    "tp_health_check",
    {
      title: "Preflight Health Check",
      description: `Check if the worker is online and how fresh the Redis data is.

Returns worker version, data freshness for all Redis keys, and high-level stats:
total pairs tracked, phase distribution, active watch/hot/armed counts.

Use this first to verify the worker is running before calling other tools.`,
      inputSchema: {},
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

        const { now, states, watch, hot, armed, snapshot, pipelineCoverage, scannerStats } = ctx;
        const snapshotAge   = snapshot?.savedAt ? now - snapshot.savedAt : null;
        const stateVals     = Object.values(states);
        const newestStateAt = stateVals.length ? Math.max(...stateVals.map(s => s.updatedAt)) : null;
        const statesAge     = newestStateAt ? now - newestStateAt : null;

        function keyInfo(exists: boolean, ageMs: number | null) {
          return { exists, ageSec: ageMs !== null ? Math.round(ageMs / 1000) : null, quality: freshnessLabel(ageMs) };
        }

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
		  workerOnline:  !!snapshot && snapshotAge !== null && snapshotAge < 5 * 60_000,
		  workerVersion: snapshot?.version ?? null,
		  keys: {
			pair_states:     keyInfo(ctx.keyExists.pair_states,     statesAge),
			worker_snapshot: keyInfo(ctx.keyExists.worker_snapshot, snapshotAge),
			active_watch:    keyInfo(ctx.keyExists.active_watch,    safeMinAge(Object.values(watch).map(w => w.addedAt))),
			hot_candidates:  keyInfo(ctx.keyExists.hot_candidates,  safeMinAge(Object.values(hot).map(h => h.promotedAt))),
			armed_entries:   keyInfo(ctx.keyExists.armed_entries,   safeMinAge(Object.values(armed).map(a => a.armedAt))),
		  },
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
			  Object.entries(scannerStats.sourceByChain ?? {}).map(([chainId, s]: [string, any]) => [
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
			  Object.entries(scannerStats.chains ?? {}).map(([chainId, c]: [string, any]) => [
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
			dexscreenerHealth: scannerStats.dexscreener ?? null,
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
		  freshnessSec: statesAge !== null ? Math.round(statesAge / 1000) : null,
		  confidence:
			snapshotAge !== null && snapshotAge < 60_000     ? "HIGH" :
			snapshotAge !== null && snapshotAge < 3 * 60_000 ? "MEDIUM" :
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
			} catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
