/**
 * lib/health/buildHealthSignals.test.ts — PH-13 (fluxul REAL de citire, nu doar clasificatorul pur).
 * Injectează un Redis fals + primitivele WS, verificând: edge-ul „fără chain-uri așteptate" (PING bounded → NU MGET
 * fără chei → redisReachable onest, worker degraded, NU „down"), fluxul normal, chain lipsă, eroare MGET, WS stale.
 */
import { buildHealthSignals, type HealthRedisLike, type BuildHealthDeps } from "./buildHealthSignals";
import { computeLiveness } from "./liveness";
import type { WsRuntimeRaw, WsRuntimeEntry, WsSubMap, WsSubKind } from "../mcp/health-freshness";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const NOW = 1_700_000_000_000;
const norm = (s: string) => s.trim().toLowerCase();

// resolveWsRuntime fals: respectă chain-guard-ul + citește wsConnected/pong/subs din raw.
const fakeResolve = (raw: WsRuntimeRaw, keyChain: string, now: number): WsRuntimeEntry | null => {
  if (norm(String(raw.chain ?? "")) !== keyChain) return null;
  return {
    updatedAt:           now,
    wsConnected:         raw.wsConnected === true,
    lastPongAgeSec:      typeof raw.lastPongAgeSec === "number" ? raw.lastPongAgeSec : null,
    lastWsMessageAgeSec: null,
    subs:                (raw.wsSubs as WsSubMap | undefined) ?? null,
  };
};
// classifyWsSubs fals: dacă subs există → un kind suspectat stale (pt. testul WS stale).
const fakeClassify = (subs: WsSubMap | null): { suspectedStaleKinds: WsSubKind[] } =>
  ({ suspectedStaleKinds: subs ? (["v2"] as WsSubKind[]) : [] });

function fakeRedis(over: Partial<HealthRedisLike> = {}): HealthRedisLike {
  return {
    ping: over.ping ?? (async () => "PONG"),
    mget: over.mget ?? (async () => []),
  };
}

function baseDeps(over: Partial<BuildHealthDeps>): BuildHealthDeps {
  return {
    redis:            fakeRedis(),
    chains:           [],
    wsExpected:       true,
    now:              NOW,
    snapshotKey:      (c) => `snap:${c}`,
    runtimeKey:       (c) => `rt:${c}`,
    resolveWsRuntime: fakeResolve,
    classifyWsSubs:   fakeClassify,
    normalizeChain:   norm,
    wsStaleSec:       300,
    runtimeMaxAgeMs:  120_000,
    futureSkewMs:     30_000,
    pingTimeoutMs:    1_000,
    ...over,
  };
}

// mget care distinge snapshot (snap:) de runtime (rt:) după prefixul primei chei.
function twoWayMget(snap: Record<string, string | null>, rt: Record<string, string | null>) {
  return async (...keys: string[]): Promise<(string | null)[]> => {
    const isSnap = keys[0]?.startsWith("snap:");
    return keys.map(k => (isSnap ? snap[k] : rt[k]) ?? null);
  };
}

