/**
 * scripts/heartbeat.test.ts — PH-12 12.4 GUARD pentru CONTRACTUL PE SÂRMĂ al heartbeat-ului de serviciu.
 *
 * Trăiește AICI, în pachetul partajat, fiindcă atât publisherii worker (indexer-evm / solana) cât și reader-ul
 * (mcp/lib/health) depind de `serializeHeartbeat` / `parseHeartbeat` / praguri. Testul mcp `test:ph12-hb`
 * verifică CLASIFICATORUL (stări/scope/byte-compat); ACEST test verifică FORMATUL + pragurile de protocol,
 * independent de mcp — ca leaf 3 (publisher) să se sprijine pe cod deja acoperit, fără să dubleze `30/300`.
 */
import {
  serializeHeartbeat, parseHeartbeat, serviceHeartbeatKey, buildHeartbeatWrite, startServiceHeartbeat,
  SERVICE_ROLES, HEARTBEAT_VERSION, HEARTBEAT_INTERVAL_SEC, HEARTBEAT_TTL_SEC,
  type ServiceRole, type HeartbeatWrite,
} from "../src/index";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const T0 = 1_700_000_000_000;

async function main(): Promise<void> {
console.log("PH-12 12.4 — heartbeat WIRE CONTRACT (@preflight/schema)");

// ── roluri + versiune ─────────────────────────────────────────────────────────
check("1. SERVICE_ROLES = ['indexer-evm','solana-worker']", JSON.stringify(SERVICE_ROLES) === JSON.stringify(["indexer-evm", "solana-worker"]));
check("2. HEARTBEAT_VERSION === 1", HEARTBEAT_VERSION === 1);

// ── praguri de PROTOCOL (partajate cu publisherii; NU dublate în worker) ───────
check("3. ⭐ HEARTBEAT_INTERVAL_SEC === 30 (publisher scrie la 30s)", HEARTBEAT_INTERVAL_SEC === 30);
check("4. ⭐ HEARTBEAT_TTL_SEC === 300 (TTL cheie)", HEARTBEAT_TTL_SEC === 300);
check("5. interval < ttl (heartbeat ≪ expirare)", HEARTBEAT_INTERVAL_SEC < HEARTBEAT_TTL_SEC);

// ── round-trip serialize ↔ parse pe AMBELE roluri ─────────────────────────────
for (const role of SERVICE_ROLES) {
  const wire = serializeHeartbeat(role, T0);
  check(`6.${role}. serialize → {v:1,service,updated_at}`, wire === JSON.stringify({ v: 1, service: role, updated_at: T0 }));
  const rt = parseHeartbeat(wire, role);
  check(`7.${role}. round-trip parse intact`, !!rt && rt.v === 1 && rt.service === role && rt.updated_at === T0);
}

// ── serialize FAIL-LOUD pe now nesincer ───────────────────────────────────────
const badNow = (n: number) => { try { serializeHeartbeat("indexer-evm", n); return false; } catch { return true; } };
check("8. ⭐ serialize aruncă pe NaN", badNow(NaN));
check("9. ⭐ serialize aruncă pe Infinity", badNow(Infinity));
check("10. ⭐ serialize aruncă pe -Infinity", badNow(-Infinity));
check("11. ⭐ serialize aruncă pe 0", badNow(0));
check("12. ⭐ serialize aruncă pe negativ", badNow(-5));
check("13. serialize acceptă un epoch-ms valid", (() => { try { return typeof serializeHeartbeat("solana-worker", T0) === "string"; } catch { return false; } })());

// ── parse FAIL-CLOSED (reader NU aruncă niciodată) ────────────────────────────
check("14. parse: null → null", parseHeartbeat(null, "indexer-evm") === null);
check("15. ⭐ parse: JSON invalid → null (nu aruncă)", parseHeartbeat("{nope", "indexer-evm") === null);
check("16. ⭐ parse: v necunoscut (2) → null", parseHeartbeat(JSON.stringify({ v: 2, service: "indexer-evm", updated_at: T0 }), "indexer-evm") === null);
check("17. ⭐ parse: service nepotrivit → null (cross-role)", parseHeartbeat(serializeHeartbeat("solana-worker", T0), "indexer-evm") === null);
check("18. parse: updated_at ne-numeric → null", parseHeartbeat(JSON.stringify({ v: 1, service: "indexer-evm", updated_at: "x" }), "indexer-evm") === null);
check("19. parse: updated_at ≤ 0 → null", parseHeartbeat(JSON.stringify({ v: 1, service: "indexer-evm", updated_at: -1 }), "indexer-evm") === null);
check("20. parse: non-obiect (array) → null", parseHeartbeat("[]", "indexer-evm") === null);

const roles: ServiceRole[] = [...SERVICE_ROLES];
check("21. tip ServiceRole uzabil (compile + runtime)", roles.length === 2);

// ── cheia Redis PARTAJATĂ writer↔reader (leaf 2) ───────────────────────────────
check("22. ⭐ serviceHeartbeatKey('indexer-evm') === 'preflight:service_heartbeat:indexer-evm'",
  serviceHeartbeatKey("indexer-evm") === "preflight:service_heartbeat:indexer-evm");
check("23. ⭐ serviceHeartbeatKey('solana-worker') === 'preflight:service_heartbeat:solana-worker'",
  serviceHeartbeatKey("solana-worker") === "preflight:service_heartbeat:solana-worker");
check("24. ⭐⭐ chei DISTINCTE per rol (fără coliziune)", serviceHeartbeatKey("indexer-evm") !== serviceHeartbeatKey("solana-worker"));
check("25. prefix `preflight:` (plan de date partajat, NU `mcp:` intern)",
  SERVICE_ROLES.every(r => serviceHeartbeatKey(r).startsWith("preflight:service_heartbeat:")));
check("26. ⭐ toate rolurile → chei unice (set size === roluri)",
  new Set(SERVICE_ROLES.map(serviceHeartbeatKey)).size === SERVICE_ROLES.length);

// ── leaf 3a: buildHeartbeatWrite (compunerea celor 3 primitive) ────────────────
for (const role of SERVICE_ROLES) {
  const w = buildHeartbeatWrite(role, T0);
  check(`27.${role}. ⭐ write.key === serviceHeartbeatKey(role)`, w.key === serviceHeartbeatKey(role));
  check(`28.${role}. ⭐ write.value round-trip prin parseHeartbeat === payload`, (() => { const p = parseHeartbeat(w.value, role); return !!p && p.updated_at === T0 && p.service === role; })());
  check(`29.${role}. ⭐⭐ write.ttlSec === HEARTBEAT_TTL_SEC (300) — TTL PARTAJAT, fără drift`, w.ttlSec === HEARTBEAT_TTL_SEC);
}
check("30. ⭐⭐⭐ buildHeartbeatWrite PROPAGĂ fail-loud pe now nesincer (NaN) — scriere invalidă NU ajunge în Redis",
  (() => { try { buildHeartbeatWrite("indexer-evm", NaN); return false; } catch { return true; } })());
check("31. ⭐ buildHeartbeatWrite aruncă și pe ≤0", (() => { try { buildHeartbeatWrite("solana-worker", 0); return false; } catch { return true; } })());

// ── leaf 3a: startServiceHeartbeat (interval injectat, pur) ─────────────────────
// Harness de timer FALS: capturează (fn, ms, handle); permite declanșare manuală + verifică clear.
function makeTimerHarness() {
  let seq = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const cleared: number[] = [];
  return {
    setInterval: (fn: () => void, ms: number) => { const h = ++seq; timers.set(h, { fn, ms }); return h; },
    clearInterval: (h: unknown) => { cleared.push(h as number); timers.delete(h as number); },
    fire: (h: number) => timers.get(h)?.fn(),
    timers, cleared,
    lastHandle: () => seq,
  };
}
const captureWrites = () => { const writes: HeartbeatWrite[] = []; return { writes, write: (w: HeartbeatWrite) => { writes.push(w); } }; };

// scriere IMEDIATĂ la pornire (cheia există din prima)
(() => {
  const t = makeTimerHarness(); const c = captureWrites(); let nowVal = T0;
  const stop = startServiceHeartbeat({ role: "indexer-evm", writeHeartbeat: c.write, now: () => nowVal, setInterval: t.setInterval, clearInterval: t.clearInterval });
  check("32. ⭐⭐⭐ startServiceHeartbeat scrie IMEDIAT (1 write înainte de orice tick)", c.writes.length === 1 && c.writes[0].key === serviceHeartbeatKey("indexer-evm"));
  check("33. ⭐⭐ intervalul programat la HEARTBEAT_INTERVAL_SEC*1000 (30000ms default)", t.timers.get(t.lastHandle())?.ms === HEARTBEAT_INTERVAL_SEC * 1000);
  // fiecare tick scrie cu now-ul CURENT (nu îngheață timestamp-ul)
  nowVal = T0 + 30_000; t.fire(t.lastHandle());
  check("34. ⭐⭐⭐ tick → alt write cu updated_at re-evaluat (now injectat, nu înghețat)", c.writes.length === 2 && parseHeartbeat(c.writes[1].value, "indexer-evm")?.updated_at === T0 + 30_000);
  // stop() oprește cadența
  stop(); nowVal = T0 + 60_000; t.fire(t.lastHandle());
  check("35. ⭐⭐⭐ după stop() → clearInterval apelat + niciun write nou (cadență oprită)", t.cleared.includes(t.lastHandle()) && c.writes.length === 2);
  stop();
  check("36. ⭐ stop() idempotent (al doilea apel nu re-clear, fără throw)", t.cleared.filter(h => h === t.lastHandle()).length === 1);
})();

// intervalSec custom respectat
(() => {
  const t = makeTimerHarness(); const c = captureWrites();
  startServiceHeartbeat({ role: "solana-worker", writeHeartbeat: c.write, now: () => T0, setInterval: t.setInterval, clearInterval: t.clearInterval, intervalSec: 10 });
  check("37. ⭐ intervalSec custom (10) → 10000ms", t.timers.get(t.lastHandle())?.ms === 10_000);
  check("37b. solana → cheia corectă", c.writes[0].key === serviceHeartbeatKey("solana-worker"));
})();

// eroare SINCRONĂ din writeHeartbeat → onError, NU throw din tick
(() => {
  const t = makeTimerHarness(); const errs: unknown[] = [];
  const throwOnce = { n: 0 };
  check("38. ⭐⭐⭐ writeHeartbeat aruncă → onError chemat, startServiceHeartbeat NU aruncă", (() => {
    try {
      startServiceHeartbeat({ role: "indexer-evm", writeHeartbeat: () => { throwOnce.n++; throw new Error("redis down"); }, now: () => T0, setInterval: t.setInterval, clearInterval: t.clearInterval, onError: (e) => errs.push(e) });
      return errs.length === 1 && errs[0] instanceof Error;
    } catch { return false; }
  })());
})();

// rejection ASYNC din writeHeartbeat (redis.set întoarce Promise rejectat) → onError, fără unhandled
{
  const t = makeTimerHarness(); const errs: unknown[] = [];
  startServiceHeartbeat({ role: "indexer-evm", writeHeartbeat: () => Promise.reject(new Error("async redis fail")), now: () => T0, setInterval: t.setInterval, clearInterval: t.clearInterval, onError: (e) => errs.push(e) });
  await new Promise<void>(r => setTimeout(r, 0)); // flush microtask-ul rejection-ului înainte de a asserta
  check("39. ⭐⭐⭐ writeHeartbeat async-reject → onError a primit rejection-ul (fără unhandled)", errs.length === 1 && (errs[0] as Error).message === "async redis fail");
}

// COMPAT ioredis: writer care întoarce `Promise<"OK">` (EXACT ce dă `redis.set(...)`) — dovedește `PromiseLike<unknown>`
// (nu `Promise<void>`) + `THandle` inferat din setInterval-ul global-like, ca 3b să paseze `redis.set` fără cast.
{
  const cleared: number[] = []; let seq = 0; const writes: HeartbeatWrite[] = [];
  // setInterval întoarce un handle „real" (aici number) — inferența lui THandle îl leagă de clearInterval fără cast.
  const stop = startServiceHeartbeat({
    role: "solana-worker",
    writeHeartbeat: (w) => { writes.push(w); return Promise.resolve("OK" as const); }, // forma ioredis
    now: () => T0,
    setInterval: (_fn, _ms) => ++seq,
    clearInterval: (h) => { cleared.push(h); },
  });
  await new Promise<void>(r => setTimeout(r, 0));
  check("40. ⭐⭐⭐ writer stil-ioredis (Promise<\"OK\">) acceptat + scriere imediată OK (compat PromiseLike)",
    writes.length === 1 && writes[0].key === serviceHeartbeatKey("solana-worker") && writes[0].ttlSec === HEARTBEAT_TTL_SEC);
  stop();
  check("41. ⭐ THandle inferat: clearInterval a primit handle-ul real (number), fără cast", cleared.length === 1 && cleared[0] === seq);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

void main();
