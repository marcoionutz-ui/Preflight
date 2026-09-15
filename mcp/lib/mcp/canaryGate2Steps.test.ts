/**
 * lib/mcp/canaryGate2Steps.test.ts — PH-12 12.5c-3b (adaptoarele reale Gate2Steps, hermetic).
 *
 * Fake-uri: `Gate2Fetch` (înregistrează url/init, întoarce răspuns programat sau aruncă), `spawn`/`stop` fake (procese
 * simulate), `ManagedProc` fake. Zero rețea, zero proces real (adaptorul real e dovedit de canaryWorkerProcess.integration.ts
 * pt. lifecycle + de runnerul opt-in pt. întreg lanțul). Verificăm: construcția env-ului (anti-cost/anti-prod), maparea de
 * stop, combinarea semnalelor, startWorker (config/spawn/abort/stop hooks), fetchHealth (JSON/malformed/unreachable),
 * probele MCP (tool+args corecte, token DOAR în header, abort propagat).
 */

import {
  buildWorkerBaseEnv, mergeAbortSignals, mapManagedStop, makeGate2Steps, realGate2Fetch,
  sweepBackstop, SNAPSHOT_TOOL, HEALTH_TOOL, DEFAULT_STOP_TIMING,
  type Gate2Fetch, type Gate2FetchInit, type WorkerLaunch, type Gate2StepsDeps, type BackstopEntry,
} from "./canaryGate2Steps";
import type { Gate2Targets } from "./canaryGate2";
import type { SpawnSpec, SpawnResult, ManagedProc, ManagedStopResult, StopTiming, StopTimerDeps } from "./canaryWorkerProcess";
import type { FetchResponseLike } from "./canaryFetch";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5c-3b — canaryGate2Steps (adaptoare reale, transport injectat, hermetic)");

// ────────────────────────────── fake-uri ──────────────────────────────

const TARGETS: Gate2Targets = {
  mcpOrigin: "http://127.0.0.1:8080",
  healthUrl: "http://127.0.0.1:8080/api/health?strict=1",
  mcpUrl:    "http://127.0.0.1:8080/api/mcp",
  redisUrl:  "redis://127.0.0.1:6379",
};
const ALCHEMY_WS = "wss://base-mainnet.g.alchemy.com/v2/SUPERSECRETKEY123";
const BASE_ENV: Record<string, string> = { PATH: "/usr/bin", HOME: "/home/x", NODE_ENV: "production" };

interface FetchCap { url: string; init: Gate2FetchInit; }
/** Fetch fake care întoarce un răspuns programat (JSON/text) și înregistrează ultima cerere. */
function fakeFetch(status: number, bodyText: string, headers: Record<string, string>, sink?: { last?: FetchCap; calls?: FetchCap[] }): Gate2Fetch {
  return async (url, init) => {
    // Un semnal DEJA abortat (timeout intern / semnal Gate 2) → aruncă, ca `fetch`-ul real.
    if (init.signal?.aborted) throw new Error("aborted");
    if (sink) { sink.last = { url, init }; (sink.calls ??= []).push({ url, init }); }
    return { status, headers: new Headers(headers), text: async () => bodyText } as FetchResponseLike;
  };
}
function throwingFetch(): Gate2Fetch { return async () => { throw new Error("ECONNREFUSED SECRET"); }; }

function fakeProc(pid = 4242): ManagedProc {
  return {
    pid,
    waitExit: () => Promise.resolve({ kind: "code", code: 0 }),
    signalGroup: () => {},
    groupAlive: () => false,
  };
}
/** spawn fake: succes cu proc dat, sau eșec spawn_failed. Înregistrează spec-ul. */
function fakeSpawn(result: SpawnResult, sink?: { spec?: SpawnSpec; called?: boolean }): (spec: SpawnSpec) => Promise<SpawnResult> {
  return async (spec) => { if (sink) { sink.spec = spec; sink.called = true; } return result; };
}
/** stop fake: întoarce rezultatul dat; înregistrează dacă a fost apelat. */
function fakeStop(result: ManagedStopResult, sink?: { called?: boolean }): (p: ManagedProc, t: StopTiming, d: StopTimerDeps, s?: AbortSignal) => Promise<ManagedStopResult> {
  return async () => { if (sink) sink.called = true; return result; };
}
const NOOP_TIMERS: StopTimerDeps = { setTimer: () => 0, clearTimer: () => {}, now: () => 0 };

