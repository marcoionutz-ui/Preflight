/**
 * lib/mcp/canaryGate2.test.ts — PH-12 12.5c-2 (orchestrator Gate 2 Base canary, PUR).
 *
 * Hermetic: ceas FALS (sleep avansează timpul) + pași fake programabili. Verifică: vet (izolare prod + Redis loopback +
 * token), lifecycle worker (stop() în finally, cleanup eșuat → roșu chiar dacă poll-ul e verde), și POLL-ul pe TOATE
 * cele trei dovezi (strict health + base_data + base_ws) cu cadențe + deadline warm-up/global.
 */
import {
  runGate2, vetGate2Targets,
  type Gate2Steps, type Gate2Clock, type Gate2Targets, type WorkerStopResult, type Gate2Timing,
} from "./canaryGate2";
import type { McpCallResult } from "./canaryMcpClient";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
console.log("PH-12 12.5c-2 — canaryGate2 (orchestrator pur, ceas fals)");

// ── Ceas fals: sleep avansează `now`; `adv` permite unei probe să avanseze ceasul. ─────────────
function makeClock(): Gate2Clock & { t: () => number; adv: (ms: number) => void } {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, t: () => t, adv: (ms) => { t += ms; } };
}

// ── Fabrici de payload ────────────────────────────────────────────────────────
function okResult(data: unknown): McpCallResult {
  const env = { ok: true, format: "preflight.response.v1", text: JSON.stringify(data), meta: {}, data };
  return { ok: true, content: [{ type: "text", text: JSON.stringify(env) }], isError: false, structuredContent: env };
}
function baseWorkerData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { total: 3, count: 3, offset: 0, has_more: false,
    pairs: [{ pairAddress: "0xA", chain: "base", symbol: "A", phase: "NEW" }, { pairAddress: "0xB", chain: "base", symbol: "B", phase: "NEW" }, { pairAddress: "0xC", chain: "base", symbol: "C", phase: "NEW" }],
    snapshotAgeSec: 12, workerVersion: "w1", ...over };
}
function baseHealthData(baseOver: Record<string, unknown> = {}): Record<string, unknown> {
  return { workerOnline: true, knownChains: ["base"], liveChains: ["base"], wsStreamStaleSubs: [],
    perChainWorker: { base: { live: true, wsConnected: true, lastPongAgeSec: 15, subs: { v2: { confirmed: true, poolCount: 4 }, v3: null, v4: null }, ...baseOver } } };
}
function healthBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "ok", httpStatus: 200, scope: "mcp-web + evm-worker",
    checks: { web: { ok: true, detail: "" }, redis: { ok: true, detail: "" }, worker: { ok: true, detail: "" }, ws: { ok: true, detail: "" } },
    expectedChains: ["base"], observedChains: ["base"], staleChains: [], wsStaleSubs: [], wsUnavailableChains: [], wsUnknownChains: [], worstSnapshotAgeSec: 20, ...over };
}

const CFG_OK = { mcpBaseUrl: "http://127.0.0.1:8080", supabaseUrl: "http://127.0.0.1:54321", redisUrl: "redis://127.0.0.1:6379", accessToken: "tok_secret_ABC" };

// ── Pași fake, cu contoare + programabilitate ──────────────────────────────────
interface FakeCounters { made: boolean; targets?: Gate2Targets; start: number; stop: number; health: number; data: number; ws: number; }
function mkSteps(cnt: FakeCounters, opts: {
  startResult?: (sig: AbortSignal) => Promise<Awaited<ReturnType<Gate2Steps["startWorker"]>>>;
  stopResult?:  (sig: AbortSignal) => Promise<WorkerStopResult>;
  health?: (n: number) => unknown;          // body la al n-lea apel
  data?:   (n: number) => McpCallResult;
  ws?:     (n: number) => McpCallResult;
} = {}): (t: Gate2Targets) => Gate2Steps {
  return (targets) => {
    cnt.made = true; cnt.targets = targets;
    return {
      startWorker: opts.startResult ?? (async (_sig) => { cnt.start++; return { ok: true, stop: async (_s) => { cnt.stop++; return (opts.stopResult ? opts.stopResult(_s) : { ok: true }); } }; }),
      fetchHealth: async (_sig) => { const n = ++cnt.health; return { ok: true, body: opts.health ? opts.health(n) : healthBody() }; },
      mcpWorkerSnapshot: async (_t, _sig) => { const n = ++cnt.data; return opts.data ? opts.data(n) : okResult(baseWorkerData()); },
      mcpHealthCheck:    async (_t, _sig) => { const n = ++cnt.ws; return opts.ws ? opts.ws(n) : okResult(baseHealthData()); },
    };
  };
}
function counters(): FakeCounters { return { made: false, start: 0, stop: 0, health: 0, data: 0, ws: 0 }; }
const FAST: Gate2Timing = { warmupMs: 100, globalMs: 1000, healthEveryMs: 10, mcpEveryMs: 20, graceMs: 5 };

