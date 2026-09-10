/**
 * lib/health/heartbeatRealRedis.test.ts — PH-12 12.4 leaf 5 DOVADĂ PE REDIS REAL (end-to-end, nu fake injectat).
 *
 * Doctrina „verde pe primitiva pură ≠ producție cablată": suita pură (heartbeat.test.ts) și cea cu Redis injectat
 * (buildHealthSignals.test.ts) dovedesc clasificarea + fluxul, DAR nu ating niciodată un Redis adevărat. Aici legăm
 * contractul PE SÂRMĂ real: publisher (`buildHeartbeatWrite` → `SET key value EX ttl`) → Redis REAL → reader
 * (`buildHealthSignals` cu client REAL) → `computeLiveness`. Verificăm exact ce a cerut cgpt pe infra reală:
 *   SET EX + TTL efectiv pe cheie · round-trip `parseHeartbeat` · fresh→stale→missing · payload CORUPT → missing ·
 *   Redis-jos (client rupt) → unavailable/down.
 *
 * GATE DE SIGURANȚĂ (ca `quotaAtomic.integration.ts`): rulează DOAR pe `REDIS_URL` LOOPBACK + `QUOTA_INTEGRATION_ALLOW=1`
 * (opt-in explicit). Altfel SKIP curat (exit 0) — nu atinge niciun Redis. FĂRĂ URL implicit, FĂRĂ fallback pe
 * `REDIS_PRIVATE_URL`, și skip-ul NU afișează valoarea URL-ului (poate purta credențiale) — nu poate nimeri accidental
 * un Redis de staging/prod chiar dacă `REDIS_URL` există în mediu. Rămâne în lanțul `npm test` (skip → satisface
 * gate-14) ȘI la finalul `test:integration` (CI setează loopback + opt-in acolo → rulează REAL). Cheile folosite sunt
 * cele de PRODUCȚIE (`serviceHeartbeatKey`) — le curățăm (DEL) la intrare ȘI la ieșire (fără reziduu pe Redis-ul local).
 *
 * WS e IRELEVANT aici (chains: []): injectăm stub-uri triviale pentru primitivele WS, ca proba să nu depindă de
 * `../mcp/health-freshness` — probăm STRICT calea serviciilor (MGET separat pe cheile hb:) pe Redis real.
 */
import Redis from "ioredis";
import {
  buildHeartbeatWrite, serializeHeartbeat, parseHeartbeat, serviceHeartbeatKey,
  HEARTBEAT_TTL_SEC, type ServiceRole,
} from "@preflight/schema";
import { buildHealthSignals, type HealthRedisLike, type BuildHealthDeps } from "./buildHealthSignals";
import { computeLiveness, HEALTH_SCOPE } from "./liveness";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const ROLE: ServiceRole = "indexer-evm";
const OTHER: ServiceRole = "solana-worker";

// SIGURANȚĂ (cgpt leaf 5): rulează DOAR pe loopback + opt-in explicit — NICIODATĂ pe un Redis de staging/prod dacă
// `REDIS_URL` s-ar întâmpla să existe în mediu. FĂRĂ fallback pe `REDIS_PRIVATE_URL`, FĂRĂ URL implicit. Skip-ul NU
// afișează niciodată valoarea URL-ului (poate purta credențiale). Efect: în `npm test` (fără opt-in) → SKIP curat
// (rămâne cablat pt. gate-14), iar în `test:integration` (CI setează loopback + QUOTA_INTEGRATION_ALLOW=1) → REAL.
const REDIS_URL = process.env.REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(REDIS_URL);
const OPTED_IN = process.env.QUOTA_INTEGRATION_ALLOW === "1";

