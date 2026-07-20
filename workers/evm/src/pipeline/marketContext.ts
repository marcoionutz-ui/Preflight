/**
 * pipeline/marketContext.ts
 * B4d-2: market_context/market_regime NU se mai scriu de aici — MCP-ul le derivă la
 * read-time din pair_states-urile per-chain (vezi mcp/lib/mcp/redis-reader.ts), plus
 * heartbeat-ul WS per-chain (worker_runtime, scris în snapshots.ts). Rămâne doar scrierea
 * pipeline_events (chain-scoped).
 */

import type { Redis } from "ioredis";
import { pipelineEvents } from "../state/stores";
import { REDIS_KEYS } from "@preflight/schema";
import { partitionArrayByChain } from "../lib/redisArrays";

export async function writeDropsAndEvents(r: Redis): Promise<void> {
  const now = Date.now();
  // B4b: pipeline_events chain-scoped → o cheie per-chain.
  const freshEvents = pipelineEvents.filter(e => now - e.ts < 10 * 60_000);
  const pipe = r.pipeline();
  for (const { key, value } of partitionArrayByChain(REDIS_KEYS.pipelineEvents, freshEvents)) pipe.set(key, value, "EX", 600);
  await pipe.exec();
}
