/**
 * discovery/discoveryCallback.ts — E23: boundary de crash-containment pentru callback-ul onLogs.
 *
 * BUG: callback-ul onLogs (index.ts) rula liveness (recordProgramLog + advanceObservedSlot) + parserele
 * `is*Log` (peste `event.logs`) + shadow handlers SINCRON, fără try/catch. Un singur event WS malformat
 * care făcea un parser să arunce urca în @solana/web3.js → uncaughtException → OMORA tot procesul de
 * discovery (procesul „pare viu", urechea moartă = tema Fazei D, dar declanșat de un throw, nu de un
 * socket wedged). Pe Node moderne un throw în handler-ul de notificare al socketului nu are unde să fie
 * prins → cade tot workerul.
 *
 * Fix: TOT corpul callback-ului rulează într-un `try` — INCLUSIV liveness-ul. (Un throw în
 * recordProgramLog / apelul inițial advanceObservedSlot n-are voie să crape procesul; dacă liveness-ul
 * aruncă, oricum n-a avut loc, deci a-l conține e strict mai bine decât a crăpa.) Orice throw SINCRON →
 * `callbackErrors++` + log cu context, procesul supraviețuiește, următorul event e procesat normal.
 * Dispatch-ul e injectat (`deps.dispatch`) → boundary-ul e testabil izolat, fără să pornească `main()`.
 *
 * SCOPE: prinde DOAR throw-uri SINCRONE. Munca async fire-and-forget din shadow handlers
 * (handleAmmV4Shadow/handlePumpfunShadow/handleClmmShadow/handleSwapShadow) e sigură SEPARAT — fiecare
 * e o funcție `void` a cărei operație async (`fetchSampleTx`, `async`) are `.catch()` intern (confirmat
 * în cele 4 fișiere) → fără unhandled rejections. Guardarea suplimentară a acelor apeluri (dacă vreodată
 * își pierd `.catch`-ul) rămâne la E21/E16/E20, nu aici.
 */
import type { LogEvent } from "./logSubscriber";

/** Dependențele boundary-ului — injectate din index.ts (production) sau din test (mock). */
export interface DiscoveryCallbackDeps {
  /** D2: înregistrează liveness-ul per-program (orice callback, chiar tx eșuată). */
  recordProgramLog:    (program: string, slot: number, now: number) => void;
  /** Avansează observed slot (liveness WS). Are `.catch` intern aici — o respingere nu propagă. */
  advanceObservedSlot: (slot: number) => Promise<unknown>;
  /** Dispatch-ul propriu-zis (cele 4 ramuri de pipeline). Un throw aici e conținut de boundary. */
  dispatch:            (event: LogEvent) => void;
  /** Contoare mutate: `events` (după gate-ul succeeded) + `callbackErrors` (pe throw conținut). */
  stats:               { events: number; callbackErrors: number };
  /** Injectat pentru testabilitate (în producție: `Date.now`). */
  now:                 () => number;
}

/**
 * Boundary-ul de crash-containment. Rulează liveness necondiționat (D2), apoi — doar pt. tx reușite —
 * dispatch-ul. TOTUL sub un singur `try`; orice throw sincron e prins, numărat și logat, fără să crape.
 */
export function runDiscoveryCallback(event: LogEvent, deps: DiscoveryCallbackDeps): void {
  try {
    // D2: ORICE callback (chiar tx eșuată) dovedește liveness-ul WS → freshness per-program ȘI observed
    // slot avansează ÎNAINTE de gate-ul `succeeded`. `observedSlot` = cel mai mare slot cu LOG WS văzut
    // (nu cu tx REUȘITĂ). Liveness-ul e în try (E23): un throw aici NU crapă procesul.
    deps.recordProgramLog(event.program, event.slot, deps.now());
    deps.advanceObservedSlot(event.slot).catch((err: Error) => {
      console.error("[SOLANA][DISCOVERY] advanceObservedSlot error:", err.message);
    });

    if (!event.succeeded) return; // tx eșuată → subscripția e vie, dar NU intră în pipeline

    deps.stats.events++;
    deps.dispatch(event);
  } catch (err) {
    // E23: containment — un event malformat NU trebuie să omoare tot procesul de discovery. Nimic
    // „silent": enqueue-ul nu s-a produs (candidatul lipsește vizibil în stats, nu e marcat procesat),
    // iar eroarea e numărată (callbackErrors) + logată cu context.
    deps.stats.callbackErrors++;
    console.error(
      "[SOLANA][DISCOVERY] callback error contained"
      + " program=" + String(event.program)
      + " slot=" + String(event.slot)
      + " sig=" + String(event.signature).slice(0, 12) + ":",
      err instanceof Error ? err.message : String(err),
    );
  }
}
