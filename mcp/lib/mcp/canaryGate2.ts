/**
 * lib/mcp/canaryGate2.ts — PH-12 12.5c-2 (orchestrator PUR al Gate 2 Base canary).
 *
 * SEPARAT de Gate 1 (decizie Marco/cgpt): Gate 1 = autentificare (OAuth login→consent→token→rotație); Gate 2 =
 * LIFECYCLE de worker + dovadă de date reale pe Base. Sunt responsabilități diferite; 12.5d le va COMPUNE (Gate 1
 * emite tokenul rotit → îl pasează lui Gate 2). Gate 2 NU repetă OAuth: primește `accessToken` ca INPUT.
 *
 * Lanț:  izolare → setup → start_worker → poll(strict_health + base_data + base_ws) → success ; finally: stop_worker.
 *
 * LOCK-uri (cgpt):
 *  - `startWorker()` întoarce o capabilitate `stop()`, apelată OBLIGATORIU în `finally`. Cleanup eșuat → Gate 2 ROȘU
 *    (chiar dacă poll-ul a fost verde). Runnerul (12.5c-3) implementează `stop` ca SIGTERM→grace→SIGKILL pe process
 *    group; aici e doar capabilitatea injectată.
 *  - POLL-ul așteaptă TOATE CELE TREI dovezi (nu doar snapshot-ul): strict Base health + `assertBaseData` +
 *    `assertBaseWsSubscriptions`. Altfel health-ul poate deveni verde ÎNAINTE să existe perechi/wsSubs, iar gate-ul ar
 *    pica prematur în loc să mai aștepte în fereastra de warm-up.
 *  - VET `REDIS_URL` LOOPBACK înainte de spawn: `assertCanaryIsolation` protejează MCP/Supabase, dar NU împiedică
 *    workerul local să pornească accidental pe Redis-ul de PRODUCȚIE. Fail-closed.
 *  - Erori prin CODURI ÎNCHISE mapate la mesaje STATICE — niciun stdout/stderr, URL Alchemy sau token în `reason`.
 *  - warm-up deadline 180s, deadline GLOBAL 300s; `makeSteps` construit DOAR după vetting; `clock` injectat (determinist).
 */

import {
  assertCanaryIsolation, parseHealthReport, assertStrictHealthy,
  type GateResult,
} from "./releaseGate";
import { assertBaseData, assertBaseWsSubscriptions } from "./canaryBaseData";
import type { McpCallResult } from "./canaryMcpClient";

// ────────────────────────────── config + ținte vetate ──────────────────────────────

/** Config-ul Gate 2. `accessToken` e INPUT (Gate 2 nu face OAuth). `redisUrl` e vetat loopback înainte de spawn. */
export interface Gate2Config {
  mcpBaseUrl:  string;  // originea MCP-ului de canary (health + /api/mcp)
  supabaseUrl: string;  // Supabase-ul de canary (plasa de izolare prod, ca la Gate 1)
  redisUrl:    string;  // Redis-ul workerului local — TREBUIE loopback (anti-prod)
  accessToken: string;  // Bearer deja emis (Gate 1 / 12.5d) — secret, NICIODATĂ în reason
}

/** Endpoint-urile derivate dintr-o origine VETATĂ + redisUrl vetat. Singura sursă de URL-uri pentru pași. */
export interface Gate2Targets {
  mcpOrigin: string;  // ex. http://127.0.0.1:8080
  healthUrl: string;  // `${origin}/api/health?strict=1`
  mcpUrl:    string;  // `${origin}/api/mcp`
  redisUrl:  string;  // loopback vetat (workerul îl folosește)
}

export type Gate2VetResult = { ok: true; targets: Gate2Targets } | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Origine CURATĂ (fără path/query/fragment) → `u.origin`. Fail-closed. */
function cleanOrigin(url: string, label: string): { origin: string } | { reject: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { reject: `${label} neparsabil` }; }
  if (u.pathname !== "/" && u.pathname !== "") return { reject: `${label} conține path — cere origine curată` };
  if (u.search !== "")                          return { reject: `${label} conține query — cere origine curată` };
  if (u.hash !== "")                            return { reject: `${label} conține fragment — cere origine curată` };
  return { origin: u.origin };
}

