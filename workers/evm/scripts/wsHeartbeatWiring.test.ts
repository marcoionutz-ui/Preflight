/**
 * scripts/wsHeartbeatWiring.test.ts — D1 (fix wiring, EVM WS watchdog).
 *
 * `heartbeat.test.ts` (test:d1) acoperă state-machine-ul PUR `heartbeatTick`. Testul ăsta acoperă
 * exact GAP-ul care a lăsat bug-ul să treacă: CABLAREA reală (`startHeartbeat`) pe un socket — listener
 * de `pong`, interval, `ping()` vs `terminate()`. Rulează pe un socket FALS + timer INJECTAT (ticuri
 * declanșate manual), fără WebSocket/timere reale. Dovada că wiring-ul chiar cheamă `terminate()` pe un
 * zombie, nu doar că funcția pură ar decide-o.
 */

import { readFileSync } from "node:fs";
import { startHeartbeat, type HeartbeatSocket } from "../src/ws/heartbeat";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const OPEN = 1, CLOSING = 2; // oglindesc WebSocket.OPEN / .CLOSING (valorile reale ale lib-ului `ws`)

/**
 * Socket fals + timer injectat. `autoPong` = serverul răspunde la ping cu pong IMEDIAT (socket viu);
 * fără el, ping-urile pleacă în gol (zombie). `tick()` declanșează manual callback-ul de interval.
 */
function makeHarness(opts: { autoPong: boolean; readyState?: number }) {
  const calls = { ping: 0, terminate: 0, pong: 0 };
  let pongCb: (() => void) | null = null;
  let tickFn: (() => void) | null = null;

  const ws: HeartbeatSocket = {
    get readyState() { return opts.readyState ?? OPEN; },
    ping() { calls.ping++; if (opts.autoPong && pongCb) pongCb(); },
    terminate() { calls.terminate++; },
    on(_event, listener) { pongCb = listener as () => void; return undefined; },
  };

  const ctrl = startHeartbeat(ws, {
    openState:     OPEN,
    intervalMs:    30_000,
    setInterval:   (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { tickFn = null; },
    onPong:        () => { calls.pong++; },
  });

  return {
    calls,
    tick:      () => { if (tickFn) tickFn(); },
    pong:      () => { if (pongCb) pongCb(); },
    stop:      () => ctrl.stop(),
    isRunning: () => tickFn !== null,
  };
}

function main(): void {
  console.log("D1 — wsHeartbeatWiring (cablarea reală a watchdog-ului EVM)");

  // ── zombie: fără pong → al doilea tick omoară socketul ──
  {
    const h = makeHarness({ autoPong: false });
    h.tick(); // tick 1: awaitingPong=false → ping, acum așteptăm pong
    check("1a. primul tick → ping trimis", h.calls.ping === 1);
    check("1b. primul tick → NU terminate", h.calls.terminate === 0);
    h.tick(); // tick 2: ping-ul precedent fără pong → terminate
    check("1c. ⭐ al doilea tick fără pong → terminate() CHEMAT", h.calls.terminate === 1);
    check("1d. nu mai trimite ping pe tick-ul de terminate", h.calls.ping === 1);
  }

  // ── viu: serverul răspunde cu pong → nu se termină niciodată ──
  {
    const h = makeHarness({ autoPong: true });
    h.tick(); h.tick(); h.tick();
    check("2a. ⭐ socket viu (pong la fiecare ping) → 3 ping-uri", h.calls.ping === 3);
    check("2b. ⭐ socket viu → terminate() NICIODATĂ", h.calls.terminate === 0);
    check("2c. onPong chemat la fiecare pong (observabilitate lastPongAt)", h.calls.pong === 3);
  }

  // ── pong între ticuri resetează așteptarea (nu se termină un socket care revine) ──
  {
    const h = makeHarness({ autoPong: false });
    h.tick();  // ping, awaitingPong=true
    h.pong();  // pong întârziat → resetează
    h.tick();  // awaitingPong=false din nou → ping, NU terminate
    check("3a. pong între ticuri → tick-ul următor NU termină", h.calls.terminate === 0);
    check("3b. → trimite alt ping în loc", h.calls.ping === 2);
  }

  // ── socket ne-OPEN (în reconnect) → tick sare, nici ping nici terminate ──
  {
    const h = makeHarness({ autoPong: false, readyState: CLOSING });
    h.tick(); h.tick();
    check("4a. readyState≠OPEN → fără ping", h.calls.ping === 0);
    check("4b. readyState≠OPEN → fără terminate", h.calls.terminate === 0);
  }

  // ── stop() oprește bucla (apelat din on('close')) ──
  {
    const h = makeHarness({ autoPong: false });
    check("5a. înainte de stop → bucla rulează", h.isRunning() === true);
    h.stop();
    check("5b. ⭐ după stop() → intervalul e curățat", h.isRunning() === false);
  }

  // ── 6. GUARD de sursă: manager.ts chiar CABLEAZĂ startHeartbeat ──
  // Fix meta-capcana D1 (obs. #1): controllerul poate fi corect, dar dacă manager.ts nu-l cheamă,
  // watchdog-ul e mort și testele de mai sus rămân verzi. Ăsta citește manager.ts și cade dacă cineva
  // scoate cablarea (import / apel / stop) SAU regresează la ping-only (`wsClient.ping()` direct).
  {
    const src = readFileSync(new URL("../src/ws/manager.ts", import.meta.url), "utf8");
    check("6a. ⭐ manager.ts importă startHeartbeat din ./heartbeat",
      /import\s*\{\s*startHeartbeat\s*\}\s*from\s*["']\.\/heartbeat["']/.test(src));
    check("6b. ⭐ manager.ts CHEAMĂ startHeartbeat(wsClient, …)",
      /startHeartbeat\(\s*wsClient/.test(src));
    check("6c. ⭐ manager.ts oprește bucla la close (heartbeat.stop())",
      /heartbeat\.stop\(\)/.test(src));
    check("6d. ⭐ NU a regresat la ping-only (fără `wsClient.ping()` direct în manager)",
      !src.includes("wsClient.ping("));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