// Deps buildHealthSignals cu chains:[] → snapshot/runtime/WS NU se ating; stub-uri triviale (WS irelevant la heartbeat).
function deps(redis: HealthRedisLike | null, expectIndexer: boolean, expectSolana: boolean): BuildHealthDeps {
  return {
    redis, chains: [], wsExpected: false, now: Date.now(),
    snapshotKey: (c) => `snap:${c}`, runtimeKey: (c) => `rt:${c}`,
    resolveWsRuntime: () => null,
    classifyWsSubs: () => ({ suspectedStaleKinds: [] }),
    normalizeChain: (s) => s.trim().toLowerCase(),
    wsStaleSec: 300, runtimeMaxAgeMs: 120_000, futureSkewMs: 30_000, pingTimeoutMs: 1_000,
    serviceExpectations: { "indexer-evm": expectIndexer, "solana-worker": expectSolana } as Record<ServiceRole, boolean>,
    serviceHeartbeatKey,
  };
}
const stateOf = (sig: Awaited<ReturnType<typeof buildHealthSignals>>, role: ServiceRole) =>
  sig.services?.find((s) => s.service === role)?.state;

async function main(): Promise<void> {
  console.log("PH-12 12.4 leaf 5 — heartbeat REAL Redis (end-to-end wire proof)");

  // ── Gate de SIGURANȚĂ: DOAR loopback + opt-in explicit; altfel SKIP curat (exit 0) — nu atingem niciun Redis. ──
  if (!LOOPBACK || !OPTED_IN) {
    console.log("  ⚠️  SKIP — cere REDIS_URL loopback + QUOTA_INTEGRATION_ALLOW=1 (dovada rulează în `test:integration` / dev cu Redis local).");
    console.log("\n0 passed, 0 failed (skip)");
    return;
  }
  // Opt-in confirmat pe loopback → conectăm MĂRGINIT (fără retry infinit / offline-queue). Dacă Redis chiar lipsește
  // acum, eșuăm CLAR (exit 1) — nu crash cu stack ioredis, dar nici skip tăcut (ai declarat opt-in ⇒ Redis trebuie sus).
  const client = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null, enableOfflineQueue: false });
  client.on("error", () => { /* decidem pe connect()/ping(); nu propagăm event-ul ca uncaught */ });
  try {
    await client.connect();
    await client.ping();
  } catch {
    console.log("  ✗ opt-in confirmat (loopback + QUOTA_INTEGRATION_ALLOW=1) DAR Redis nu răspunde la loopback — pornește un Redis local (`redis-server`) și reia.");
    try { client.disconnect(); } catch { /* noop */ }
    process.exit(1);
  }

  const key = serviceHeartbeatKey(ROLE);
  const otherKey = serviceHeartbeatKey(OTHER);
  const real: HealthRedisLike = { ping: () => client.ping(), mget: (...k: string[]) => client.mget(...k) };

  try {
    await client.del(key, otherKey); // pornim curat

    // ── 1. SET EX real: publisher scrie exact ce dă buildHeartbeatWrite; verificăm valoarea, TTL-ul efectiv, round-trip. ──
    const t0 = Date.now();
    const w = buildHeartbeatWrite(ROLE, t0);
    await client.set(w.key, w.value, "EX", w.ttlSec);
    check("1. ⭐⭐⭐ SET key EX pe cheia de producție (buildHeartbeatWrite) — cheia există în Redis", (await client.exists(w.key)) === 1);
    check("2. ⭐⭐ valoarea din Redis === serializeHeartbeat(role, now) (byte-exact pe sârmă)", (await client.get(w.key)) === serializeHeartbeat(ROLE, t0));
    const ttl = await client.ttl(w.key);
    check(`3. ⭐⭐⭐ TTL efectiv pe cheie ≈ ${HEARTBEAT_TTL_SEC}s (obținut ${ttl}s) — expiră singură fără DEL la shutdown`, ttl > HEARTBEAT_TTL_SEC - 10 && ttl <= HEARTBEAT_TTL_SEC);
    const rt = parseHeartbeat(await client.get(w.key), ROLE);
    check("4. ⭐⭐ round-trip: parseHeartbeat(valoarea din Redis) === payload cu updated_at intact", rt !== null && rt.updated_at === t0 && rt.service === ROLE);

    // ── 2. Reader REAL vede `ok`: buildHealthSignals cu client REAL citește cheia hb: și clasifică fresh. ──
    {
      const sig = await buildHealthSignals(deps(real, true, false));
      check("5. ⭐⭐⭐ reader REAL (buildHealthSignals) citește heartbeat-ul proaspăt → indexer-evm 'ok'", stateOf(sig, ROLE) === "ok");
      check("6. ⭐⭐⭐ solana-worker NE-așteptat → 'disabled' (nu-l citim, nu penalizăm)", stateOf(sig, OTHER) === "disabled");
      const rep = computeLiveness(sig);
      check("7. ⭐⭐ computeLiveness: checks.services.ok + scope EXTINS cu indexer-evm (real)", rep.checks.services?.ok === true && rep.scope.includes("indexer-evm") && rep.scope.startsWith(HEALTH_SCOPE));
    }

    // ── 3. STALE real: rescriem cheia cu updated_at vechi (120s > fresh 90s), cheia încă vie (SET EX). ──
    {
      const old = Date.now() - 120_000;
      await client.set(key, serializeHeartbeat(ROLE, old), "EX", HEARTBEAT_TTL_SEC);
      const sig = await buildHealthSignals(deps(real, true, false));
      check("8. ⭐⭐⭐ heartbeat vechi (120s, cheie vie) → reader real 'stale' (banda [fresh,ttl))", stateOf(sig, ROLE) === "stale");
      check("9. ⭐⭐ un serviciu stale → computeLiveness degraded (web viu, 200)", (() => { const r = computeLiveness(sig); return r.status === "degraded" && r.httpStatus === 200 && r.checks.services?.ok === false; })());
    }

    // ── 4. CORUPT real: payload ne-JSON pe cheie → reader 'missing' (fail-closed), NU 'ok' fals. ──
    {
      await client.set(key, "not-a-heartbeat", "EX", HEARTBEAT_TTL_SEC);
      const sig = await buildHealthSignals(deps(real, true, false));
      check("10. ⭐⭐⭐ payload CORUPT pe cheie → reader real 'missing' (fail-closed, nu 'ok')", stateOf(sig, ROLE) === "missing");
    }

    // ── 5. MISSING real: DEL cheia (simulează expirarea TTL fără a aștepta 300s) → 'missing'. ──
    {
      await client.del(key);
      const sig = await buildHealthSignals(deps(real, true, false));
      check("11. ⭐⭐⭐ cheie ștearsă (≡ expirare TTL) → reader real 'missing'", stateOf(sig, ROLE) === "missing");
      check("12. ⭐⭐ missing pe serviciu așteptat → degraded (nu ascundem un serviciu mort)", computeLiveness(sig).status === "degraded");
    }

    // ── 6. REDIS-JOS real: client rupt (port mort) → ping/mget aruncă → unavailable + down/503. ──
    {
      const dead = new Redis("redis://127.0.0.1:1", { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500, retryStrategy: () => null, enableOfflineQueue: false });
      dead.on("error", () => { /* așteptat */ });
      const deadLike: HealthRedisLike = { ping: () => dead.ping(), mget: (...k: string[]) => dead.mget(...k) };
      const sig = await buildHealthSignals(deps(deadLike, true, false));
      check("13. ⭐⭐⭐ Redis JOS (client real rupt) → redisReachable false + indexer-evm 'unavailable'", sig.redisReachable === false && stateOf(sig, ROLE) === "unavailable");
      const rep = computeLiveness(sig);
      check("14. ⭐⭐ Redis jos → computeLiveness down/503, checks.services prezent (down domină)", rep.status === "down" && rep.httpStatus === 503 && rep.checks.services?.ok === false);
      try { dead.disconnect(); } catch { /* noop */ }
    }
  } finally {
    try { await client.del(key, otherKey); } catch { /* noop */ } // nu lăsăm reziduu pe Redis-ul de dev
    try { client.disconnect(); } catch { /* noop */ }
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main();
