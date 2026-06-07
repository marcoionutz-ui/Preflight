import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readAllRedis, freshnessLabel, safeMinAge } from "../redis-reader";
import { mcpOk, mcpErr, ERR } from "../errors";

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
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed, snapshot } = ctx;
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

        return mcpOk({
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
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
