/**
 * scripts/boundedProcess.test.ts — PH-12 12.5c-4 (dovezi HERMETICE: teardown mărginit, distincția error pre/post-spawn,
 * backstop de proces, predicatul de succes STRICT).
 *
 * Fix cgpt rev6/rev7. Copil FAKE controlabil (pid/exitCode/signalCode + emit spawn/exit/error) + timers reali scurți.
 * PUR → rulează în lanțul rapid `npm test`.
 */
import { awaitProcessOutcome, backstopKill, sweepBackstop, runStagedWithConfirm, isCleanExit, type ChildLike, type ProcOutcome, type BackstopEntry } from "./boundedProcess";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

interface FakeChild extends ChildLike {
  emitSpawn(): void;
  emitExit(code: number | null, signal: NodeJS.Signals | null): void;
  emitError(err: Error): void;
  killed: Array<NodeJS.Signals | number | undefined>;
}
/** `opts.pid`: prezent = spawn reușit; `undefined` = spawn eșuat. `killReturns`: dacă `kill()` „reușește". */
function makeFakeChild(opts: { pid?: number; killReturns?: boolean } = {}): FakeChild {
  const h: { spawn: Array<() => void>; exit: Array<(c: number | null, s: NodeJS.Signals | null) => void>; error: Array<(e: Error) => void> } = { spawn: [], exit: [], error: [] };
  const child: FakeChild = {
    pid: "pid" in opts ? opts.pid : 4242,
    exitCode: null,
    signalCode: null,
    killed: [],
    on(event: string, listener: (...a: never[]) => void) {
      if (event === "spawn") h.spawn.push(listener as () => void);
      if (event === "exit")  h.exit.push(listener as (c: number | null, s: NodeJS.Signals | null) => void);
      if (event === "error") h.error.push(listener as (e: Error) => void);
      return child;
    },
    kill(signal) { child.killed.push(signal); return opts.killReturns ?? true; },
    emitSpawn() { h.spawn.forEach((f) => f()); },
    emitExit(code, signal) { child.exitCode = code; child.signalCode = signal; h.exit.forEach((f) => f(code, signal)); },
    emitError(err) { h.error.forEach((f) => f(err)); },
  };
  return child;
}
const errno = (code: string): Error => Object.assign(new Error(code), { code });

