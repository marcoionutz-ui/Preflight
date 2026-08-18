/**
 * workers/evm/src/lib/lifecycle.ts — PH-13 (shutdown REALMENTE graceful, cgpt #3).
 *
 * PROBLEMA (cgpt #3): shutdown-ul vechi doar chema `saveMemoryToRedis()` (best-effort, înghițea erorile) și ieșea
 * 0 chiar dacă persistarea eșua — o „reușită" falsă. Nu oprea intervalele/loop-urile (un scan putea muta memoria
 * DUPĂ save), nu aștepta job-urile în zbor, nu închidea WS și lăsa handler-ul de reconnect să reprogrameze socket-uri
 * în timpul închiderii.
 *
 * Acest modul ține starea de ciclu-de-viață a worker-ului + orchestratorul de shutdown, ca FRUNZĂ pură (efectele —
 * clearInterval / close WS / save / quit Redis — sunt INJECTATE), ca `runShutdownSequence` să fie unit-testabil pe
 * fake-uri, fără timere/Redis/socket-uri reale.
 *
 *   markShuttingDown()  — ridică flag-ul GLOBAL imediat (guard pt. scan-uri noi + gate pt. reconnect WS).
 *   trackInterval()     — registru de intervale, ca shutdown-ul să le poată opri pe TOATE (nu mai pornesc loop-uri noi).
 *   beginJob()/drain    — contorizează job-urile în zbor (scan/loops care scriu memoria) și așteaptă golirea lor.
 *   runShutdownSequence — ordinea corectă: flag → stop intervale → close WS → drain → persist STRICT → close Redis.
 *                         Exit 0 DOAR dacă persistarea a reușit; persist eșuat → exit 1 (nu succes fals).
 */

// ── Flag global de shutdown ───────────────────────────────────────────────────
let shuttingDown = false;
/** true de îndată ce a sosit primul semnal de terminare. Guard pt. loop-uri noi + gate pt. reconnect WS. */
export function isShuttingDown(): boolean { return shuttingDown; }
/** Ridică flag-ul. Idempotent. Trebuie apelat PRIMUL în secvența de shutdown (înainte de orice teardown). */
export function markShuttingDown(): void { shuttingDown = true; }

// ── Registru de intervale ─────────────────────────────────────────────────────
const intervals = new Set<unknown>();
/** Înregistrează un handle de `setInterval` ca shutdown-ul să-l poată opri. Întoarce handle-ul (compus la apel). */
export function trackInterval<T>(handle: T): T { intervals.add(handle); return handle; }
/** Oprește TOATE intervalele înregistrate (nu mai pornesc scan-uri/loop-uri noi). Întoarce câte a oprit. */
export function clearAllIntervals(clear: (h: unknown) => void = clearInterval as (h: unknown) => void): number {
  let n = 0;
  for (const h of intervals) { try { clear(h); } catch { /* best-effort */ } n++; }
  intervals.clear();
  return n;
}

// ── Contorizarea job-urilor în zbor (drain) ───────────────────────────────────
let activeJobs = 0;
/**
 * Marchează începutul unui job care mută starea (scan / loop). Întoarce un `done()` idempotent de apelat în `finally`.
 * Drain-ul așteaptă ca acest contor să ajungă la 0 înainte de persistare, ca să NU salvăm o memorie pe jumătate scrisă.
 */
export function beginJob(): () => void {
  activeJobs++;
  let done = false;
  return () => { if (!done) { done = true; activeJobs = Math.max(0, activeJobs - 1); } };
}
export function activeJobCount(): number { return activeJobs; }

/**
 * Așteaptă golirea job-urilor în zbor până la `deadlineMs`. PUR: `count`/`now`/`sleep` injectate (testabil fără timere
 * reale). Întoarce `{ drained, remaining }` — `drained=false` dacă a expirat deadline-ul (caller persistă oricum, dar
 * loghează câte au rămas). Nu aruncă.
 */
export async function waitForDrain(opts: {
  deadlineMs: number;
  count:      () => number;
  now:        () => number;
  sleep:      (ms: number) => Promise<void>;
  pollMs?:    number;
}): Promise<{ drained: boolean; remaining: number }> {
  const poll  = opts.pollMs ?? 50;
  const start = opts.now();
  while (opts.count() > 0) {
    if (opts.now() - start >= opts.deadlineMs) return { drained: false, remaining: opts.count() };
    await opts.sleep(poll);
  }
  return { drained: true, remaining: 0 };
}

// ── Închiderea WS bounded (PUR, efecte injectate) ─────────────────────────────
/** Socket minim închidabil (compat cu `ws`): `close()` graceful, `terminate()` dur, `once("close")` pt. await. */
export interface ClosableSocket {
  close():     void;
  terminate(): void;
  once(event: "close", cb: () => void): void;
}

/**
 * PH-13 (cgpt #4): închide un set de socket-uri WS, AȘTEPTÂND evenimentul `close` al fiecăruia, cu un timeout scurt
 * per socket după care cade pe `terminate()` (handshake care nu se mai termină). PUR: `setTimer`/`clearTimer`
 * injectate (testabil fără timere reale). Toate socket-urile se închid CONCURENT → wall-clock ≤ `perSocketTimeoutMs`,
 * deci respectă deadline-ul global de shutdown. Nu aruncă. Întoarce câte a închis curat vs. câte au necesitat terminate.
 */