/** `REDIS_URL` acceptat DOAR pe loopback + schemă redis(s). Fail-closed (anti-prod). Nu ecouă URL-ul în reject. */
function vetRedisLoopback(url: string): { ok: true } | { reject: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { reject: "REDIS_URL neparsabil" }; }
  // ⭐ fix cgpt P2: NU ecoua `u.protocol` — un `secretmarker://…` fabricat ar reflecta valoarea în reason (log leak). Static.
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") return { reject: "REDIS_URL schemă neacceptată (cere redis/rediss)" };
  const host = u.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) return { reject: "REDIS_URL non-loopback — refuz (workerul nu pornește pe Redis extern/prod)" };
  return { ok: true };
}

/**
 * Poarta zero Gate 2: `assertCanaryIsolation` (MCP/Supabase prod) + `REDIS_URL` loopback + origine MCP curată +
 * `accessToken` prezent. Derivă endpoint-urile DOAR după ce toate trec. `makeSteps` se invocă abia pe `ok:true`.
 */
export function vetGate2Targets(cfg: Partial<Gate2Config> | null | undefined): Gate2VetResult {
  const iso = assertCanaryIsolation(cfg ? { mcpBaseUrl: cfg.mcpBaseUrl, supabaseUrl: cfg.supabaseUrl } : cfg);
  if (!iso.ok) return { ok: false, reason: iso.reason };

  const redisRaw = cfg?.redisUrl;
  if (typeof redisRaw !== "string" || redisRaw.trim() === "") return { ok: false, reason: "REDIS_URL lipsă/gol (ambiguu → fail-closed)" };
  const redis = vetRedisLoopback(redisRaw);
  if ("reject" in redis) return { ok: false, reason: redis.reject };

  const token = cfg?.accessToken;
  if (typeof token !== "string" || token.trim() === "") return { ok: false, reason: "accessToken lipsă/gol (Gate 2 cere token emis, nu face OAuth)" };

  const mcpRaw = cfg?.mcpBaseUrl;
  if (typeof mcpRaw !== "string") return { ok: false, reason: "config invalid după izolare (fail-closed)" };
  const mcp = cleanOrigin(mcpRaw, "mcpBaseUrl");
  if ("reject" in mcp) return { ok: false, reason: mcp.reject };

  const origin = mcp.origin;
  return {
    ok: true,
    targets: { mcpOrigin: origin, healthUrl: `${origin}/api/health?strict=1`, mcpUrl: `${origin}/api/mcp`, redisUrl: redisRaw },
  };
}

// ────────────────────────────── contractele pașilor (coduri închise) ──────────────────────────────

export type WorkerStartCode = "spawn_failed" | "redis_unreachable" | "config";
export type WorkerStopCode  = "stop_timeout" | "stop_failed";
export type HealthFetchCode = "unreachable" | "malformed_json" | "status_mismatch";

export type WorkerStopResult  = { ok: true } | { ok: false; code: WorkerStopCode };
export type WorkerStartResult = { ok: true; stop: (signal: AbortSignal) => Promise<WorkerStopResult> } | { ok: false; code: WorkerStartCode };
export type HealthFetchResult = { ok: true; body: unknown } | { ok: false; code: HealthFetchCode };

/**
 * Pașii cu I/O, construiți din `targets` vetate. `startWorker` pornește Worker Base (`ENABLED_CHAINS=base`,
 * `PREFLIGHT_MODE=LIVE`, `ALCHEMY_BASE_WS`, `REDIS_URL=targets.redisUrl`) și întoarce `stop()`. `fetchHealth` lovește
 * `targets.healthUrl` și întoarce CORPUL brut (orchestratorul îl parsează + asertă — codul HTTP e în `body.httpStatus`,
 * nu în transport). Probele MCP întorc `McpCallResult` (clientul deja anti-leak); orchestratorul aplică aserturile 12.5c-1.
 */
