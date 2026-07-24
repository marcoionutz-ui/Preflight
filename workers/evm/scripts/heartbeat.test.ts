/**
 * scripts/heartbeat.test.ts — D1 (EVM WS watchdog).
 *
 * Testează state-machine-ul PUR `heartbeatTick` (funcția reală importată) + o simulare a buclei de
 * heartbeat: ping → pong → ping (socket viu) vs ping → (fără pong) → terminate (socket zombie).
 * Fără WebSocket/timere.
 */

import { heartbeatTick } from "../src/ws/heartbeat";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

function main(): void {
  console.log("D1 — heartbeat (EVM WS zombie watchdog)");

  // ── D1.1: prima tură (nu așteptăm pong) → trimite ping, acum așteptăm pong ──
  {
    const t = heartbeatTick(false);
    check("D1.1a. awaitingPong=false → action ping", t.action === "ping");
    check("D1.1b. → awaitingPong devine true", t.awaitingPong === true);
  }

  // ── D1.2: ping-ul anterior fără pong → terminate (socket zombie) ──
  {
    const t = heartbeatTick(true);
    check("D1.2a. awaitingPong=true → action terminate", t.action === "terminate");
    check("D1.2b. → awaitingPong resetat la false", t.awaitingPong === false);
  }

  // ── D1.3 (socket VIU): ping → pong între ticks → ping din nou, niciodată terminate ──
  {
    let awaitingPong = false;
    let terminated = false, pings = 0;
    const onPong = () => { awaitingPong = false; };
    const tick = () => {
      const t = heartbeatTick(awaitingPong);
      awaitingPong = t.awaitingPong;
      if (t.action === "terminate") terminated = true; else pings++;
    };
    for (let i = 0; i < 5; i++) { tick(); onPong(); } // pong sosește după fiecare ping
    check("D1.3a. socket viu (pong mereu) → niciodată terminate", terminated === false);
    check("D1.3b. a trimis ping la fiecare tick", pings === 5);
  }

  // ── D1.4 (socket ZOMBIE): ping, apoi zero pong → următorul tick termină ──
  {
    let awaitingPong = false;
    let terminated = false, pings = 0;
    const tick = () => {
      const t = heartbeatTick(awaitingPong);
      awaitingPong = t.awaitingPong;
      if (t.action === "terminate") terminated = true; else pings++;
    };
    tick();               // tick 1: ping (awaitingPong → true)
    check("D1.4a. tick 1 → ping (aștept pong)", pings === 1 && terminated === false);
    tick();               // tick 2: fără pong între timp → terminate
    check("D1.4b. tick 2 fără pong → terminate", terminated === true);
    check("D1.4c. nu a mai trimis un al doilea ping", pings === 1);
  }

  // ── D1.5 (recuperare): pong întârziat înainte de tick → NU termină ──
  {
    let awaitingPong = false;
    let terminated = false;
    const onPong = () => { awaitingPong = false; };
    const tick = () => {
      const t = heartbeatTick(awaitingPong);
      awaitingPong = t.awaitingPong;
      if (t.action === "terminate") terminated = true;
    };
    tick();        // ping, aștept pong
    onPong();      // pong sosește chiar înainte de următorul tick
    tick();        // awaitingPong=false → ping din nou, nu terminate
    check("D1.5. pong înainte de tick → recuperare, fără terminate", terminated === false);
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