// ─────────────────────────────────────────────────────────────────────────────
// V. Vet (izolare + Redis loopback + token)
// ─────────────────────────────────────────────────────────────────────────────
check("V1. ⭐⭐⭐ cfg curat (loopback) → vet ok + ținte derivate (health strict, mcp)", (() => {
  const v = vetGate2Targets(CFG_OK);
  return v.ok && v.targets.healthUrl === "http://127.0.0.1:8080/api/health?strict=1" && v.targets.mcpUrl === "http://127.0.0.1:8080/api/mcp" && v.targets.redisUrl === CFG_OK.redisUrl;
})());
check("V2. ⭐⭐⭐ mcpBaseUrl prod → vet fail", vetGate2Targets({ ...CFG_OK, mcpBaseUrl: "https://preflight.jackspools.lol" }).ok === false);
check("V3. ⭐⭐ supabaseUrl prod → vet fail", vetGate2Targets({ ...CFG_OK, supabaseUrl: "https://ipeyogzfgqypfkujraxm.supabase.co" }).ok === false);
check("V4. ⭐⭐⭐ REDIS_URL non-loopback (prod) → vet fail (anti-prod worker)", vetGate2Targets({ ...CFG_OK, redisUrl: "redis://prod-redis.example.com:6379" }).ok === false);
check("V5. ⭐⭐ REDIS_URL schemă greșită (http) → vet fail", vetGate2Targets({ ...CFG_OK, redisUrl: "http://127.0.0.1:6379" }).ok === false);
check("V6. ⭐ rediss:// pe loopback → vet ok (TLS local acceptat)", vetGate2Targets({ ...CFG_OK, redisUrl: "rediss://127.0.0.1:6380" }).ok === true);
check("V6b. redis://localhost → vet ok", vetGate2Targets({ ...CFG_OK, redisUrl: "redis://localhost:6379" }).ok === true);
check("V7. ⭐⭐ accessToken lipsă → vet fail (Gate 2 nu face OAuth)", vetGate2Targets({ ...CFG_OK, accessToken: "" }).ok === false);
check("V8. mcpBaseUrl cu path → vet fail (origine curată)", vetGate2Targets({ ...CFG_OK, mcpBaseUrl: "http://127.0.0.1:8080/x" }).ok === false);
check("V9. ⭐ REDIS_URL neparsabil → vet fail", vetGate2Targets({ ...CFG_OK, redisUrl: "not a url" }).ok === false);
check("V10. ⭐⭐ vet reject NU conține tokenul (anti-leak)", (() => { const v = vetGate2Targets({ ...CFG_OK, mcpBaseUrl: "https://preflight.up.railway.app" }); return v.ok === false && !v.reason.includes("tok_secret"); })());
check("V11. ⭐⭐⭐ REDIS_URL 'secretmarker://…' → vet fail, reason NU reflectă 'secretmarker' (anti-leak schemă)",
  (() => { const v = vetGate2Targets({ ...CFG_OK, redisUrl: "secretmarker://127.0.0.1:6379" }); return v.ok === false && !v.reason.includes("secretmarker"); })());

// ─────────────────────────────────────────────────────────────────────────────
// L. Lifecycle: izolare gate 0, start, stop în finally
// ─────────────────────────────────────────────────────────────────────────────
(async () => {

let c = counters();
let r = await runGate2(CFG_OK, mkSteps(c), makeClock(), FAST);
check("L1. ⭐⭐⭐ happy → verde, stop() apelat exact o dată", r.ok === true && c.start === 1 && c.stop === 1);
check("L1b. ⭐ happy → stages complet", r.ok === true && r.stages.join(">") === "isolation>setup>start_worker>poll");

c = counters();
r = await runGate2({ ...CFG_OK, mcpBaseUrl: "https://preflight.jackspools.lol" }, mkSteps(c), makeClock(), FAST);
check("L2. ⭐⭐⭐ izolare prod → stage isolation, makeSteps NEinvocat, worker neatins", r.ok === false && r.stage === "isolation" && c.made === false && c.start === 0);

c = counters();
r = await runGate2({ ...CFG_OK, redisUrl: "redis://prod.example.com:6379" }, mkSteps(c), makeClock(), FAST);
check("L3. ⭐⭐⭐ Redis prod → stage isolation, makeSteps NEinvocat (workerul nu pornește pe Redis prod)", r.ok === false && r.stage === "isolation" && c.made === false);

c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { startResult: async () => ({ ok: false, code: "spawn_failed" }) }), makeClock(), FAST);
check("L4. ⭐⭐ startWorker fail → stage start_worker, stop NEapelat (nu există capabilitate)", r.ok === false && r.stage === "start_worker" && c.stop === 0);