export interface Gate2Steps {
  startWorker:       (signal: AbortSignal) => Promise<WorkerStartResult>;
  fetchHealth:       (signal: AbortSignal) => Promise<HealthFetchResult>;
  mcpWorkerSnapshot: (accessToken: string, signal: AbortSignal) => Promise<McpCallResult>;
  mcpHealthCheck:    (accessToken: string, signal: AbortSignal) => Promise<McpCallResult>;
}

/** Ceas injectat → polling/deadline-uri deterministe la test. */
export interface Gate2Clock { now: () => number; sleep: (ms: number) => Promise<void>; }

/**
 * Praguri (overridable la test). Warm-up = fereastra de poll; global = tot runul (poll); cadențe per-probă.
 * ⭐ fix cgpt: `startTimeoutMs`/`stopTimeoutMs` mărginesc `startWorker`/`stop` — altfel un spawn/teardown care nu se
 * rezolvă niciodată ar scăpa de sub orice deadline (hang infinit / worker orfan). `probeTimeoutMs` mărginește fiecare
 * probă de poll. La expirare, `AbortSignal`-ul operației e ABORTAT (proba/spawn-ul chiar se anulează, nu doar „nu mai
 * așteptăm"). Toate FINITE > 0 (validate înainte de spawn).
 */
export interface Gate2Timing {
  warmupMs?:      number; // default 180_000
  globalMs?:      number; // default 300_000
  healthEveryMs?: number; // default 2_000
  mcpEveryMs?:    number; // default 5_000
  probeTimeoutMs?: number; // default 15_000 — bound per-probă (abort la expirare), plafonat de timpul rămas din global
  startTimeoutMs?: number; // default 60_000 — bound pe startWorker (abort), plafonat de global (deadline HARD)
  stopTimeoutMs?:  number; // default 30_000 — bound pe stop (abort → stop_timeout). Teardown: buget propriu, NU plafonat.
  graceMs?:        number; // default 5_000 — după abort, cât AȘTEPTĂM confirmarea cleanup-ului înainte de „posibil orfan"
  maxSnapshotAgeSec?: number; // pt. strict health + assertBaseData (default 300)
  pongFreshSec?:  number; // pt. assertBaseWsSubscriptions (default 120)
}

// ────────────────────────────── mesaje statice ──────────────────────────────

const START_MSG: Record<WorkerStartCode, string> = {
  spawn_failed:     "start_worker: procesul workerului nu a pornit (spawn)",
  redis_unreachable:"start_worker: Redis-ul (loopback) inaccesibil la pornire",
  config:           "start_worker: config worker invalid (ex. ALCHEMY_BASE_WS lipsă)",
};
const STOP_MSG: Record<WorkerStopCode, string> = {
  stop_timeout: "stop_worker: workerul nu s-a oprit în fereastra de grace (teardown incomplet)",
  stop_failed:  "stop_worker: oprirea workerului a eșuat (posibil consumator Alchemy orfan)",
};
const HEALTH_FETCH_MSG: Record<HealthFetchCode, string> = {
  unreachable:    "strict_health: /api/health?strict=1 inaccesibil (transport)",
  malformed_json: "strict_health: corpul /api/health nu e JSON valid",
  // Statusul HTTP declarat în corp NU se potrivește cu statusul de transport REAL → server buggy/ostil; fail-closed
  // (NU alegem un „câștigător", ceea ce ar masca inconsistența inversă). 12.5c-3b.
  status_mismatch:"strict_health: httpStatus din corp ≠ statusul HTTP real (inconsistență transport/corp)",
};

export type Gate2Stage = "config" | "isolation" | "setup" | "start_worker" | "poll" | "stop_worker";
export type Gate2Probe = "strict_health" | "base_data" | "base_ws";

const THREW: Record<Gate2Stage, string> = {
  config:       "config: parametri de timing invalizi (fail-closed)",
  isolation:    "izolare: excepție (fail-closed)",
  setup:        "setup: construirea pașilor a aruncat (fail-closed)",
  start_worker: "start_worker: pasul a aruncat (execuție)",
  poll:         "poll: o probă a aruncat sau ceasul a aruncat (fail-closed)",
  stop_worker:  "stop_worker: oprirea a aruncat (execuție)",
};

