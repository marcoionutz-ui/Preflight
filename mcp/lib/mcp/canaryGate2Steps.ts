/**
 * lib/mcp/canaryGate2Steps.ts — PH-12 12.5c-3b (adaptoarele REALE `Gate2Steps` pentru orchestratorul Gate 2).
 *
 * `canaryGate2.ts` (12.5c-2) e PUR: primește `makeSteps(targets) => Gate2Steps` cu pașii de I/O injectați. ACEST modul
 * furnizează implementarea REALĂ a acelor pași, legând:
 *   - `startWorker`/`stop` → lifecycle-ul de PROCES din 12.5c-3a (`spawnManagedProcess`/`stopManagedProcess`, group-kill
 *     detached, teardown confirmat = grup dispărut + lider reap-uit) → NICIUN consumator Alchemy orfan după Gate 2.
 *   - `fetchHealth` → GET `/api/health?strict=1` (corpul brut; codul HTTP e în `body.httpStatus`, orchestratorul asertă).
 *   - `mcpWorkerSnapshot`/`mcpHealthCheck` → `callMcpTool` (12.5b-2) peste `PostJson` real (12.5b-4a) cu `Bearer`.
 *
 * Transportul e INJECTAT (fetch/spawn/stop) → leaf-ul e testabil HERMETIC în cloud, ÎNAINTE de a lovi stack-ul real
 * (worker + MCP + Redis) în runnerul opt-in `runGate2Live.mjs`. Doctrina 12.5b (leaf-first, transport injectat).
 *
 * ⚠️ SEMNAL: `makeFetchPostJson` (12.5b-4a) NU are parametru de semnal — își pune propriul `AbortController` de timeout
 * intern. Ca semnalul Gate 2 (deadline-ul orchestratorului per-probă) să ANULEZE efectiv fetch-ul MCP, injectăm un
 * `fetch` care combină semnalul intern de timeout cu semnalul Gate 2 prin `AbortSignal.any([intern, gate2])`. La abort
 * din oricare parte, cererea se anulează (nu doar „nu mai așteptăm").
 *
 * ANTI-LEAK (regula Marco): `Bearer`/ALCHEMY key trăiesc DOAR în header/env, niciodată în vreun `reason`; validatorul de
 * env NU ecouă valoarea; erorile de pas rămân codurile ÎNCHISE ale contractului (`spawn_failed`/`config`/`unreachable`/…).
 *
 * ⚠️ TREI durate distincte (lock cgpt 12.5c-3a, NU le confunda): `StopTiming.workerShutdownGraceMs` (13_000, SIGTERM→
 * SIGKILL, > deadline-ul intern PH-13 de 10s al worker-ului) ≠ `Gate2Timing.graceMs` (5_000, confirmare post-abort în
 * orchestrator) ≠ `Gate2Timing.stopTimeoutMs` (bugetul orchestratorului pe `stop`).
 */

import type {
  Gate2Steps, Gate2Targets, WorkerStartResult, WorkerStopResult, HealthFetchResult,
} from "./canaryGate2";
import type { McpCallResult } from "./canaryMcpClient";
import { callMcpTool } from "./canaryMcpClient";
import type { FetchFn, FetchResponseLike } from "./canaryFetch";
import { makeFetchPostJson, DEFAULT_CANARY_TIMEOUT_MS } from "./canaryFetch";
import {
  spawnManagedProcess, stopManagedProcess, realStopTimers,
  type SpawnSpec, type SpawnResult, type ManagedProc, type ManagedStopResult,
  type StopTiming, type StopTimerDeps,
} from "./canaryWorkerProcess";

// ────────────────────────────── constante de tool + timing worker ──────────────────────────────

/** Tool-urile MCP PH-14 pe care le sondăm (recon 12.5c). `tp_worker_snapshot` cere `{chain}`; `tp_health_check` fără args. */
export const SNAPSHOT_TOOL = "tp_worker_snapshot";
export const HEALTH_TOOL   = "tp_health_check";

/** Timing implicit de teardown (lock Marco): grace 13s > deadline-ul intern PH-13 (10s) → shutdown ordonat, apoi SIGKILL. */
export const DEFAULT_STOP_TIMING: StopTiming = { workerShutdownGraceMs: 13_000, killConfirmIntervalMs: 100, killConfirmMaxMs: 5_000 };

