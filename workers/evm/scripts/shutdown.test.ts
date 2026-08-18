/**
 * scripts/shutdown.test.ts — PH-13 (graceful shutdown, deps injectate).
 * Partea 1 (installGracefulShutdown): înregistrare semnale, exit 0/1, idempotență, timeout, cod-de-ieșire numeric.
 * Partea 2 (lifecycle + runShutdownSequence, cgpt #3): flag global, registru de intervale, drain, ordinea corectă
 * a secvenței, persist STRICT după quiesce, exit 1 pe persist eșuat (fără succes fals), deadline autoritate finală.
 * Partea 3 (source-guards): worker wiring real (index/manager/memory/redis).
 */
import { readFileSync } from "node:fs";
import { installGracefulShutdown, type ShutdownDeps } from "../src/lib/shutdown";
import {
  isShuttingDown, markShuttingDown, trackInterval, clearAllIntervals,
  beginJob, activeJobCount, waitForDrain, runShutdownSequence,
  closeSocketsBounded, __resetLifecycleForTests,
  type ShutdownSequenceDeps, type ClosableSocket,
} from "../src/lib/lifecycle";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}
const tick = () => new Promise<void>(res => setTimeout(res, 0));

interface Harness {
  handlers: Record<string, () => void>;
  exits:    number[];
  timers:   { fn: () => void; ms: number; cleared: boolean }[];
  deps:     ShutdownDeps;
  fire:     (sig: string) => void;
  fireTimeout: (i?: number) => void;
}
function harness(over: Partial<ShutdownDeps> = {}): Harness {
  const handlers: Record<string, () => void> = {};
  const exits: number[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const deps: ShutdownDeps = {
    onShutdown: () => {},
    on: (s, h) => { handlers[s] = h; },
    exit: (c) => { exits.push(c); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeout: (h) => { const i = h as number; if (timers[i]) timers[i].cleared = true; },
    ...over,
  };
  return {
    handlers, exits, timers, deps,
    fire: (sig) => handlers[sig]?.(),
    fireTimeout: (i = 0) => { if (timers[i] && !timers[i].cleared) timers[i].fn(); },
  };
}

async function main(): Promise<void> {
console.log("PH-13 — graceful shutdown orchestrator (deps injectate)");

// ── 1. înregistrare pe SIGTERM + SIGINT (default) ─────────────────────────────
{
  const h = harness();
  installGracefulShutdown(h.deps);
  check("1. ⭐ înregistrează handler pe SIGTERM + SIGINT (default)",
    typeof h.handlers.SIGTERM === "function" && typeof h.handlers.SIGINT === "function");
}

// ── 2. succes → onShutdown rulat o dată → exit 0 + timeout anulat ──────────────
{
  let ran = 0;
  const h = harness({ onShutdown: async () => { ran++; } });
  installGracefulShutdown(h.deps);
  h.fire("SIGTERM");
  await tick(); await tick();
  check("2. ⭐⭐ SIGTERM → onShutdown rulat exact o dată + exit 0", ran === 1 && h.exits.length === 1 && h.exits[0] === 0);
  check("3. ⭐ timeout-ul de siguranță e ANULAT după succes", h.timers[0]?.cleared === true);
}

// ── 3. onShutdown aruncă → exit 1 (nu lasă procesul agățat) ────────────────────
{
  const h = harness({ onShutdown: async () => { throw new Error("boom"); } });
  installGracefulShutdown(h.deps);
  h.fire("SIGINT");
  await tick(); await tick();
  check("4. ⭐⭐ onShutdown aruncă → exit 1 (fail-safe, nu agățat)", h.exits.length === 1 && h.exits[0] === 1);
  check("5. timeout anulat și pe eroare", h.timers[0]?.cleared === true);
}

// ── 4. onShutdown atârnă → timeout dur → exit 1 ───────────────────────────────
{
  const h = harness({ onShutdown: () => new Promise<void>(() => {}), timeoutMs: 5000 }); // nu se rezolvă niciodată
  installGracefulShutdown(h.deps);
  h.fire("SIGTERM");
  await tick();
  check("6. ⭐ onShutdown agățat → NU a ieșit încă (așteaptă deadline-ul)", h.exits.length === 0);
  check("7. ⭐ timeout-ul e programat cu timeoutMs custom (5000)", h.timers[0]?.ms === 5000);
  h.fireTimeout();
  check("8. ⭐⭐ deadline depășit → exit 1 (nu blochează redeploy-ul)", h.exits.length === 1 && h.exits[0] === 1);
}

// ── 5. idempotență: al doilea semnal în timpul închiderii → exit forțat, onShutdown NU se re-rulează ─
{
  let ran = 0;
  const h = harness({ onShutdown: () => new Promise<void>(() => { ran++; }) }); // atârnă (rămânem „în shutdown")
  installGracefulShutdown(h.deps);
  h.fire("SIGTERM");
  await tick();
  check("9. primul semnal → onShutdown pornit o dată, încă în shutdown", ran === 1 && h.exits.length === 0);
  h.fire("SIGTERM");
  check("10. ⭐⭐⭐ al doilea semnal în timpul închiderii → exit forțat (1) IMEDIAT", h.exits.length === 1 && h.exits[0] === 1);
  check("11. ⭐⭐ onShutdown NU se re-rulează la al doilea semnal", ran === 1);
}

// ── 6. semnale + timeout custom ───────────────────────────────────────────────
{
  const h = harness({ signals: ["SIGUSR2"], timeoutMs: 1234, onShutdown: () => {} });
  installGracefulShutdown(h.deps);
  check("12. semnale custom respectate (SIGUSR2, fără SIGTERM implicit)",
    typeof h.handlers.SIGUSR2 === "function" && h.handlers.SIGTERM === undefined);
  h.fire("SIGUSR2");
  await tick(); await tick();
  check("13. custom: exit 0 + timeout 1234ms programat", h.exits[0] === 0 && h.timers[0]?.ms === 1234);
}

// ── 7. cod-de-ieșire numeric din onShutdown (runShutdownSequence întoarce 0/1) ─
{
  const h = harness({ onShutdown: async () => 1 }); // persist eșuat → sequence întoarce 1
  installGracefulShutdown(h.deps);
  h.fire("SIGTERM");
  await tick(); await tick();
  check("14. ⭐⭐⭐ onShutdown rezolvă 1 → exit 1 (nu forțăm 0 pe persist eșuat)", h.exits.length === 1 && h.exits[0] === 1);
}
{
  const h = harness({ onShutdown: async () => 0 });
  installGracefulShutdown(h.deps);
  h.fire("SIGTERM");
  await tick(); await tick();
  check("15. onShutdown rezolvă 0 → exit 0", h.exits.length === 1 && h.exits[0] === 0);
}

// ════════════════ Partea 2 — lifecycle + runShutdownSequence (cgpt #3) ════════════════

// ── 8. flag global de shutdown + guard „no new jobs" ──────────────────────────
{
  __resetLifecycleForTests();
  check("16. ⭐ isShuttingDown false la start", isShuttingDown() === false);
  // Pattern-ul runTracked: un job guardat NU pornește după shutdown.
  let started = 0;
  const guarded = () => { if (isShuttingDown()) return; const done = beginJob(); started++; done(); };
  guarded();
  check("17. job pornește înainte de shutdown", started === 1);
  markShuttingDown();
  check("18. ⭐⭐ markShuttingDown → isShuttingDown true", isShuttingDown() === true);
  guarded();
  check("19. ⭐⭐ niciun job nou după SIGTERM (guard pe isShuttingDown)", started === 1);
}

// ── 9. registru de intervale: clearAllIntervals oprește TOATE ─────────────────
{
  __resetLifecycleForTests();
  const cleared: unknown[] = [];
  trackInterval("A"); trackInterval("B"); trackInterval("C");
  const n = clearAllIntervals((h) => cleared.push(h));
  check("20. ⭐ clearAllIntervals oprește toate intervalele înregistrate", n === 3 && cleared.length === 3);
  check("21. registrul e golit după clear (al doilea clear = 0)", clearAllIntervals(() => {}) === 0);
}

// ── 10. drain: așteaptă job-urile în zbor, apoi timeout ───────────────────────
{
  __resetLifecycleForTests();
  const clock = () => { let t = 0; return { now: () => t, sleep: (ms: number) => { t += ms; return Promise.resolve(); } }; };
  // 10a: contor 2→1→0 → drained true
  {
    const c = clock(); let calls = 0; const counts = [2, 1, 0];
    const r = await waitForDrain({ deadlineMs: 10_000, count: () => counts[Math.min(calls++, 2)], now: c.now, sleep: c.sleep, pollMs: 50 });
    check("22. ⭐⭐ waitForDrain: job-urile se golesc → drained true, remaining 0", r.drained === true && r.remaining === 0);
  }
  // 10b: contor constant 1 + deadline mic → drained false
  {
    const c = clock();
    const r = await waitForDrain({ deadlineMs: 100, count: () => 1, now: c.now, sleep: c.sleep, pollMs: 50 });
    check("23. ⭐ waitForDrain: deadline depășit → drained false, remaining raportat", r.drained === false && r.remaining === 1);
  }
  // 10c: beginJob/activeJobCount reale
  {
    __resetLifecycleForTests();
    const d1 = beginJob(); const d2 = beginJob();
    check("24. beginJob incrementează activeJobCount", activeJobCount() === 2);
    d1(); d1(); // idempotent
    check("25. done() idempotent (al doilea apel nu scade sub real)", activeJobCount() === 1);
    d2();
    check("26. drain conceptual atins (0 job-uri)", activeJobCount() === 0);
  }
}

// ── 11. runShutdownSequence: ORDINEA corectă + exit 0 pe succes ───────────────
function seqDeps(over: Partial<ShutdownSequenceDeps>, order: string[]): ShutdownSequenceDeps {
  return {
    markShuttingDown: () => { order.push("mark"); },
    clearIntervals:   () => { order.push("clear"); return 3; },
    closeWebSockets:  () => { order.push("ws"); },
    drain:            async () => { order.push("drain"); return { drained: true, remaining: 0 }; },
    saveStrict:       async () => { order.push("save"); },
    closeRedis:       () => { order.push("redis"); },
    log:              () => {},
    ...over,
  };
}
{
  const order: string[] = [];
  const code = await runShutdownSequence(seqDeps({}, order));
  check("27. ⭐⭐⭐ secvența în ordine: mark→clear→ws→drain→save→redis",
    JSON.stringify(order) === JSON.stringify(["mark", "clear", "ws", "drain", "save", "redis"]));
  check("28. ⭐⭐ persist reușit + resurse închise → exit 0", code === 0);
}

// ── 12. persist EȘUAT → exit 1 (NU succes fals), Redis tot închis ─────────────
{
  const order: string[] = [];
  const code = await runShutdownSequence(seqDeps({ saveStrict: async () => { order.push("save"); throw new Error("redis down la save"); } }, order));
  check("29. ⭐⭐⭐ saveStrict aruncă → exit 1 (nu 0 fals)", code === 1);
  check("30. ⭐⭐ persist eșuat: memoria NU e raportată persistată, dar Redis tot se închide", order.includes("save") && order.includes("redis"));
  check("31. ⭐ NU continuăm după save eșuat cu vreun pas fantomă", order[order.length - 1] === "redis" && order.filter(s => s === "save").length === 1);
}

// ── 13. drain EXPIRAT → tot persistăm, DAR exit 1 (cgpt #2: nu succes fals) ────
{
  const order: string[] = [];
  const code = await runShutdownSequence(seqDeps({ drain: async () => { order.push("drain"); return { drained: false, remaining: 2 }; } }, order));
  check("32. ⭐⭐⭐ drain expirat → tot persistăm strict + închidem Redis, DAR exit 1 (nu graceful)",
    code === 1 && order.indexOf("save") > order.indexOf("drain") && order.includes("redis"));
}

// ── 13b. closeRedis EȘUAT după persist reușit → exit 1 (cgpt #5) ──────────────
{
  const order: string[] = [];
  const code = await runShutdownSequence(seqDeps({ closeRedis: () => { order.push("redis"); throw new Error("redis quit failed"); } }, order));
  check("32b. ⭐⭐ persist reușit dar closeRedis aruncă → exit 1 (nu ascundem eșecul de resurse)",
    code === 1 && order.indexOf("save") < order.indexOf("redis"));
}

// ── 13c. closeWebSockets EȘUAT → exit 1, dar continuăm secvența ───────────────
{
  const order: string[] = [];
  const code = await runShutdownSequence(seqDeps({ closeWebSockets: () => { order.push("ws"); throw new Error("ws close boom"); } }, order));
  check("32c. ⭐ closeWebSockets aruncă → exit 1, dar tot persistăm + închidem Redis",
    code === 1 && order.includes("save") && order.includes("redis"));
}

// ── 14. mark ÎNAINTE de close WS (reconnect gate deja activ când închidem) ─────
{
  const order: string[] = [];
  await runShutdownSequence(seqDeps({}, order));
  check("33. ⭐⭐ markShuttingDown se execută ÎNAINTE de closeWebSockets (gate reconnect activ la close)",
    order.indexOf("mark") < order.indexOf("ws") && order.indexOf("clear") < order.indexOf("ws"));
  check("34. ⭐ persistarea vine DUPĂ drain (memorie consistentă, nu pe jumătate scrisă)",
    order.indexOf("save") > order.indexOf("drain") && order.indexOf("save") > order.indexOf("clear"));
}

// ── 15. closeSocketsBounded (cgpt #4): close normal vs. handshake blocat → terminate ─
function timerHarness() {
  const timers: { fn: () => void; fired: boolean; cleared: boolean }[] = [];
  return {
    setTimer:   (fn: () => void, _ms: number) => { timers.push({ fn, fired: false, cleared: false }); return timers.length - 1; },
    clearTimer: (h: unknown) => { const t = timers[h as number]; if (t) t.cleared = true; },
    fireAll:    () => { for (const t of timers) if (!t.cleared && !t.fired) { t.fired = true; t.fn(); } },
  };
}
function fakeSocket(behavior: "close" | "hang"): ClosableSocket & { closed: boolean; terminated: boolean } {
  const state = { closed: false, terminated: false };
  let onClose: (() => void) | null = null;
  return {
    get closed() { return state.closed; },
    get terminated() { return state.terminated; },
    once(_ev: "close", cb: () => void) { onClose = cb; },
    close() { state.closed = true; if (behavior === "close") onClose?.(); },   // close curat → emite `close` sincron
    terminate() { state.terminated = true; onClose?.(); },                     // fallback dur → emite `close`
  };
}
{
  // 15a: socket-uri care se închid curat → 0 terminate, close() apelat
  const th = timerHarness();
  const s1 = fakeSocket("close"), s2 = fakeSocket("close");
  const res = await closeSocketsBounded([s1, s2], { perSocketTimeoutMs: 1000, setTimer: th.setTimer, clearTimer: th.clearTimer });
  check("35. ⭐⭐ closeSocketsBounded: close normal → toate închise, 0 terminate", res.closed === 2 && res.terminated === 0 && s1.closed && !s1.terminated);
}
{
  // 15b: handshake blocat (nu emite `close`) → după timeout, terminate()
  const th = timerHarness();
  const s = fakeSocket("hang");
  const p = closeSocketsBounded([s], { perSocketTimeoutMs: 1000, setTimer: th.setTimer, clearTimer: th.clearTimer });
  check("36. ⭐ handshake blocat: NU s-a terminat încă (așteaptă close)", s.terminated === false);
  th.fireAll(); // declanșează timeout-ul per socket
  const res = await p;
  check("37. ⭐⭐⭐ handshake blocat → terminate() ca fallback + numărat", res.terminated === 1 && s.terminated === true);
}

// ── 16. reconnect gate: după markShuttingDown, un „connect" programat NU construiește ─
{
  __resetLifecycleForTests();
  let built = 0;
  // Oglindă a guard-ului de la intrarea în connectChainWebSocket.
  const connect = () => { if (isShuttingDown()) return; built++; };
  const scheduled = connect; // „timer deja programat"
  markShuttingDown();
  scheduled();               // timer-ul se declanșează DUPĂ shutdown
  check("38. ⭐⭐⭐ reconnect programat înainte de shutdown → NU construiește socket nou după markShuttingDown", built === 0);
}

// ════════════════ Partea 3 — source-guards (worker wiring real) ════════════════
{
  const idx = readFileSync("src/index.ts", "utf8");
  check("39. ⭐⭐ index.ts rulează runShutdownSequence prin installGracefulShutdown",
    /installGracefulShutdown\(/.test(idx) && /runShutdownSequence\(/.test(idx));
  check("40. ⭐ index.ts: intervale trackInterval + drain waitForDrain + eth-price/periodic-save prin runTracked + startup beginJob",
    /trackInterval\(/.test(idx) && /waitForDrain\(/.test(idx) && /runTracked\("ETH PRICE"/.test(idx) && /runTracked\("PERIODIC SAVE"/.test(idx) && /startupJob\s*=\s*beginJob\(\)/.test(idx));
  check("41. ⭐⭐ index.ts persistă STRICT la shutdown + închide Redis + await closeAllWebSockets",
    /saveMemoryToRedisStrict\b/.test(idx) && /closeRedis\b/.test(idx) && /closeWebSockets:\s*\(\)\s*=>\s*closeAllWebSockets\(\)/.test(idx));

  const mgr = readFileSync("src/ws/manager.ts", "utf8");
  check("42. ⭐⭐ manager.ts: guard isShuttingDown la INTRAREA în connectChainWebSocket",
    /export function connectChainWebSocket[\s\S]{0,400}isShuttingDown\(\)/.test(mgr));
  check("43. ⭐⭐ manager.ts: handler-ele open + message gate-ate pe isShuttingDown; message urmărit (beginJob/__wsJob)",
    /on\("open"[\s\S]{0,400}isShuttingDown\(\)/.test(mgr) && /on\("message"[\s\S]{0,600}isShuttingDown\(\)/.test(mgr) && /const __wsJob = beginJob\(\)/.test(mgr) && /finally\s*\{\s*__wsJob\(\)/.test(mgr));
  check("44. ⭐⭐ manager.ts: closeAllWebSockets async/bounded (closeSocketsBounded) + oprește reconnect timers",
    /export async function closeAllWebSockets/.test(mgr) && /closeSocketsBounded\(/.test(mgr) && /stopWsReconnectTimers\(/.test(mgr));

  const mem = readFileSync("src/state/memory.ts", "utf8");
  check("45. ⭐⭐ memory.ts: saveMemoryToRedisStrict aruncă pe Redis lipsă + verifică rezultatele pipeline",
    /saveMemoryToRedisStrict/.test(mem) && /throw new Error/.test(mem) && /pipe\.exec\(\)/.test(mem));

  const redis = readFileSync("src/infra/redis.ts", "utf8");
  check("46. ⭐ infra/redis.ts exportă closeRedis (quit + disconnect fallback)",
    /export async function closeRedis/.test(redis) && /\.quit\(\)/.test(redis));
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
