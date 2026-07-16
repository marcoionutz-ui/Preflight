import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis } from "../redis-reader";
import type { PairState, MemoryEntry } from "../types";
import { mcpResponse, mcpErr, ERR } from "../errors";

export function registerWorkerSnapshot(server: McpServer, exposePerformance: boolean) {
  server.registerTool(
    "tp_worker_snapshot",
    {
      title: "Preflight Worker Snapshot",
      description: `Query the worker's full pair memory with filters and pagination.

Args:
  phase (optional): TRENDING, SECOND_WAVE, RECOVERING, PUMPING, ZOMBIE, DEAD
  flow_pressure (optional): BUYING, SELLING, NEUTRAL
  chain (optional): base, arbitrum
  min_seen_count (default 0), limit (default 20, max 100), offset (default 0)`,
      inputSchema: {
        phase:          z.string().optional(),
        flow_pressure:  z.string().optional(),
        chain:          z.string().optional(),
        min_seen_count: z.number().int().min(0).default(0),
        limit:          z.number().int().min(1).max(100).default(20),
        offset:         z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ phase, flow_pressure, chain, min_seen_count, limit, offset }: {
      phase?: string; flow_pressure?: string; chain?: string;
      min_seen_count: number; limit: number; offset: number;
    }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, snapshot } = ctx;
        const allAddrs = new Set([...Object.keys(states), ...Object.keys(snapshot?.memory ?? {})]);

        let pairs = [...allAddrs].map(addr => {
          const data = states[addr] ?? snapshot?.memory?.[addr];
          return data ? { addr, data } : null;
        }).filter((x): x is { addr: string; data: PairState | MemoryEntry } => x !== null);

        if (phase)              pairs = pairs.filter(p => p.data.phase === phase.toUpperCase());
        if (flow_pressure)      pairs = pairs.filter(p => states[p.addr]?.flow?.pressure === flow_pressure.toUpperCase());
        if (min_seen_count > 0) pairs = pairs.filter(p => p.data.seenCount >= min_seen_count);
        // Bug: this used to filter on tokenAddress?.startsWith(chain) — token
        // addresses start with "0x", never with a chain name, so the filter
        // silently dropped almost everything whenever `chain` was passed.
        if (chain) {
          const wantedChain = chain === "eth" ? "ethereum" : chain.toLowerCase();
          pairs = pairs.filter(p => p.data.chain?.toLowerCase() === wantedChain);
        }

        const total     = pairs.length;
        const paginated = pairs.slice(offset, offset + limit);

        const snapshotFreshnessSec = snapshot?.savedAt ? Math.round((now - snapshot.savedAt) / 1000) : null;

        return mcpResponse({
          text: JSON.stringify({
            total, count: paginated.length, offset,
            has_more: total > offset + paginated.length,
            pairs: paginated.map(({ addr, data }) => ({
              pairAddress: addr, symbol: data.symbol, phase: data.phase,
              seenCount: data.seenCount, currentPrice: data.currentPrice,
              dexType:    states[addr]?.dexType    ?? null,
              reserveUsd: states[addr]?.reserveUsd ?? null,
              liqStatus:  states[addr]?.liqStatus  ?? null,
              flow:       states[addr]?.flow ?? null,
              history: exposePerformance ? {
                totalEntries:      data.totalEntries,
                wins24h:           data.wins24h,
                losses24h:         data.losses24h,
                badExits24h:       data.badExits24h,
                consecutiveLosses: data.consecutiveLosses,
              } : undefined,
              updatedAt: states[addr]?.updatedAt ?? null,
            })),
            snapshotAgeSec: snapshotFreshnessSec,
            workerVersion:  snapshot?.version ?? null,
          }, null, 2),
          freshnessSec: snapshotFreshnessSec,
          confidence:
            snapshotFreshnessSec !== null && snapshotFreshnessSec < 60  ? "HIGH" :
            snapshotFreshnessSec !== null && snapshotFreshnessSec < 180 ? "MEDIUM" :
            "LOW",
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
