/**
 * scripts/beta1/harness/observers.ts — BETA-1, felia 1 (harness): observatori.
 *
 * Toți DOAR CITESC; niciunul nu schimbă traseul codului observat:
 *   - captură de consolă (liniile scrise prin `console.*`, per proces);
 *   - evidența timerelor create prin `setTimeout`/`setInterval` (global + modulul `node:timers`), cu starea
 *     callbackului (terminat / aruncat / anulat), reactivarea prin `refresh()` și `hasRef()` — un timer cu
 *     `unref()` NU ține procesul viu, deci ieșirea naturală nu-i dovedește absența; evidența îl arată separat.
 *     Erorile callbackurilor au evidență PERSISTENTĂ (`faults`), fiindcă o respingere async observată aici nu
 *     mai ajunge la `unhandledRejection`;
 *   - `uncaughtException` / `unhandledRejection`;
 *   - ascultător pe un socket WS client (cadre, erori, închidere).
 *
 * `realTimers` = funcțiile ORIGINALE, capturate la încărcarea modulului. Harness-ul le folosește pentru propriile
 * termene-limită, ca să nu-și polueze evidența. NU importă nimic din `src/`.
 */

import util from "node:util";
import timersModule from "node:timers";
import { syncBuiltinESMExports } from "node:module";

export const realTimers = {
  setTimeout:    globalThis.setTimeout,
  clearTimeout:  globalThis.clearTimeout,
  setInterval:   globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

/** Eroare de harness: gardă încălcată, barieră lipsă/expirată, control eșuat. Niciodată „defect reprodus". */
export class HarnessError extends Error {
  constructor(message: string) { super(message); this.name = "HarnessError"; }
}

function patch(target: object, key: string, value: unknown): void {
  (target as Record<string, unknown>)[key] = value;
}

/** Așteaptă MĂRGINIT o condiție. Expirarea aruncă `HarnessError` (lipsa barierei ≠ verdict). */
export function waitUntil(cond: () => boolean, deadlineMs: number, label: string, pollMs = 5): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      let ok = false;
      try { ok = cond(); } catch (e) { reject(e); return; }
      if (ok) { resolve(); return; }
      if (Date.now() - started >= deadlineMs) {
        reject(new HarnessError(`barieră expirată după ${deadlineMs}ms: ${label}`));
        return;
      }
      realTimers.setTimeout(tick, pollMs);
    };
    tick();
  });
}

/** Mărginește o promisiune: dacă nu se așază în `deadlineMs`, respinge cu `HarnessError`. */
export function withDeadline<T>(p: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = realTimers.setTimeout(() => reject(new HarnessError(`termen depășit (${deadlineMs}ms): ${label}`)), deadlineMs);
    p.then(
      (v) => { realTimers.clearTimeout(t); resolve(v); },
      (e: unknown) => { realTimers.clearTimeout(t); reject(e); },
    );
  });
}

// ── Consolă ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ConsoleLine { seq: number; level: string; text: string; }

export interface ConsoleCapture {
  lines(): ConsoleLine[];
  count(substr: string): number;
  /** Control propriu: scrie o linie-martor și verifică regăsirea ei. O captură inertă ar ascunde un `[WS ERR`. */
  selfCheck(): boolean;
}

let consoleInstalled = false;

/** Capturează `console.*`. Liniile sunt retransmise pe STDERR (stdout rămâne liber pentru rezultat). */
export function installConsoleCapture(): ConsoleCapture {
  if (consoleInstalled) throw new HarnessError("captura de consolă e deja instalată");
  consoleInstalled = true;
  const lines: ConsoleLine[] = [];
  let seq = 0;
  const errWrite = process.stderr.write.bind(process.stderr);
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    patch(console, level, (...args: unknown[]): void => {
      const text = util.format(...args);
      lines.push({ seq: ++seq, level, text });
      errWrite(text + "\n");
    });
  }
  let markerN = 0;
  return {
    lines: () => lines.map(l => ({ ...l })),
    count: (substr: string) => lines.filter(l => l.text.includes(substr)).length,
    selfCheck(): boolean {
      const marker = `[BETA1-HARNESS martor-consolă #${++markerN}]`;
      console.log(marker);
      return lines.filter(l => l.text === marker).length === 1;
    },
  };
}

// ── Timere ───────────────────────────────────────────────────────────────────────────────────────────────────

export type TimerState = "pending" | "running" | "done" | "threw" | "cleared";