c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { startResult: async () => { throw new Error("boom"); } }), makeClock(), FAST);
check("L5. ⭐⭐ startWorker THROW → stage start_worker (generic), fără propagare", r.ok === false && r.stage === "start_worker");

// ⭐⭐⭐ LOCK cgpt: poll verde DAR stop() eșuează → Gate 2 ROȘU (worker posibil orfan)
c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { stopResult: async () => ({ ok: false, code: "stop_failed" }) }), makeClock(), FAST);
check("L6. ⭐⭐⭐ poll verde + stop() fail → Gate ROȘU stage stop_worker (cleanup eșuat = roșu)", r.ok === false && r.stage === "stop_worker" && c.stop === 1);

c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { stopResult: async () => { throw new Error("kill boom"); } }), makeClock(), FAST);
check("L7. ⭐⭐ poll verde + stop() THROW → stage stop_worker (generic)", r.ok === false && r.stage === "stop_worker");

// stop() apelat MEREU, chiar dacă poll-ul pică
c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { data: () => okResult(baseWorkerData({ total: 0, count: 0, pairs: [] })) }), makeClock(), FAST);
check("L8. ⭐⭐⭐ poll pică (data goală) → stop() TOT apelat în finally", r.ok === false && r.stage === "poll" && c.stop === 1);

// ─────────────────────────────────────────────────────────────────────────────
// P. Poll pe TOATE cele trei dovezi
// ─────────────────────────────────────────────────────────────────────────────

// P1: health verde imediat, DAR base_data devine gata abia după câteva probe → NU declară succes prematur
c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { data: (n) => okResult(baseWorkerData(n >= 3 ? {} : { total: 0, count: 0, pairs: [] })) }), makeClock(), FAST);
check("P1. ⭐⭐⭐ health verde dar pairs abia la a 3-a probă → așteaptă, apoi verde (nu premature)", r.ok === true && c.data >= 3);

// P2: health + data verzi, DAR ws (wsConnected) devine gata abia mai târziu → așteaptă ws
c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { ws: (n) => okResult(baseHealthData(n >= 2 ? {} : { wsConnected: false })) }), makeClock(), FAST);
check("P2. ⭐⭐⭐ health+data verzi dar ws abia mai târziu → așteaptă ws, apoi verde", r.ok === true && c.ws >= 2);

// P3: base_data nu devine niciodată gata → warm-up expiră, diagnostic pe base_data
c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { data: () => okResult(baseWorkerData({ total: 0, count: 0, pairs: [] })) }), makeClock(), FAST);
check("P3. ⭐⭐⭐ data niciodată gata → warm-up expiră, stage poll, probe base_data", r.ok === false && r.stage === "poll" && (r as { probe?: string }).probe === "base_data" && /warm-up/.test(r.reason));

// P3b: health niciodată verde (worker stale) → probe strict_health
c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { health: () => healthBody({ staleChains: ["base"], status: "degraded", httpStatus: 503 }) }), makeClock(), FAST);
check("P3b. ⭐⭐ health niciodată verde → probe strict_health (health domină în raportare)", r.ok === false && r.stage === "poll" && (r as { probe?: string }).probe === "strict_health");

// P4: deadline GLOBAL mai mic decât warm-up → global lovește primul
c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { data: () => okResult(baseWorkerData({ total: 0, count: 0, pairs: [] })) }), makeClock(), { warmupMs: 1000, globalMs: 50, healthEveryMs: 10, mcpEveryMs: 20 });
check("P4. ⭐⭐⭐ deadline GLOBAL < warm-up → reason 'deadline global', tot roșu", r.ok === false && r.stage === "poll" && /deadline global/.test(r.reason));