// ────────────────────────────── fetch injectabil (superset GET/POST) ──────────────────────────────

/** Init minimal (superset peste `FetchInit` din canaryFetch: `method` e `string`, nu doar `"POST"` → acoperă GET-ul de health). */
export interface Gate2FetchInit { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; }
export type Gate2Fetch = (url: string, init: Gate2FetchInit) => Promise<FetchResponseLike>;

/** Adaptor real peste `fetch`-ul global. `Response` e structural compatibil cu `FetchResponseLike` (status/headers/text). */
export const realGate2Fetch: Gate2Fetch = (url, init) =>
  (fetch as unknown as (u: string, i: Gate2FetchInit) => Promise<FetchResponseLike>)(url, init);

/**
 * Combină semnale de abort: întoarce `undefined` dacă niciunul nu-i definit, semnalul unic dacă e doar unul, altfel
 * `AbortSignal.any([...])` (abort din oricare le propagă). Un semnal DEJA abortat se propagă imediat prin `any`.
 */
export function mergeAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}

// ────────────────────────────── validatoare de env worker (PURE, anti-cost/anti-prod) ──────────────────────────────

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Prefixe de env care NU au voie să ajungă în procesul worker: variabilele runner-only care pot purta SECRETE de canary
 * (ex. `GATE2_ACCESS_TOKEN` = Bearer-ul Gate 2). Worker-ul nu are nevoie de ele; le stripuim din env-ul de spawn ca un
 * `baseEnv: {...process.env}` naiv să NU scurgă tokenul într-un proces copil. `GATE2_DEBUG` (tot runner-only) la fel.
 */
export const WORKER_ENV_DENYLIST_PREFIXES: readonly string[] = ["GATE2_"];

/**
 * `ALCHEMY_BASE_WS` valid pentru cheia Alchemy: **`wss://` OBLIGATORIU** (cheia e în path — `ws://` clar ar trimite-o
 * necriptat prin rețea), host PREZENT, FĂRĂ userinfo (`user:pass@` = credențiale în URL) și fără `#fragment` (clientul
 * WS îl respinge). NU ecouă valoarea (secret).
 */
function isWorkerWsUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "wss:") return false;                  // cheia traversează rețeaua → cere TLS (nu ws:// clar)
  if (u.hostname === "") return false;                      // host prezent
  if (u.username !== "" || u.password !== "") return false; // fără credențiale în URL
  if (u.hash !== "") return false;                          // `#fragment` → clientul WS îl respinge
  return true;
}

/** `REDIS_URL` acceptat DOAR pe loopback + schemă redis(s) — anti-prod (workerul nu pornește pe un Redis extern). */
function isLoopbackRedisUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") return false;
  return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
}

export type WorkerEnvResult = { ok: true; env: Record<string, string> } | { ok: false; reason: string };

/**
 * Construiește env-ul Worker Base pentru spawn: peste `baseEnv` (PATH/HOME/NODE_ENV… de la runner) suprapune EXACT
 * cheile de control — `ENABLED_CHAINS=base`, `PREFLIGHT_MODE=LIVE`, `ALCHEMY_BASE_WS`, `REDIS_URL` — ULTIMELE, ca un
 * `baseEnv`/`extraEnv` care ar conține din greșeală `ENABLED_CHAINS=base,arbitrum` (alt chain = alt cost RPC) SAU
 * `PREFLIGHT_MODE=DEV` (scan-only tăcut) să NU poată submina garanția leaf-ului. Fail-closed ÎNAINTE de orice spawn:
 *   - `ALCHEMY_BASE_WS` gol/invalid → `config` (fără el, LIVE ar rula base scan-only tăcut → date absente + nicio dovadă WS);
 *   - `REDIS_URL` non-loopback → `config` (anti-prod: nu pornim un consumator Alchemy pe Redis-ul de producție).
 * Mesajele NU ecouă valorile (secret/injecție în boot-log).
 */