export interface TimerRecord {
  id:        number;
  kind:      "timeout" | "interval";
  delayMs:   number;
  /** Faza în care a fost creat (setată de harness: „import", „connect"…). */
  phase:     string;
  /** Eticheta controlului deliberat în care a fost creat, sau `null`. */
  control:   string | null;
  state:     TimerState;
  /** De câte ori a pornit callbackul (interval: fiecare tic; timeout reactivat: fiecare execuție). */
  fires:     number;
  /** De câte ori s-a chemat `refresh()` pe handle. */
  refreshes: number;
  /** `false` = timer cu `unref()`: nu ține procesul viu, dar EXISTĂ. */
  hasRef:    boolean;
  /** Programarea a fost anulată: nu mai pornesc execuții NOI. Nu spune nimic despre cele deja pornite. */
  cancelled: boolean;
  /** Execuții ale callbackului încă neîncheiate (async în așteptare). Anularea nu le oprește. */
  inFlight:  number;
}

/**
 * Eroare a unui callback de timer. Evidența e PERSISTENTĂ: starea `threw` a înregistrării poate fi suprascrisă
 * (ex. prin `refresh()`), dar intrarea de aici rămâne. O respingere async e CONSUMATĂ de observator (îi atașează un
 * handler), deci NU mai ajunge la `unhandledRejection` — singura ei urmă e aici.
 */
export interface TimerFault {
  timerId: number;
  kind:    "sync-throw" | "async-rejection";
  message: string;
  control: string | null;
}

export interface TimerObserver {
  setPhase(phase: string): void;
  /** Rulează SINCRON `fn` ca un control deliberat: timerele create în timpul lui (și erorile lor) poartă eticheta. */
  runControl<T>(label: string, fn: () => T): T;
  records(): TimerRecord[];
  /**
   * Timere încă vii: programate să mai ruleze (inclusiv reactivate prin `refresh()` sau cu `unref()`) SAU cu execuții
   * async în lucru — acestea din urmă rămân aici și DUPĂ anulare, până se încheie.
   */
  outstanding(): TimerRecord[];
  faults(): TimerFault[];
  /** Erori de callback din afara controalelor deliberate. Orice element invalidează rularea. */
  violations(): TimerFault[];
  /**
   * DOAR pentru cleanup: anulează PROGRAMAREA a tot ce a rămas, ca procesul să se poată termina. Întoarce
   * înregistrările anulate (starea de DINAINTEA anulării) — apelantul le păstrează ca dovadă; anularea forțată nu
   * are voie să transforme o resursă rămasă în verde. Execuțiile async deja pornite NU pot fi oprite: rămân în
   * `outstanding()`.
   */
  clearOutstandingForCleanup(): TimerRecord[];
}

interface Internal extends TimerRecord { handle: NodeJS.Timeout; cancel: () => void; }

let timersInstalled = false;

