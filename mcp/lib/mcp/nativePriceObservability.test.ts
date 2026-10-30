import assert from "node:assert/strict";
import { queueWorkerRuntime } from "../../../workers/evm/src/pipeline/workerRuntime";
import { __setNativePriceForTest } from "../../../workers/evm/src/infra/nativePrice";
import { recordNoPriceDrop } from "../../../workers/evm/src/infra/noPrice";
import { normalizeNativePriceObservation } from "./nativePriceObservation";
import { WorkerRuntimeSchema } from "./schemas/evm";
import { readAllRedis } from "./redis-reader";
import { registerHealthCheck } from "./tools/tp_health_check";
import { bindRoleCaps } from "./profileCaps";

let passed = 0;
function check(name: string, f: () => void): void { f(); passed++; console.log("  OK " + name); }
const now = 1_800_000_000_000;
const map = new Map<string, string>();
const sink = { set(key: string, raw: string, mode: "EX", ttl: number) { assert.equal(mode, "EX"); assert.equal(ttl, 120); map.set(key, raw); } };
const redis = { async mget(...keys: string[]) { return keys.map(k => map.get(k) ?? null); } } as NonNullable<Parameters<typeof readAllRedis>[0]>;
__setNativePriceForTest("ETH", 2500, now - 5000);
__setNativePriceForTest("BNB", 600, now);
recordNoPriceDrop("base", 0, () => {}); recordNoPriceDrop("base", 1, () => {});
const written = queueWorkerRuntime(sink, { chain: "base", wsConnected: true, updatedAt: now }, 120);
const key = [...map.keys()][0];
const valid = written.nativePrice!;
check("M1 normalizer rejects bad leaves, no coercion or extra fields", () => {
  for (const raw of [undefined, null, [], 7, { ...valid, symbol: "BNB" }, { ...valid, value: 0 }, { ...valid, value: Infinity }, { ...valid, ageSec: -1 }, { ...valid, sourceAgeSec: "0" }, { ...valid, observedAt: now + 1 }, { ...valid, droppedNoPrice: 0.5 }]) assert.equal(normalizeNativePriceObservation(raw, "base", now), null);
  assert.deepEqual(normalizeNativePriceObservation({ ...valid, rpc: "never publish" }, "base", now), valid);
  assert.equal(normalizeNativePriceObservation(valid, "polygon", now), null);
});
check("M2 malformed leaf does not invalidate parent WS schema", () => { assert(WorkerRuntimeSchema.safeParse({ ...written, nativePrice: 7 }).success); });
check("M3 caps propagate canonical price requirement and provenance", () => {
  const caps = bindRoleCaps(); const validate = caps.validateService["worker-evm"]!;
  const env = { NODE_ENV: "production", PREFLIGHT_MODE: "LIVE", ENABLED_CHAINS: "base", REDIS_URL: "redis://localhost:6379", ALCHEMY_BASE_WS: "wss://base.example" };
  const v = validate(env); assert.equal(v.ok, false);
  assert(v.problems.some(p => p.name === "ETH_PRICE_RPC_GROUP"));
  for (const p of v.problems) { assert(caps.envKeys["worker-evm"]!.includes(p.name)); assert.deepEqual(Object.keys(p).sort(), ["kind", "name"]); }
  assert.equal(validate({ ...env, ALCHEMY_BASE_RPC: "https://base.example" }).ok, true);
});
async function main(): Promise<void> {
  const ctx = await readAllRedis(redis, now + 1000);
  if (!ctx) throw new Error("reader unexpectedly unavailable");
  check("M4 actual publisher -> Redis double -> actual reader preserves observation", () => {
    assert(ctx); assert.deepEqual(ctx.wsRuntimeByChain.base.nativePrice, valid); assert.equal(ctx.wsRuntimeByChain.base.wsConnected, true);
    assert.equal(ctx.wsRuntimeByChain.base.nativePrice!.ageSec, 5); // age at observedAt, not at request time
  });
  let handler: () => Promise<unknown> = async () => { throw new Error("tool handler not registered"); };
  const server = { registerTool(name: string, _config: unknown, run: () => Promise<unknown>) { assert.equal(name, "tp_health_check"); handler = run; } } as unknown as Parameters<typeof registerHealthCheck>[0];
  registerHealthCheck(server, {
    readAllRedis: () => readAllRedis(redis, now + 1000),
    readQuoteOracleHealth: async () => ({}), readQuotePriceHealth: async () => ({}),
    readSolanaIndexerStats: async () => ({ health: { workerOnline: false, slot: null, cursor: null, blocksBehind: null, status: "OFFLINE", indexerVersion: null, ageSec: null }, indexedPools: 0, indexedLaunches: 0, trackedPricePools: 0, moversStatus: "EMPTY", moversCount: 0, moversComputedAgeSec: null, coverage: "SAMPLED" }),
  });
  const result = await handler() as { structuredContent?: { data?: { perChainWorker?: Record<string, { nativePrice: unknown }> } }; isError?: boolean };
  check("M5 actual tool handler exposes exact observation", () => { assert.notEqual(result.isError, true); assert.deepEqual(result.structuredContent?.data?.perChainWorker?.base?.nativePrice, valid); });
  for (const bad of [7, { ...valid, observedAt: now + 1 }, { ...valid, value: -1 }]) {
    map.set(key, JSON.stringify({ ...written, nativePrice: bad })); const c = await readAllRedis(redis, now);
    check("M6 bad price preserves healthy WS", () => { assert.equal(c?.wsRuntimeByChain.base.nativePrice, null); assert.equal(c?.wsRuntimeByChain.base.wsConnected, true); });
  }
  const legacy = { chain: "base", wsConnected: true, updatedAt: now };
  map.set(key, JSON.stringify(legacy)); const old = await readAllRedis(redis, now);
  check("M7 old worker remains compatible", () => { assert.equal(old?.wsRuntimeByChain.base.nativePrice, null); assert.equal(old?.wsRuntimeByChain.base.wsConnected, true); });
  map.set(key, JSON.stringify(written)); const stale = await readAllRedis(redis, now + 120_001);
  check("M8 stale parent cannot expose price", () => assert.equal(stale?.wsRuntimeByChain.base, undefined));
  map.set(key, JSON.stringify({ ...written, chain: "bsc" })); const crossed = await readAllRedis(redis, now);
  check("M9 key chain remains authoritative", () => assert.equal(crossed?.wsRuntimeByChain.base, undefined));
  map.set(key, JSON.stringify({ ...written, nativePrice: { ...valid, value: null } })); const missing = await readAllRedis(redis, now);
  check("M10 null is unavailable, never an invented price", () => assert.equal(missing?.wsRuntimeByChain.base.nativePrice?.value, null));
  console.log(passed + " passed, 0 failed (P1 MCP)");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