export function buildWorkerBaseEnv(
  baseEnv:       Record<string, string>,
  redisUrl:      string,
  alchemyBaseWs: string,
  extraEnv?:     Record<string, string>,
): WorkerEnvResult {
  if (!isWorkerWsUrl(alchemyBaseWs)) return { ok: false, reason: "ALCHEMY_BASE_WS lipsă/invalid (cere wss://, host, fără userinfo/#fragment) — LIVE ar rula base scan-only sau ar scurge cheia" };
  if (!isLoopbackRedisUrl(redisUrl)) return { ok: false, reason: "REDIS_URL non-loopback/schemă greșită — refuz (anti-prod)" };
  const env: Record<string, string> = {
    ...baseEnv,
    ...(extraEnv ?? {}),
    // Cheile de control — SUPRASCRIU orice ar veni din baseEnv/extraEnv (garanție: base-only, LIVE, WS real, Redis loopback).
    ENABLED_CHAINS:  "base",
    PREFLIGHT_MODE:  "LIVE",
    ALCHEMY_BASE_WS: alchemyBaseWs,
    REDIS_URL:       redisUrl,
  };
  // Strip runner-only secrets (GATE2_*) — un `baseEnv:{...process.env}` naiv ar căra `GATE2_ACCESS_TOKEN` (Bearer-ul
  // Gate 2) în procesul worker. Worker-ul nu-l folosește; îl ținem AFARĂ din env-ul de spawn.
  for (const k of Object.keys(env)) {
    if (WORKER_ENV_DENYLIST_PREFIXES.some((p) => k.startsWith(p))) delete env[k];
  }
  return { ok: true, env };
}

// ────────────────────────────── config de lansare a worker-ului (injectat de runner) ──────────────────────────────

/**
 * Cum se lansează Worker Base. Runnerul (care știe path-urile reale ~/preflight/workers/evm + `ALCHEMY_BASE_WS` din env)
 * completează asta; leaf-ul doar construiește env-ul + cablează spawn/stop. `command`/`args`/`cwd` injectate → pure la test.
 * Exemplu real: `{ command:"npx", args:["tsx","src/bootstrap.ts"], cwd:"…/workers/evm", … }`.
 */
export interface WorkerLaunch {
  command:       string;
  args:          readonly string[];
  cwd:           string;
  baseEnv:       Record<string, string>;  // env de bază pe care worker-ul îl primește (spawn înlocuiește process.env)
  alchemyBaseWs: string;                   // ALCHEMY_BASE_WS (secret în path); validat înainte de spawn
  extraEnv?:     Record<string, string>;   // opțional (ex. ALCHEMY_BASE_RPC) — NU poate suprascrie cheile de control
  onDebugLine?:  (line: string) => void;   // debug OPT-IN (stderr redactat linie cu linie); fără el, stderr = ignore
}

// ────────────────────────────── deps injectabile (spawn/stop/fetch + hooks runner) ──────────────────────────────

export interface Gate2StepsDeps {
  launch:        WorkerLaunch;
  fetchFn?:      Gate2Fetch;   // default: realGate2Fetch
  spawn?:        (spec: SpawnSpec) => Promise<SpawnResult>;                                                         // default: spawnManagedProcess
  stop?:         (proc: ManagedProc, timing: StopTiming, deps: StopTimerDeps, signal?: AbortSignal) => Promise<ManagedStopResult>; // default: stopManagedProcess
  stopTimers?:   StopTimerDeps; // default: realStopTimers
  stopTiming?:   StopTiming;    // default: DEFAULT_STOP_TIMING
  timeoutMs?:    number;        // timeout fetch (health + MCP); default DEFAULT_CANARY_TIMEOUT_MS
  /** Hook: proc-ul spawnat, pentru registrul de backstop al runnerului (sweep independent anti-orfan). */
  onSpawn?:      (proc: ManagedProc) => void;
  /** Hook: rezultatul REAL al stop-ului (cu `teardownConfirmed`) — runnerul latch-uiește din el, fără re-sondare pgid. */
  onStopResult?: (r: ManagedStopResult) => void;
}

// ────────────────────────────── maparea rezultatului de stop (3a → contractul Gate 2) ──────────────────────────────

