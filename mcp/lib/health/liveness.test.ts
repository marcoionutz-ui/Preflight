/**
 * lib/health/liveness.test.ts — PH-13 GUARD (clasificatorul pur de liveness, model nou cgpt #1/#2/#5/#6).
 * Acoperă: matricea status × httpStatus, praguri, strict, chain-completeness (expected vs observed), starea WS
 * onestă (deriveWsState + wsUnavailable/wsUnknown/wsStaleSubs), parseExpectedChains, scope, + source-guards pe
 * rută (readHealthSignals/computeLiveness/strict/no-store/coalescing) și pe graceful shutdown la worker.
 */
import { readFileSync } from "node:fs";
import {
  computeLiveness, parseExpectedChains, deriveWsState,
  HEALTH_WORKER_FRESH_SEC, HEALTH_SCOPE,
  type HealthSignals, type PerChainHealth, type WsState, type WsRuntimeView,
} from "./liveness";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// Constructor de PerChainHealth cu default-uri sănătoase (fresh + ws healthy).
function pc(o: Partial<PerChainHealth> & { chain: string }): PerChainHealth {
  return {
    expected: true, observed: true, snapshotAgeSec: 10, wsState: "healthy", wsStaleKinds: [],
    ...o,
  };
}
// Semnale default: Base + Arbitrum, ambele fresh + ws healthy.
const sig = (o: Partial<HealthSignals> = {}): HealthSignals => ({
  redisReachable: true, wsExpected: true,
  expectedChains: ["base", "arbitrum"], observedChains: ["base", "arbitrum"],
  perChain: [pc({ chain: "base" }), pc({ chain: "arbitrum", snapshotAgeSec: 20 })],
  ...o,
});
const norm = (s: string) => s; // identitate (validChains deja normalizate în teste)

