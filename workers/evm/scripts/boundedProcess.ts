/**
 * scripts/boundedProcess.ts — PH-12 12.5c-4 (teardown MĂRGINIT + backstop de proces pt. copii spawnați în teste de integrație).
 *
 * Fix cgpt rev6/rev7:
 *  - Un „hard timeout" care doar cheamă `kill` NU e deadline real: `await`-ul se rezolvă abia la `exit`. `awaitProcessOutcome`
 *    garantează rezolvarea în ≤ `deadlineMs + reapGraceMs`, chiar dacă kill-ul e absorbit sau `exit` nu vine.
 *  - `error` NU e mereu terminal (rev7 #1): ÎNAINTE de spawn = spawn failure (procesul nu există) → terminal `spawn_error`.
 *    DUPĂ spawn = procesul poate fi ÎNCĂ VIU (ex. semnal ne-livrabil) → îl păstrăm ca DIAGNOSTIC (`postSpawnError`) și
 *    lăsăm bound-ul să continue; DOAR `exit` confirmă reap-ul.
 *  - `deadline_unreaped` mărginește AȘTEPTAREA, dar poate abandona un copil viu (rev7 #2): `backstopKill` face un
 *    SIGKILL de process-GROUP mărginit și confirmă reap-ul; dacă nu poate confirma → `unconfirmed` (apelantul termină roșu).
 *  - Succesul teardown-ului e STRICT `exit`+code 0+fără semnal (rev7 #3): `isCleanExit`.
 *
 * Un SINGUR settle (idempotent). Timers injectabili → testabil hermetic. `spawned` derivat din `child.pid` (setat sincron
 * la spawn reușit) + evenimentul `spawn` (belt), ca un `error` post-spawn să nu fie confundat cu un spawn failure.
 */