export function installTimerObserver(): TimerObserver {
  if (timersInstalled) throw new HarnessError("observatorul de timere e deja instalat");
  timersInstalled = true;

  const all: Internal[] = [];
  const faults: TimerFault[] = [];
  const byHandle = new Map<object, Internal>();
  let nextId = 0;
  let phase = "start";
  let currentControl: string | null = null;

  type AnyFn = (...a: unknown[]) => unknown;
  const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

  const make = (kind: "timeout" | "interval") => (cb: AnyFn, delay?: number, ...rest: unknown[]): NodeJS.Timeout => {
    const rec = {
      id: ++nextId, kind, delayMs: Number(delay ?? 0), phase, control: currentControl,
      state: "pending", fires: 0, refreshes: 0, hasRef: true, cancelled: false, inFlight: 0,
    } as Internal;
    // Starea e DERIVATĂ din fapte SEPARATE, ca nicio ordine de evenimente să nu poată ascunde ceva viu:
    //   cancelled = PROGRAMAREA a fost anulată (clearTimeout/clearInterval/close/dispose): nu mai pornesc execuții;
    //   armed     = timerul real e programat să mai ruleze (interval: mereu, până la anulare; timeout: până rulează,
    //               și din nou după `refresh()`);
    //   inFlight  = câte execuții ale callbackului NU s-au încheiat (async în așteptare) — anularea NU le oprește
    //               și NU are voie să le ascundă;
    //   last      = rezultatul ultimei execuții încheiate.
    let armed = true;
    let last: "done" | "threw" = "done";
    const derive = (): void => {
      rec.state = rec.inFlight > 0 ? "running" : rec.cancelled ? "cleared" : armed ? "pending" : last;
    };
    const finish = (outcome: "done" | "threw"): void => { rec.inFlight--; last = outcome; derive(); };
    rec.cancel = (): void => { rec.cancelled = true; armed = false; derive(); };

    // `function`, nu arrow: Node cheamă callbackul cu handle-ul timerului drept `this` — îl transmitem neschimbat.
    const wrapped = function (this: unknown, ...a: unknown[]): void {
      rec.fires++;
      if (kind === "timeout") armed = false;
      rec.inFlight++;
      derive();
      let out: unknown;
      try { out = cb.apply(this, a); }
      catch (e) {
        faults.push({ timerId: rec.id, kind: "sync-throw", message: errText(e), control: rec.control });
        finish("threw");
        throw e;
      }
      if (out !== null && typeof out === "object" && typeof (out as { then?: unknown }).then === "function") {
        (out as Promise<unknown>).then(
          () => finish("done"),
          (e: unknown) => {
            faults.push({ timerId: rec.id, kind: "async-rejection", message: errText(e), control: rec.control });
            finish("threw");
          },
        );
      } else {
        finish("done");
      }
    };
    const orig = kind === "timeout" ? realTimers.setTimeout : realTimers.setInterval;
    const handle = (orig as unknown as (f: AnyFn, d?: number, ...r: unknown[]) => NodeJS.Timeout)(wrapped, delay, ...rest);

    // `refresh()` reactivează timerul REAL chiar după ce a rulat — evidența trebuie să-l urmeze. Un timer anulat
    // nu mai rulează după `refresh()` (callbackul e șters de `clearTimeout`), deci programarea rămâne anulată.
    const origRefresh = handle.refresh.bind(handle);
    patch(handle, "refresh", (): NodeJS.Timeout => {
      rec.refreshes++;
      if (!rec.cancelled) { armed = true; derive(); }
      return origRefresh();
    });
    // `close()` și `Symbol.dispose` anulează timerul fără a trece prin `clearTimeout` global.
    const origClose = handle.close.bind(handle);
    patch(handle, "close", (): NodeJS.Timeout => { rec.cancel(); return origClose(); });
    const disposeKey = (Symbol as unknown as { dispose?: symbol }).dispose;
    if (disposeKey !== undefined) {
      const origDispose = (handle as unknown as Record<symbol, unknown>)[disposeKey];
      if (typeof origDispose === "function") {
        (handle as unknown as Record<symbol, unknown>)[disposeKey] = (): void => {
          rec.cancel();
          (origDispose as () => void).call(handle);
        };
      }
    }

    rec.handle = handle;
    all.push(rec);
    byHandle.set(handle, rec);
    return handle;
  };

  const clear = (kind: "timeout" | "interval") => (h: unknown): void => {
    // Anularea prin id primitiv (`clearTimeout(+h)`) nu e recunoscută: înregistrarea rămâne „pending" și e
    // raportată ca rămasă — eroare în sensul SIGUR (fals-roșu, niciodată fals-verde).
    const rec = typeof h === "object" && h !== null ? byHandle.get(h) : undefined;
    if (rec) rec.cancel();
    const orig = kind === "timeout" ? realTimers.clearTimeout : realTimers.clearInterval;
    (orig as (x: unknown) => void)(h);
  };

  const wrappedSetTimeout = make("timeout");
  // `util.promisify(setTimeout)` trebuie să funcționeze în continuare (delegă la original).
  (wrappedSetTimeout as unknown as Record<symbol, unknown>)[util.promisify.custom] =
    (realTimers.setTimeout as unknown as Record<symbol, unknown>)[util.promisify.custom];

  const replacements: Record<string, unknown> = {
    setTimeout:    wrappedSetTimeout,
    setInterval:   make("interval"),
    clearTimeout:  clear("timeout"),
    clearInterval: clear("interval"),
  };
  for (const [name, fn] of Object.entries(replacements)) {
    patch(globalThis, name, fn);
    patch(timersModule, name, fn);
  }
  syncBuiltinESMExports();

  const view = (r: Internal): TimerRecord => ({
    id: r.id, kind: r.kind, delayMs: r.delayMs, phase: r.phase, control: r.control, state: r.state,
    fires: r.fires, refreshes: r.refreshes, cancelled: r.cancelled, inFlight: r.inFlight,
    hasRef: typeof r.handle.hasRef === "function" ? r.handle.hasRef() : true,
  });
  // Viu = are execuții în lucru (chiar dacă programarea e anulată) SAU mai e programat să ruleze.
  const isOutstanding = (r: Internal): boolean => r.inFlight > 0 || r.state === "pending";

  return {
    setPhase(p: string): void { phase = p; },
    runControl<T>(label: string, fn: () => T): T {
      if (currentControl !== null) throw new HarnessError("control de timer imbricat");
      currentControl = label;
      try { return fn(); } finally { currentControl = null; }
    },
    records:     () => all.map(view),
    outstanding: () => all.filter(isOutstanding).map(view),
    faults:      () => faults.map(f => ({ ...f })),
    violations:  () => faults.filter(f => f.control === null).map(f => ({ ...f })),
    clearOutstandingForCleanup(): TimerRecord[] {
      const cancelled: TimerRecord[] = [];
      for (const r of all) {
        // Deja anulat sau încheiat fără a mai fi programat → nimic de anulat.
        if (r.cancelled || r.state === "done" || r.state === "threw") continue;
        cancelled.push(view(r));
        (r.kind === "timeout" ? realTimers.clearTimeout : realTimers.clearInterval)(r.handle);
        r.cancel();
      }
      return cancelled;
    },
  };
}

