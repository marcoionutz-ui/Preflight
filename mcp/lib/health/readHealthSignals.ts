/**
 * lib/health/readHealthSignals.ts — PH-13 (wiring Redis + env pentru semnalele de liveness).
 *
 * THIN: rezolvă clientul Redis, cheile și lista de chain-uri AȘTEPTATE din env, apoi delegă asamblarea PURĂ lui
 * `buildHealthSignals` (frunză testabilă). Endpoint-ul `/api/health` e neautentificat + poll-uit des, deci citim
 * mărginit: worker snapshot (freshness worker) + worker runtime (WS-liveness) pe chain-urile așteptate (2 MGET-uri,
 * sau un PING bounded când lista e goală) PLUS — 12.4 leaf 4 — un MGET CONDIȚIONAL pentru heartbeat-urile serviciilor
 * AȘTEPTATE (doar dacă vreun flag `HEALTH_EXPECT_*` e „1"; altfel zero comenzi în plus). Reutilizăm primitivele PURE
 * D1c: `resolveWsRuntime` + `classifyWsSubs`.
 *
 * CHAIN COMPLETENESS (cgpt #1): chain-urile AȘTEPTATE vin din env (`HEALTH_EXPECTED_CHAINS` → `ENABLED_CHAINS` →
 * `"base,arbitrum"`), NU din ce a supraviețuit în Redis. WS TRUTHFULNESS (cgpt #2): starea WS per chain via
 * `deriveWsState`. EDGE: lista goală → PING bounded (nu MGET fără chei) → `redisReachable` onest, worker `degraded`.
 */
import { getRedis } from "../db/redis";
import { REDIS_KEYS, PREFLIGHT_EVM_CHAINS, normalizeChainId, serviceHeartbeatKey } from "@preflight/schema";
import { resolveWsRuntime, classifyWsSubs } from "../mcp/health-freshness";
import { parseExpectedChains, type HealthSignals } from "./liveness";
import { resolveServiceExpectations } from "./heartbeat";
import { buildHealthSignals, type HealthRedisLike } from "./buildHealthSignals";

const WS_STALE_SEC       = 300;      // subscripție tăcută mai mult de atât (cu frate viu) → suspectată stale
const RUNTIME_MAX_AGE_MS = 120_000;  // worker_runtime mai vechi = worker mort → ignorat
const FUTURE_SKEW_MS     = 30_000;
const PING_TIMEOUT_MS    = 1_000;    // PING bounded pentru cazul „fără chain-uri așteptate"

/** Lista de chain-uri AȘTEPTATE: env dedicat → env-ul worker-ului (ENABLED_CHAINS) → default. Aliniat cu worker-ul. */
function expectedChains(): string[] {
  const raw = process.env.HEALTH_EXPECTED_CHAINS ?? process.env.ENABLED_CHAINS ?? "base,arbitrum";
  return parseExpectedChains(raw, PREFLIGHT_EVM_CHAINS, normalizeChainId);
}

/** WS așteptat? `HEALTH_WS_ENABLED=0` dezactivează evaluarea WS (mode scan-only) → wsState `disabled`, fără penalizare. */
function wsExpectedFromEnv(): boolean {
  return process.env.HEALTH_WS_ENABLED !== "0";
}

export async function readHealthSignals(): Promise<HealthSignals> {
  return buildHealthSignals({
    redis:            getRedis() as HealthRedisLike | null,
    chains:           expectedChains(),
    wsExpected:       wsExpectedFromEnv(),
    now:              Date.now(),
    snapshotKey:      (c) => REDIS_KEYS.workerSnapshot(c),
    runtimeKey:       (c) => REDIS_KEYS.workerRuntime(c),
    resolveWsRuntime,
    classifyWsSubs,
    normalizeChain:   normalizeChainId,
    wsStaleSec:       WS_STALE_SEC,
    runtimeMaxAgeMs:  RUNTIME_MAX_AGE_MS,
    futureSkewMs:     FUTURE_SKEW_MS,
    pingTimeoutMs:    PING_TIMEOUT_MS,
    // PH-12 12.4 leaf 4: așteptarea per serviciu din env (fail-closed byte-exact „1"), cheia partajată din schema.
    serviceExpectations: resolveServiceExpectations(process.env),
    serviceHeartbeatKey,
  });
}