/** deps de bază pentru makeGate2Steps, cu spawn/stop/fetch programabile. */
function deps(over: Partial<Omit<Gate2StepsDeps, "launch">> & { launch?: Partial<WorkerLaunch> } = {}): Gate2StepsDeps {
  const launch: WorkerLaunch = {
    command: "npx", args: ["tsx", "src/bootstrap.ts"], cwd: "/repo/workers/evm",
    baseEnv: BASE_ENV, alchemyBaseWs: ALCHEMY_WS,
    ...over.launch,
  };
  return {
    launch,
    fetchFn:    over.fetchFn    ?? fakeFetch(200, "{}", { "content-type": "application/json" }),
    spawn:      over.spawn      ?? fakeSpawn({ ok: true, proc: fakeProc() }),
    stop:       over.stop       ?? fakeStop({ ok: true, teardownConfirmed: true }),
    stopTimers: over.stopTimers ?? NOOP_TIMERS,
    stopTiming: over.stopTiming,
    timeoutMs:  over.timeoutMs,
    onSpawn:    over.onSpawn,
    onStopResult: over.onStopResult,
  };
}

// JSON-RPC result de succes pt. un tool MCP (id=1, așa cum trimite callMcpTool).
function mcpOkBody(structured: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }], structuredContent: structured } });
}

