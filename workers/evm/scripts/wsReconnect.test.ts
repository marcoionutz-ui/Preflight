/**
 * scripts/wsReconnect.test.ts — E27b (controller de reconnect — integrarea, nu doar formula).
 *
 * Acoperă exact capcanele semnalate:
 *   - close-uri consecutive → attempt 0,1,2… (backoff crește);
 *   - `open` urmat imediat de `close` → backoff-ul NU se resetează (endpoint accept+close = tot backoff);
 *   - conexiune stabilă (peste stableMs) → attempt resetat la 0;
 *   - connect() aruncă sincron repetat → reprogramare protejată + contorizată, FĂRĂ excepție necapturată;
 *   - attempts INDEPENDENTE per chain;
 *   - maximum UN timer de reconnect activ per chain.
 * Scheduler + rand + connect INJECTATE (timp virtual) → determinist, fără WebSocket real.
 */
import { createReconnectManager, type ReconnectManagerDeps, type ReconnectManager } from "../src/ws/wsBackoff";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// Scheduler cu timp virtual; permite reprogramări în timpul avansării (recursiv).
function makeScheduler() {
  let seq = 0, now = 0;
  const timers = new Map<number, { fn: () => void; due: number }>();
  const scheduled: number[] = [];
  return {
    setTimer: (fn: () => void, ms: number): unknown => { const id = ++seq; timers.set(id, { fn, due: now + ms }); scheduled.push(ms); return id; },
    clearTimer: (h: unknown): void => { timers.delete(h as number); },
    advance: (ms: number): void => {
      const target = now + ms;
      while (true) {
        let next: [number, { fn: () => void; due: number }] | null = null;
        for (const e of timers) if (e[1].due <= target && (!next || e[1].due < next[1].due)) next = [e[0], e[1]];
        if (!next) break;
        now = next[1].due; timers.delete(next[0]); next[1].fn();
      }
      now = target;
    },
    active: (): number => timers.size,
    scheduled: (): number[] => scheduled.slice(),
    last: (): number => scheduled[scheduled.length - 1],
  };
}

const CFG = { baseMs: 1000, capMs: 30_000, jitterRatio: 0.5 };
// rand=1 → delay = exp (fără componentă random) → attempt 0→1000, 1→2000, 2→4000, 3→8000, 4→16000, 5→cap 30000.
function makeMgr(connect: (id: string) => void, sched: ReturnType<typeof makeScheduler>) {
  const deps: ReconnectManagerDeps = {
    connect,
    config:     CFG,
    stableMs:   60_000,
    setTimer:   sched.setTimer,
    clearTimer: sched.clearTimer,
    rand:       () => 1,
  };
  return createReconnectManager(deps);
}