async function main(): Promise<void> {
console.log("PH-13 — buildHealthSignals (flux real, Redis injectat)");

// ── A. fără chain-uri așteptate + PING ok → redisReachable true, perChain [], degraded (NU down) ──
{
  const sig = await buildHealthSignals(baseDeps({ chains: [], redis: fakeRedis({ ping: async () => "PONG" }) }));
  check("1. ⭐⭐⭐ chains [] + PING ok → redisReachable true, expected/observed/perChain goale",
    sig.redisReachable === true && sig.expectedChains.length === 0 && sig.observedChains.length === 0 && sig.perChain.length === 0);
  const rep = computeLiveness(sig);
  check("2. ⭐⭐⭐ computeLiveness: worker degraded + redis reachable (NU down), HTTP 200",
    rep.status === "degraded" && rep.httpStatus === 200 && rep.checks.redis.ok === true && rep.checks.worker.ok === false);
  check("3. ⭐⭐ ws check = 'no expected chains configured' (NU 'ws healthy on ')",
    rep.checks.ws.detail === "no expected chains configured" && !/ws healthy/.test(rep.checks.ws.detail));
  check("4. ⭐ strict pe degraded → 503 chiar și cu lista goală", computeLiveness(sig, { strict: true }).httpStatus === 503);
}

// ── B. fără chain-uri + PING aruncă → redisReachable false → down/503 ──────────
{
  const sig = await buildHealthSignals(baseDeps({ chains: [], redis: fakeRedis({ ping: async () => { throw new Error("no redis"); } }) }));
  check("5. ⭐⭐ chains [] + PING aruncă → redisReachable false", sig.redisReachable === false);
  check("6. ⭐ computeLiveness → down + 503", computeLiveness(sig).status === "down" && computeLiveness(sig).httpStatus === 503);
}

// ── C. fără chain-uri + PING atârnă → timeout bounded → redisReachable false ───
{
  const sig = await buildHealthSignals(baseDeps({ chains: [], pingTimeoutMs: 20, redis: fakeRedis({ ping: () => new Promise<never>(() => {}) }) }));
  check("7. ⭐⭐ chains [] + PING atârnă → timeout bounded → redisReachable false (nu atârnăm endpoint-ul)", sig.redisReachable === false);
}

// ── D. redis null → redisReachable false (fără MGET) ──────────────────────────
{
  const sig = await buildHealthSignals(baseDeps({ chains: [], redis: null }));
  check("8. redis null → redisReachable false", sig.redisReachable === false);
}

// ── E. flux normal: 2 chain-uri fresh + WS conectat → ok ──────────────────────
{
  const snap = { "snap:base": JSON.stringify({ savedAt: NOW - 5_000 }), "snap:arbitrum": JSON.stringify({ savedAt: NOW - 8_000 }) };
  const rt   = { "rt:base": JSON.stringify({ chain: "base", wsConnected: true, lastPongAgeSec: 10 }), "rt:arbitrum": JSON.stringify({ chain: "arbitrum", wsConnected: true, lastPongAgeSec: 12 }) };
  const sig  = await buildHealthSignals(baseDeps({ chains: ["base", "arbitrum"], redis: fakeRedis({ mget: twoWayMget(snap, rt) }) }));
  check("9. ⭐⭐ flux normal: perChain 2, observedChains 2, snapshotAge ~5/8s",
    sig.perChain.length === 2 && sig.observedChains.length === 2 && sig.perChain[0].snapshotAgeSec === 5 && sig.perChain[1].snapshotAgeSec === 8);
  const rep = computeLiveness(sig);
  check("10. ⭐⭐ computeLiveness pe flux normal → ok + 200", rep.status === "ok" && rep.httpStatus === 200 && rep.checks.ws.ok === true);
}

// ── F. chain așteptat lipsă (ambele chei null) → observed false + degraded ────
{
  const snap = { "snap:base": JSON.stringify({ savedAt: NOW - 5_000 }), "snap:arbitrum": null };
  const rt   = { "rt:base": JSON.stringify({ chain: "base", wsConnected: true, lastPongAgeSec: 10 }), "rt:arbitrum": null };
  const sig  = await buildHealthSignals(baseDeps({ chains: ["base", "arbitrum"], redis: fakeRedis({ mget: twoWayMget(snap, rt) }) }));
  const arb  = sig.perChain.find(p => p.chain === "arbitrum")!;
  check("11. ⭐⭐⭐ arbitrum fără ambele chei → observed false, snapshotAgeSec null, NU în observedChains",
    arb.observed === false && arb.snapshotAgeSec === null && !sig.observedChains.includes("arbitrum") && sig.expectedChains.includes("arbitrum"));
  check("12. ⭐⭐ computeLiveness → degraded + staleChains conține arbitrum", (() => { const r = computeLiveness(sig); return r.status === "degraded" && r.staleChains.includes("arbitrum"); })());
}

// ── G. WS stale real-flow (runtime cu subs) → suspected_stale + wsStaleSubs ────
{
  const snap = { "snap:base": JSON.stringify({ savedAt: NOW - 5_000 }) };
  const rt   = { "rt:base": JSON.stringify({ chain: "base", wsConnected: true, lastPongAgeSec: 10, wsSubs: { v2: {}, v3: null, v4: null } }) };
  const sig  = await buildHealthSignals(baseDeps({ chains: ["base"], redis: fakeRedis({ mget: twoWayMget(snap, rt) }) }));
  const rep  = computeLiveness(sig);
  check("13. ⭐⭐ WS cu subs → clasificat suspected_stale → wsStaleSubs 'base:v2' + degraded",
    rep.status === "degraded" && rep.wsStaleSubs.includes("base:v2") && rep.checks.ws.ok === false);
}

// ── H. eroare MGET → fail-closed (redisReachable false) ───────────────────────
{
  const sig = await buildHealthSignals(baseDeps({ chains: ["base"], redis: fakeRedis({ mget: async () => { throw new Error("MGET boom"); } }) }));
  check("14. ⭐ MGET aruncă → fail-closed: redisReachable false", sig.redisReachable === false);
}

// ── I. wsExpected=false propagat prin flux ────────────────────────────────────
{
  const snap = { "snap:base": JSON.stringify({ savedAt: NOW - 5_000 }) };
  const rt   = { "rt:base": null };
  const sig  = await buildHealthSignals(baseDeps({ chains: ["base"], wsExpected: false, redis: fakeRedis({ mget: twoWayMget(snap, rt) }) }));
  check("15. ⭐ wsExpected=false → perChain wsState disabled + computeLiveness ok (WS nepenalizat)",
    sig.wsExpected === false && sig.perChain[0].wsState === "disabled" && computeLiveness(sig).status === "ok");
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