export async function closeSocketsBounded(
  sockets: Iterable<ClosableSocket>,
  opts: {
    perSocketTimeoutMs: number;
    setTimer:   (fn: () => void, ms: number) => unknown;
    clearTimer: (h: unknown) => void;
  },
): Promise<{ closed: number; terminated: number }> {
  const list = [...sockets];
  let terminated = 0;
  await Promise.all(list.map(sock => new Promise<void>(resolve => {
    let settled = false;
    let timer: unknown;
    const finish = (): void => { if (!settled) { settled = true; opts.clearTimer(timer); resolve(); } };
    timer = opts.setTimer(() => {
      if (settled) return;
      try { sock.terminate(); } catch { /* best-effort */ }  // handshake blocat → închidere dură
      terminated++;
      finish();
    }, opts.perSocketTimeoutMs);
    try {
      sock.once("close", finish);   // închidere curată → resolve înainte de timeout
      sock.close();
    } catch { finish(); }
  })));
  return { closed: list.length, terminated };
}

// ── Orchestratorul de shutdown (PUR, efecte injectate) ────────────────────────
export interface ShutdownSequenceDeps {
  /** Ridică flag-ul global ÎNTÂI — blochează scan-uri noi + gate-ază reconnect-ul WS. */
  markShuttingDown: () => void;
  /** Oprește toate intervalele (scan/loops/periodic-save). Întoarce câte a oprit. */
  clearIntervals:   () => number;
  /** Închide socket-urile WS (bounded + awaited). Handler-ul `close` NU trebuie să reprogrameze reconnect. */
  closeWebSockets:  () => void | Promise<void>;
  /** Așteaptă job-urile în zbor (scan/loops/handler-e WS care scriu memoria) până la deadline. */
  drain:            () => Promise<{ drained: boolean; remaining: number }>;
  /** Persistă memoria STRICT: aruncă dacă Redis lipsește / dacă pipeline-ul a eșuat (fără reușită falsă). */
  saveStrict:       () => Promise<void>;
  /** Închide conexiunea Redis DUPĂ persistare. */
  closeRedis:       () => void | Promise<void>;
  log?:             (msg: string) => void;
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/**
 * Secvența ordonată de shutdown graceful. Întoarce CODUL DE IEȘIRE, ONEST (cgpt #2/#5):
 *   - `0` DOAR dacă TOTUL a fost curat: WS închise, drain-ul s-a TERMINAT (`drained:true`), snapshot strict reușit ȘI
 *     Redis închis fără eroare.
 *   - `1` dacă ORICE dintre acestea eșuează: drain expirat (snapshot-ul poate concura cu un job → NU e graceful),
 *     persist eșuat, SAU închiderea Redis a eșuat. Chiar și pe `1` încercăm în continuare snapshot-ul + closeRedis
 *     (nu abandonăm starea), dar NU raportăm succes fals.
 * Ordinea: markShuttingDown (1) → clearIntervals (2) → closeWebSockets (3) → drain (4) → saveStrict (5) → closeRedis (6).
 * Persistarea vine DUPĂ quiesce (intervale oprite + WS închise + job-uri golite) ca snapshot-ul să fie consistent.
 * Deadline-ul dur (din installGracefulShutdown) rămâne autoritatea finală dacă vreun pas atârnă.
 */
export async function runShutdownSequence(deps: ShutdownSequenceDeps): Promise<number> {
  const log = deps.log ?? (() => {});
  let exitCode = 0;

  deps.markShuttingDown();                                   // 1. blochează munca nouă + reconnect-ul WS
  const cleared = deps.clearIntervals();                     // 2. oprește scan/loops/periodic-save
  log(`[SHUTDOWN] intervale oprite: ${cleared}`);

  try { await deps.closeWebSockets(); log("[SHUTDOWN] WS închise (fără reconnect)"); }  // 3. close sockets (awaited)
  catch (e) { log(`[SHUTDOWN] eroare la închiderea WS: ${errMsg(e)} — exit 1`); exitCode = 1; }

  const d = await deps.drain();                              // 4. așteaptă job-urile în zbor
  if (!d.drained) {                                          // drain expirat → NU e graceful, dar tot persistăm
    log(`[SHUTDOWN] drain EXPIRAT — ${d.remaining} job(uri) încă active; snapshot-ul poate concura → exit 1 (persist oricum)`);
    exitCode = 1;
  } else {
    log("[SHUTDOWN] job-uri golite");
  }

  try {                                                      // 5. persistă STRICT (după quiesce)
    await deps.saveStrict();
    log("[SHUTDOWN] memorie persistată (strict)");
  } catch (e) {
    log(`[SHUTDOWN] PERSISTARE EȘUATĂ: ${errMsg(e)} — exit 1`);
    try { await deps.closeRedis(); } catch { /* best-effort */ }
    return 1;                                                // persist eșuat → NU succes fals
  }

  try { await deps.closeRedis(); log("[SHUTDOWN] Redis închis"); }  // 6. close Redis după persist reușit
  catch (e) { log(`[SHUTDOWN] eroare la închiderea Redis: ${errMsg(e)} — exit 1`); exitCode = 1; }

  return exitCode;
}

// ── Test-only: resetează starea de modul între cazuri ─────────────────────────
export function __resetLifecycleForTests(): void {
  shuttingDown = false;
  intervals.clear();
  activeJobs = 0;
}