// P5: cadență — MCP NU e lovit mai des decât mcpEvery (throttle), health mai des
c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { data: () => okResult(baseWorkerData({ total: 0, count: 0, pairs: [] })) }), makeClock(), FAST);
check("P5. ⭐⭐⭐ cadență: mcp (data) lovit STRICT mai rar decât health (throttle ~5s vs ~2s)", r.ok === false && c.data < c.health && c.data >= 1 && c.health >= 5);
check("P5b. ⭐ ws throttlat la aceeași cadență ca data", c.ws === c.data);

// P6: o probă aruncă în timpul poll-ului → tratată ca failing (nu crash), warm-up expiră
c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { data: () => { throw new Error("mcp boom"); } }), makeClock(), FAST);
check("P6. ⭐⭐ proba MCP aruncă → poll o tratează ca fail (nu crash), warm-up expiră pe base_data", r.ok === false && r.stage === "poll" && c.stop === 1);

// P7: token-ul e pasat la probele MCP (nu OAuth în Gate 2)
let seenToken: string | null = null;
c = counters();
r = await runGate2(CFG_OK, (_t) => ({
  startWorker: async (_s) => ({ ok: true, stop: async (_s2) => ({ ok: true }) }),
  fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
  mcpWorkerSnapshot: async (tok, _s) => { seenToken = tok; return okResult(baseWorkerData()); },
  mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
}), makeClock(), FAST);
check("P7. ⭐⭐ accessToken din cfg pasat la proba MCP (Gate 2 nu re-autentifică)", r.ok === true && seenToken === "tok_secret_ABC");

// P8: anti-leak — reason la poll-fail nu conține tokenul
c = counters();
r = await runGate2(CFG_OK, mkSteps(c, { data: () => okResult(baseWorkerData({ total: 0, count: 0, pairs: [] })) }), makeClock(), FAST);
check("P8. ⭐⭐ reason poll-fail NU conține tokenul (anti-leak)", r.ok === false && !r.reason.includes("tok_secret"));

// ─────────────────────────────────────────────────────────────────────────────
// D. Cazuri decisive cgpt (fix R2)
// ─────────────────────────────────────────────────────────────────────────────

// D1 (P1 #1): o probă AVANSEAZĂ ceasul peste warm-up, apoi răspunde VERDE → trebuie ROȘU (fără fals verde)
{
  const clk = makeClock();
  c = counters();
  r = await runGate2(CFG_OK, mkSteps(c, { data: () => { clk.adv(500); return okResult(baseWorkerData()); } }), clk,
    { warmupMs: 100, globalMs: 1000, healthEveryMs: 10, mcpEveryMs: 20, probeTimeoutMs: 15_000 });
  check("D1. ⭐⭐⭐ probă avansează ceasul peste warm-up apoi verde → ROȘU (re-check deadline post-eval)",
    r.ok === false && r.stage === "poll" && /warm-up|deadline global/.test(r.reason) && c.stop === 1);
}

// D2: probă NEVER-RESOLVING → bound timeout (abort), warm-up expiră, stop() AȘTEPTAT
{
  let stopN = 0;
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: async (_s2) => { stopN++; return { ok: true }; } }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: (_t, _s) => new Promise<McpCallResult>(() => {}), // never resolves
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }), makeClock(), { warmupMs: 50, globalMs: 1000, healthEveryMs: 10, mcpEveryMs: 10, probeTimeoutMs: 10, graceMs: 5 });
  check("D2. ⭐⭐⭐ probă never-resolving → bound timeout, warm-up expiră, stop() apelat (nu hang)",
    r.ok === false && r.stage === "poll" && stopN === 1);
}

// D3: clock.now() aruncă → raport ROȘU (nu Promise rejected), makeSteps NEinvocat
{
  c = counters();
  let threw = false; let rr: Awaited<ReturnType<typeof runGate2>> | null = null;
  try { rr = await runGate2(CFG_OK, mkSteps(c), { now: () => { throw new Error("now boom"); }, sleep: async () => {} }, FAST); }
  catch { threw = true; }
  check("D3. ⭐⭐⭐ clock.now() aruncă → raport roșu stage config (NU rejected), worker neatins",
    threw === false && rr !== null && rr.ok === false && rr.stage === "config" && c.made === false);
}

// D3b: clock.sleep() aruncă mid-poll → raport ROȘU stage poll (nu rejected), stop() AȘTEPTAT
{
  c = counters();
  let threw = false; let rr: Awaited<ReturnType<typeof runGate2>> | null = null;
  const badSleep: Gate2Clock = { now: () => 0, sleep: async () => { throw new Error("sleep boom"); } };
  try { rr = await runGate2(CFG_OK, mkSteps(c, { data: () => okResult(baseWorkerData({ total: 0, count: 0, pairs: [] })) }), badSleep, FAST); }
  catch { threw = true; }
  check("D3b. ⭐⭐⭐ clock.sleep() aruncă mid-poll → raport roșu stage poll (NU rejected), stop() apelat",
    threw === false && rr !== null && rr.ok === false && rr.stage === "poll" && c.stop === 1);
}

