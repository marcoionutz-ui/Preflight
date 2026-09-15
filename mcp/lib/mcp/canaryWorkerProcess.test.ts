/**
 * lib/mcp/canaryWorkerProcess.test.ts — PH-12 12.5c-3a (lifecycle de proces Worker Base, HERMETIC).
 *
 * Testează `stopManagedProcess` + `isGroupAliveFromProbe` + `redactWorkerLog` cu primitive INJECTATE. Proprietatea
 * centrală: teardown CONFIRMAT ⇔ GRUP dispărut ȘI lider reap-uit (`exitP`). Cazuri decisive:
 *   - lider exit 0, nepot iese SINGUR în restul grace-ului → `{ok:true}`, fără SIGKILL;
 *   - după SIGKILL, grup dispărut dar `exitP` PENDING → NU declară confirmat până la reap;
 *   - `groupAlive` cu eroare necunoscută → fail-closed VIU (nu raportează fals „gone");
 *   - grace invalid → fail-safe fără hang; redactarea log-ului worker-ului (anti-leak).
 */

import {
  stopManagedProcess, redactWorkerLog, isGroupAliveFromProbe,
  type ManagedProc, type ProcExit, type StopTimerDeps, type ManagedStopResult,
} from "./canaryWorkerProcess";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const tick = () => new Promise<void>((r) => setImmediate(r));
let sawUnhandled = false;
process.on("unhandledRejection", () => { sawUnhandled = true; });

function makeFakeProc(pid = 4242): {
  proc: ManagedProc; signals: string[]; exit: (e: ProcExit) => void; rejectExit: () => void; waitCalls: () => number; setAlive: (v: boolean) => void;
} {
  let resolveExit!: (e: ProcExit) => void;
  let rejectExitFn!: (e: unknown) => void;
  const exitP = new Promise<ProcExit>((res, rej) => { resolveExit = res; rejectExitFn = rej; });
  const signals: string[] = [];
  let waitCalls = 0;
  let aliveVal = true; // implicit: grup viu la intrare
  const proc: ManagedProc = {
    pid,
    waitExit: () => { waitCalls++; return exitP; },
    signalGroup: (s) => { signals.push(s); },
    groupAlive: () => aliveVal,
  };
  return { proc, signals, exit: (e) => resolveExit(e), rejectExit: () => rejectExitFn(new Error("waitExit rejected")), waitCalls: () => waitCalls, setAlive: (v) => { aliveVal = v; } };
}

interface FakeTimer { ms: number; cb: () => void; cleared: boolean; fired: boolean; }
type ClockMode = "ok" | "throw" | "nan";
function makeFakeTimers(): { deps: StopTimerDeps; seq: FakeTimer[]; fireNext: () => void; flush: (cap?: number) => Promise<void>; pending: () => number; jump: (ms: number) => void; breakClock: (m: ClockMode) => void } {
  const seq: FakeTimer[] = [];
  let virtualNow = 0; // ceas monoton virtual: firing-ul unui timer avansează timpul cu `ms` (mimă timpul REAL)
  let clockMode: ClockMode = "ok";
  const deps: StopTimerDeps = {
    setTimer: (ms, cb) => { const t: FakeTimer = { ms, cb, cleared: false, fired: false }; seq.push(t); return t; },
    clearTimer: (h) => { if (h) (h as FakeTimer).cleared = true; },
    now: () => { if (clockMode === "throw") throw new Error("ceas rupt"); if (clockMode === "nan") return NaN; return virtualNow; },
  };
  const fireNext = () => { const t = seq.find((x) => !x.cleared && !x.fired); if (t) { t.fired = true; virtualNow += t.ms; t.cb(); } };
  // Firește timerele în ordine (avansând ceasul), dar dacă nu găsește niciunul așteaptă un tick și RE-verifică (un timer
  // poate fi programat pe o microtask ulterioară — ex. phase 2 după phase 1); se oprește doar când nu mai apare niciunul.
  const flush = async (cap = 500) => {
    for (let i = 0; i < cap; i++) {
      const t = seq.find((x) => !x.cleared && !x.fired);
      if (!t) { await tick(); if (!seq.find((x) => !x.cleared && !x.fired)) return; continue; }
      t.fired = true; virtualNow += t.ms; t.cb();
      await tick();
    }
  };
  const pending = () => seq.filter((x) => !x.cleared && !x.fired).length;
  const jump = (ms: number) => { virtualNow += ms; }; // salt de ceas (ex. deadline depășit din interiorul ferestrei)
  const breakClock = (m: ClockMode) => { clockMode = m; };
  return { deps, seq, fireNext, flush, pending, jump, breakClock };
}