function main(): void {
console.log("PH-13 — liveness classifier (model nou: expected chains + WS onest)");

// ── OK ────────────────────────────────────────────────────────────────────────
const ok = computeLiveness(sig());
check("1. worker proaspăt + ws healthy → ok + HTTP 200", ok.status === "ok" && ok.httpStatus === 200);
check("2. ok: toate check-urile true", ok.checks.web.ok && ok.checks.redis.ok && ok.checks.worker.ok && ok.checks.ws.ok);
check("3. worstSnapshotAgeSec = cel mai slab (20)", ok.worstSnapshotAgeSec === 20);
check("4. scope expus în raport (cgpt #6)", ok.scope === HEALTH_SCOPE && /evm-worker/.test(ok.scope));
check("5. expected vs observed populate", ok.expectedChains.length === 2 && ok.observedChains.length === 2);

// ── Redis down → down/503 ─────────────────────────────────────────────────────
const down = computeLiveness(sig({ redisReachable: false }));
check("6. ⭐⭐ Redis inaccesibil → down + HTTP 503", down.status === "down" && down.httpStatus === 503);
check("7. down: redis check false, web check true", down.checks.redis.ok === false && down.checks.web.ok === true);
check("8. down: 503 chiar fără strict", computeLiveness(sig({ redisReachable: false }), { strict: false }).httpStatus === 503);

// ── Worker stale pe un chain → degraded; 200 implicit, 503 strict ─────────────
const staleAge = HEALTH_WORKER_FRESH_SEC + 60;
const wStale = computeLiveness(sig({ perChain: [pc({ chain: "base" }), pc({ chain: "arbitrum", snapshotAgeSec: staleAge })] }));
check("9. ⭐⭐ worker stale pe un chain → degraded + HTTP 200 (web e viu)", wStale.status === "degraded" && wStale.httpStatus === 200);
check("10. ⭐ worker check false + staleChains conține chain-ul vechi", wStale.checks.worker.ok === false && wStale.staleChains.includes("arbitrum"));
check("11. ⭐⭐ același degraded cu strict=1 → HTTP 503 (ținta monitorului extern)",
  computeLiveness(sig({ expectedChains: ["arbitrum"], observedChains: ["arbitrum"], perChain: [pc({ chain: "arbitrum", snapshotAgeSec: staleAge })] }), { strict: true }).httpStatus === 503);

// ── REGRESIE cgpt #1: chain așteptat care a pierdut AMBELE chei → degraded, niciodată ok ──
const missingBoth = computeLiveness(sig({
  expectedChains: ["base", "arbitrum"], observedChains: ["base"],
  perChain: [pc({ chain: "base", snapshotAgeSec: 10 }), pc({ chain: "arbitrum", observed: false, snapshotAgeSec: null, wsState: "unknown" })],
}));
check("12. ⭐⭐⭐ Base fresh + Arbitrum lipsă (ambele chei) → degraded, NICIODATĂ ok",
  missingBoth.status === "degraded" && missingBoth.staleChains.includes("arbitrum"));
check("13. ⭐ chain lipsă apare în expected dar NU în observed (nu-l numim known fals)",
  missingBoth.expectedChains.includes("arbitrum") && !missingBoth.observedChains.includes("arbitrum"));

// ── Niciun chain așteptat configurat → degraded ───────────────────────────────
const none = computeLiveness(sig({ expectedChains: [], observedChains: [], perChain: [] }));
check("14. ⭐ niciun chain așteptat → degraded (worker down semnalat, web tot 200)",
  none.status === "degraded" && none.httpStatus === 200 && none.checks.worker.ok === false);

// ── WS onest: disconnected / unknown / suspected_stale ────────────────────────
const wsDisc = computeLiveness(sig({ perChain: [pc({ chain: "base" }), pc({ chain: "arbitrum", snapshotAgeSec: 20, wsState: "disconnected" })] }));
check("15. ⭐⭐ ws disconnected → degraded + wsUnavailableChains (≠ zombie)",
  wsDisc.status === "degraded" && wsDisc.wsUnavailableChains.includes("arbitrum") && wsDisc.checks.ws.ok === false);
const wsUnk = computeLiveness(sig({ perChain: [pc({ chain: "base" }), pc({ chain: "arbitrum", snapshotAgeSec: 20, wsState: "unknown" })] }));
check("16. ⭐⭐ ws unknown (runtime lipsă/expirat) → degraded + wsUnknownChains (separat de disconnected)",
  wsUnk.status === "degraded" && wsUnk.wsUnknownChains.includes("arbitrum") && wsUnk.wsUnavailableChains.length === 0);
const wsZombie = computeLiveness(sig({ perChain: [pc({ chain: "base", wsState: "suspected_stale", wsStaleKinds: ["v2"] }), pc({ chain: "arbitrum", snapshotAgeSec: 20 })] }));
check("17. ⭐⭐ ws suspected_stale → degraded + wsStaleSubs 'chain:kind'",
  wsZombie.status === "degraded" && wsZombie.wsStaleSubs.includes("base:v2") && wsZombie.checks.ws.ok === false);

// ── WS dezactivat (wsExpected=false) → NU penalizează ─────────────────────────
const wsOff = computeLiveness(sig({ wsExpected: false, perChain: [pc({ chain: "base", wsState: "disabled" }), pc({ chain: "arbitrum", snapshotAgeSec: 20, wsState: "disabled" })] }));
check("18. ⭐ wsExpected=false → ws check ok (disabled), status ok, fără semnale ws",
  wsOff.status === "ok" && wsOff.checks.ws.ok === true && wsOff.wsUnavailableChains.length === 0 && wsOff.wsUnknownChains.length === 0);

// ── prag exact / custom ───────────────────────────────────────────────────────
check("19. exact la prag (age === freshSec) → stale (≥)",
  computeLiveness(sig({ expectedChains: ["base"], observedChains: ["base"], perChain: [pc({ chain: "base", snapshotAgeSec: HEALTH_WORKER_FRESH_SEC })] })).checks.worker.ok === false);
check("20. sub prag (age = freshSec-1) → fresh",
  computeLiveness(sig({ expectedChains: ["base"], observedChains: ["base"], perChain: [pc({ chain: "base", snapshotAgeSec: HEALTH_WORKER_FRESH_SEC - 1 })] })).checks.worker.ok === true);
check("21. freshSec custom respectat (10s prag, age 20 → stale)",
  computeLiveness(sig({ expectedChains: ["base"], observedChains: ["base"], perChain: [pc({ chain: "base", snapshotAgeSec: 20 })] }), { freshSec: 10 }).checks.worker.ok === false);

// ── parseExpectedChains (pur) ─────────────────────────────────────────────────
check("22. parseExpectedChains: normalizează + validează + dedupe",
  JSON.stringify(parseExpectedChains("base, arbitrum , base ,BASE", ["base", "arbitrum", "bsc"], norm)) === JSON.stringify(["base", "arbitrum"]));
check("23. parseExpectedChains: aruncă necunoscutele (nu-s în validChains)",
  JSON.stringify(parseExpectedChains("base,doge,solana", ["base", "arbitrum"], norm)) === JSON.stringify(["base"]));
check("24. parseExpectedChains: gol/undefined → []",
  parseExpectedChains(undefined, ["base"], norm).length === 0 && parseExpectedChains("", ["base"], norm).length === 0);

// ── deriveWsState (pur) — fiecare ramură ──────────────────────────────────────
const view = (o: Partial<WsRuntimeView> = {}): WsRuntimeView => ({ present: true, wsConnected: true, lastPongAgeSec: 10, suspectedStaleKinds: [], ...o });
const state = (o: Partial<WsRuntimeView>, exp = true): WsState => deriveWsState(view(o), exp).state;
check("25. deriveWsState: !wsExpected → disabled", state({}, false) === "disabled");
check("26. deriveWsState: runtime absent → unknown", state({ present: false }) === "unknown");
check("27. deriveWsState: !wsConnected → disconnected", state({ wsConnected: false }) === "disconnected");
check("28. deriveWsState: cross-kind stale → suspected_stale", deriveWsState(view({ suspectedStaleKinds: ["v3"] }), true).state === "suspected_stale");
check("29. deriveWsState: pong necunoscut → suspected_stale (fără dovadă de transport)", state({ lastPongAgeSec: null }) === "suspected_stale");
check("30. deriveWsState: pong expirat → suspected_stale", state({ lastPongAgeSec: 9999 }) === "suspected_stale");
check("31. deriveWsState: conectat + pong proaspăt + fără subs stale → healthy (piață liniștită ≠ mort)", state({}) === "healthy");
check("32. deriveWsState: staleKinds propagate pe suspected_stale", JSON.stringify(deriveWsState(view({ suspectedStaleKinds: ["v2", "v4"] }), true).staleKinds) === JSON.stringify(["v2", "v4"]));

// ── source-guards: ruta + worker shutdown ─────────────────────────────────────
const route = readFileSync("app/api/health/route.ts", "utf8");
check("33. ⭐ ruta cheamă readHealthSignals + computeLiveness și întoarce httpStatus",
  /readHealthSignals\(/.test(route) && /computeLiveness\(/.test(route) && /httpStatus/.test(route));
check("34. ⭐ ruta tratează ?strict + force-dynamic + runtime nodejs + no-store",
  /strict/.test(route) && /force-dynamic/.test(route) && /runtime\s*=\s*["']nodejs["']/.test(route) && /no-store/.test(route));
check("35. ⭐ ruta coalescează (cgpt #5): single-flight/cache la nivel de modul",
  /inflight/.test(route) && /COALESCE_MS/.test(route));

const idx = readFileSync("../workers/evm/src/index.ts", "utf8");
check("36. ⭐⭐ worker index rulează secvența reală (installGracefulShutdown + runShutdownSequence)",
  /installGracefulShutdown\(/.test(idx) && /runShutdownSequence\(/.test(idx));
check("37. ⭐ worker index înregistrează intervalele (trackInterval) + drain (waitForDrain)",
  /trackInterval\(/.test(idx) && /waitForDrain\(/.test(idx) && /saveMemoryToRedisStrict\b/.test(idx));

const shut = readFileSync("../workers/evm/src/lib/shutdown.ts", "utf8");
check("38. ⭐ shutdown.ts ascultă SIGTERM + SIGINT și are timeout hard-exit",
  /SIGTERM/.test(shut) && /SIGINT/.test(shut) && /timeout/i.test(shut));
const mem = readFileSync("../workers/evm/src/state/memory.ts", "utf8");
check("39. ⭐⭐ memory.ts are saveMemoryToRedisStrict care aruncă pe Redis lipsă + verifică pipeline.exec()",
  /saveMemoryToRedisStrict/.test(mem) && /throw new Error/.test(mem) && /pipe\.exec\(\)/.test(mem));
const mgr = readFileSync("../workers/evm/src/ws/manager.ts", "utf8");
check("40. ⭐⭐ manager.ts gate-ază reconnect pe isShuttingDown + exportă closeAllWebSockets (async/bounded)",
  /isShuttingDown\(\)/.test(mgr) && /export async function closeAllWebSockets/.test(mgr));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
