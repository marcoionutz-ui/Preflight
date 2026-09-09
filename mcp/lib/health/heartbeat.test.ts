/**
 * lib/health/heartbeat.test.ts — PH-12 slice 12.4 GUARD (frunza pură: model heartbeat + byte-compat liveness).
 *
 * Acoperă cele 8 corecții lock-uite de Marco:
 *  #3 rol tipizat · #4 payload versionat fail-closed · #5 cele 5 stări (disabled/ok/stale/missing/unavailable,
 *  Redis-jos ⇒ unavailable) · #6 praguri separate (fresh 90s ≪ TTL 300s, banda stale există) · #7 expirare ⇒ missing
 *  (nu DEL) · round-trip serialize↔parse · progresia fresh→stale→missing · agregare `foldServiceChecks` ·
 *  BYTE-COMPAT: `computeLiveness` produce JSON identic când ambele servicii-s explicit ne-așteptate.
 */
import {
  serializeHeartbeat, parseHeartbeat, classifyHeartbeat, foldServiceChecks,
  serviceHeartbeatKey, resolveServiceExpectations, HEALTH_EXPECT_ENV,
  HEALTH_HEARTBEAT_FRESH_SEC, HEARTBEAT_TTL_SEC, HEARTBEAT_INTERVAL_SEC,
  HEALTH_HEARTBEAT_FUTURE_SKEW_SEC, SERVICE_ROLES,
  type ServiceRole, type ServiceHeartbeatSignal, type ServiceHeartbeatCheck,
} from "./heartbeat";
import { computeLiveness, HEALTH_SCOPE, type HealthSignals, type PerChainHealth } from "./liveness";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const T0 = 1_700_000_000_000; // epoch ms fix (determinist)
const sigOf = (o: Partial<ServiceHeartbeatSignal> & { role: ServiceRole }): ServiceHeartbeatSignal =>
  ({ expected: true, redisReachable: true, raw: null, ...o });

