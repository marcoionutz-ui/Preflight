/**
 * ws/heartbeat.ts — D1: watchdog de socket zombie (EVM WS).
 *
 * BUG-ul reparat: `manager.ts` trimitea `ws.ping()` la fiecare 30s, DAR fără listener de `pong` și fără
 * nicio detecție de stall. Un socket ZOMBIE (TCP încă deschis, dar serverul nu mai livrează nimic —
 * „half-open"/wedged) rămâne `readyState === OPEN`, deci ping-urile pleacă în gol, `close` NU se emite
 * niciodată, reconnect-ul din `on("close")` NU se declanșează → flow-ul se oprește TĂCUT pe veci. Exact
 * tema Fazei D: procesul pare viu, dar urechea e moartă.
 *
 * Fix (heartbeat ping/pong canonic): la fiecare tick, dacă ping-ul ANTERIOR n-a primit `pong` → socketul
 * e mort → `terminate()` (forțează `close` → reconnect). Altfel, trimite un `pong`-expected `ping` nou.
 * Un `pong` de la server resetează așteptarea. Protocolul WS răspunde la ping cu pong INDIFERENT de
 * activitatea aplicației, deci e un semnal de liveness independent de fluxul de mesaje (un chain liniștit,
 * fără swap-uri, NU e fals-pozitiv). Decizia e PURĂ → testabilă izolat (fără WebSocket/timere).
 */

export type HeartbeatAction = "ping" | "terminate";

export interface HeartbeatTick {
  action:       HeartbeatAction; // ce face call-site-ul: trimite ping SAU omoară socketul zombie
  awaitingPong: boolean;         // noua stare „aștept pong" pe care call-site-ul o păstrează
}

/**
 * Un tick de heartbeat. `awaitingPong` = am trimis un ping la tick-ul anterior și încă NU a venit pong.
 *   - `awaitingPong === true`  → ping-ul precedent a rămas fără răspuns un interval întreg → socket zombie
 *     → `terminate` (și resetăm așteptarea, socketul se închide oricum).
 *   - `awaitingPong === false` → trimite un `ping` nou și marchează că așteptăm pong.
 * Un interval fără pong = mort. (Ajustează intervalul dacă vrei o toleranță mai mare.)
 */
export function heartbeatTick(awaitingPong: boolean): HeartbeatTick {
  if (awaitingPong) return { action: "terminate", awaitingPong: false };
  return { action: "ping", awaitingPong: true };
}

/** Suprafața minimă de socket pe care watchdog-ul o atinge (WebSocket-ul real din `ws` o satisface). */
export interface HeartbeatSocket {
  readonly readyState: number;
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: (data?: unknown) => void): unknown;
}

/** Controller-ul întors de `startHeartbeat` — `stop()` se cheamă din `on("close")`. */
export interface HeartbeatController {
  stop(): void;
}

export interface HeartbeatDeps<H> {
  openState:     number;                               // WebSocket.OPEN
  intervalMs:    number;
  setInterval:   (fn: () => void, ms: number) => H;    // injectat → testabil fără timere reale
  clearInterval: (h: H) => void;
  log?:          (msg: string) => void;
  onPong?:       () => void;                            // observabilitate: momentul ultimului pong (transport viu)
}

/**
 * D1 (fix wiring): CABLEAZĂ `heartbeatTick` pe un socket real. Atașează listener-ul de `pong`
 * (resetează așteptarea), pornește intervalul, și pe fiecare tick decide ping-vs-terminate prin
 * funcția pură. Ticuri sărite când socketul nu-i `OPEN` (fereastra de reconnect). Un `terminate()`
 * forțează `close` → reconnect via controller-ul de backoff.
 *
 * Wiring-ul trăiește AICI, nu inline în `manager.ts`, EXACT ca să fie testabil pe un socket fals —
 * bug-ul D1 a fost că `heartbeatTick` exista + era testat izolat, dar `manager.ts` trimitea doar
 * `ping()` și nu-l chema niciodată → socketul zombie rămânea OPEN pe veci, raportat „conectat".
 */
export function startHeartbeat<H>(ws: HeartbeatSocket, deps: HeartbeatDeps<H>): HeartbeatController {
  let awaitingPong = false;
  ws.on("pong", () => { awaitingPong = false; deps.onPong?.(); }); // pong de la server = viu → resetează + marchează
  const handle = deps.setInterval(() => {
    if (ws.readyState !== deps.openState) return;   // în reconnect/închis → nici ping, nici terminate
    const tick = heartbeatTick(awaitingPong);
    awaitingPong = tick.awaitingPong;
    if (tick.action === "terminate") {
      deps.log?.("socket zombie (ping fără pong un interval întreg) — terminate → reconnect");
      ws.terminate();
    } else {
      ws.ping();
    }
  }, deps.intervalMs);
  return { stop: () => deps.clearInterval(handle) };
}