// D4: timing invalid → REFUZ înainte de spawn (stage config, makeSteps NEinvocat)
{
  let cc = counters(); r = await runGate2(CFG_OK, mkSteps(cc), makeClock(), { warmupMs: NaN });
  check("D4a. ⭐⭐⭐ warmupMs NaN → stage config, makeSteps NEinvocat", r.ok === false && r.stage === "config" && cc.made === false && cc.start === 0);
  cc = counters(); r = await runGate2(CFG_OK, mkSteps(cc), makeClock(), { mcpEveryMs: 0 });
  check("D4b. ⭐⭐ mcpEveryMs 0 → stage config", r.ok === false && r.stage === "config" && cc.made === false);
  cc = counters(); r = await runGate2(CFG_OK, mkSteps(cc), makeClock(), { globalMs: -5 });
  check("D4c. ⭐⭐ globalMs negativ → stage config", r.ok === false && r.stage === "config");
  cc = counters(); r = await runGate2(CFG_OK, mkSteps(cc), makeClock(), { healthEveryMs: Infinity });
  check("D4d. ⭐⭐ healthEveryMs Infinity → stage config", r.ok === false && r.stage === "config");
  cc = counters(); r = await runGate2(CFG_OK, mkSteps(cc), makeClock(), { probeTimeoutMs: 0 });
  check("D4e. ⭐ probeTimeoutMs 0 → stage config", r.ok === false && r.stage === "config");
}

// D5: poll ROȘU + stop ROȘU → poll domină + teardown EXPLICIT în reason
{
  c = counters();
  r = await runGate2(CFG_OK, mkSteps(c, { data: () => okResult(baseWorkerData({ total: 0, count: 0, pairs: [] })), stopResult: async () => ({ ok: false, code: "stop_failed" }) }), makeClock(), FAST);
  check("D5. ⭐⭐⭐ poll roșu + stop roșu → stage poll + teardown explicit în reason, stop apelat",
    r.ok === false && r.stage === "poll" && /teardown/.test(r.reason) && c.stop === 1);
}

// D6 (P1): probă timeout → AbortSignal chiar TRIMIS (proba anulată, nu doar neașteptată)
{
  let aborted: boolean = false;
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: async (_s2) => ({ ok: true }) }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: (_tk, sig) => new Promise<never>(() => { sig.addEventListener("abort", () => { aborted = true; }); }),
    mcpHealthCheck: async (_tk, _s) => okResult(baseHealthData()),
  }), makeClock(), { warmupMs: 40, globalMs: 1000, healthEveryMs: 10, mcpEveryMs: 10, probeTimeoutMs: 10, graceMs: 5 });
  check("D6. ⭐⭐⭐ probă timeout → AbortSignal TRIMIS (anulare reală, nu doar 'nu mai așteptăm')",
    r.ok === false && r.stage === "poll" && aborted);
}

// D7 (P1): startWorker never-resolving → MĂRGINIT + abort (fără proces orfan), makeSteps invocat
{
  let aborted: boolean = false; const cc = counters();
  r = await runGate2(CFG_OK, (_t) => { cc.made = true; return {
    startWorker: (sig) => new Promise<never>(() => { sig.addEventListener("abort", () => { aborted = true; }); }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_tk, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_tk, _s) => okResult(baseHealthData()),
  }; }, makeClock(), { ...FAST, startTimeoutMs: 10 });
  check("D7. ⭐⭐⭐ startWorker never-resolving → bounded stage start_worker + abort trimis (fără orfan)",
    r.ok === false && r.stage === "start_worker" && /timeout/.test(r.reason) && aborted && cc.stop === 0);
}

// D8 (P1): stop() never-resolving → MĂRGINIT → stage stop_worker (stop_timeout) + abort
{
  let aborted: boolean = false;
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: (sig) => new Promise<never>(() => { sig.addEventListener("abort", () => { aborted = true; }); }) }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_tk, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_tk, _s) => okResult(baseHealthData()),
  }), makeClock(), { ...FAST, stopTimeoutMs: 10 });
  check("D8. ⭐⭐⭐ stop() never-resolving → bounded stage stop_worker (stop_timeout) + abort trimis",
    r.ok === false && r.stage === "stop_worker" && /grace|teardown/.test(r.reason) && aborted);
}