function main(): void {
console.log("PH-12 12.4 — heartbeat model (pur) + byte-compat liveness");

// ── #3 roluri tipizate ────────────────────────────────────────────────────────
check("1. SERVICE_ROLES = exact cele 2 roluri", JSON.stringify(SERVICE_ROLES) === JSON.stringify(["indexer-evm", "solana-worker"]));

// ── round-trip serialize ↔ parse ──────────────────────────────────────────────
const wire = serializeHeartbeat("indexer-evm", T0);
check("2. serialize produce payload versionat {v,service,updated_at}", wire === JSON.stringify({ v: 1, service: "indexer-evm", updated_at: T0 }));
const rt = parseHeartbeat(wire, "indexer-evm");
check("3. round-trip parse întoarce payload-ul intact", !!rt && rt.v === 1 && rt.service === "indexer-evm" && rt.updated_at === T0);

// ── #4 parse FAIL-CLOSED ──────────────────────────────────────────────────────
check("4. parse: raw null → null", parseHeartbeat(null, "indexer-evm") === null);
check("5. parse: raw undefined → null", parseHeartbeat(undefined, "indexer-evm") === null);
check("6. ⭐ parse: JSON invalid → null (NU aruncă)", parseHeartbeat("{not json", "indexer-evm") === null);
check("7. parse: non-obiect (număr) → null", parseHeartbeat("123", "indexer-evm") === null);
check("8. parse: array → null", parseHeartbeat("[]", "indexer-evm") === null);
check("9. ⭐ parse: versiune necunoscută (v=2) → null (nu presupunem compat)", parseHeartbeat(JSON.stringify({ v: 2, service: "indexer-evm", updated_at: T0 }), "indexer-evm") === null);
check("10. ⭐ parse: service nepotrivit (cheie/rol greșit) → null", parseHeartbeat(JSON.stringify({ v: 1, service: "solana-worker", updated_at: T0 }), "indexer-evm") === null);
check("11. parse: updated_at lipsă → null", parseHeartbeat(JSON.stringify({ v: 1, service: "indexer-evm" }), "indexer-evm") === null);
check("12. parse: updated_at ne-numeric (string) → null", parseHeartbeat(JSON.stringify({ v: 1, service: "indexer-evm", updated_at: "x" }), "indexer-evm") === null);
check("13. parse: updated_at ≤ 0 → null", parseHeartbeat(JSON.stringify({ v: 1, service: "indexer-evm", updated_at: 0 }), "indexer-evm") === null);
check("14. parse: updated_at NaN/Infinity → null", parseHeartbeat('{"v":1,"service":"indexer-evm","updated_at":null}', "indexer-evm") === null);

// ── #5 cele 5 stări ───────────────────────────────────────────────────────────
check("15. ⭐ disabled: expected=false → state=disabled, age=null",
  (() => { const c = classifyHeartbeat(sigOf({ role: "indexer-evm", expected: false }), T0); return c.state === "disabled" && c.ageSec === null; })());
check("16. ⭐⭐ unavailable: redisReachable=false (expected) → state=unavailable (NU stale)",
  (() => { const c = classifyHeartbeat(sigOf({ role: "solana-worker", redisReachable: false }), T0); return c.state === "unavailable" && c.ageSec === null; })());
check("17. ⭐ missing: redis ok + raw null (cheie expirată) → state=missing",
  classifyHeartbeat(sigOf({ role: "indexer-evm", raw: null }), T0).state === "missing");
check("18. ⭐⭐ missing: payload CORUPT (redis ok) → state=missing (fail-closed, nu ok fals)",
  classifyHeartbeat(sigOf({ role: "indexer-evm", raw: "{garbage" }), T0).state === "missing");
check("19. missing: service nepotrivit (cheie coruptă) → missing",
  classifyHeartbeat(sigOf({ role: "indexer-evm", raw: serializeHeartbeat("solana-worker", T0) }), T0).state === "missing");

// ── #6 praguri separate: fresh 90s ≪ TTL 300s ────────────────────────────────
check("20. constante (interval/ttl din @preflight/schema): fresh(90) < ttl(300) și interval(30) < fresh", HEALTH_HEARTBEAT_FRESH_SEC === 90 && HEARTBEAT_TTL_SEC === 300 && HEARTBEAT_INTERVAL_SEC === 30 && HEARTBEAT_INTERVAL_SEC < HEALTH_HEARTBEAT_FRESH_SEC && HEALTH_HEARTBEAT_FRESH_SEC < HEARTBEAT_TTL_SEC);
const at = (agoSec: number, role: ServiceRole = "indexer-evm") => classifyHeartbeat(sigOf({ role, raw: serializeHeartbeat(role, T0 - agoSec * 1000) }), T0);
check("21. ok: age 0 → ok", at(0).state === "ok" && at(0).ageSec === 0);
check("22. ok: age 30 (un beat) → ok", at(30).state === "ok");
check("23. ⭐ ok la PRAG exact: age === 90 → ok (≤)", at(90).state === "ok" && at(90).ageSec === 90);
check("24. ⭐⭐ stale: age 91 (peste prag, sub TTL) → stale (banda [90,300) există)", at(91).state === "stale" && at(91).ageSec === 91);
check("25. stale: age 200 (încă în Redis, sub TTL) → stale", at(200).state === "stale");
check("26. ⭐ skew MIC (20s viitor ≤ 30s) → ok, age clamp la 0", at(-20).state === "ok" && at(-20).ageSec === 0);
check("26b. ⭐⭐ future-skew MĂRGINIT (cgpt P2): 45s viitor > 30s → missing (NU fals fresh), age=null",
  at(-45).state === "missing" && at(-45).ageSec === null);
check("26c. ⭐ prag exact de skew: exact 30s viitor → încă ok (clamp)", at(-30).state === "ok");
check("27. freshSec custom respectat (prag 30, age 45 → stale)",
  classifyHeartbeat(sigOf({ role: "indexer-evm", raw: serializeHeartbeat("indexer-evm", T0 - 45000) }), T0, { freshSec: 30 }).state === "stale");
check("27b. FUTURE_SKEW = 30s (const)", HEALTH_HEARTBEAT_FUTURE_SKEW_SEC === 30);
// serialize REFUZĂ now nesincer (cgpt P2 — fail-loud pe writer)
check("27c. ⭐ serializeHeartbeat aruncă pe NaN", (() => { try { serializeHeartbeat("indexer-evm", NaN); return false; } catch { return true; } })());
check("27d. ⭐ serializeHeartbeat aruncă pe Infinity", (() => { try { serializeHeartbeat("indexer-evm", Infinity); return false; } catch { return true; } })());
check("27e. ⭐ serializeHeartbeat aruncă pe ≤0", (() => { try { serializeHeartbeat("indexer-evm", 0); return false; } catch { return true; } })());

// ── #7 progresia fresh → stale → missing pe ACEEAȘI cheie (fără DEL) ──────────
// Publisher scrie la T0; Redis expiră cheia peste TTL → raw devine null → missing.
const beat = serializeHeartbeat("indexer-evm", T0);
const atNow = (now: number, raw: string | null) => classifyHeartbeat(sigOf({ role: "indexer-evm", raw }), now).state;
check("28. ⭐⭐⭐ progresie: t=+60s → ok, t=+150s → stale, t=+320s (cheie expirată, raw=null) → missing",
  atNow(T0 + 60_000, beat) === "ok" && atNow(T0 + 150_000, beat) === "stale" && atNow(T0 + 320_000, null) === "missing");

// ── foldServiceChecks ─────────────────────────────────────────────────────────
const mk = (service: ServiceRole, state: ServiceHeartbeatCheck["state"]): ServiceHeartbeatCheck => ({ service, state, ageSec: null, detail: state });
check("29. ⭐ fold: ambele disabled → undefined (byte-compat)", foldServiceChecks([mk("indexer-evm", "disabled"), mk("solana-worker", "disabled")]) === undefined);
check("30. fold: array gol → undefined", foldServiceChecks([]) === undefined);
check("31. fold: ok + disabled → definit, degraded=false, check.ok=true",
  (() => { const s = foldServiceChecks([mk("indexer-evm", "ok"), mk("solana-worker", "disabled")]); return !!s && s.degraded === false && s.check.ok === true && s.services.length === 2; })());
check("32. ⭐ fold: un stale → degraded=true, check.ok=false, detail menționează rolul",
  (() => { const s = foldServiceChecks([mk("indexer-evm", "stale"), mk("solana-worker", "ok")]); return !!s && s.degraded === true && s.check.ok === false && /indexer-evm:stale/.test(s.check.detail); })());
check("33. ⭐ fold: un missing → degraded=true", (() => { const s = foldServiceChecks([mk("indexer-evm", "missing")]); return !!s && s.degraded === true && s.check.ok === false; })());
check("34. ⭐⭐⭐ fold: unavailable → degraded=TRUE + check.ok=false (necunoscut ≠ ok; cgpt P1)",
  (() => { const s = foldServiceChecks([mk("indexer-evm", "unavailable"), mk("solana-worker", "unavailable")]); return !!s && s.degraded === true && s.check.ok === false && /unavailable/.test(s.check.detail); })());
check("34b. ⭐ fold: stale domină în detail peste unavailable (problems raportate primele)",
  (() => { const s = foldServiceChecks([mk("indexer-evm", "stale"), mk("solana-worker", "unavailable")]); return !!s && s.degraded === true && /indexer-evm:stale/.test(s.check.detail); })());

// ── BYTE-COMPAT în computeLiveness ────────────────────────────────────────────
const pc = (chain: string, o: Partial<PerChainHealth> = {}): PerChainHealth => ({ chain, expected: true, observed: true, snapshotAgeSec: 10, wsState: "healthy", wsStaleKinds: [], ...o });
const baseSig = (o: Partial<HealthSignals> = {}): HealthSignals => ({
  redisReachable: true, wsExpected: true, expectedChains: ["base", "arbitrum"], observedChains: ["base", "arbitrum"],
  perChain: [pc("base"), pc("arbitrum", { snapshotAgeSec: 20 })], ...o,
});
const bothDisabled: ServiceHeartbeatCheck[] = [mk("indexer-evm", "disabled"), mk("solana-worker", "disabled")];

const noServices  = JSON.stringify(computeLiveness(baseSig()));                          // caller vechi (fără services)
const undefinedSv = JSON.stringify(computeLiveness(baseSig({ services: undefined })));    // services undefined explicit
const bothOff     = JSON.stringify(computeLiveness(baseSig({ services: bothDisabled }))); // ambele explicit disabled
check("35. ⭐⭐⭐ BYTE-COMPAT: fără services === services:undefined === ambele disabled (JSON identic)",
  noServices === undefinedSv && undefinedSv === bothOff);
check("36. ⭐⭐ BYTE-COMPAT: JSON-ul NU conține câmpul 'services' când ambele-s disabled", !/"services"/.test(bothOff));

// ── computeLiveness CU servicii așteptate ────────────────────────────────────
const okSvc = computeLiveness(baseSig({ services: [mk("indexer-evm", "ok"), mk("solana-worker", "disabled")] }));
check("37. ⭐ servicii ok (≥1 așteptat) → status rămâne ok, câmpul services PREZENT (len 2), checks.services.ok=true",
  okSvc.status === "ok" && okSvc.httpStatus === 200 && !!okSvc.services && okSvc.services.length === 2 && okSvc.checks.services?.ok === true);
const staleSvc = computeLiveness(baseSig({ services: [mk("indexer-evm", "stale")] }));
check("38. ⭐⭐ serviciu stale → degraded + HTTP 200 (web viu), checks.services.ok=false",
  staleSvc.status === "degraded" && staleSvc.httpStatus === 200 && staleSvc.checks.services?.ok === false);
const missingStrict = computeLiveness(baseSig({ services: [mk("solana-worker", "missing")] }), { strict: true });
check("39. ⭐⭐ serviciu missing + strict=1 → HTTP 503 (ținta monitorului extern)",
  missingStrict.status === "degraded" && missingStrict.httpStatus === 503);
check("40. ⭐ serviciu stale NU corupe status-ul worker/ws al chain-urilor (rămân ok)",
  staleSvc.checks.worker.ok === true && staleSvc.checks.ws.ok === true);

// ── cgpt P1: unavailable PARȚIAL (Redis global ok, dar cheia serviciului a eșuat) NU produce ok ────────────────
const partialUnavail = computeLiveness(baseSig({ services: [mk("indexer-evm", "unavailable"), mk("solana-worker", "ok")] }));
check("40a. ⭐⭐⭐ Redis global ok + un serviciu unavailable → degraded (NU ok), checks.services.ok=false",
  partialUnavail.status === "degraded" && partialUnavail.httpStatus === 200 && partialUnavail.checks.services?.ok === false);
check("40b. ⭐⭐ același unavailable parțial + strict=1 → 503",
  computeLiveness(baseSig({ services: [mk("indexer-evm", "unavailable")] }), { strict: true }).httpStatus === 503);

// ── cgpt P1#2: scope reflectă serviciile monitorizate ─────────────────────────
check("41s. ⭐⭐⭐ scope EXTINS cu serviciul așteptat: '...+ indexer-evm' (solana disabled → nu apare)",
  okSvc.scope === `${HEALTH_SCOPE} + indexer-evm` && !/solana-worker/.test(okSvc.scope));
check("41t. ⭐ ambele așteptate → scope conține ambele roluri",
  (() => { const r = computeLiveness(baseSig({ services: [mk("indexer-evm", "ok"), mk("solana-worker", "stale")] })); return r.scope === `${HEALTH_SCOPE} + indexer-evm + solana-worker`; })());
check("41u. ⭐⭐ BYTE-COMPAT scope: ambele disabled → scope rămâne exact HEALTH_SCOPE",
  computeLiveness(baseSig({ services: bothDisabled })).scope === HEALTH_SCOPE && computeLiveness(baseSig()).scope === HEALTH_SCOPE);

// ── Redis-down: servicii unavailable, verdict rămâne down ─────────────────────
const downSvc = computeLiveness(baseSig({ redisReachable: false, services: [mk("indexer-evm", "unavailable"), mk("solana-worker", "unavailable")] }));
check("41. ⭐⭐⭐ Redis jos → status=down/503, services PREZENT & unavailable, checks.services.ok=false (down domină)",
  downSvc.status === "down" && downSvc.httpStatus === 503 && !!downSvc.services && downSvc.services.every(s => s.state === "unavailable") && downSvc.checks.services?.ok === false);
const downNoSvc = JSON.stringify(computeLiveness(baseSig({ redisReachable: false })));
const downBothOff = JSON.stringify(computeLiveness(baseSig({ redisReachable: false, services: bothDisabled })));
check("42. ⭐ BYTE-COMPAT pe Redis-down: fără services === ambele disabled", downNoSvc === downBothOff && !/"services"/.test(downBothOff));

// ── leaf 2: cheia Redis (re-export din schema) + rezolvarea AȘTEPTĂRII din env ─────────────────────────────────
check("43. cheia Redis re-exportată din schema: serviceHeartbeatKey('indexer-evm') corectă",
  serviceHeartbeatKey("indexer-evm") === "preflight:service_heartbeat:indexer-evm");
check("44. ⭐ HEALTH_EXPECT_ENV mapează exact cele 2 roluri la numele de flag",
  HEALTH_EXPECT_ENV["indexer-evm"] === "HEALTH_EXPECT_INDEXER_EVM" && HEALTH_EXPECT_ENV["solana-worker"] === "HEALTH_EXPECT_SOLANA_WORKER");
check("45. ⭐⭐ expected DOAR pe '1': {INDEXER=1, SOLANA=0} → indexer true, solana false",
  (() => { const e = resolveServiceExpectations({ HEALTH_EXPECT_INDEXER_EVM: "1", HEALTH_EXPECT_SOLANA_WORKER: "0" }); return e["indexer-evm"] === true && e["solana-worker"] === false; })());
check("46. ⭐ flag absent → false (disabled), NU crapă", (() => { const e = resolveServiceExpectations({}); return e["indexer-evm"] === false && e["solana-worker"] === false; })());
check("47. ⭐⭐⭐ fail-closed byte-exact: '1 ' (spațiu) / 'true' / 'yes' → false (NU aluneca la ON)",
  (() => {
    const a = resolveServiceExpectations({ HEALTH_EXPECT_INDEXER_EVM: "1 " })["indexer-evm"];
    const b = resolveServiceExpectations({ HEALTH_EXPECT_INDEXER_EVM: "true" })["indexer-evm"];
    const c = resolveServiceExpectations({ HEALTH_EXPECT_INDEXER_EVM: "yes" })["indexer-evm"];
    return a === false && b === false && c === false;
  })());
check("48. ⭐ '0' explicit → false", resolveServiceExpectations({ HEALTH_EXPECT_INDEXER_EVM: "0" })["indexer-evm"] === false);
check("49. rezultatul acoperă EXACT rolurile din SERVICE_ROLES (fără chei în plus/lipsă)",
  (() => { const e = resolveServiceExpectations({}); return JSON.stringify(Object.keys(e).sort()) === JSON.stringify([...SERVICE_ROLES].sort()); })());
check("50. ⭐ expected din env alimentează classifyHeartbeat: {INDEXER=0} → disabled",
  (() => {
    const exp = resolveServiceExpectations({ HEALTH_EXPECT_INDEXER_EVM: "0", HEALTH_EXPECT_SOLANA_WORKER: "1" });
    const c = classifyHeartbeat({ role: "indexer-evm", expected: exp["indexer-evm"], redisReachable: true, raw: null }, T0);
    return c.state === "disabled";
  })());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