function main(): void {
  console.log("E27b — createReconnectManager (integrare reconnect)");

  // A. close-uri consecutive → attempt crește; delays 1000,2000,4000; UN singur timer activ.
  {
    const s = makeScheduler();
    const mgr = makeMgr(() => {}, s);
    mgr.handleClose("base"); check("1. close#1 → attempt 1", mgr.getAttempt("base") === 1);
    mgr.handleClose("base"); check("2. close#2 → attempt 2", mgr.getAttempt("base") === 2);
    mgr.handleClose("base"); check("3. close#3 → attempt 3", mgr.getAttempt("base") === 3);
    check("4. delays backoff 1000,2000,4000", JSON.stringify(s.scheduled()) === JSON.stringify([1000, 2000, 4000]));
    check("5. maximum UN timer de reconnect activ", s.active() === 1);
  }

  // B. open urmat imediat de close → backoff NU se resetează (delay 2000, nu 1000).
  {
    const s = makeScheduler();
    let connects = 0;
    const mgr = makeMgr(() => { connects++; }, s);
    mgr.handleClose("base");         // attempt→1, timer delay 1000
    s.advance(1000);                 // timer firează → connect() (socket „creat")
    check("6. connect apelat o dată după delay", connects === 1);
    mgr.handleOpen("base");          // socket „open" → programează stableTimer (60s), attempt rămâne 1
    mgr.handleClose("base");         // „close" imediat (înainte de stableMs)
    check("7. open+close imediat → attempt 2 (nu reset)", mgr.getAttempt("base") === 2);
    check("8. delay = 2000 (backoff păstrat), NU 1000", s.last() === 2000);
  }

  // C. conexiune stabilă (peste stableMs) → attempt resetat la 0.
  {
    const s = makeScheduler();
    const mgr = makeMgr(() => {}, s);
    mgr.handleClose("base");         // attempt→1
    s.advance(1000);                 // connect
    mgr.handleOpen("base");          // stableTimer 60s
    check("9. înainte de stableMs → attempt încă 1", mgr.getAttempt("base") === 1);
    s.advance(60_000);               // stableTimer firează → reset
    check("10. după stableMs stabil → attempt 0", mgr.getAttempt("base") === 0);
    mgr.handleClose("base");
    check("11. următorul close pornește iar de la delay 1000", s.last() === 1000 && mgr.getAttempt("base") === 1);
  }

  // D. connect() aruncă sincron repetat → reprogramare protejată + contorizată, fără excepție necapturată.
  {
    const s = makeScheduler();
    let connects = 0;
    const mgr = makeMgr(() => { connects++; throw new Error("URL invalid"); }, s);
    let escaped = false;
    try {
      mgr.handleClose("base");       // attempt→1, delay 1000
      s.advance(1000);               // fire → connect throws → reschedule (attempt→2, delay 2000)
      s.advance(2000);               // fire → throws → reschedule (attempt→3, delay 4000)
      s.advance(4000);               // fire → throws → reschedule (attempt→4, delay 8000)
    } catch { escaped = true; }
    check("12. niciun throw necapturat scăpat din controller", escaped === false);
    check("13. connect încercat de 3 ori (fiecare protejat)", connects === 3);
    check("14. attempt contorizat prin throw-uri → 4", mgr.getAttempt("base") === 4);
    check("15. delays cu backoff prin throw-uri 1000,2000,4000,8000",
      JSON.stringify(s.scheduled()) === JSON.stringify([1000, 2000, 4000, 8000]));
    check("16. tot maximum UN timer activ după reprogramări", s.active() === 1);
  }

  // E. attempts INDEPENDENTE per chain.
  {
    const s = makeScheduler();
    const mgr = makeMgr(() => {}, s);
    mgr.handleClose("base"); mgr.handleClose("base");   // base → 2
    mgr.handleClose("arb");                              // arb → 1
    check("17. base attempt 2 independent", mgr.getAttempt("base") === 2);
    check("18. arb attempt 1 independent", mgr.getAttempt("arb") === 1);
    check("19. două chain-uri → două timere active", s.active() === 2);
  }

  // F. conexiunea INIȚIALĂ directă (ca index.ts) → constructor throw auto-capturat → backoff programat,
  //    fără excepție; apoi retry recursiv → constructor throw din nou → attempt crescut.
  //    `connect` modelează connectChainWebSocket: `new WebSocket` aruncă → try/catch INTERN → handleClose.
  {
    const s = makeScheduler();
    let connects = 0;
    let mgr!: ReconnectManager;
    const connect = (id: string): void => {
      connects++;
      try {
        throw new Error("WebSocket ctor fail (URL invalid)"); // new WebSocket(chain.wsUrl)
      } catch {
        mgr.handleClose(id); // E27: catch-ul intern din connectChainWebSocket programează reconnect
      }
    };
    mgr = makeMgr(connect, s);

    let escaped = false;
    try {
      connect("base"); // pornire INIȚIALĂ directă, exact ca `CHAINS.forEach(c => connectChainWebSocket(c))`
    } catch { escaped = true; }
    check("20. initial connect throw → nicio excepție nu scapă", escaped === false);
    check("21. initial connect throw → reconnect programat (attempt 1)", mgr.getAttempt("base") === 1);
    check("22. initial connect throw → un singur timer activ", s.active() === 1);
    check("23. delay initial = 1000 (attempt 0)", s.last() === 1000);

    s.advance(1000); // timer firează → runConnect → connect (self-catch) → handleClose → attempt 2
    check("24. retry recursiv → connect reîncercat (2 apeluri)", connects === 2);
    check("25. retry throw din nou → attempt crescut la 2, delay 2000", mgr.getAttempt("base") === 2 && s.last() === 2000);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
