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