/**
 * `ManagedStopResult` (3a, cu `teardownConfirmed`) → `WorkerStopResult` (contractul Gate 2). Codul e păstrat structural:
 * `ok:true`→`{ok:true}`; `stop_failed`/`stop_timeout`→`{ok:false, code}`. `teardownConfirmed` e RAPORTAT separat prin
 * `onStopResult` (runnerul îl folosește pt. latch-ul anti-orfan); pentru VERDICTUL Gate 2, orice `{ok:false}` = roșu
 * (un worker care a cerut SIGKILL, chiar cu grup confirmat gol, e un shutdown PH-13 rupt — semnal real).
 */
export function mapManagedStop(r: ManagedStopResult): WorkerStopResult {
  return r.ok ? { ok: true } : { ok: false, code: r.code };
}

// ────────────────────────────── backstop anti-orfan (REFOLOSEȘTE lifecycle-ul 3a, bounded) ──────────────────────────────

/** Intrare de registru: un proc spawnat + dacă teardown-ul lui a fost DEJA confirmat (latch din `onStopResult`, fără re-sondare pgid). */
export interface BackstopEntry { proc: ManagedProc; confirmed: boolean; }
export interface BackstopSummary { swept: number; confirmed: number; orphan: number; }

/**
 * Plasa finală anti-orfan a runnerului: pentru fiecare proc NEconfirmat (stop-ul normal al orchestratorului n-a putut
 * dovedi teardown-ul), RErulează lifecycle-ul CONFIRMAT din 3a (`stop` injectat = `stopManagedProcess`: SIGTERM pe grup →
 * grace → SIGKILL → confirmă grup dispărut ȘI lider reap-uit, MĂRGINIT) în loc de un SIGKILL slab „o dată + sleep". Un
 * proc care rămâne neconfirmat (`teardownConfirmed:false`) SAU al cărui stop aruncă = `orphan` (raportat, nu mascat).
 * Mutează `confirmed` pe intrare la confirmare (idempotent la re-rulare). Pur (stop injectat) → testabil hermetic.
 */
export async function sweepBackstop(
  entries: readonly BackstopEntry[],
  stop:    (proc: ManagedProc) => Promise<ManagedStopResult>,
): Promise<BackstopSummary> {
  let swept = 0, confirmed = 0, orphan = 0;
  for (const e of entries) {
    if (e.confirmed) continue;
    swept++;
    let r: ManagedStopResult;
    try { r = await stop(e.proc); } catch { orphan++; continue; } // stop a aruncat → nu putem confirma → posibil orfan
    if (r.teardownConfirmed) { confirmed++; e.confirmed = true; }
    else orphan++;
  }
  return { swept, confirmed, orphan };
}

// ────────────────────────────── fabrica de pași reali ──────────────────────────────

/**
 * Construiește `Gate2Steps` REALE din `targets` (deja VETATE de `vetGate2Targets` — origine MCP curată + Redis loopback).
 * `makeSteps` (parametrul lui `runGate2`) = `(t) => makeGate2Steps(deps, t)` — dar `deps.launch.alchemyBaseWs` etc. vin de
 * la runner. Pașii sunt SUBȚIRI: fără logică de gate (aserturile trăiesc în orchestrator), doar I/O + mapare de coduri.
 */