async function main(): Promise<void> {
  console.log("PH-12 12.5c-4 — boundedProcess (teardown mărginit + error pre/post-spawn + backstop + succes strict)");

  // ── 1. DECISIV: kill ABSORBIT + fără exit → `deadline_unreaped` în deadline+grace (nu atârnă) ──
  {
    const f = makeFakeChild({ killReturns: false });
    const t0 = Date.now();
    const o = await awaitProcessOutcome(f, { deadlineMs: 30, reapGraceMs: 30 });
    check("1a. ⭐⭐⭐ kill absorbit + fără exit → `deadline_unreaped` (fail-closed)", o.kind === "deadline_unreaped");
    check("1b. ⭐⭐⭐ terminat în ~deadline+grace (nu la infinit)", Date.now() - t0 < 500);
    check("1c. ⭐⭐ kill chiar încercat (faza 1)", f.killed.length === 1);
  }

  // ── 2. DECISIV (rev7 #1): error POST-spawn FĂRĂ exit → NU e declarat reap-uit; bound-ul continuă → `deadline_unreaped` ──
  {
    const f = makeFakeChild({ pid: 100 });
    f.emitSpawn(); // spawn confirmat
    const p = awaitProcessOutcome(f, { deadlineMs: 40, reapGraceMs: 40 });
    setTimeout(() => f.emitError(errno("EPIPE")), 10); // error POST-spawn, procesul poate fi viu
    const o = await p;
    check("2a. ⭐⭐⭐ error post-spawn NU termină ca `error`/`exit` (procesul poate fi viu)", o.kind === "deadline_unreaped");
    check("2b. ⭐⭐⭐ error-ul e păstrat ca DIAGNOSTIC (postSpawnError), nu ca reap", (o as { postSpawnError?: string }).postSpawnError === "EPIPE");
  }
  {
    // variantă: error post-spawn, apoi exit ordonat înainte de deadline → `exit` cu diagnostic păstrat
    const f = makeFakeChild({ pid: 101 });
    f.emitSpawn();
    const p = awaitProcessOutcome(f, { deadlineMs: 1000, reapGraceMs: 1000 });
    setTimeout(() => f.emitError(errno("EPIPE")), 5);
    setTimeout(() => f.emitExit(0, null), 20);
    const o = await p;
    check("2c. ⭐⭐⭐ error post-spawn + exit 0 ulterior → `exit` (bound-ul a continuat până la exit)", o.kind === "exit" && o.code === 0);
    check("2d. ⭐⭐ diagnosticul post-spawn e păstrat pe exit", (o as { postSpawnError?: string }).postSpawnError === "EPIPE");
  }

  // ── 3. error ÎNAINTE de spawn (fără pid) → `spawn_error` terminal ──
  {
    const f = makeFakeChild({ pid: undefined }); // spawn n-a produs pid
    const p = awaitProcessOutcome(f, { deadlineMs: 1000, reapGraceMs: 1000 });
    setTimeout(() => f.emitError(errno("ENOENT")), 5);
    const o = await p;
    check("3a. ⭐⭐⭐ error pre-spawn (fără pid) → `spawn_error` terminal", o.kind === "spawn_error" && (o as { errorCode: string }).errorCode === "ENOENT");
  }

  // ── 4. exit normal / deadline_reaped ──
  {
    const f = makeFakeChild({ pid: 200 }); f.emitSpawn();
    const p = awaitProcessOutcome(f, { deadlineMs: 1000, reapGraceMs: 1000 });
    setTimeout(() => f.emitExit(0, null), 10);
    check("4a. ⭐⭐⭐ exit 0 înainte de deadline → `exit`", isCleanExit(await p));
  }
  {
    const f = makeFakeChild({ pid: 201 }); f.emitSpawn();
    const p = awaitProcessOutcome(f, { deadlineMs: 20, reapGraceMs: 300 });
    setTimeout(() => f.emitExit(null, "SIGKILL"), 60); // după deadline, în fereastra de reap
    const o = await p;
    check("4b. ⭐⭐⭐ exit în fereastra de reap → `deadline_reaped`", o.kind === "deadline_reaped");
  }

  // ── 5. predicatul STRICT de succes (rev7 #3): DOAR exit+0+fără semnal ──
  {
    check("5a. ⭐⭐⭐ exit/0/null → verde", isCleanExit({ kind: "exit", code: 0, signal: null }));
    check("5b. ⭐⭐⭐ exit/1/null → roșu", !isCleanExit({ kind: "exit", code: 1, signal: null }));
    check("5c. ⭐⭐⭐ exit/0/SIGTERM (semnal) → roșu", !isCleanExit({ kind: "exit", code: 0, signal: "SIGTERM" }));
    check("5d. ⭐⭐⭐ deadline_reaped → roșu (a ignorat SIGTERM, omorât forțat)", !isCleanExit({ kind: "deadline_reaped", code: null, signal: "SIGKILL" }));
    check("5e. ⭐⭐⭐ deadline_unreaped → roșu", !isCleanExit({ kind: "deadline_unreaped" }));
    check("5f. ⭐⭐⭐ spawn_error → roșu", !isCleanExit({ kind: "spawn_error", errorCode: "ENOENT" }));
  }

  // ── 6. backstopKill: confirmare STRICTĂ (lider reap-uit ȘI grup dispărut), fără fallback pe +pid (rev7-2) ──
  {
    // 6a DECISIV: lider exitCode=0 dar GRUP încă viu → NU `already_dead`; group-kill OBLIGATORIU; grup rămâne viu → `unconfirmed`.
    const f = makeFakeChild({ pid: 300 }); f.exitCode = 0; // lider reap-uit
    const grpKills: number[] = [];
    const r = await backstopKill(f, { reapGraceMs: 40, groupProbe: () => "alive", killGroup: (pid) => { grpKills.push(pid); } });
    check("6a. ⭐⭐⭐ DECISIV: lider ieșit dar grup viu → NU `already_dead`, group-kill încercat", grpKills.length >= 1 && grpKills[0] === 300);
    check("6b. ⭐⭐⭐ DECISIV: grup încă viu după kill → `unconfirmed` (nepot orfan → nu pretinde curat)", r === "unconfirmed");
  }
  {
    // 6c DECISIV: grup DISPĂRUT dar liderul NU e reap-uit → `unconfirmed` (cere AMBELE)
    const f = makeFakeChild({ pid: 301 }); // exitCode rămâne null (nereap-uit), niciun emitExit
    const r = await backstopKill(f, { reapGraceMs: 30, groupProbe: () => "gone", killGroup: () => { /* */ } });
    check("6c. ⭐⭐⭐ grup dispărut dar lider nereap-uit → `unconfirmed`", r === "unconfirmed");
  }
  {
    // 6d: grup DISPĂRUT + lider reap-uit → `reaped` (ambele), fără kill (deja curat)
    const f = makeFakeChild({ pid: 302 }); f.exitCode = 0;
    let killed: boolean = false;
    const r = await backstopKill(f, { reapGraceMs: 30, groupProbe: () => "gone", killGroup: () => { killed = true; } });
    check("6d. ⭐⭐⭐ grup dispărut + lider reap-uit → `reaped`, fără kill (deja curat)", r === "reaped" && !killed);
  }
  {
    // 6e DECISIV: sonda întoarce `unknown` (EPERM/eroare) → FAIL-CLOSED `unconfirmed` (niciodată „curat")
    const f = makeFakeChild({ pid: 303 }); f.exitCode = 0;
    const r = await backstopKill(f, { reapGraceMs: 30, groupProbe: () => "unknown", killGroup: () => { /* */ } });
    check("6e. ⭐⭐⭐ sonda `unknown` (EPERM/necunoscut) → fail-closed `unconfirmed`", r === "unconfirmed");
  }
  {
    // 6f: nepot orfan omorât — grup viu inițial, apoi DISPARE după group-kill + lider reap-uit → `reaped`
    const f = makeFakeChild({ pid: 304 }); f.exitCode = 0;
    let groupAlive: boolean = true; let killedGroup: boolean = false;
    const r = await backstopKill(f, { reapGraceMs: 300, groupProbe: () => (groupAlive ? "alive" : "gone"), killGroup: () => { killedGroup = true; setTimeout(() => { groupAlive = false; }, 20); } });
    check("6f. ⭐⭐⭐ grup viu → group-kill → grup dispare + lider reap-uit → `reaped`", r === "reaped" && killedGroup);
  }
  {
    // 6g: lider iese ÎN TIMPUL poll-ului (nereap-uit inițial), grup dispărut → `reaped`
    const f = makeFakeChild({ pid: 305 }); // nereap-uit inițial
    let groupAlive = true;
    const p = backstopKill(f, { reapGraceMs: 400, groupProbe: () => (groupAlive ? "alive" : "gone"), killGroup: () => { setTimeout(() => { f.emitExit(null, "SIGKILL"); groupAlive = false; }, 20); } });
    check("6g. ⭐⭐ lider iese în timpul poll-ului + grup dispărut → `reaped`", (await p) === "reaped");
  }
  {
    // 6h: spawn eșuat (fără pid) → `already_dead`
    const f = makeFakeChild({ pid: undefined });
    const r = await backstopKill(f, { reapGraceMs: 30, groupProbe: () => "alive", killGroup: () => { /* */ } });
    check("6h. ⭐⭐ fără pid (spawn eșuat) → `already_dead`", r === "already_dead");
  }

  // ── 7. exit sincron deja consemnat înainte de await → `exit` imediat (race backstop) ──
  {
    const f = makeFakeChild({ pid: 400 }); f.exitCode = 0; f.signalCode = null;
    const o = await awaitProcessOutcome(f, { deadlineMs: 5, reapGraceMs: 5 });
    check("7a. ⭐⭐ copil deja ieșit la momentul await → `exit` imediat", isCleanExit(o));
  }

  // ── 8. sweepBackstop: LATCH per-intrare (fix cgpt rev8-2 — fără sondare tardivă / PGID reutilizat) ──
  {
    // 8a DECISIV: run 1 confirmă + latch-uiește; sweep-ul global NU mai sondează/semnalează intrarea latch-uită,
    //   chiar dacă o sondă tardivă ar răspunde `alive` (PGID reutilizat de un grup STRĂIN).
    const c1 = makeFakeChild({ pid: 500 }); c1.exitCode = 0;
    const entry: BackstopEntry = { child: c1, teardownConfirmed: false };
    const registry = [entry];
    // confirmarea imediată (grup dispărut + lider reap-uit) → latch
    const s1 = await sweepBackstop(registry, { reapGraceMs: 30, groupProbe: () => "gone", killGroup: () => { /* */ } });
    check("8a. ⭐⭐⭐ run 1: teardown confirmat + LATCH-uit", s1.confirmed === 1 && entry.teardownConfirmed === true);
    // sweep global cu o sondă care ar zice `alive` (PGID reutilizat) + spioni — intrarea latch-uită trebuie SĂRITĂ.
    let probeCalls = 0, killCalls = 0;
    const s2 = await sweepBackstop(registry, { reapGraceMs: 30, groupProbe: () => { probeCalls++; return "alive"; }, killGroup: () => { killCalls++; } });
    check("8b. ⭐⭐⭐ DECISIV: intrare latch-uită → SĂRITĂ (fără groupProbe, fără killGroup) la sweep-ul tardiv", s2.skipped === 1 && probeCalls === 0 && killCalls === 0);
    check("8c. ⭐⭐⭐ intrarea străină cu același PGID NU e semnalată (fără kill pe intrarea latch-uită)", killCalls === 0);
  }
  {
    // 8d: o intrare NEconfirmată e reîncercată și poate deveni confirmată; una persistent neconfirmată rămâne roșie.
    const cRetry = makeFakeChild({ pid: 501 }); cRetry.exitCode = 0; // lider reap-uit
    const cStuck = makeFakeChild({ pid: 502 }); cStuck.exitCode = 0;
    const eRetry: BackstopEntry = { child: cRetry, teardownConfirmed: false };
    const eStuck: BackstopEntry = { child: cStuck, teardownConfirmed: false };
    const reg = [eRetry, eStuck];
    // primul sweep: cRetry grup încă `alive` → unconfirmed; cStuck la fel.
    let phase = "alive";
    const sA = await sweepBackstop(reg, { reapGraceMs: 20, groupProbe: (pid) => (pid === 501 ? (phase as "alive" | "gone") : "alive"), killGroup: () => { /* */ } });
    check("8d. ⭐⭐ ambele neconfirmate la primul sweep", sA.unconfirmed === 2 && eRetry.teardownConfirmed === false);
    // al doilea sweep (retry): grupul lui cRetry a dispărut → confirmat; cStuck rămâne `alive` → încă unconfirmed.
    phase = "gone";
    const sB = await sweepBackstop(reg, { reapGraceMs: 20, groupProbe: (pid) => (pid === 501 ? (phase as "alive" | "gone") : "alive"), killGroup: () => { /* */ } });
    check("8e. ⭐⭐⭐ retry global: cRetry devine confirmat, cStuck rămâne unconfirmed (test roșu)",
      eRetry.teardownConfirmed === true && eStuck.teardownConfirmed === false && sB.confirmed === 1 && sB.unconfirmed === 1);
    // al treilea sweep: cRetry e acum latch-uit → sărit; cStuck tot alive → unconfirmed persistent.
    let probe502 = 0;
    const sC = await sweepBackstop(reg, { reapGraceMs: 20, groupProbe: (pid) => { if (pid === 502) probe502++; return "alive"; }, killGroup: () => { /* */ } });
    check("8f. ⭐⭐⭐ cRetry latch-uit → sărit; cStuck persistent unconfirmed → rămâne roșu", sC.skipped === 1 && sC.unconfirmed === 1 && probe502 >= 1);
  }

  // ── 9. runStagedWithConfirm: poarta de teardown între pași (fix cgpt rev9-2) ──
  {
    // 9a: confirm imediat mereu curat → TOȚI pașii rulează (al doilea spawn e apelat)
    const calls: number[] = [];
    const out = await runStagedWithConfirm(
      [async () => { calls.push(1); return "s1"; }, async () => { calls.push(2); return "s2"; }],
      async () => ({ unconfirmed: 0 }),
    );
    check("9a. ⭐⭐⭐ confirm curat după fiecare pas → toți pașii rulează (al doilea spawn apelat)", out.ranAll && !out.gateViolated && calls.length === 2 && calls[1] === 2);
  }
  {
    // 9b DECISIV: confirm imediat `unconfirmed` după pasul 1 → pasul 2 NEAPELAT + gateViolated
    const calls: number[] = [];
    const out = await runStagedWithConfirm(
      [async () => { calls.push(1); return "s1"; }, async () => { calls.push(2); return "s2"; }],
      async () => ({ unconfirmed: 1 }),
    );
    check("9b. ⭐⭐⭐ DECISIV: sweep imediat unconfirmed → al doilea pas NEAPELAT", calls.length === 1 && calls[0] === 1);
    check("9c. ⭐⭐⭐ DECISIV: gateViolated=true, ranAll=false, stoppedAt=0 (proprietate încălcată → roșu)", out.gateViolated && !out.ranAll && out.stoppedAt === 0 && out.results.length === 1);
  }
  {
    // 9d: confirm chemat DUPĂ fiecare pas (ordinea pas→confirm→pas)
    const seq: string[] = [];
    await runStagedWithConfirm(
      [async () => { seq.push("step1"); return 0; }, async () => { seq.push("step2"); return 0; }],
      async () => { seq.push("confirm"); return { unconfirmed: 0 }; },
    );
    check("9d. ⭐⭐ ordinea: step1 → confirm → step2 → confirm", seq.join(",") === "step1,confirm,step2,confirm");
  }

  console.log(`\n${passed}/${passed + failed} OK` + (failed ? `  —  ${failed} FAIL` : ""));
  if (failed) process.exit(1);
}

void main();
