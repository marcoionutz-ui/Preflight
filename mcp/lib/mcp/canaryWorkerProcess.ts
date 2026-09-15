/**
 * lib/mcp/canaryWorkerProcess.ts — PH-12 12.5c-3a (lifecycle de PROCES al Worker Base pentru Gate 2 live).
 *
 * Gate 2 (`canaryGate2.ts`) primește `startWorker()` care întoarce un `stop()`; ACEST modul furnizează lifecycle-ul
 * REAL, extras din runner ca leaf TIPAT + testabil (doctrina 12.5b). E cea mai riscantă bucată a Gate 2: un proces
 * care supraviețuiește teardown-ului ARDE bani pe Alchemy WS/RPC.
 *
 * PROPRIETATEA PROMISĂ (lock cgpt): teardown „confirmat" = **ÎNTREGUL GROUP a dispărut ȘI liderul a fost reap-uit**
 * (event `exit` de la Node), nu doar „liderul a ieșit". Nuanțe cheie:
 *   - Fereastra de grace e pentru GRUP, NU pentru lider: dacă liderul iese dar un nepot mai are câteva sute de ms până
 *     iese SINGUR (tot pe SIGTERM), îl AȘTEPTĂM în restul grace-ului — nu escaladăm prematur.
 *   - CURAT (`{ok:true}`) DOAR dacă, în grace, grupul s-a golit ȘI liderul a ieșit cu cod 0.
 *   - Orice cale care a avut nevoie de SIGKILL (lider care atârnă / nepot supraviețuitor / abort) → `stop_timeout`.
 *   - Confirmarea „grup dispărut" se face prin PROBĂ (`groupAlive()`), fail-closed: succes/EPERM ⇒ viu, ESRCH ⇒ dispărut,
 *     ORICE ALTĂ eroare ⇒ „nu pot confirma" ⇒ tratat ca VIU (`isGroupAliveFromProbe`).
 *   - După SIGKILL AȘTEPTĂM ȘI reap-ul liderului (`exitP`), nu doar sonda de grup — nu declarăm teardown înainte ca Node
 *     să confirme ieșirea copilului.
 *
 * DE CE group-kill: `process.kill(-pid, sig)` (pid NEGATIV = grup) prinde liderul + nepoții; `detached:true` face
 * copilul LIDER de grup. `child.kill()` simplu ar lăsa nepoții vii.
 *
 * ⚠️ TREI durate DISTINCTE (lock cgpt): `workerShutdownGraceMs` (AICI, 13_000, > deadline intern 10s al worker-ului) ≠
 * `Gate2Timing.graceMs` (5_000, confirmare post-abort) ≠ `Gate2Timing.stopTimeoutMs` (20_000, bugetul orchestratorului pe stop).
 *
 * PUR + testabil: `stopManagedProcess` folosește primitive INJECTATE (`ManagedProc` + timere) → hermetic. Adaptorul
 * real (`spawnManagedProcess`) e dovedit de `canaryWorkerProcess.integration.ts` (POSIX/WSL, procese reale).
 */

import { spawn, type ChildProcess } from "node:child_process";

// ────────────────────────────── coduri închise + tipuri ──────────────────────────────

export type WorkerSpawnFailCode = "spawn_failed";
export type WorkerStopFailCode = "stop_timeout" | "stop_failed"; // structural == `WorkerStopCode` din canaryGate2.ts

export type ProcExit = { kind: "code"; code: number } | { kind: "signal"; signal: string };

/**
 * `teardownConfirmed` = teardown DOVEDIT (grup dispărut ȘI lider reap-uit) în bugetul propriu. Invarianta e MODELATĂ în
 * union (TS interzice stări imposibile ca `{ok:true, teardownConfirmed:false}`): pe calea curată (`ok:true`) ȘI pe
 * `stop_failed` (grup confirmat gol în grace) e MEREU `true`; DOAR pe `stop_timeout` poate fi `false` (SIGKILL
 * neconfirmat în `killConfirmMaxMs` ⇒ posibil orfan). Apelantul (harness/runner) latch-uiește O DATĂ din acest flag,
 * FĂRĂ să re-sondeze pgid-ul (evită cursa de reutilizare de PID — modulul a confirmat deja intern, sincron cu rezultatul).
 */
export type ManagedStopResult =
  | { ok: true;  teardownConfirmed: true }
  | { ok: false; code: "stop_failed";  teardownConfirmed: true }
  | { ok: false; code: "stop_timeout"; teardownConfirmed: boolean };