// D9 (P2): TOATE probele verzi după deadline → reason coerent (NU acuză o probă verde), `probe` OMIS.
// ULTIMA probă (ws) avansează ceasul → toate trei-s verzi când post-eval detectează depășirea (all-green legitim).
{
  const clk = makeClock(); c = counters();
  r = await runGate2(CFG_OK, mkSteps(c, { ws: () => { clk.adv(500); return okResult(baseHealthData()); } }), clk,
    { warmupMs: 100, globalMs: 1000, healthEveryMs: 10, mcpEveryMs: 20, probeTimeoutMs: 15_000, graceMs: 5 });
  check("D9. ⭐⭐⭐ toate probele verzi după deadline → reason 'toate cele 3 probe verzi', probe OMIS (nu acuză verde)",
    r.ok === false && r.stage === "poll" && /toate cele 3 probe verzi/.test(r.reason) && (r as { probe?: string }).probe === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// E. Cazuri decisive cgpt (fix R3): abort ≠ cleanup terminat; global = deadline HARD pe start/probe
// ─────────────────────────────────────────────────────────────────────────────

// E1 (P1): abort + cleanup ÎNTÂRZIAT în grace → runGate2 NU revine înainte de confirmarea cleanup-ului
{
  let cleanupDone = false;
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: (sig) => new Promise<WorkerStopResult>((res) => { sig.addEventListener("abort", () => { setTimeout(() => { cleanupDone = true; res({ ok: true }); }, 5); }); }) }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }), makeClock(), { ...FAST, stopTimeoutMs: 5, graceMs: 50 });
  check("E1. ⭐⭐⭐ abort + cleanup întârziat în grace → runGate2 AȘTEAPTĂ confirmarea (cleanupDone) + red 'cleanup confirmat'",
    r.ok === false && r.stage === "stop_worker" && cleanupDone && /cleanup confirmat/.test(r.reason));
}

// E2 (P1): adaptor de stop care IGNORĂ abortul → grace expiră → bounded roșu „posibil orfan"
{
  let aborted: boolean = false;
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: (sig) => new Promise<WorkerStopResult>(() => { sig.addEventListener("abort", () => { aborted = true; }); }) }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }), makeClock(), { ...FAST, stopTimeoutMs: 5, graceMs: 10 });
  check("E2. ⭐⭐⭐ stop ignoră abort → bounded roșu stop_worker 'posibil orfan' (abort trimis)",
    r.ok === false && r.stage === "stop_worker" && /orfan/i.test(r.reason) && aborted);
}

// E3 (P1): globalMs < startTimeoutMs + start BLOCAT → timeout la GLOBAL, nu la start-timeout
{
  let aborted: boolean = false; const cc = counters();
  r = await runGate2(CFG_OK, (_t) => { cc.made = true; return {
    startWorker: (sig) => new Promise<never>(() => { sig.addEventListener("abort", () => { aborted = true; }); }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }; }, makeClock(), { warmupMs: 1000, globalMs: 20, healthEveryMs: 10, mcpEveryMs: 10, startTimeoutMs: 200, stopTimeoutMs: 30, probeTimeoutMs: 15_000, graceMs: 5 });
  check("E3. ⭐⭐⭐ globalMs(20) < startTimeoutMs(200) + start blocat → timeout la GLOBAL (nu start-timeout), abort trimis",
    r.ok === false && r.stage === "start_worker" && /deadline global/.test(r.reason) && aborted && cc.made === true);
}

// E4 (P1): probă BLOCATĂ lângă global → buget = timp RĂMAS (nu probeTimeout mare) → bounded, roșu deadline global
{
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: async (_s2) => ({ ok: true }) }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: (_t, _s) => new Promise<never>(() => {}), // blocată
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }), makeClock(), { warmupMs: 1000, globalMs: 40, healthEveryMs: 10, mcpEveryMs: 10, probeTimeoutMs: 100_000, graceMs: 3 });
  check("E4. ⭐⭐⭐ probă blocată lângă global → buget = timp rămas (NU probeTimeout mare) → bounded, roșu deadline global",
    r.ok === false && r.stage === "poll" && /deadline global/.test(r.reason));
}

// ─────────────────────────────────────────────────────────────────────────────
// F. Cazuri decisive cgpt (fix R4): settle ≠ cleanup reușit; timere anulate; clock nefinit
// ─────────────────────────────────────────────────────────────────────────────