// ── Excepții la nivel de proces ──────────────────────────────────────────────────────────────────────────────

export interface ProcessFault {
  kind:    "uncaughtException" | "unhandledRejection";
  message: string;
  /** Marcajul unui control deliberat anunțat prin `expect`, sau `null` = eroare reală. */
  control: string | null;
}
export interface ProcessObserver {
  /** Anunță un control deliberat: erorile al căror mesaj conține `marker` sunt etichetate, nu contează ca încălcări. */
  expect(marker: string): void;
  faults(): ProcessFault[];
  /** Erori în afara controalelor deliberate. Orice element invalidează rularea. */
  violations(): ProcessFault[];
}

let processInstalled = false;

/**
 * Înregistrează excepțiile neprinse. ATENȚIE: un ascultător de `uncaughtException` împiedică oprirea procesului —
 * apelantul TREBUIE să transforme orice `violations()` nevid în eșec. NU vede respingerile deja tratate (de exemplu
 * cele din callbackuri de timer, consumate de observatorul de timere — vezi `TimerObserver.faults`).
 */
export function installProcessObserver(): ProcessObserver {
  if (processInstalled) throw new HarnessError("observatorul de proces e deja instalat");
  processInstalled = true;
  const faults: ProcessFault[] = [];
  const expected: string[] = [];
  const msg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  const add = (kind: ProcessFault["kind"], e: unknown): void => {
    const message = msg(e);
    faults.push({ kind, message, control: expected.find(m => message.includes(m)) ?? null });
  };
  process.on("uncaughtException",  (e) => { add("uncaughtException", e); });
  process.on("unhandledRejection", (e) => { add("unhandledRejection", e); });
  return {
    expect(marker: string): void { if (marker.length < 8) throw new HarnessError("marcaj prea scurt"); expected.push(marker); },
    faults:     () => faults.map(f => ({ ...f })),
    violations: () => faults.filter(f => f.control === null).map(f => ({ ...f })),
  };
}

// ── Socket WS client ─────────────────────────────────────────────────────────────────────────────────────────

/** Minimul de care are nevoie observatorul de la un socket `ws` (evită cuplarea de tipuri cu biblioteca). */
export interface ObservableSocket {
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error",   listener: (err: Error) => void): unknown;
  on(event: "close",   listener: (code: number) => void): unknown;
  readonly readyState: number;
}

export interface SeenFrame {
  seq:    number;
  text:   string;
  /** JSON parsat, sau `undefined` dacă nu e JSON valid. */
  json:   unknown;
  /** Valoarea citită prin `readProbe` în momentul în care observatorul a văzut cadrul (ex. `activeJobCount()`). */
  probe:  number | null;
}

export interface SocketObserver {
  frames(): SeenFrame[];
  errors(): string[];
  /** `null` cât timp socketul nu s-a închis. */
  closedCode(): number | null;
  /** Așteaptă MĂRGINIT un cadru care satisface predicatul; întoarce cadrul. Expirare → `HarnessError`. */
  waitForFrame(pred: (f: SeenFrame) => boolean, deadlineMs: number, label: string): Promise<SeenFrame>;
}

/**
 * Atașează un ascultător pe socketul client. Trebuie înregistrat DUPĂ handlerul observat: `EventEmitter` cheamă
 * ascultătorii sincron, în ordinea înregistrării, deci când acesta vede un cadru, corpul SINCRON al handlerului
 * anterior s-a executat deja. Dovada NU se generalizează la un handler cu `await` — de aceea `readProbe`.
 */
export function observeSocket(ws: ObservableSocket, readProbe?: () => number): SocketObserver {
  const frames: SeenFrame[] = [];
  const errors: string[] = [];
  let closed: number | null = null;
  let seq = 0;

  ws.on("message", (data: unknown) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8")
      : Array.isArray(data) ? Buffer.concat(data as Buffer[]).toString("utf8")
      : data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8")
      : String(data);
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    frames.push({ seq: ++seq, text, json, probe: readProbe ? readProbe() : null });
  });
  ws.on("error", (err: Error) => { errors.push(err.message); });
  ws.on("close", (code: number) => { closed = code; });

  return {
    frames: () => frames.map(f => ({ ...f })),
    errors: () => [...errors],
    closedCode: () => closed,
    async waitForFrame(pred, deadlineMs, label): Promise<SeenFrame> {
      let found: SeenFrame | undefined;
      await waitUntil(() => { found = frames.find(pred); return found !== undefined; }, deadlineMs, label);
      return { ...(found as SeenFrame) };
    },
  };
}