export type SpawnResult = { ok: true; proc: ManagedProc } | { ok: false; code: WorkerSpawnFailCode };

export interface ManagedProc {
  readonly pid: number;
  waitExit(): Promise<ProcExit>;               // ieșirea LIDERULUI, MEMOIZAT
  signalGroup(sig: "SIGTERM" | "SIGKILL"): void; // best-effort; confirmarea se face prin groupAlive()
  groupAlive(): boolean;                        // vreun membru al grupului viu? (fail-closed pe erori necunoscute)
}

export interface StopTimerDeps {
  setTimer(ms: number, cb: () => void): unknown;
  clearTimer(handle: unknown): void;
  /** Ceas MONOTON (real: `performance.now()`). Deadline-urile se măsoară pe ACEST ceas, nu prin numărarea intervalelor
   * (un timer care se declanșează târziu, sau un salt de ceas, NU trebuie să accepte o confirmare de după deadline). */
  now(): number;
}

export interface StopTiming {
  /** Între SIGTERM și SIGKILL. Caller 13_000 (> deadline intern 10s). Finite > 0; altfel fail-safe (grace 0 → kill direct). */
  workerShutdownGraceMs: number;
  /** Cadența de probare a dispariției grupului (default 100ms). */
  killConfirmIntervalMs?: number;
  /** Plafon de confirmare după SIGKILL (default 5_000ms). Depășit → nu putem confirma → tot ROȘU. */
  killConfirmMaxMs?: number;
}

// ────────────────────────────── sonda de grup (PURĂ, fail-closed) ──────────────────────────────

/**
 * Interpretează rezultatul unei sonde `process.kill(-pid, 0)`:
 *   - `null` (kill a reușit)  → VIU (există membri signalabili)
 *   - `ESRCH`                 → DISPĂRUT (niciun proces în grup)
 *   - `EPERM` / ORICE ALTCEVA → VIU (fail-closed: EPERM = există dar nesignalabil; o eroare necunoscută NU dovedește
 *     dispariția → o tratăm ca „încă viu", ca să nu declarăm fals „grup dispărut" = orfan mascat).
 */
export function isGroupAliveFromProbe(err: NodeJS.ErrnoException | null): boolean {
  if (err === null) return true;
  if (err.code === "ESRCH") return false;
  return true; // EPERM sau necunoscut → fail-closed VIU
}

// ────────────────────────────── teardown (PUR, injectat) ──────────────────────────────

/** Rezultatul confirmării de teardown. `confirmed` = grup dispărut ȘI lider reap-uit în buget. `exit` = ieșirea liderului dacă s-a rezolvat. */
interface TeardownConfirm { confirmed: boolean; exit: ProcExit | null; }

/**
 * Așteaptă până când AMBELE sunt adevărate — grupul e dispărut (`!groupAlive()`) ȘI liderul a fost reap-uit (`exitP`
 * rezolvat) — sau până se epuizează bugetul `maxMs`, sau (opțional) până la abort. Poll-ul unic (un singur timer în zbor)
 * verifică ambele condiții; `exitP` doar setează un flag (nu programează timere paralele).
 *
 * ⭐ Grupul dispărut fără reap confirmat (`exitP` încă pending) NU e „confirmat": Node poate raporta ESRCH înainte de a
 * emite `exit` — nu declarăm teardown până nu vine ieșirea copilului. La abort/buget epuizat → `confirmed:false`.
 */