async function main(): Promise<void> {
  // ────────────── A. buildWorkerBaseEnv (anti-cost / anti-prod) ──────────────
  {
    const r = buildWorkerBaseEnv(BASE_ENV, TARGETS.redisUrl, ALCHEMY_WS);
    check("A1. ⭐⭐⭐ env valid → ENABLED_CHAINS=base, PREFLIGHT_MODE=LIVE, ALCHEMY_BASE_WS, REDIS_URL",
      r.ok && r.env.ENABLED_CHAINS === "base" && r.env.PREFLIGHT_MODE === "LIVE" && r.env.ALCHEMY_BASE_WS === ALCHEMY_WS && r.env.REDIS_URL === TARGETS.redisUrl);
    check("A1b. ⭐⭐ baseEnv păstrat (PATH/HOME/NODE_ENV)", r.ok && r.env.PATH === "/usr/bin" && r.env.HOME === "/home/x" && r.env.NODE_ENV === "production");
  }
  {
    // Cheile de control SUPRASCRIU orice ar veni din baseEnv/extraEnv (garanție base-only / LIVE / loopback).
    const poisoned = { ...BASE_ENV, ENABLED_CHAINS: "base,arbitrum", PREFLIGHT_MODE: "DEV", REDIS_URL: "redis://prod:6379" };
    const r = buildWorkerBaseEnv(poisoned, TARGETS.redisUrl, ALCHEMY_WS, { PREFLIGHT_MODE: "DEV", ENABLED_CHAINS: "ethereum" });
    check("A2. ⭐⭐⭐ cheile de control suprascriu baseEnv+extraEnv (ENABLED_CHAINS=base, LIVE, REDIS loopback)",
      r.ok && r.env.ENABLED_CHAINS === "base" && r.env.PREFLIGHT_MODE === "LIVE" && r.env.REDIS_URL === TARGETS.redisUrl);
  }
  {
    const r = buildWorkerBaseEnv(BASE_ENV, TARGETS.redisUrl, ALCHEMY_WS, { ALCHEMY_BASE_RPC: "https://base.example/v2/K" });
    check("A3. ⭐⭐ extraEnv non-control păstrat (ALCHEMY_BASE_RPC)", r.ok && r.env.ALCHEMY_BASE_RPC === "https://base.example/v2/K");
  }
  {
    const empty = buildWorkerBaseEnv(BASE_ENV, TARGETS.redisUrl, "");
    const http  = buildWorkerBaseEnv(BASE_ENV, TARGETS.redisUrl, "http://x/v2/K");
    const frag  = buildWorkerBaseEnv(BASE_ENV, TARGETS.redisUrl, "wss://x/v2/K#f");
    check("A4. ⭐⭐⭐ ALCHEMY_BASE_WS gol → config (scan-only silent evitat)", !empty.ok);
    check("A5. ⭐⭐⭐ ALCHEMY_BASE_WS schemă non-ws → config", !http.ok);
    check("A6. ⭐⭐ ALCHEMY_BASE_WS cu #fragment → config", !frag.ok);
  }
  {
    // ⭐ fix cgpt: cheia Alchemy traversează rețeaua → cere wss:// (nu ws:// clar), host prezent, fără userinfo.
    const wsPlain = buildWorkerBaseEnv(BASE_ENV, TARGETS.redisUrl, "ws://base.alchemy.com/v2/SECRET");
    const wsUser  = buildWorkerBaseEnv(BASE_ENV, TARGETS.redisUrl, "wss://user:pass@base.alchemy.com/v2/K");
    const wsOk    = buildWorkerBaseEnv(BASE_ENV, TARGETS.redisUrl, "wss://base-mainnet.g.alchemy.com/v2/K");
    check("A5b. ⭐⭐⭐ ALCHEMY_BASE_WS ws:// clar → config (cheia ar traversa necriptat)", !wsPlain.ok);
    check("A5c. ⭐⭐⭐ ALCHEMY_BASE_WS cu userinfo (user:pass@) → config", !wsUser.ok);
    check("A5d. ⭐⭐ ALCHEMY_BASE_WS wss:// cu host → ok", wsOk.ok === true);
  }
  {
    const ext  = buildWorkerBaseEnv(BASE_ENV, "redis://10.0.0.5:6379", ALCHEMY_WS);
    const bad  = buildWorkerBaseEnv(BASE_ENV, "http://127.0.0.1:6379", ALCHEMY_WS);
    check("A7. ⭐⭐⭐ REDIS_URL non-loopback → config (anti-prod)", !ext.ok);
    check("A8. ⭐⭐ REDIS_URL schemă greșită → config", !bad.ok);
  }
  {
    // ANTI-LEAK: reason-ul de eșec NU ecouă valoarea secretă a WS-ului.
    const r = buildWorkerBaseEnv(BASE_ENV, TARGETS.redisUrl, "wss://x/v2/SECRETKEY#frag");
    check("A9. ⭐⭐⭐ reason NU ecouă secretul din ALCHEMY_BASE_WS (anti-leak)", !r.ok && !/SECRETKEY/.test(r.reason));
  }
  {
    // ⭐ fix cgpt P1: tokenul Gate 2 (GATE2_*) NU are voie în env-ul worker-ului (un baseEnv:{...process.env} naiv l-ar căra).
    const poisoned = { ...BASE_ENV, GATE2_ACCESS_TOKEN: "SECRET_BEARER", GATE2_DEBUG: "1" };
    const r = buildWorkerBaseEnv(poisoned, TARGETS.redisUrl, ALCHEMY_WS);
    check("A10. ⭐⭐⭐ GATE2_ACCESS_TOKEN + GATE2_* STRIPATE din env-ul worker-ului (anti-leak)",
      r.ok && r.env.GATE2_ACCESS_TOKEN === undefined && r.env.GATE2_DEBUG === undefined && r.env.PATH === "/usr/bin");
  }

  // ────────────── B. mergeAbortSignals ──────────────
  {
    check("B1. ⭐ niciun semnal → undefined", mergeAbortSignals(undefined, undefined) === undefined);
    const a = new AbortController();
    check("B2. ⭐⭐ un singur semnal → identitate (fără AbortSignal.any inutil)", mergeAbortSignals(a.signal, undefined) === a.signal);
    const c1 = new AbortController(), c2 = new AbortController();
    const merged = mergeAbortSignals(c1.signal, c2.signal)!;
    const before = merged.aborted;
    c2.abort();
    check("B3. ⭐⭐⭐ două semnale → abort din oricare propagă", !before && merged.aborted);
    const ab = new AbortController(); ab.abort();
    const m2 = mergeAbortSignals(ab.signal, new AbortController().signal)!;
    check("B4. ⭐⭐ semnal deja abortat → merged abortat", m2.aborted);
  }

  // ────────────── C. mapManagedStop ──────────────
  {
    check("C1. ⭐⭐⭐ ok:true → {ok:true}", mapManagedStop({ ok: true, teardownConfirmed: true }).ok === true);
    const f = mapManagedStop({ ok: false, code: "stop_failed", teardownConfirmed: true });
    check("C2. ⭐⭐ stop_failed → {ok:false, stop_failed}", !f.ok && f.code === "stop_failed");
    const t0 = mapManagedStop({ ok: false, code: "stop_timeout", teardownConfirmed: false });
    const t1 = mapManagedStop({ ok: false, code: "stop_timeout", teardownConfirmed: true });
    check("C3. ⭐⭐⭐ stop_timeout (neconfirmat) → {ok:false, stop_timeout}", !t0.ok && t0.code === "stop_timeout");
    check("C4. ⭐⭐ stop_timeout (confirmat, dar a cerut SIGKILL) → tot roșu stop_timeout", !t1.ok && t1.code === "stop_timeout");
  }

  // ────────────── D. startWorker ──────────────
  {
    // D1: spawn eșuează → spawn_failed.
    const steps = makeGate2Steps(deps({ spawn: fakeSpawn({ ok: false, code: "spawn_failed" }) }), TARGETS);
    const r = await steps.startWorker(new AbortController().signal);
    check("D1. ⭐⭐⭐ spawn eșuat → {ok:false, spawn_failed}", !r.ok && r.code === "spawn_failed");
  }
  {
    // D2: env invalid (ALCHEMY gol) → config, spawn NEapelat.
    const sink: { called?: boolean } = {};
    const steps = makeGate2Steps(deps({ launch: { alchemyBaseWs: "" }, spawn: fakeSpawn({ ok: true, proc: fakeProc() }, sink as { spec?: SpawnSpec; called?: boolean }) }), TARGETS);
    const r = await steps.startWorker(new AbortController().signal);
    check("D2. ⭐⭐⭐ env invalid → {ok:false, config} + spawn NEapelat (zero cost)", !r.ok && r.code === "config" && sink.called !== true);
  }
  {
    // D3: semnal deja abortat → spawn_failed, spawn NEapelat.
    const sink: { called?: boolean; spec?: SpawnSpec } = {};
    const ac = new AbortController(); ac.abort();
    const steps = makeGate2Steps(deps({ spawn: fakeSpawn({ ok: true, proc: fakeProc() }, sink) }), TARGETS);
    const r = await steps.startWorker(ac.signal);
    check("D3. ⭐⭐⭐ semnal deja abortat → spawn_failed + spawn NEapelat (fereastră închisă → fără worker)", !r.ok && r.code === "spawn_failed" && sink.called !== true);
  }
  {
    // D4: spawn ok → stop capabil; onSpawn apelat; spec corect.
    const spawnSink: { spec?: SpawnSpec; called?: boolean } = {};
    const spawnedProc = fakeProc(999);
    let onSpawnGot: ManagedProc | null = null;
    const steps = makeGate2Steps(deps({
      spawn: fakeSpawn({ ok: true, proc: spawnedProc }, spawnSink),
      onSpawn: (p) => { onSpawnGot = p; },
    }), TARGETS);
    const r = await steps.startWorker(new AbortController().signal);
    check("D4. ⭐⭐⭐ spawn ok → {ok:true, stop}", r.ok === true && typeof (r as { stop?: unknown }).stop === "function");
    check("D4b. ⭐⭐ onSpawn primește proc-ul spawnat (registrul de backstop al runnerului)", onSpawnGot === spawnedProc);
    check("D4c. ⭐⭐⭐ spec: command/args/cwd + env de control", !!spawnSink.spec && spawnSink.spec.command === "npx" && spawnSink.spec.args[1] === "src/bootstrap.ts" && spawnSink.spec.cwd === "/repo/workers/evm" && spawnSink.spec.env.ENABLED_CHAINS === "base" && spawnSink.spec.env.PREFLIGHT_MODE === "LIVE");
    check("D4d. ⭐⭐ onDebugLine OMIS din spec când lipsește (stderr=ignore, anti-leak default)", !!spawnSink.spec && spawnSink.spec.onDebugLine === undefined);
  }
  {
    // D4e: onDebugLine forward când e dat.
    const spawnSink: { spec?: SpawnSpec } = {};
    const dbg = (_l: string) => {};
    const steps = makeGate2Steps(deps({ launch: { onDebugLine: dbg }, spawn: fakeSpawn({ ok: true, proc: fakeProc() }, spawnSink as { spec?: SpawnSpec; called?: boolean }) }), TARGETS);
    await steps.startWorker(new AbortController().signal);
    check("D4e. ⭐⭐ onDebugLine forward în spec când e furnizat", spawnSink.spec?.onDebugLine === dbg);
  }
  {
    // D4f (decisiv fix cgpt P1): tokenul Gate 2 din baseEnv NU ajunge în SpawnSpec.env.
    const spawnSink: { spec?: SpawnSpec } = {};
    const steps = makeGate2Steps(deps({
      launch: { baseEnv: { ...BASE_ENV, GATE2_ACCESS_TOKEN: "SECRET_BEARER" } },
      spawn: fakeSpawn({ ok: true, proc: fakeProc() }, spawnSink as { spec?: SpawnSpec; called?: boolean }),
    }), TARGETS);
    await steps.startWorker(new AbortController().signal);
    check("D4f. ⭐⭐⭐ SpawnSpec.env NU conține GATE2_ACCESS_TOKEN (tokenul nu ajunge în worker)",
      !!spawnSink.spec && spawnSink.spec.env.GATE2_ACCESS_TOKEN === undefined && !JSON.stringify(spawnSink.spec.env).includes("SECRET_BEARER"));
  }
  {
    // D6 (decisiv fix cgpt): un onSpawn care ARUNCĂ NU pierde ownership-ul — startWorker tot întoarce {ok:true, stop}.
    const steps = makeGate2Steps(deps({ onSpawn: () => { throw new Error("hook boom"); } }), TARGETS);
    const r = await steps.startWorker(new AbortController().signal);
    check("D6. ⭐⭐⭐ onSpawn aruncă → startWorker tot {ok:true, stop} (ownership păstrat, fără orfan)", r.ok === true && typeof (r as { stop?: unknown }).stop === "function");
    if (r.ok) {
      const s = await r.stop(new AbortController().signal);
      check("D6b. ⭐⭐⭐ onStopResult aruncă → stop tot întoarce rezultatul mapat (teardown deja făcut)", s.ok === true);
    }
  }
  {
    // onStopResult aruncă DAR stop returnează mapat.
    const steps = makeGate2Steps(deps({ stop: fakeStop({ ok: false, code: "stop_timeout", teardownConfirmed: false }), onStopResult: () => { throw new Error("boom"); } }), TARGETS);
    const s = await steps.startWorker(new AbortController().signal);
    if (s.ok) {
      const r = await s.stop(new AbortController().signal);
      check("D6c. ⭐⭐ onStopResult aruncă pe stop eșuat → tot {ok:false, stop_timeout} (lifecycle controlat)", !r.ok && r.code === "stop_timeout");
    } else check("D6c", false);
  }
  {
    // D5: stop mapează fiecare rezultat + onStopResult primește REZULTATUL real (cu teardownConfirmed).
    for (const [label, real, wantOk, wantCode] of [
      ["ok:true",       { ok: true, teardownConfirmed: true },                       true,  undefined],
      ["stop_failed",   { ok: false, code: "stop_failed", teardownConfirmed: true }, false, "stop_failed"],
      ["stop_timeout",  { ok: false, code: "stop_timeout", teardownConfirmed: false },false, "stop_timeout"],
    ] as const) {
      let got: ManagedStopResult | null = null;
      const steps = makeGate2Steps(deps({ stop: fakeStop(real as ManagedStopResult), onStopResult: (r) => { got = r; } }), TARGETS);
      const s = await steps.startWorker(new AbortController().signal);
      if (!s.ok) { check(`D5.${label}`, false); continue; }
      const res = await s.stop(new AbortController().signal);
      const okMatch = wantOk ? res.ok === true : (!res.ok && res.code === wantCode);
      check(`D5. ⭐⭐⭐ stop(${label}) → mapat + onStopResult primește rezultatul REAL (teardownConfirmed)`, okMatch && got === real);
    }
  }

  // ────────────── E. fetchHealth ──────────────
  {
    const sink: { last?: FetchCap } = {};
    const body = { status: "ok", httpStatus: 200, scope: "mcp-web", checks: {} };
    const steps = makeGate2Steps(deps({ fetchFn: fakeFetch(200, JSON.stringify(body), { "content-type": "application/json" }, sink) }), TARGETS);
    const r = await steps.fetchHealth(new AbortController().signal);
    check("E1. ⭐⭐⭐ fetchHealth: JSON valid → {ok:true, body parsat}", r.ok === true && (r as { body: { httpStatus: number } }).body.httpStatus === 200);
    check("E1b. ⭐⭐ GET pe targets.healthUrl", sink.last?.init.method === "GET" && sink.last?.url === TARGETS.healthUrl);
  }
  {
    // strict-degraded = 503 CU raport JSON valid → tot {ok:true, body} (orchestratorul citește body.httpStatus).
    const body = { status: "degraded", httpStatus: 503, scope: "mcp-web", checks: {} };
    const steps = makeGate2Steps(deps({ fetchFn: fakeFetch(503, JSON.stringify(body), { "content-type": "application/json" }) }), TARGETS);
    const r = await steps.fetchHealth(new AbortController().signal);
    check("E2. ⭐⭐⭐ 503 cu raport JSON → {ok:true, body} (nu gatăm pe res.status)", r.ok === true && (r as { body: { httpStatus: number } }).body.httpStatus === 503);
  }
  {
    const steps = makeGate2Steps(deps({ fetchFn: fakeFetch(200, "<html>not json</html>", { "content-type": "text/html" }) }), TARGETS);
    const r = await steps.fetchHealth(new AbortController().signal);
    check("E3. ⭐⭐⭐ body non-JSON → {ok:false, malformed_json}", !r.ok && (r as { code: string }).code === "malformed_json");
  }
  {
    const steps = makeGate2Steps(deps({ fetchFn: throwingFetch() }), TARGETS);
    const r = await steps.fetchHealth(new AbortController().signal);
    check("E4. ⭐⭐⭐ fetch throw → {ok:false, unreachable} (fără leak)", !r.ok && (r as { code: string }).code === "unreachable");
  }
  {
    // Semnal Gate 2 deja abortat → merged abortat → fake aruncă → unreachable.
    const ac = new AbortController(); ac.abort();
    const steps = makeGate2Steps(deps({ fetchFn: fakeFetch(200, "{}", {}) }), TARGETS);
    const r = await steps.fetchHealth(ac.signal);
    check("E5. ⭐⭐⭐ semnal Gate 2 abortat → cererea se anulează → unreachable", !r.ok && (r as { code: string }).code === "unreachable");
  }
  {
    // E6 (decisiv fix cgpt P1): HTTP 503 REAL + body care MINTE `httpStatus:200` → status_mismatch (NU suprascriem).
    const lying = { status: "ok", httpStatus: 200, scope: "mcp-web", checks: {} };
    const steps = makeGate2Steps(deps({ fetchFn: fakeFetch(503, JSON.stringify(lying), { "content-type": "application/json" }) }), TARGETS);
    const r = await steps.fetchHealth(new AbortController().signal);
    check("E6. ⭐⭐⭐ 503 real + corp httpStatus:200 → status_mismatch (fail-closed, nu suprascriem)", !r.ok && (r as { code: string }).code === "status_mismatch");
  }
  {
    // E7 (decisiv fix cgpt P1, INVERS): HTTP 200 REAL + body care declară `httpStatus:503` → tot status_mismatch.
    const lying = { status: "degraded", httpStatus: 503, scope: "mcp-web", checks: {} };
    const steps = makeGate2Steps(deps({ fetchFn: fakeFetch(200, JSON.stringify(lying), { "content-type": "application/json" }) }), TARGETS);
    const r = await steps.fetchHealth(new AbortController().signal);
    check("E7. ⭐⭐⭐ INVERS: 200 real + corp httpStatus:503 → status_mismatch (suprascrierea ar fi mascat-o)", !r.ok && (r as { code: string }).code === "status_mismatch");
  }
  {
    // E8 (decisiv): HTTP 503 + body CONCORDANT httpStatus:503 → parsat pt. polling (ok:true, corp NEATINS); niciodată verde.
    const concordant = { status: "degraded", httpStatus: 503, scope: "mcp-web", checks: {} };
    const steps = makeGate2Steps(deps({ fetchFn: fakeFetch(503, JSON.stringify(concordant), { "content-type": "application/json" }) }), TARGETS);
    const r = await steps.fetchHealth(new AbortController().signal);
    check("E8. ⭐⭐⭐ 503 concordant → {ok:true, body neatins} (parsat pt. polling; assertStrictHealthy îl va face roșu)",
      r.ok === true && (r as { body: { httpStatus: number; status: string } }).body.httpStatus === 503 && (r as { body: { status: string } }).body.status === "degraded");
  }

  // ────────────── F. probele MCP ──────────────
  {
    const sink: { last?: FetchCap } = {};
    const steps = makeGate2Steps(deps({ fetchFn: fakeFetch(200, mcpOkBody({ ok: true, data: { total: 5 } }), { "content-type": "application/json" }, sink) }), TARGETS);
    const r = await steps.mcpWorkerSnapshot("SECRET_AT", new AbortController().signal);
    check("F1. ⭐⭐⭐ mcpWorkerSnapshot → McpCallResult ok cu structuredContent", r.ok === true && !!(r as { structuredContent?: unknown }).structuredContent);
    const bodyStr = sink.last?.init.body ?? "";
    check("F1b. ⭐⭐⭐ cerere pe mcpUrl, tool=tp_worker_snapshot, arguments={chain:base}", sink.last?.url === TARGETS.mcpUrl && bodyStr.includes(SNAPSHOT_TOOL) && bodyStr.includes("\"chain\":\"base\""));
    check("F1c. ⭐⭐⭐ token DOAR în header Authorization, NICIODATĂ în corp (anti-leak)", sink.last?.init.headers?.["Authorization"] === "Bearer SECRET_AT" && !bodyStr.includes("SECRET_AT"));
  }
  {
    const sink: { last?: FetchCap } = {};
    const steps = makeGate2Steps(deps({ fetchFn: fakeFetch(200, mcpOkBody({ ok: true }), { "content-type": "application/json" }, sink) }), TARGETS);
    const r = await steps.mcpHealthCheck("AT2", new AbortController().signal);
    const bodyStr = sink.last?.init.body ?? "";
    check("F2. ⭐⭐⭐ mcpHealthCheck → ok, tool=tp_health_check, arguments={} (fără chain)", r.ok === true && bodyStr.includes(HEALTH_TOOL) && !bodyStr.includes("\"chain\""));
  }
  {
    // Semnal Gate 2 abortat → fake aruncă → callMcpTool clasifică transport.
    const ac = new AbortController(); ac.abort();
    const steps = makeGate2Steps(deps({ fetchFn: fakeFetch(200, mcpOkBody({ ok: true }), {}) }), TARGETS);
    const r = await steps.mcpWorkerSnapshot("AT", ac.signal);
    check("F3. ⭐⭐⭐ semnal Gate 2 abortat pe MCP → transport (cerere anulată)", !r.ok && (r as { stage: string }).stage === "transport");
  }

  // ────────────── H. sweepBackstop (refolosește lifecycle-ul 3a, bounded) ──────────────
  {
    // Intrare DEJA confirmată → NEatinsă (nu re-oprim un proc curat).
    let called = 0;
    const entries: BackstopEntry[] = [{ proc: fakeProc(1), confirmed: true }];
    const s = await sweepBackstop(entries, async () => { called++; return { ok: true, teardownConfirmed: true }; });
    check("H1. ⭐⭐ intrare confirmată → NEatinsă (swept 0)", s.swept === 0 && called === 0);
  }
  {
    // Neconfirmat → re-stop cu lifecycle-ul 3a; confirmă → confirmed + latch pe intrare.
    const entries: BackstopEntry[] = [{ proc: fakeProc(2), confirmed: false }];
    const s = await sweepBackstop(entries, async () => ({ ok: false, code: "stop_timeout", teardownConfirmed: true }));
    check("H2. ⭐⭐⭐ neconfirmat → re-stop → teardownConfirmed → confirmed + latch pe intrare", s.swept === 1 && s.confirmed === 1 && s.orphan === 0 && entries[0].confirmed === true);
  }
  {
    // Neconfirmat + re-stop tot neconfirmat → orphan (raportat, nemascat).
    const entries: BackstopEntry[] = [{ proc: fakeProc(3), confirmed: false }];
    const s = await sweepBackstop(entries, async () => ({ ok: false, code: "stop_timeout", teardownConfirmed: false }));
    check("H3. ⭐⭐⭐ re-stop tot neconfirmat → orphan (posibil consumator Alchemy viu, raportat)", s.orphan === 1 && s.confirmed === 0 && entries[0].confirmed === false);
  }
  {
    // Stop-ul aruncă → orphan (nu putem confirma).
    const entries: BackstopEntry[] = [{ proc: fakeProc(4), confirmed: false }];
    const s = await sweepBackstop(entries, async () => { throw new Error("kill boom"); });
    check("H4. ⭐⭐ stop aruncă → orphan (fail-closed)", s.orphan === 1 && s.swept === 1);
  }

  // ────────────── G. defaults + sanity ──────────────
  {
    check("G1. ⭐ DEFAULT_STOP_TIMING: grace 13s > deadline intern PH-13 (10s)", DEFAULT_STOP_TIMING.workerShutdownGraceMs === 13_000 && DEFAULT_STOP_TIMING.workerShutdownGraceMs > 10_000);
    check("G2. ⭐ realGate2Fetch e funcție (adaptorul real peste fetch global)", typeof realGate2Fetch === "function");
  }

  console.log(`\n${passed}/${passed + failed} OK` + (failed ? `  —  ${failed} FAIL` : ""));
  if (failed) process.exit(1);
}

main().catch((e) => { console.error("EROARE test:", e); process.exit(1); });