export interface ChildLike {
  pid?: number;                                // setat sincron DOAR la spawn reușit (undefined = spawn a eșuat)
  exitCode: number | null;                     // non-null după ce a ieșit cu cod
  signalCode: NodeJS.Signals | null;           // non-null după ce a fost terminat de semnal
  on(event: "spawn", listener: () => void): unknown;
  on(event: "exit",  listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface TimerHandle { /* opac */ }
export interface TimerLike {
  set(fn: () => void, ms: number): TimerHandle;
  clear(h: TimerHandle): void;
}

/**
 * Timers reali. NU folosim `unref`: deadline-ul e un ENFORCER — trebuie să țină event-loop-ul viu până se declanșează
 * (altfel, dacă copilul detașat n-ar mai ține loop-ul, procesul ar ieși fără să aplice bound-ul). La `settle` toate
 * timerele sunt curățate, deci nu rămâne niciun ref suspendat.
 */
export const realTimers: TimerLike = {
  set(fn, ms) { return setTimeout(fn, ms); },
  clear(h) { clearTimeout(h as ReturnType<typeof setTimeout>); },
};

export type ProcOutcome =
  | { kind: "exit";              code: number | null; signal: NodeJS.Signals | null; postSpawnError?: string } // ieșire observată
  | { kind: "spawn_error";       errorCode: string }                                                          // error ÎNAINTE de spawn (terminal)
  | { kind: "deadline_reaped";   code: number | null; signal: NodeJS.Signals | null; postSpawnError?: string } // deadline → kill → exit CONFIRMAT
  | { kind: "deadline_unreaped"; postSpawnError?: string };                                                    // deadline → kill → exit NECONFIRMAT (fail-closed)

/** Succes STRICT de teardown (fix cgpt rev7 #3): ieșire ordonată cu cod 0, FĂRĂ semnal. Orice altceva = roșu. */
export function isCleanExit(o: ProcOutcome): boolean {
  return o.kind === "exit" && o.code === 0 && o.signal === null;
}

/**
 * Așteaptă rezultatul unui copil, MĂRGINIT. Se rezolvă cu:
 *   - `exit`/`spawn_error` (error PRE-spawn) dacă vin înainte de `deadlineMs`;
 *   - la `deadlineMs` fără exit → `kill(killSignal)` + fereastră `reapGraceMs`: exit în fereastră → `deadline_reaped`,
 *     altfel → `deadline_unreaped` (fail-closed). Un `error` POST-spawn NU termină — rămâne diagnostic (`postSpawnError`).
 *   Garantat ≤ `deadlineMs + reapGraceMs`.
 */
export function awaitProcessOutcome(
  child: ChildLike,
  opts: { deadlineMs: number; reapGraceMs: number; killSignal?: NodeJS.Signals; timers?: TimerLike },
): Promise<ProcOutcome> {
  const timers = opts.timers ?? realTimers;
  const killSignal = opts.killSignal ?? "SIGKILL";
  return new Promise<ProcOutcome>((resolve) => {
    // Deja ieșit înainte de a atașa handlerele (ex. race în backstop) → `exit` imediat (fără a mai aștepta un event).
    if (child.exitCode !== null || child.signalCode !== null) { resolve({ kind: "exit", code: child.exitCode, signal: child.signalCode }); return; }

    let settled = false, deadlineFired = false;
    let spawned = typeof child.pid === "number"; // pid setat sincron la spawn reușit
    let postSpawnError: string | undefined;
    let deadlineH: TimerHandle | null = null;
    let reapH: TimerHandle | null = null;
    const settle = (o: ProcOutcome) => {
      if (settled) return; settled = true;
      if (deadlineH) timers.clear(deadlineH);
      if (reapH) timers.clear(reapH);
      resolve(o);
    };
    child.on("spawn", () => { spawned = true; });
    // exit ÎNAINTE de deadline → `exit`; exit DUPĂ kill-ul de deadline (în fereastra de reap) → `deadline_reaped`.
    child.on("exit", (code, signal) => settle(deadlineFired ? { kind: "deadline_reaped", code, signal, postSpawnError } : { kind: "exit", code, signal, postSpawnError }));
    child.on("error", (err) => {
      const codeStr = typeof (err as NodeJS.ErrnoException).code === "string" ? (err as NodeJS.ErrnoException).code as string : "ERR";
      if (!spawned) { settle({ kind: "spawn_error", errorCode: codeStr }); return; } // spawn a eșuat → procesul nu există → terminal
      postSpawnError = codeStr; // POST-spawn: procesul poate fi ÎNCĂ VIU → diagnostic, NU terminăm; bound-ul continuă, doar `exit` confirmă
    });
    deadlineH = timers.set(() => {
      if (settled) return;
      deadlineFired = true;
      try { child.kill(killSignal); } catch { /* semnal absorbit/eșuat — reap-ul de mai jos mărginește */ }
      // Faza 2 (reap mărginit): dacă `exit` NU vine în `reapGraceMs` → fail-closed `deadline_unreaped` (NU atârnă).
      reapH = timers.set(() => settle({ kind: "deadline_unreaped", postSpawnError }), opts.reapGraceMs);
    }, opts.deadlineMs);
  });
}

/** Starea unui process-group, prin sonda `kill(-pid, 0)`. `unknown` (EPERM/altceva) e FAIL-CLOSED — niciodată „curat". */
export type GroupState = "alive" | "gone" | "unknown";
export type GroupProbe = (pid: number) => GroupState;

/**
 * Sonda reală de grup (fix cgpt rev7-2): `process.kill(-pid, 0)` NU trimite semnal, doar testează existența GRUPULUI.
 *   - fără eroare → grup VIU; `ESRCH` → grup DISPĂRUT; `EPERM`/altă eroare → `unknown` (viu/nesigur → fail-closed).
 * Semnalul 0 pe `-pid` (grup), niciodată pe `+pid` (ar putea lovi un proces străin dacă PID-ul a fost reutilizat).
 */
export const realGroupProbe: GroupProbe = (pid) => {
  try { process.kill(-pid, 0); return "alive"; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
};

/** SIGKILL pe GRUP (`-pid`). FĂRĂ fallback pe `+pid` (fix cgpt rev7-2): la copil `detached`, ownership-ul e process-group-ul;
 *  un `ESRCH` pe `-pid` = grup deja dispărut (îl vede sonda), iar un `+pid` ar putea semnala un proces străin reutilizat. */
const realKillGroup = (pid: number, sig: NodeJS.Signals): void => { try { process.kill(-pid, sig); } catch { /* sonda decide; fără fallback pe +pid */ } };

/**
 * Backstop de proces (fix cgpt rev7-2): confirmarea cere STRICT AMBELE — (a) liderul reap-uit prin `exit` ȘI (b)
 * process-group-ul confirmat DISPĂRUT (sonda `ESRCH`). Un lider ieșit dar cu grup încă viu (nepot orfan) NU e „curat":
 * trimitem SIGKILL grupului și continuăm verificarea mărginită.
 *   - `already_dead`: fără pid (spawn eșuat) → niciun grup/lider;
 *   - `reaped`: lider reap-uit ȘI grup dispărut (dovada „niciun consumator orfan");
 *   - `unconfirmed`: în `reapGraceMs` nu s-au confirmat AMBELE (grup încă viu / `unknown`, sau lider nereap-uit) → apelantul
 *     termină ROȘU (nu pretinde cleanup reușit).
 * `killGroup`/`groupProbe`/`timers` injectabili → testabil hermetic.
 */
export async function backstopKill(
  child: ChildLike,
  opts: { reapGraceMs: number; timers?: TimerLike; killGroup?: (pid: number, signal: NodeJS.Signals) => void; groupProbe?: GroupProbe },
): Promise<"already_dead" | "reaped" | "unconfirmed"> {
  const pid = child.pid;
  if (pid === undefined) return "already_dead"; // spawn eșuat → niciun grup/lider de curățat
  const timers    = opts.timers    ?? realTimers;
  const probe     = opts.groupProbe ?? realGroupProbe;
  const killGroup = opts.killGroup ?? realKillGroup;

  let leaderReaped = child.exitCode !== null || child.signalCode !== null;
  // Curat deja? (lider reap-uit ȘI grup dispărut) → gata, fără kill.
  if (leaderReaped && probe(pid) === "gone") return "reaped";
  // Altfel — inclusiv „lider ieșit dar grup încă viu" (fix cgpt: NU `already_dead`) — trimite SIGKILL grupului.
  killGroup(pid, "SIGKILL");

  return await new Promise<"reaped" | "unconfirmed">((resolve) => {
    let settled = false;
    let pollH: TimerHandle | null = null;
    let deadlineH: TimerHandle | null = null;
    const settle = (r: "reaped" | "unconfirmed") => {
      if (settled) return; settled = true;
      if (pollH) timers.clear(pollH);
      if (deadlineH) timers.clear(deadlineH);
      resolve(r);
    };
    const tryFinish = () => { if (leaderReaped && probe(pid) === "gone") settle("reaped"); }; // cere AMBELE
    if (!leaderReaped) child.on("exit", () => { leaderReaped = true; tryFinish(); });
    const pollMs = Math.max(5, Math.min(50, Math.floor(opts.reapGraceMs / 4)));
    const schedulePoll = () => { pollH = timers.set(() => { tryFinish(); if (!settled) schedulePoll(); }, pollMs); };
    deadlineH = timers.set(() => settle("unconfirmed"), opts.reapGraceMs); // fail-closed: neconfirmat în fereastră
    tryFinish();          // verificare imediată (grupul poate fi deja mort după kill)
    if (!settled) schedulePoll();
  });
}

/**
 * Intrare de registru pentru backstop: copilul + dacă teardown-ul lui a fost DEJA confirmat (latch).
 * Fix cgpt rev8-2: odată `teardownConfirmed`, intrarea NU mai e sondată/semnalată NICIODATĂ — chiar dacă între timp PGID-ul
 * ar fi reutilizat de un grup STRĂIN (o sondă tardivă l-ar vedea `alive` și l-ar semnala pe nedrept).
 */
export interface BackstopEntry { child: ChildLike; teardownConfirmed: boolean; }
export interface SweepSummary { confirmed: number; unconfirmed: number; skipped: number }

/**
 * Trece prin registru și confirmă teardown-ul DOAR pentru intrările încă neconfirmate (`teardownConfirmed === false`):
 * rulează `backstopKill` și LATCH-uiește (`reaped`/`already_dead` → `teardownConfirmed = true`; `unconfirmed` → rămâne false).
 * Intrările latch-uite sunt SĂRITE (fără `groupProbe`/`killGroup`). Se apelează IMEDIAT după fiecare rulare (înainte de
 * următorul spawn → fără fereastră de reutilizare PGID) ȘI în sweep-ul global (retry doar pentru cele rămase neconfirmate).
 */
export async function sweepBackstop(
  entries: readonly BackstopEntry[],
  opts: { reapGraceMs: number; timers?: TimerLike; killGroup?: (pid: number, signal: NodeJS.Signals) => void; groupProbe?: GroupProbe },
): Promise<SweepSummary> {
  let confirmed = 0, unconfirmed = 0, skipped = 0;
  for (const e of entries) {
    if (e.teardownConfirmed) { skipped++; continue; } // latch-uit → NU mai sondăm/semnalăm (PGID poate fi reutilizat)
    const r = await backstopKill(e.child, opts);
    if (r === "reaped" || r === "already_dead") { e.teardownConfirmed = true; confirmed++; }
    else unconfirmed++;
  }
  return { confirmed, unconfirmed, skipped };
}

export interface StagedRunOutcome<T> {
  results:      T[];       // rezultatele pașilor RULAȚI (poate fi mai scurt decât `steps` dacă gate-ul a oprit)
  ranAll:       boolean;   // au rulat TOȚI pașii?
  gateViolated: boolean;   // un `confirm` imediat a rămas `unconfirmed` → proprietatea „cleanup confirmat înainte de următorul spawn" e ÎNCĂLCATĂ
  stoppedAt?:   number;    // indexul pasului DUPĂ care gate-ul a oprit (dacă `gateViolated`)
}

/**
 * Rulează pași secvențial cu POARTĂ de teardown între ei (fix cgpt rev9-2): după FIECARE pas rulează `confirm` (=
 * `sweepBackstop` imediat) și, dacă rămâne vreo intrare `unconfirmed`, OPREȘTE — NU pornește pasul următor (evită fereastra
 * de reutilizare PGID). Marchează `gateViolated` (proprietate încălcată → apelantul termină ROȘU permanent, independent de
 * retry-ul global). Fără `return`-uri care să sară raportarea: apelantul citește `gateViolated`/`ranAll` și scorează.
 * Pași + confirm injectați → testabil hermetic (al doilea pas NEapelat când primul rămâne neconfirmat).
 */
export async function runStagedWithConfirm<T>(
  steps: ReadonlyArray<() => Promise<T>>,
  confirm: () => Promise<{ unconfirmed: number }>,
): Promise<StagedRunOutcome<T>> {
  const results: T[] = [];
  for (let i = 0; i < steps.length; i++) {
    results.push(await steps[i]());
    const s = await confirm();
    if (s.unconfirmed !== 0) return { results, ranAll: false, gateViolated: true, stoppedAt: i };
  }
  return { results, ranAll: true, gateViolated: false };
}