function confirmTeardown(
  proc:   ManagedProc,
  exitP:  Promise<ProcExit>,
  deps:   StopTimerDeps,
  o:      { intervalMs: number; maxMs: number; signal?: AbortSignal },
): Promise<TeardownConfirm> {
  return new Promise<TeardownConfirm>((resolve) => {
    let settled = false, exitDone = false;
    let exit: ProcExit | null = null;
    let timer: unknown;
    // Citire de ceas SIGURĂ: dacă `now()` aruncă SAU întoarce non-finit (NaN/Infinity), o tratăm ca „ceas rupt" → NULL.
    const readNow = (): number | null => { try { const n = deps.now(); return Number.isFinite(n) ? n : null; } catch { return null; } };
    const onAbort = () => finish(false);
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      deps.clearTimer(timer);
      if (o.signal) o.signal.removeEventListener("abort", onAbort);
      resolve({ confirmed, exit });
    };
    // Doar FULFILL-ul e dovadă de reap. Un REJECT al lui `waitExit()` (eroare) NU dovedește ieșirea copilului → lăsăm
    // `exitDone` false (fail-closed): fără reap confirmat, `confirmTeardown` nu declară „gol", escaladează / eșuează.
    exitP.then((e) => { exit = e; exitDone = true; }, () => { /* rejection ≠ reap — NU setăm exitDone */ });
    if (o.signal) { if (o.signal.aborted) { finish(false); return; } o.signal.addEventListener("abort", onAbort, { once: true }); }

    const start = readNow();
    if (start === null) { finish(false); return; } // ceas rupt la intrare → RED, mărginit (nu poll infinit, nu promise respins)
    const deadline = start + o.maxMs;              // deadline pe CEAS MONOTON

    const poll = () => {
      if (settled) return;
      const now = readNow();
      // ⭐ Ceas rupt SAU deadline depășit → PREA TÂRZIU: RED, chiar dacă grupul apare gol + exitP rezolvat ACUM (un timer
      // întârziat / salt de ceas nu transformă un teardown ratat în „curat"). Mărginit — niciun poll infinit.
      if (now === null || now >= deadline) { finish(false); return; }
      if (!proc.groupAlive() && exitDone) { finish(true); return; }
      // Următorul poll NU depășește deadline-ul: dacă `intervalMs > timpul rămas`, programăm la timpul rămas → terminăm
      // la maxMs, nu după un interval mai lung.
      timer = deps.setTimer(Math.min(o.intervalMs, Math.max(0, deadline - now)), poll);
    };
    poll();
  });
}

/**
 * Oprește worker-ul, IDEMPOTENT + fail-closed:
 *   1. SIGTERM pe GRUP.
 *   2. Fereastra de grace pentru GRUP: dacă grupul se golește ȘI liderul e reap-uit în grace →
 *        - lider exit 0 → `{ok:true}` (CURAT);   lider exit ≠ 0 / semnal → `{ok:false, stop_failed}`.
 *   3. Altfel (lider atârnă / nepot supraviețuitor / abort) → SIGKILL pe GRUP → confirmă grup dispărut + lider reap-uit
 *      (bounded) → `{ok:false, stop_timeout}`.
 *
 * `signal` (opțional) = semnalul orchestratorului: abort în grace → escaladăm imediat. Grace INVALID → fail-safe: sărim
 * grace-ul, direct SIGKILL + confirmare (niciodată hang).
 */
export async function stopManagedProcess(
  proc:   ManagedProc,
  timing: StopTiming,
  deps:   StopTimerDeps,
  signal?: AbortSignal,
): Promise<ManagedStopResult> {
  const graceRaw   = timing.workerShutdownGraceMs;
  const grace      = Number.isFinite(graceRaw) && graceRaw > 0 ? graceRaw : 0;                                 // validare cgpt
  const intervalMs = Number.isFinite(timing.killConfirmIntervalMs) && (timing.killConfirmIntervalMs as number) > 0 ? (timing.killConfirmIntervalMs as number) : 100;
  const maxConfirm = Number.isFinite(timing.killConfirmMaxMs) && (timing.killConfirmMaxMs as number) > 0 ? (timing.killConfirmMaxMs as number) : 5_000;

  const exitP = proc.waitExit(); // memoizat
  proc.signalGroup("SIGTERM");

  if (grace > 0) {
    const t = await confirmTeardown(proc, exitP, deps, { intervalMs, maxMs: grace, signal });
    if (t.confirmed) {
      return t.exit && t.exit.kind === "code" && t.exit.code === 0
        ? { ok: true,  teardownConfirmed: true }
        : { ok: false, code: "stop_failed", teardownConfirmed: true };
    }
    // negol în grace (supraviețuitor / lider care atârnă / abort) → escaladăm.
  }

  // SIGKILL pe GRUP + confirmare independentă (grup dispărut ȘI lider reap-uit, bounded — nu ne bazăm pe întoarcerea lui kill).
  proc.signalGroup("SIGKILL");
  const t2 = await confirmTeardown(proc, exitP, deps, { intervalMs, maxMs: maxConfirm });
  return { ok: false, code: "stop_timeout", teardownConfirmed: t2.confirmed };
}

// ────────────────────────────── redactare log worker (anti-leak) ──────────────────────────────

/**
 * Redactează o linie de log a worker-ului: URL-urile pot purta SECRETE în PATH (Alchemy `wss://…/v2/<KEY>`) — reducem
 * orice URL la ORIGINE + „/…", tăind path/query/hash. PUR + testabil.
 */