// F1 (P1): start EXPIRĂ, apoi întoarce TARDIV {ok:true, stop} în grace → acel stop e OBLIGATORIU apelat
{
  let lateStopCalled = 0;
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => { await new Promise((res) => setTimeout(res, 8)); return { ok: true, stop: async (_s2) => { lateStopCalled++; return { ok: true }; } }; },
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }), makeClock(), { ...FAST, startTimeoutMs: 3, graceMs: 50 });
  check("F1. ⭐⭐⭐ start expiră apoi întoarce TARDIV {ok:true,stop} → stop OBLIGATORIU apelat + red start_worker",
    r.ok === false && r.stage === "start_worker" && lateStopCalled === 1);
}

// F2 (P1): stop EXPIRĂ, apoi întoarce {ok:false} în grace → NU apare „cleanup confirmat" (settle ≠ succes)
{
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: async (_s2) => { await new Promise((res) => setTimeout(res, 8)); return { ok: false, code: "stop_failed" }; } }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }), makeClock(), { ...FAST, stopTimeoutMs: 3, graceMs: 50 });
  check("F2. ⭐⭐⭐ stop expiră apoi {ok:false} în grace → NU 'cleanup confirmat' (settle ≠ succes)",
    r.ok === false && r.stage === "stop_worker" && !/cleanup confirmat/.test(r.reason));
}

// F3 (P1): stop EXPIRĂ, apoi RESPINGE în grace → „posibil orfan", NU cleaned
{
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: async (_s2) => { await new Promise((res) => setTimeout(res, 8)); throw new Error("stop boom"); } }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }), makeClock(), { ...FAST, stopTimeoutMs: 3, graceMs: 50 });
  check("F3. ⭐⭐⭐ stop respinge în grace → 'posibil orfan', NU cleaned",
    r.ok === false && r.stage === "stop_worker" && /orfan/i.test(r.reason) && !/cleanup confirmat/.test(r.reason));
}

// F4 (P1): operație RAPIDĂ → AMBELE timere anulate (fără timer orfan de 9000s care ține event-loop-ul)
{
  const timersBefore = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  c = counters();
  r = await runGate2(CFG_OK, mkSteps(c), makeClock(), { ...FAST, probeTimeoutMs: 9_000_000, startTimeoutMs: 9_000_000, stopTimeoutMs: 9_000_000, graceMs: 9_000_000 });
  const timersAfter = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  check("F4. ⭐⭐⭐ operație rapidă → ambele timere anulate (fără timer orfan)", r.ok === true && timersAfter <= timersBefore);
}

// F5 (P2): clock.now() nefinit (NaN/Infinity) → config ROȘU, makeSteps NEinvocat
{
  let cc = counters();
  r = await runGate2(CFG_OK, mkSteps(cc), { now: () => NaN, sleep: async () => {} }, FAST);
  check("F5a. ⭐⭐⭐ clock.now()=NaN → stage config, makeSteps NEinvocat", r.ok === false && r.stage === "config" && cc.made === false);
  cc = counters();
  r = await runGate2(CFG_OK, mkSteps(cc), { now: () => Infinity, sleep: async () => {} }, FAST);
  check("F5b. ⭐⭐ clock.now()=Infinity → stage config, makeSteps NEinvocat", r.ok === false && r.stage === "config" && cc.made === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// G. Cazuri decisive cgpt (fix R5): warm-up plafonează probele; mesaj corect de handle tardiv
// ─────────────────────────────────────────────────────────────────────────────

// G1 (P1): warm-up mic + health NEVER-RESOLVING → bugetul probei e plafonat de warm-up (NU probeTimeout uriaș).
//   Dacă NU era plafonat, iter-1 ar aștepta probeTimeoutMs (9000s) → testul ar atârna. Trecerea dovedește plafonarea.
{
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: async (_s2) => ({ ok: true }) }),
    fetchHealth: (_s) => new Promise<never>(() => {}), // never resolves
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }), makeClock(), { warmupMs: 20, globalMs: 9_000_000, healthEveryMs: 10, mcpEveryMs: 10, probeTimeoutMs: 9_000_000, graceMs: 3 });
  check("G1. ⭐⭐⭐ warm-up mic + health never-resolving → buget plafonat de warm-up (bounded, NU probeTimeout uriaș)",
    r.ok === false && r.stage === "poll" && (r as { probe?: string }).probe === "strict_health" && /warm-up/.test(r.reason));
}