function makeFakeSignal(): { signal: AbortSignal; abort: () => void; listenerCount: () => number } {
  let aborted = false;
  const listeners: Array<() => void> = [];
  const signal = {
    get aborted() { return aborted; },
    addEventListener: (_e: string, cb: () => void) => { listeners.push(cb); },
    removeEventListener: (_e: string, cb: () => void) => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); },
  } as unknown as AbortSignal;
  return { signal, abort: () => { aborted = true; listeners.slice().forEach((cb) => cb()); }, listenerCount: () => listeners.length };
}

const T = { workerShutdownGraceMs: 13_000, killConfirmIntervalMs: 100, killConfirmMaxMs: 5_000 };
async function isPending(p: Promise<unknown>): Promise<boolean> {
  return (await Promise.race([p.then(() => "settled"), tick().then(() => "pending")])) === "pending";
}

async function main(): Promise<void> {
  console.log("PH-12 12.5c-3a — lifecycle de proces Worker Base (hermetic)");

  // ── isGroupAliveFromProbe: fail-closed pe erori necunoscute ──
  check("P1. probe null (kill 0 reușit) → VIU", isGroupAliveFromProbe(null) === true);
  check("P2. ESRCH → DISPĂRUT", isGroupAliveFromProbe({ code: "ESRCH" } as NodeJS.ErrnoException) === false);
  check("P3. EPERM → VIU (există, nesignalabil)", isGroupAliveFromProbe({ code: "EPERM" } as NodeJS.ErrnoException) === true);
  check("P4. ⭐ eroare NECUNOSCUTĂ → VIU (fail-closed, nu raportează fals gone)", isGroupAliveFromProbe({ code: "EINVAL" } as NodeJS.ErrnoException) === true);
  check("P5. eroare fără code → VIU", isGroupAliveFromProbe({} as NodeJS.ErrnoException) === true);

  // ── A. lider exit 0 + grup se golește → curat ──
  {
    const { proc, signals, exit, setAlive, waitCalls } = makeFakeProc();
    const { deps, flush, pending } = makeFakeTimers();
    const p = stopManagedProcess(proc, T, deps);
    check("A1. SIGTERM trimis sincron", signals[0] === "SIGTERM");
    exit({ kind: "code", code: 0 });
    setAlive(false);              // grupul s-a golit pe SIGTERM
    await flush();
    const res = await p;
    check("A2. grup dispărut + lider exit 0 → {ok:true}", res.ok === true);
    check("A2b. teardownConfirmed === true (curat)", res.teardownConfirmed === true);
    check("A3. fără SIGKILL", !signals.includes("SIGKILL"));
    check("A4. waitExit apelat o singură dată", waitCalls() === 1);
    check("A5. niciun timer în zbor (fără leak)", pending() === 0);
  }

  // ── B. lider exit ≠ 0 + grup dispărut → stop_failed ──
  {
    const { proc, signals, exit, setAlive } = makeFakeProc();
    const { deps, flush } = makeFakeTimers();
    const p = stopManagedProcess(proc, T, deps);
    exit({ kind: "code", code: 1 });
    setAlive(false);
    await flush();
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("B1. exit 1 + grup dispărut → stop_failed", res.ok === false && res.code === "stop_failed");
    check("B2. fără SIGKILL", !signals.includes("SIGKILL"));
  }

  // ── C. lider ieșit prin SEMNAL + grup dispărut → stop_failed ──
  {
    const { proc, exit, setAlive } = makeFakeProc();
    const { deps, flush } = makeFakeTimers();
    const p = stopManagedProcess(proc, T, deps);
    exit({ kind: "signal", signal: "SIGTERM" });
    setAlive(false);
    await flush();
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("C1. semnal + grup dispărut → stop_failed", res.ok === false && res.code === "stop_failed");
  }

  // ── D. ⭐ DECISIV: lider exit 0, nepot iese SINGUR în restul grace-ului → {ok:true}, fără SIGKILL ──
  {
    const { proc, signals, exit, setAlive } = makeFakeProc();
    const { deps, fireNext, flush } = makeFakeTimers();
    const p = stopManagedProcess(proc, T, deps);
    exit({ kind: "code", code: 0 });   // liderul iese pe SIGTERM
    await tick();
    fireNext();                        // un tick de grace: grupul ÎNCĂ viu (nepot nu a ieșit încă)
    await tick();
    check("D1. încă în grace, fără SIGKILL (nepot nu a ieșit)", !signals.includes("SIGKILL") && await isPending(p));
    setAlive(false);                   // nepotul iese SINGUR, în restul grace-ului
    await flush();
    const res = await p;
    check("D2. → {ok:true} (grup golit în grace)", res.ok === true);
    check("D3. NICIUN SIGKILL (teardown curat prin SIGTERM)", !signals.includes("SIGKILL"));
  }

  // ── K. ⭐ DECISIV DEADLINE: ceasul monoton SARE peste deadline-ul de grace din INTERIORUL ferestrei, apoi grupul
  //    apare gol ȘI exitP rezolvat → tot ROȘU (o confirmare de DUPĂ deadline nu transformă un teardown ratat în curat). ──
  {
    const { proc, signals, exit, setAlive } = makeFakeProc();
    const { deps, fireNext, flush, jump } = makeFakeTimers();
    const p = stopManagedProcess(proc, { workerShutdownGraceMs: 1_000, killConfirmIntervalMs: 100, killConfirmMaxMs: 5_000 }, deps);
    await tick();
    fireNext();                       // un tick de grace (now ≈ 100 < deadline 1000), grup încă viu
    await tick();
    jump(2_000);                      // ⭐ salt de ceas peste deadline-ul de grace (now ≈ 2100 > 1000)
    exit({ kind: "code", code: 0 });  // liderul a ieșit 0...
    setAlive(false);                  // ...și grupul apare gol — DAR după deadline
    await flush();
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("K1. confirmare de DUPĂ deadline → NU curat (stop_timeout)", res.ok === false && res.code === "stop_timeout");
    check("K2. a fost nevoie de SIGKILL (deadline dominat → escaladare)", signals.includes("SIGKILL"));
  }

  // ── L. ⭐ now() ARUNCĂ în timpul poll-ului → RED mărginit, fără promise respins ──
  {
    const { proc, signals } = makeFakeProc(); // rămâne viu
    const { deps, fireNext, breakClock } = makeFakeTimers();
    const p = stopManagedProcess(proc, { workerShutdownGraceMs: 13_000, killConfirmIntervalMs: 100, killConfirmMaxMs: 5_000 }, deps);
    await tick();
    fireNext();                    // un poll normal (ceas ok)
    await tick();
    breakClock("throw");           // ceasul începe să arunce
    fireNext();                    // poll: readNow prinde throw → finish(false) → escaladare → phase 2 (ceas tot rupt → finish false)
    await tick(); await tick();
    check("L1. ceas care aruncă → SIGKILL (escaladare)", signals.includes("SIGKILL"));
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("L2. → stop_timeout mărginit (fără hang, fără rejected promise)", res.ok === false && res.code === "stop_timeout");
  }

  // ── M. ⭐ now() întoarce NaN → RED mărginit ──
  {
    const { proc, signals } = makeFakeProc();
    const { deps, fireNext, breakClock } = makeFakeTimers();
    const p = stopManagedProcess(proc, { workerShutdownGraceMs: 13_000, killConfirmIntervalMs: 100, killConfirmMaxMs: 5_000 }, deps);
    await tick();
    fireNext(); await tick();
    breakClock("nan");
    fireNext();
    await tick(); await tick();
    check("M1. ceas NaN → SIGKILL (escaladare)", signals.includes("SIGKILL"));
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("M2. → stop_timeout mărginit", res.ok === false && res.code === "stop_timeout");
  }

  // ── N. ⭐ intervalMs > maxMs → termină la maxMs, nu după interval ──
  {
    const { proc, signals, exit, setAlive } = makeFakeProc(); // viu (lider atârnă)
    const { deps, seq, fireNext, flush } = makeFakeTimers();
    const p = stopManagedProcess(proc, { workerShutdownGraceMs: 100, killConfirmIntervalMs: 1_000, killConfirmMaxMs: 5_000 }, deps);
    await tick();
    check("N1. primul poll programat la maxMs=100 (clamp), NU la interval=1000", seq[0]?.ms === 100);
    fireNext();                    // now → 100 = deadline → escaladare la maxMs (nu la 1000)
    await tick();
    check("N2. SIGKILL la maxMs, nu după interval", signals.includes("SIGKILL"));
    setAlive(false); exit({ kind: "signal", signal: "SIGKILL" });
    await flush();
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("N3. → stop_timeout", res.ok === false && res.code === "stop_timeout");
  }

  // ── E. ⭐ DECISIV: după SIGKILL, grup dispărut dar exitP PENDING → NU confirmă până la reap ──
  {
    const { proc, signals, exit, setAlive } = makeFakeProc();
    const { deps, fireNext } = makeFakeTimers();
    const { signal, abort } = makeFakeSignal();
    const p = stopManagedProcess(proc, T, deps, signal);
    abort();                           // forțează phase 2 (escaladare)
    await tick();
    check("E1. SIGKILL trimis", signals.includes("SIGKILL"));
    setAlive(false);                   // grupul a dispărut...
    fireNext();                        // poll: grup gone DAR exitP pending
    await tick();
    check("E2. ⭐ grup dispărut + exitP pending → NU confirmat (încă pending)", await isPending(p));
    exit({ kind: "signal", signal: "SIGKILL" }); // reap-ul liderului
    await tick();
    fireNext();
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("E3. după reap → stop_timeout", res.ok === false && res.code === "stop_timeout");
    check("E3b. teardownConfirmed === true (grup dispărut + reap în phase 2)", res.teardownConfirmed === true);
  }

  // ── F. lider atârnă (grace se scurge) → SIGKILL → grup dispărut + reap → stop_timeout ──
  {
    const { proc, signals, exit, setAlive } = makeFakeProc();
    const { deps, fireNext, flush } = makeFakeTimers();
    // lider atârnă (nu iese, grup viu) → phase 1 epuizează bugetul de grace → escaladare la SIGKILL.
    const p = stopManagedProcess(proc, { workerShutdownGraceMs: 300, killConfirmIntervalMs: 100, killConfirmMaxMs: 5_000 }, deps);
    let guard = 0;
    while (!signals.includes("SIGKILL") && guard++ < 40) { fireNext(); await tick(); }
    check("F1. SIGKILL după ce grace-ul s-a scurs", signals.includes("SIGKILL"));
    setAlive(false); exit({ kind: "signal", signal: "SIGKILL" }); // SIGKILL dărâmă grupul + reap
    await flush();
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("F2. → stop_timeout", res.ok === false && res.code === "stop_timeout");
  }

  // ── G. abort DEJA setat la intrare → escaladare imediată ──
  {
    const { proc, signals, exit, setAlive } = makeFakeProc();
    const { deps, flush } = makeFakeTimers();
    const preAborted = { get aborted() { return true; }, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
    const p = stopManagedProcess(proc, T, deps, preAborted);
    await tick();
    check("G1. SIGTERM apoi SIGKILL imediat", signals[0] === "SIGTERM" && signals.includes("SIGKILL"));
    setAlive(false); exit({ kind: "signal", signal: "SIGKILL" });
    await flush();
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("G2. → stop_timeout", res.ok === false && res.code === "stop_timeout");
  }

  // ── H. grace INVALID → fail-safe: sări grace, SIGTERM+SIGKILL, fără hang ──
  for (const [label, bad] of [["NaN", NaN], ["0", 0], ["Infinity", Infinity], ["negativ", -5]] as const) {
    const { proc, signals, exit, setAlive } = makeFakeProc();
    const { deps, flush } = makeFakeTimers();
    const p = stopManagedProcess(proc, { workerShutdownGraceMs: bad, killConfirmIntervalMs: 100, killConfirmMaxMs: 5_000 }, deps);
    setAlive(false); exit({ kind: "signal", signal: "SIGKILL" });
    await flush();
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check(`H(${label}). grace invalid → SIGKILL fără hang → stop_timeout`,
      signals[0] === "SIGTERM" && signals.includes("SIGKILL") && res.ok === false && res.code === "stop_timeout");
  }

  // ── I. kill NECONFIRMABIL (grupul rămâne viu) → plafon depășit → tot ROȘU ──
  {
    const { proc, signals } = makeFakeProc(); // rămâne alive (implicit true), nu iese
    const { deps, flush } = makeFakeTimers();
    const preAborted = { get aborted() { return true; }, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
    const p = stopManagedProcess(proc, { workerShutdownGraceMs: 13_000, killConfirmIntervalMs: 10, killConfirmMaxMs: 30 }, deps, preAborted);
    await flush();
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("I1. SIGKILL trimis deși grupul nu se confirmă dispărut", signals.includes("SIGKILL"));
    check("I2. plafon depășit → tot stop_timeout (orfan neconfirmat)", res.ok === false && res.code === "stop_timeout");
    check("I2b. teardownConfirmed === false (SIGKILL NEconfirmat în buget)", res.teardownConfirmed === false);
  }

  // ── J. redactWorkerLog (anti-leak) ──
  {
    const alchemy = redactWorkerLog("connecting wss://base-mainnet.g.alchemy.com/v2/SECRET_ALCHEMY_KEY subscribed");
    check("J1. cheia Alchemy din PATH tăiată", !alchemy.includes("SECRET_ALCHEMY_KEY") && alchemy.includes("base-mainnet.g.alchemy.com"));
    const q = redactWorkerLog("GET https://api.example.io/v1/x?token=abc123&k=v done");
    check("J2. query cu token tăiat", !q.includes("abc123") && !q.includes("token="));
    const plain = "Preflight Worker starting... Chains: base";
    check("J3. linie fără URL neschimbată", redactWorkerLog(plain) === plain);
    const two = redactWorkerLog("a wss://h1/v2/K1 b https://h2/p?s=K2 c");
    check("J4. mai multe URL-uri redactate", !two.includes("K1") && !two.includes("K2"));
  }

  // ── R. ⭐ waitExit() RESPINS ≠ reap: grup apare gol dar reject-ul NU confirmă → escaladare, teardownConfirmed false ──
  {
    const { proc, signals, setAlive, rejectExit } = makeFakeProc();
    const { deps, flush } = makeFakeTimers();
    const p = stopManagedProcess(proc, { workerShutdownGraceMs: 300, killConfirmIntervalMs: 100, killConfirmMaxMs: 300 }, deps);
    setAlive(false);   // grupul apare gol...
    rejectExit();      // ...dar waitExit RESPINGE (eroare) — NU e dovadă de reap
    await flush();
    const res = await p as Extract<ManagedStopResult, { ok: false }>;
    check("R1. reject ≠ reap → NU confirmat în grace → escaladare (SIGKILL)", signals.includes("SIGKILL"));
    check("R2. → stop_timeout", res.ok === false && res.code === "stop_timeout");
    check("R3. teardownConfirmed === false (reject nu dovedește reap)", res.teardownConfirmed === false);
  }

  await tick(); await tick();
  check("Z. niciun unhandled rejection pe tot parcursul", sawUnhandled === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