export function redactWorkerLog(line: string): string {
  return line.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, (m) => {
    try { return new URL(m).origin + "/…"; } catch { return "…"; }
  });
}

// ────────────────────────────── spawn REAL (adaptor, integration-tested) ──────────────────────────────

export interface SpawnSpec {
  command: string;
  args:    readonly string[];
  cwd:     string;
  env:     Record<string, string>;
  /** Debug OPT-IN: stderr redactat linie cu linie. Fără el, stderr = `ignore` (DEFAULT, anti-leak). */
  onDebugLine?: (line: string) => void;
}

/**
 * Pornește un proces DETACHED (grup nou) și clasifică pornirea (primul dintre `spawn`/`error`). `waitExit()` se rezolvă
 * DOAR pe event `exit` (un `error` NU înseamnă `exit`). stdio DEFAULT `ignore`.
 */
export function spawnManagedProcess(spec: SpawnSpec): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const stderrMode = spec.onDebugLine ? "pipe" : "ignore";
    let child: ChildProcess;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd:      spec.cwd,
        // Cast necesar: tsconfig-ul MCP trage `next/types/global.d.ts` care face `NODE_ENV` OBLIGATORIU pe `ProcessEnv`,
        // deci un `Record<string,string>` construit dinamic nu e assignable la `SpawnOptions.env` (doctrina 12.2d-mcp).
        env:      spec.env as unknown as NodeJS.ProcessEnv,
        detached: true,
        stdio:    ["ignore", "ignore", stderrMode],
      });
    } catch {
      resolve({ ok: false, code: "spawn_failed" });
      return;
    }

    // Ieșirea LIDERULUI — EXCLUSIV pe event `exit` (P1: `error` ≠ `exit`).
    let exitResolve!: (e: ProcExit) => void;
    const exitP = new Promise<ProcExit>((res) => { exitResolve = res; });
    let exited = false;
    child.once("exit", (code, sig) => { if (!exited) { exited = true; exitResolve(sig ? { kind: "signal", signal: sig } : { kind: "code", code: code ?? -1 }); } });

    if (spec.onDebugLine && child.stderr) {
      const MAX_DEBUG_BUF = 65_536;
      const SUPPRESSED = "[stderr worker: linie > 64KB — suprimată]"; // marker STATIC (fără conținut)
      let buf = "";
      let suppressing = false; // aruncăm restul unei linii deja prea lungi, până la newline-ul ei
      const emit = (line: string) => { try { spec.onDebugLine!(redactWorkerLog(line)); } catch { /* debug best-effort */ } };
      const emitStatic = () => { try { spec.onDebugLine!(SUPPRESSED); } catch { /* best-effort */ } };
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          // O linie prea lungă (fie completă acum, fie continuarea uneia deja suprimate) NU se emite ca CONȚINUT — un
          // secret poate TRAVERSA limita de 64KB și ar scăpa redactării (redactat pe jumătate). Doar marker STATIC.
          if (suppressing) { suppressing = false; emitStatic(); }
          else if (line.length > MAX_DEBUG_BUF) emitStatic();
          else emit(line);
        }
        // Rest fără newline peste plafon → intrăm în suprimare + drop (bufferul rămâne realmente mărginit indiferent de chunk).
        if (buf.length > MAX_DEBUG_BUF) { suppressing = true; buf = ""; }
      });
    }

    let settled = false;
    const settle = (r: SpawnResult) => { if (!settled) { settled = true; resolve(r); } };
    child.once("error", () => { settle({ ok: false, code: "spawn_failed" }); }); // `error` pre-`spawn` = pornire eșuată; post-spawn NU atinge exitP
    child.once("spawn", () => {
      const pid = child.pid;
      if (typeof pid !== "number") { settle({ ok: false, code: "spawn_failed" }); return; }
      const proc: ManagedProc = {
        pid,
        waitExit: () => exitP,
        signalGroup: (s) => { try { process.kill(-pid, s); } catch { /* best-effort; confirmarea se face prin groupAlive() */ } },
        groupAlive: () => {
          try { process.kill(-pid, 0); return isGroupAliveFromProbe(null); }
          catch (e) { return isGroupAliveFromProbe(e as NodeJS.ErrnoException); }
        },
      };
      settle({ ok: true, proc });
    });
  });
}

// ────────────────────────────── adaptor de timere real (pt. runner) ──────────────────────────────

export const realStopTimers: StopTimerDeps = {
  setTimer:   (ms, cb) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now:        () => performance.now(), // ceas monoton
};