// G2 (P1): health CONSUMĂ restul warm-up-ului → data și ws NU mai pornesc (fereastra deja expirată).
{
  const clk = makeClock(); c = counters();
  r = await runGate2(CFG_OK, mkSteps(c, { health: (_n) => { clk.adv(200); return healthBody(); } }), clk,
    { warmupMs: 100, globalMs: 1000, healthEveryMs: 10, mcpEveryMs: 10, probeTimeoutMs: 15_000, graceMs: 5 });
  check("G2. ⭐⭐⭐ health consumă restul warm-up-ului → data și ws NU mai pornesc", r.ok === false && r.stage === "poll" && c.data === 0 && c.ws === 0);
}

// G3 (P2): start tardiv + lateStop EȘUAT → reason conține „posibil orfan", NU afirmă fals „oprit".
{
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => { await new Promise((res) => setTimeout(res, 8)); return { ok: true, stop: async (_s2) => ({ ok: false, code: "stop_failed" }) }; },
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }), makeClock(), { ...FAST, startTimeoutMs: 3, graceMs: 50 });
  check("G3. ⭐⭐⭐ start tardiv + lateStop eșuat → reason 'posibil orfan', NU 'oprit'",
    r.ok === false && r.stage === "start_worker" && /orfan/i.test(r.reason) && !/oprit/.test(r.reason));
}

// G4 (P2): start tardiv + lateStop OK TARDIV (în grace) → „teardown confirmat" (consistent cu calea principală), NU „neconfirmat"
{
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => { await new Promise((res) => setTimeout(res, 8)); return { ok: true, stop: async (_s2) => { await new Promise((res) => setTimeout(res, 8)); return { ok: true }; } }; },
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
  }), makeClock(), { ...FAST, startTimeoutMs: 3, stopTimeoutMs: 3, graceMs: 50 });
  check("G4. ⭐⭐⭐ start tardiv + lateStop OK tardiv (în grace) → 'teardown confirmat', NU 'neconfirmat'",
    r.ok === false && r.stage === "start_worker" && /confirmat/.test(r.reason) && !/[Nn][Ee]confirmat/.test(r.reason));
}

// ─────────────────────────────────────────────────────────────────────────────
// GEN. Bariera de generație post-spawn (12.5c-4) — probele finale contează DOAR după barieră
// ─────────────────────────────────────────────────────────────────────────────

// GEN1 (DECISIV, fix cgpt): health/data/WS VERZI tot timpul (reziduu), dar generația NU avansează niciodată (ar avansa
// abia la stop()) → Gate 2 ROȘU @ poll/generation. Bariera în poll împiedică falsul verde pe date pre-spawn.
{
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: async (_s2) => ({ ok: true }) }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
    checkGeneration: async (_s) => ({ ok: false, reason: "generație neavansată (reziduu pre-spawn)" }),
  }), makeClock(), FAST);
  check("GEN1. ⭐⭐⭐ probe vechi VERZI + generație NEavansată → Gate 2 ROȘU @ generation (barieră în poll)",
    r.ok === false && r.stage === "poll" && r.probe === "generation");
}

// GEN2: generația avansează ÎN TIMPUL poll-ului (după câteva ticks) → Gate 2 VERDE (probele finale rulează după barieră).
{
  let gcalls = 0;
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: async (_s2) => ({ ok: true }) }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody() }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
    checkGeneration: async (_s) => { gcalls++; return gcalls >= 3 ? { ok: true, reason: "avansat" } : { ok: false, reason: "încă nu" }; },
  }), makeClock(), FAST);
  check("GEN2. ⭐⭐⭐ generația avansează în poll → Gate 2 VERDE (probele finale după barieră)", r.ok === true);
}

// GEN3: barieră VERDE dar strict_health ROȘU → Gate 2 roșu @ strict_health (bariera nu maschează un health nesănătos).
{
  r = await runGate2(CFG_OK, (_t) => ({
    startWorker: async (_s) => ({ ok: true, stop: async (_s2) => ({ ok: true }) }),
    fetchHealth: async (_s) => ({ ok: true, body: healthBody({ status: "degraded" }) }),
    mcpWorkerSnapshot: async (_t, _s) => okResult(baseWorkerData()),
    mcpHealthCheck: async (_t, _s) => okResult(baseHealthData()),
    checkGeneration: async (_s) => ({ ok: true, reason: "avansat" }),
  }), makeClock(), FAST);
  check("GEN3. ⭐⭐ barieră verde + strict_health roșu → Gate 2 roșu @ strict_health (nu mascat de barieră)",
    r.ok === false && r.stage === "poll" && r.probe === "strict_health");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
})();