// ────────────────────────────── orchestrator ──────────────────────────────

export type Gate2Report =
  | { ok: true;  stages: Gate2Stage[]; note: string }
  | { ok: false; stage: Gate2Stage; probe?: Gate2Probe; reason: string };

const START_TIMEOUT_MSG = "start_worker: spawn fără răspuns (timeout) — abort trimis";

/** Prinde un throw → `{thrown:true}` (fără a propaga excepția/mesajul). Altfel `{thrown:false, value}`. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ thrown: false; value: T } | { thrown: true }> {
  try { return { thrown: false, value: await fn() }; }
  catch { return { thrown: true }; }
}

/**
 * ⭐ fix cgpt: rulează o operație cu `AbortSignal` + timeout REAL, în DOUĂ faze. La expirare ABORTEAZĂ operația, apoi
 * NU revine imediat — AȘTEAPTĂ până la `graceMs` ca operația să se stingă. Rezultat discriminat care păstrează
 * VALOAREA reală + dacă settle-ul a fost DUPĂ abort (`late`) — apelantul decide dacă e „cleanup reușit" (fiindcă un
 * settle NU e neapărat succes: `{ok:false}` sau o respingere în grace ≠ curat). `orphan` = abort trimis dar operația
 * nici după grace nu s-a stins. ⭐ AMBELE timere (timeout + grace) sunt anulate la orice settle (fără timere orfane).
 */
type Bounded<T> =
  | { kind: "value"; value: T; late: boolean } // rezolvat cu valoare; late = după timeout/abort (în grace)
  | { kind: "threw"; late: boolean }           // respins; late = după timeout/abort
  | { kind: "orphan" };                         // timeout + abort, dar operația nu s-a stins în grace
