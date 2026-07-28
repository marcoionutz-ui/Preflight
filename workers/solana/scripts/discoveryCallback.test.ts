/**
 * scripts/discoveryCallback.test.ts — E23 (crash-containment boundary pentru onLogs).
 *
 * Dovedește: un throw SINCRON oriunde în callback (dispatch SAU liveness) NU propagă din boundary →
 * `callbackErrors++` → următorul event e procesat normal. Boundary-ul acoperă TOT callback-ul, inclusiv
 * liveness-ul (recordProgramLog / advanceObservedSlot) — feedback varu R1 (try prea târziu).
 * Boundary-ul e `runDiscoveryCallback` (discovery/discoveryCallback.ts), importat direct (fără `main()`).
 */
import { runDiscoveryCallback, type DiscoveryCallbackDeps } from "../src/discovery/discoveryCallback";
import type { LogEvent } from "../src/discovery/logSubscriber";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

function makeEvent(over: Partial<LogEvent> = {}): LogEvent {
  return {
    program: "pumpfun", programId: "pid", signature: "sig1234567890abcdef",
    slot: 100, logs: [], succeeded: true, ...over,
  };
}
function makeDeps(over: Partial<DiscoveryCallbackDeps> = {}): DiscoveryCallbackDeps {
  return {
    recordProgramLog: () => {},
    advanceObservedSlot: () => Promise.resolve(),
    dispatch: () => {},
    stats: { events: 0, callbackErrors: 0 },
    now: () => 1,
    ...over,
  };
}

console.log("E23 — runDiscoveryCallback (crash-containment boundary onLogs)");

// 1. Happy path — succeeded → liveness + dispatch, fără erori.
{
  let recorded = 0, dispatched = 0;
  const deps = makeDeps({
    recordProgramLog: () => { recorded++; },
    dispatch: () => { dispatched++; },
  });
  runDiscoveryCallback(makeEvent(), deps);
  check("1a. liveness (recordProgramLog) apelat", recorded === 1);
  check("1b. dispatch apelat", dispatched === 1);
  check("1c. events++", deps.stats.events === 1);
  check("1d. fără callbackErrors", deps.stats.callbackErrors === 0);
}

// 2. Dispatch aruncă SINCRON → prins, nu propagă din callback, callbackErrors++.
{
  const deps = makeDeps({ dispatch: () => { throw new Error("boom dispatch"); } });
  let threw = false;
  try { runDiscoveryCallback(makeEvent(), deps); } catch { threw = true; }
  check("2a. throw în dispatch NU propagă din callback", threw === false);
  check("2b. callbackErrors++", deps.stats.callbackErrors === 1);
  check("2c. events tot ++ (înainte de dispatch)", deps.stats.events === 1);
}

// 3. Izolare între event-uri: după un event care crapă, următorul e procesat normal.
{
  let dispatched = 0;
  const deps = makeDeps({ dispatch: (e) => { if (e.slot === 1) throw new Error("boom"); dispatched++; } });
  runDiscoveryCallback(makeEvent({ slot: 1 }), deps); // crapă
  runDiscoveryCallback(makeEvent({ slot: 2 }), deps); // ok
  check("3a. primul (crapă) → callbackErrors 1", deps.stats.callbackErrors === 1);
  check("3b. al doilea procesat → dispatch 1", dispatched === 1);
  check("3c. events 2 (ambele au trecut de gate)", deps.stats.events === 2);
}

// 4. Throw în LIVENESS (recordProgramLog) → prins (varu R1: boundary acoperă TOT callback-ul).
{
  let dispatched = 0;
  const deps = makeDeps({
    recordProgramLog: () => { throw new Error("boom liveness"); },
    dispatch: () => { dispatched++; },
  });
  let threw = false;
  try { runDiscoveryCallback(makeEvent(), deps); } catch { threw = true; }
  check("4a. throw în recordProgramLog NU propagă", threw === false);
  check("4b. callbackErrors++", deps.stats.callbackErrors === 1);
  check("4c. dispatch NU s-a apelat (throw înainte)", dispatched === 0);
  check("4d. events NU a crescut (throw înainte de events++)", deps.stats.events === 0);
}

// 5. tx eșuată (succeeded=false) → liveness rulează, dispatch NU, events NU.
{
  let recorded = 0, dispatched = 0;
  const deps = makeDeps({
    recordProgramLog: () => { recorded++; },
    dispatch: () => { dispatched++; },
  });
  runDiscoveryCallback(makeEvent({ succeeded: false }), deps);
  check("5a. liveness rulează chiar pe tx eșuată", recorded === 1);
  check("5b. dispatch NU pe tx eșuată", dispatched === 0);
  check("5c. events NU crește pe tx eșuată", deps.stats.events === 0);
}

// 6. advanceObservedSlot respinge → .catch intern prinde; callback nu aruncă, dispatch continuă.
{
  let dispatched = 0;
  const deps = makeDeps({
    advanceObservedSlot: () => Promise.reject(new Error("redis down")),
    dispatch: () => { dispatched++; },
  });
  let threw = false;
  try { runDiscoveryCallback(makeEvent(), deps); } catch { threw = true; }
  check("6a. rejection din advanceObservedSlot NU propagă sincron", threw === false);
  check("6b. dispatch tot rulează (rejection e async, prins de .catch)", dispatched === 1);
  check("6c. fără callbackErrors (rejection ≠ throw sincron)", deps.stats.callbackErrors === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