export function makeGate2Steps(deps: Gate2StepsDeps, targets: Gate2Targets): Gate2Steps {
  const fetchFn   = deps.fetchFn   ?? realGate2Fetch;
  const spawn     = deps.spawn     ?? spawnManagedProcess;
  const stop      = deps.stop      ?? stopManagedProcess;
  const stopTimers= deps.stopTimers?? realStopTimers;
  const stopTiming= deps.stopTiming?? DEFAULT_STOP_TIMING;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CANARY_TIMEOUT_MS;
  const launch    = deps.launch;

  // ── pas: pornirea worker-ului (env validat → spawn detached → capabilitate stop mapată) ──
  const startWorker = async (signal: AbortSignal): Promise<WorkerStartResult> => {
    // Fereastra de start a orchestratorului deja închisă → NU pornim un consumator Alchemy (cost) degeaba.
    if (signal.aborted) return { ok: false, code: "spawn_failed" };

    const envR = buildWorkerBaseEnv(launch.baseEnv, targets.redisUrl, launch.alchemyBaseWs, launch.extraEnv);
    if (!envR.ok) return { ok: false, code: "config" }; // ALCHEMY_BASE_WS/REDIS_URL invalid — niciun proces pornit

    const spec: SpawnSpec = {
      command: launch.command, args: launch.args, cwd: launch.cwd, env: envR.env,
      ...(launch.onDebugLine ? { onDebugLine: launch.onDebugLine } : {}),
    };
    const sr = await spawn(spec);
    if (!sr.ok) return { ok: false, code: "spawn_failed" };

    const proc = sr.proc;
    // Hook-urile sunt BEST-EFFORT: un `onSpawn` care aruncă NU trebuie să propage (procesul e deja spawnat → am pierde
    // capabilitatea `stop` → consumator Alchemy ORFAN). Prindem + continuăm; ownership-ul procesului rămâne al nostru.
    try { deps.onSpawn?.(proc); } catch { /* hook best-effort — nu pierde ownership-ul procesului */ }
    return {
      ok: true,
      stop: async (stopSignal: AbortSignal): Promise<WorkerStopResult> => {
        const r = await stop(proc, stopTiming, stopTimers, stopSignal);
        try { deps.onStopResult?.(r); } catch { /* hook best-effort — teardown-ul e deja făcut, doar latch-ul runnerului */ }
        return mapManagedStop(r);
      },
    };
  };

  // ── pas: GET /api/health?strict=1 → corpul brut (JSON). Nu gatam pe `res.status`: strict-degraded e 503 CU raport JSON
  //    valid (`body.httpStatus` = statusul real), iar orchestratorul îl asertă. Timeout intern + semnal Gate 2 combinat. ──
  const fetchHealth = async (signal: AbortSignal): Promise<HealthFetchResult> => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const merged = mergeAbortSignals(ctrl.signal, signal);
      const res    = await fetchFn(targets.healthUrl, { method: "GET", signal: merged });
      const text   = await res.text(); // sub deadline (body/SSE care atârnă → abort → throw)
      let body: unknown;
      try { body = JSON.parse(text); } catch { return { ok: false, code: "malformed_json" }; }
      // ⭐ fix cgpt P1: CONCORDANȚĂ transport↔corp, NU suprascriere. Un body care declară un `httpStatus` numeric care
      // NU se potrivește cu statusul HTTP REAL (`res.status`) = server buggy/ostil → `status_mismatch` (fail-closed). A
      // SUPRASCRIE `httpStatus` cu transportul ar alege un câștigător și ar MASCA inconsistența inversă (HTTP 200 + corp
      // care declară 503). Când sunt concordante, întoarcem corpul NEATINS → orchestratorul parsează + asertă (un 503
      // concordant e parsat pt. polling, dar `assertStrictHealthy` cere httpStatus===200 → niciodată verde fals).
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        const declared = (body as Record<string, unknown>).httpStatus;
        if (typeof declared === "number" && declared !== res.status) return { ok: false, code: "status_mismatch" };
      }
      return { ok: true, body };
    } catch {
      return { ok: false, code: "unreachable" }; // transport (inclusiv abort la timeout / semnal Gate 2)
    } finally {
      clearTimeout(timer);
    }
  };

  // ── pas: apel MCP autentificat. `makeFetchPostJson` (12.5b-4a) își pune propriul timeout intern; injectăm un fetch care
  //    COMBINĂ semnalul lui intern cu semnalul Gate 2 → abort din oricare anulează cererea. Tokenul = DOAR în header. ──
  const mcpCall = (tool: string, toolArgs: Record<string, unknown> | undefined) =>
    async (accessToken: string, signal: AbortSignal): Promise<McpCallResult> => {
      const signalAwareFetch: FetchFn = (url, init) =>
        fetchFn(url, { ...init, signal: mergeAbortSignals(init.signal, signal) });
      const postJson = makeFetchPostJson(signalAwareFetch, timeoutMs);
      return callMcpTool(postJson, { mcpEndpoint: targets.mcpUrl }, { accessToken, tool, ...(toolArgs ? { toolArgs } : {}) });
    };

  return {
    startWorker,
    fetchHealth,
    mcpWorkerSnapshot: mcpCall(SNAPSHOT_TOOL, { chain: "base" }),
    mcpHealthCheck:    mcpCall(HEALTH_TOOL, undefined),
  };
}