function boundedRun<T>(timeoutMs: number, graceMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<Bounded<T>> {
  return new Promise<Bounded<T>>((resolve) => {
    const ctrl = new AbortController();
    let phase: "run" | "grace" | "done" = "run";
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    const done = (b: Bounded<T>) => {
      if (phase === "done") return;
      phase = "done";
      if (timer !== undefined) clearTimeout(timer);          // ⭐ fix cgpt: nu lăsa timer-ul de succes/timeout orfan
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve(b);
    };
    let p: Promise<T>;
    try { p = run(ctrl.signal); } catch { done({ kind: "threw", late: false }); return; }
    p.then(
      (value) => done({ kind: "value", value, late: phase !== "run" }),
      ()      => done({ kind: "threw", late: phase !== "run" }),
    );
    timer = setTimeout(() => {
      if (phase !== "run") return;
      phase = "grace";
      ctrl.abort(); // anulează efectiv operația; AȘTEAPTĂ până la graceMs stingerea ei
      graceTimer = setTimeout(() => done({ kind: "orphan" }), graceMs);
    }, timeoutMs);
  });
}

/**
 * Rulează Gate 2. Izolarea + vetul Redis sunt poarta zero. `startWorker` obține `stop()`, apelat MEREU în `finally`.
 * Poll-ul cere TOATE cele trei dovezi verzi în fereastra de warm-up (deadline global peste tot). Cleanup eșuat → roșu.
 */
export async function runGate2(
  cfg:       Partial<Gate2Config> | null | undefined,
  makeSteps: (targets: Gate2Targets) => Gate2Steps,
  clock:     Gate2Clock,
  timing:    Gate2Timing = {},
): Promise<Gate2Report> {
  const warmupMs   = timing.warmupMs      ?? 180_000;
  const globalMs   = timing.globalMs      ?? 300_000;
  const healthEvery= timing.healthEveryMs ?? 2_000;
  const mcpEvery   = timing.mcpEveryMs    ?? 5_000;
  const probeTmo   = timing.probeTimeoutMs ?? 15_000;
  const startTmo   = timing.startTimeoutMs ?? 60_000;
  const stopTmo    = timing.stopTimeoutMs  ?? 30_000;
  const graceMs    = timing.graceMs       ?? 5_000;
  const maxSnapSec = timing.maxSnapshotAgeSec ?? 300;
  const pongSec    = timing.pongFreshSec  ?? 120;

  // ⭐ fix cgpt P1 #2: timing invalid (NaN/Infinity/0/negativ) ar bloca workerul (loop infinit → worker neoprit) sau ar
  // face comparațiile de deadline să treacă tăcut. REFUZ ÎNAINTE de spawn — niciun worker pornit pe config invalid.
  for (const [k, v] of [["warmupMs", warmupMs], ["globalMs", globalMs], ["healthEveryMs", healthEvery], ["mcpEveryMs", mcpEvery], ["probeTimeoutMs", probeTmo], ["startTimeoutMs", startTmo], ["stopTimeoutMs", stopTmo], ["graceMs", graceMs], ["maxSnapshotAgeSec", maxSnapSec], ["pongFreshSec", pongSec]] as const) {
    if (!Number.isFinite(v) || v <= 0) return { ok: false, stage: "config", reason: `timing.${k} invalid (${v}) — cere finit > 0` };
  }

  // ⭐ fix cgpt P1 #3 + P2: `clock.now()` poate ARUNCA sau întoarce valori NEFINITE (NaN/Infinity) → ambele ar strica
  // aritmetica de deadline tăcut. `nowOrNull` întoarce `null` pe oricare → raport ROȘU (NU Promise rejected).
  const nowOrNull = (): number | null => { try { const n = clock.now(); return Number.isFinite(n) ? n : null; } catch { return null; } };
  const runStart = nowOrNull();
  if (runStart === null) return { ok: false, stage: "config", reason: "clock.now() a aruncat sau a întors o valoare nefinită (fail-closed)" };

  // 0. IZOLARE + vet Redis loopback + derivare ținte — ÎNAINTE de orice I/O sau spawn.
  const vet = vetGate2Targets(cfg);
  if (!vet.ok) return { ok: false, stage: "isolation", reason: vet.reason };
  const targets = vet.targets;

  // 1. SETUP — construirea pașilor poate arunca.
  let steps: Gate2Steps;
  try { steps = makeSteps(targets); }
  catch { return { ok: false, stage: "setup", reason: THREW.setup }; }

  // 2. START WORKER — MĂRGINIT, cu GLOBAL ca deadline HARD (fix cgpt P1): bugetul de start = min(startTmo, timpul RĂMAS
  //    din global). Dacă global e mai mic, timeout-ul e la GLOBAL, nu la start-timeout. La expirare, abort + grace →
  //    dacă spawn-ul ignoră abortul (nu se stinge în grace) → „posibil orfan". Fără capabilitate stop dacă nu pornește.
  const nowStart = nowOrNull();
  if (nowStart === null) return { ok: false, stage: "config", reason: "clock.now() a întors o valoare invalidă (fail-closed)" };
  const remStart = globalMs - (nowStart - runStart);
  if (remStart <= 0) return { ok: false, stage: "start_worker", reason: `deadline global (${globalMs}ms) atins înainte de start (fail-closed)` };
  const startBudget = Math.min(startTmo, remStart);
  const startCapGlobal = startBudget < startTmo; // global e plafonul care mușcă
  const sw = await boundedRun(startBudget, graceMs, (sig) => steps.startWorker(sig));
  const startTimeoutReason = (orphan: string): string =>
    startCapGlobal ? `deadline global (${globalMs}ms) atins la start_worker${orphan}` : `${START_TIMEOUT_MSG}${orphan}`;
  let stop: (signal: AbortSignal) => Promise<WorkerStopResult>;
  if (sw.kind === "value" && !sw.late) {
    // Cale rapidă normală.
    if (!sw.value.ok) return { ok: false, stage: "start_worker", reason: START_MSG[sw.value.code] };
    stop = sw.value.stop;
  } else if (sw.kind === "value" && sw.late && sw.value.ok) {
    // ⭐ fix cgpt: start-ul a EXPIRAT dar a întors TARDIV un handle valid → `stop`-ul lui TREBUIE apelat (teardown
    //   obligatoriu, altfel worker orfan). Îl oprim best-effort, mărginit, apoi raportăm roșu (a depășit bugetul).
    const lateStop = sw.value.stop;
    const td = await boundedRun(stopTmo, graceMs, (sig) => lateStop(sig));
    // ⭐ fix cgpt P2: un teardown care întoarce `ok` — RAPID SAU tardiv în grace — confirmă cleanup-ul (consistent cu
    // calea principală de stop). NU condiționăm pe `!td.late` (un stop verde tardiv NU e „neconfirmat").
    const cleaned = td.kind === "value" && td.value.ok;
    // ⭐ fix cgpt P2: NU afirma „oprit" când teardown-ul NU e confirmat (lateStop eșuat/orphan) → „posibil orfan".
    const tail = cleaned ? " — handle întârziat oprit curat (teardown confirmat)" : " — handle întârziat, teardown NEconfirmat, worker POSIBIL ORFAN";
    return { ok: false, stage: "start_worker", reason: `${startTimeoutReason("")}${tail}` };
  } else if (sw.kind === "orphan" || (sw.kind === "value" && sw.late && !sw.value.ok) || (sw.kind === "threw" && sw.late)) {
    // Timeout: abort ignorat / settle tardiv fără handle → posibil orfan.
    return { ok: false, stage: "start_worker", reason: startTimeoutReason(" — abort ignorat/tardiv, worker POSIBIL ORFAN") };
  } else {
    // sw.kind === "threw" && !sw.late — spawn a aruncat rapid.
    return { ok: false, stage: "start_worker", reason: THREW.start_worker };
  }

  // 3. POLL (în try) + 4. STOP (în finally, MEREU). `runPoll` e wrapped în `attempt`. `stop` e mărginit de `stopTmo` cu
  // buget PROPRIU (teardown-ul e mandatoriu, nu-l plafonăm de global). Abort + grace: un teardown care ignoră abortul
  // → `cleaned:false` → „posibil orfan" (roșu), mărginit; unul care se curăță întârziat în grace → `cleaned:true` (am
  // AȘTEPTAT confirmarea înainte de a reveni).
  let pollReport: Gate2Report;
  let stopFail: { code: WorkerStopCode; cleaned?: boolean } | { thrown: true } | null = null;
  try {
    const pr = await attempt(() => runPoll(steps, cfg!.accessToken as string, clock, {
      runStart, warmupMs, globalMs, healthEvery, mcpEvery, probeTmo, graceMs, maxSnapSec, pongSec, nowOrNull,
    }));
    pollReport = pr.thrown ? { ok: false, stage: "poll", reason: THREW.poll } : pr.value;
  } finally {
    const st = await boundedRun(stopTmo, graceMs, (sig) => stop(sig));
    // ⭐ fix cgpt: SETTLE ≠ cleanup reușit. Interpretăm valoarea reală:
    if (st.kind === "value" && !st.late) {
      // Rapid: onorăm ok/eșec exact.
      if (!st.value.ok) stopFail = { code: st.value.code };
    } else if (st.kind === "value" && st.late) {
      // Tardiv (în grace): `cleanup confirmat` DOAR dacă valoarea e ok; `{ok:false}` tardiv → NU confirmat.
      stopFail = { code: "stop_timeout", cleaned: st.value.ok };
    } else if (st.kind === "threw") {
      // Respins rapid → excepție de teardown; respins TARDIV (în grace) → posibil orfan (nu cleaned).
      stopFail = st.late ? { code: "stop_timeout", cleaned: false } : { thrown: true };
    } else {
      // orphan: abort ignorat, nu s-a stins în grace → posibil orfan.
      stopFail = { code: "stop_timeout", cleaned: false };
    }
  }

  const stopReason = (): string => {
    if (!stopFail) return "";
    if ("thrown" in stopFail) return THREW.stop_worker;
    if (stopFail.code === "stop_timeout") return `${STOP_MSG.stop_timeout}${stopFail.cleaned ? " (cleanup confirmat după abort)" : " — abort ignorat, worker POSIBIL ORFAN"}`;
    return STOP_MSG[stopFail.code];
  };

  // Poll eșuat DOMINĂ (diagnosticul substanțial). ⭐ fix cgpt: dacă ȘI stop-ul a eșuat, teardown-ul apare EXPLICIT în reason.
  if (!pollReport.ok) {
    if (stopFail) return { ...pollReport, reason: `${pollReport.reason} | teardown eșuat: ${stopReason()}` };
    return pollReport;
  }
  // Poll verde, dar cleanup eșuat → Gate ROȘU (worker posibil orfan — consumator Alchemy).
  if (stopFail) {
    return { ok: false, stage: "stop_worker", reason: stopReason() };
  }
  return {
    ok: true,
    stages: ["isolation", "setup", "start_worker", "poll"],
    note: "Gate 2 verde: izolare + worker Base pornit + strict health + date Base + WS subscriptions; worker oprit curat",
  };
}

/**
 * Poll-ul: evaluează cele trei probe cu cadențe (health ~2s, MCP ~5s), până TOATE trei-s verzi SIMULTAN sau expiră
 * warm-up-ul/global-ul. O probă se re-evaluează doar când i-a trecut cadența (nu hammering pe /api/mcp). La expirare,
 * întoarce ULTIMA probă care încă pică (diagnostic). Pur (clock injectat).
 */
async function runPoll(
  steps: Gate2Steps,
  accessToken: string,
  clock: Gate2Clock,
  o: { runStart: number; warmupMs: number; globalMs: number; healthEvery: number; mcpEvery: number; probeTmo: number; graceMs: number; maxSnapSec: number; pongSec: number; nowOrNull: () => number | null },
): Promise<Gate2Report> {
  const pollStart0 = o.nowOrNull();
  if (pollStart0 === null) return { ok: false, stage: "poll", reason: "clock.now() invalid la pornirea poll-ului (fail-closed)" };
  const pollStart = pollStart0;
  let lastHealthAt = -Infinity, lastDataAt = -Infinity, lastWsAt = -Infinity;
  let health: GateResult | null = null, data: GateResult | null = null, ws: GateResult | null = null;

  // ⭐ fix cgpt: bound per-probă care ANULEAZĂ efectiv proba la expirare (abort + grace), PLAFONAT de timpul RĂMAS din
  // global — o probă pornită aproape de global folosește DOAR timpul rămas, nu tot `probeTmo` (global = deadline HARD).
  const boundProbe = async (label: string, run: (sig: AbortSignal) => Promise<GateResult>): Promise<GateResult> => {
    const now = o.nowOrNull();
    if (now === null) return { ok: false, reason: `${label}: clock.now() invalid (fail-closed)` };
    // ⭐ fix cgpt P1: bugetul e plafonat de timpul rămas din AMBELE ferestre — global ȘI warm-up. O probă pornită
    //   aproape de expirarea warm-up-ului abortează la timpul rămas din warm-up, nu așteaptă tot `probeTmo`.
    const remGlobal = o.globalMs - (now - o.runStart);
    const remWarmup = o.warmupMs - (now - pollStart);
    const remaining = Math.min(remGlobal, remWarmup);
    if (remaining <= 0) return { ok: false, reason: `${label}: fereastră (warm-up/global) expirată` };
    const budget = Math.min(o.probeTmo, remaining);
    const r = await boundedRun(budget, o.graceMs, run);
    // O probă care s-a stins ÎNAINTE de timeout → onorăm rezultatul. Timeout (settle tardiv / respins tardiv / orphan)
    // → probă FAILING (a depășit bugetul; nu contează un rezultat sosit după abort).
    if (r.kind === "value" && !r.late) return r.value;
    if (r.kind === "threw" && !r.late) return { ok: false, reason: `${label}: probă a aruncat (fail-closed)` };
    const orphan = r.kind === "orphan" ? ", posibil orfan" : "";
    return { ok: false, reason: `${label}: probă fără răspuns în ${budget}ms (timeout, abort trimis${orphan})` };
  };

  const evalHealth = async (sig: AbortSignal): Promise<GateResult> => {
    const r = await steps.fetchHealth(sig);
    if (!r.ok) return { ok: false, reason: HEALTH_FETCH_MSG[r.code] };
    const report = parseHealthReport(r.body);
    if (report === null) return { ok: false, reason: "strict_health: raport /api/health malformat (fail-closed)" };
    return assertStrictHealthy(report, { requireChains: ["base"], maxSnapshotAgeSec: o.maxSnapSec });
  };
  const evalData = async (sig: AbortSignal): Promise<GateResult> =>
    assertBaseData(await steps.mcpWorkerSnapshot(accessToken, sig), { maxSnapshotAgeSec: o.maxSnapSec });
  const evalWs = async (sig: AbortSignal): Promise<GateResult> =>
    assertBaseWsSubscriptions(await steps.mcpHealthCheck(accessToken, sig), { pongFreshSec: o.pongSec });

  // ⭐ fix cgpt P2: diagnostic COERENT. Numim prima probă care PICĂ (sau e neevaluată); dacă TOATE-s verzi (dar am
  // depășit deadline-ul), NU acuzăm o probă verde — reason distinct, `probe` OMIS.
  const diagnose = (): { probe?: Gate2Probe; reason: string } => {
    if (!health)     return { probe: "strict_health", reason: "strict_health: neevaluat" };
    if (!health.ok)  return { probe: "strict_health", reason: health.reason };
    if (!data)       return { probe: "base_data", reason: "base_data: neevaluat" };
    if (!data.ok)    return { probe: "base_data", reason: data.reason };
    if (!ws)         return { probe: "base_ws", reason: "base_ws: neevaluat" };
    if (!ws.ok)      return { probe: "base_ws", reason: ws.reason };
    return { reason: "toate cele 3 probe verzi, dar deadline depășit înainte de confirmare simultană" };
  };
  const overDeadline = (now: number): Gate2Report | null => {
    if (now - o.runStart >= o.globalMs) { const d = diagnose(); return { ok: false, stage: "poll", ...(d.probe ? { probe: d.probe } : {}), reason: `deadline global (${o.globalMs}ms) depășit — ${d.reason}` }; }
    if (now - pollStart  >= o.warmupMs) { const d = diagnose(); return { ok: false, stage: "poll", ...(d.probe ? { probe: d.probe } : {}), reason: `warm-up (${o.warmupMs}ms) expirat — ${d.reason}` }; }
    return null;
  };

  // Un „tick": citește ceasul (guardat) + verifică deadline-ul. Bail = raport roșu; altfel `now`.
  const tick = (): { now: number } | { bail: Gate2Report } => {
    const n = o.nowOrNull();
    if (n === null) return { bail: { ok: false, stage: "poll", reason: "clock.now() invalid în poll (fail-closed)" } };
    const od = overDeadline(n);
    if (od) return { bail: od };
    return { now: n };
  };

  for (;;) {
    // ⭐ fix cgpt P1: verific deadline-ul ÎNAINTE de FIECARE probă — dacă health consumă restul warm-up-ului, data și ws
    //   NU mai pornesc (nu pornim probe MCP într-o fereastră deja expirată). Post-eval re-check acoperă și falsul verde.
    const t0 = tick(); if ("bail" in t0) return t0.bail;
    if (t0.now - lastHealthAt >= o.healthEvery) { health = await boundProbe("strict_health", evalHealth); lastHealthAt = t0.now; }

    const t1 = tick(); if ("bail" in t1) return t1.bail;
    if (t1.now - lastDataAt >= o.mcpEvery) { data = await boundProbe("base_data", evalData); lastDataAt = t1.now; }

    const t2 = tick(); if ("bail" in t2) return t2.bail;
    if (t2.now - lastWsAt >= o.mcpEvery) { ws = await boundProbe("base_ws", evalWs); lastWsAt = t2.now; }

    const t3 = tick(); if ("bail" in t3) return t3.bail;

    if (health && data && ws && health.ok && data.ok && ws.ok) {
      return { ok: true, stages: ["isolation", "setup", "start_worker", "poll"], note: "poll verde" };
    }

    await clock.sleep(o.healthEvery);
  }
}
