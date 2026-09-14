/**
 * lib/mcp/canaryBaseData.test.ts — PH-12 12.5c-1 (aserturi Base strict + Base data + WS subscriptions, PUR).
 *
 * Hermetic (fără Redis/rețea): construiește `McpCallResult`-uri fabricate (contract PH-14: succes cu
 * `structuredContent.data`, eroare cu `isError:true`) + rapoarte `/api/health` fabricate, apoi verifică fail-closed +
 * anti-leak. Acoperă: succes/eșec pe fiecare condiție, absența `structuredContent` la succes (FĂRĂ fallback pe text),
 * și extensia per-chain a `parseHealthReport`/`assertStrictHealthy` (P1 #1 cgpt).
 */
import { assertBaseData, assertBaseWsSubscriptions } from "./canaryBaseData";
import { parseHealthReport, assertStrictHealthy } from "./releaseGate";
import type { McpCallResult } from "./canaryMcpClient";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5c-1 — canaryBaseData (Base strict + data + WS subs, pur)");

// ── Fabrici ───────────────────────────────────────────────────────────────────
/** Succes MCP tipat PH-14: structuredContent {ok,format,text,meta,data}. */
function okResult(data: unknown): McpCallResult {
  const envelope = { ok: true, format: "preflight.response.v1", text: JSON.stringify(data), meta: {}, data };
  return { ok: true, content: [{ type: "text", text: JSON.stringify(envelope) }], isError: false, structuredContent: envelope };
}
/** Eroare de tool: isError:true, cod în content[0].text, FĂRĂ structuredContent. */
function errResult(code: string): McpCallResult {
  return { ok: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code, message: "x" } }) }], isError: true };
}
function baseWorkerData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total: 3, count: 3, offset: 0, has_more: false,
    pairs: [
      { pairAddress: "0xA", chain: "base", symbol: "AA", phase: "NEW" },
      { pairAddress: "0xB", chain: "base", symbol: "BB", phase: "TRENDING" },
      { pairAddress: "0xC", chain: "base", symbol: "CC", phase: "NEW" },
    ],
    snapshotAgeSec: 12, workerVersion: "w1",
    ...over,
  };
}
function baseHealthData(baseOver: Record<string, unknown> = {}, topOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workerOnline: true, workerVersion: "w1",
    perChainWorker: {
      base: {
        ageSec: 10, quality: "fresh", live: true,
        wsConnected: true, lastPongAgeSec: 15, lastWsMessageAgeSec: 5,
        subs: { v2: { confirmed: true, poolCount: 4 }, v3: { confirmed: false, poolCount: 0 }, v4: null },
        subsState: null, subsSummary: null,
        ...baseOver,
      },
    },
    wsStreamStaleSubs: [], knownChains: ["base"], liveChains: ["base"],
    ...topOver,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. assertBaseData
// ─────────────────────────────────────────────────────────────────────────────
check("A1. ⭐ succes base (3 perechi, snapshot 12s) → ok", assertBaseData(okResult(baseWorkerData())).ok === true);
check("A2. ⭐⭐ total 0 → fail (worker n-a indexat)", assertBaseData(okResult(baseWorkerData({ total: 0, count: 0, pairs: [] }))).ok === false);
check("A3. count 0 (dar total>0) → fail", assertBaseData(okResult(baseWorkerData({ count: 0 }))).ok === false);
check("A4. pairs gol → fail", assertBaseData(okResult(baseWorkerData({ pairs: [] }))).ok === false);
check("A5. ⭐ pairs.length ≠ count → fail (inconsistent)", assertBaseData(okResult(baseWorkerData({ count: 5 }))).ok === false);
check("A6. ⭐⭐⭐ o pereche pe alt chain (arbitrum) → fail (agregare greșită)",
  assertBaseData(okResult(baseWorkerData({ pairs: [{ chain: "base", pairAddress: "0x1" }, { chain: "arbitrum", pairAddress: "0x2" }], total: 2, count: 2 }))).ok === false);
check("A7. ⭐⭐ chain '  BASE ' (case/spatii) -> FAIL (exact base; nu mascam drift de contract)",
  assertBaseData(okResult(baseWorkerData({ pairs: [{ chain: "  BASE ", pairAddress: "0x1" }], total: 1, count: 1 }))).ok === false);
check("A7b. ⭐ total ne-întreg (2.5) → fail", assertBaseData(okResult(baseWorkerData({ total: 2.5 }))).ok === false);
check("A7c. ⭐ total Infinity → fail", assertBaseData(okResult(baseWorkerData({ total: Infinity }))).ok === false);
check("A7d. ⭐⭐ total < count → fail (paginare incoerentă)", assertBaseData(okResult(baseWorkerData({ total: 2, count: 3 }))).ok === false);
check("A7e. ⭐ maxSnapshotAgeSec NaN → fail (prag invalid, nu comparație tăcută)", assertBaseData(okResult(baseWorkerData()), { maxSnapshotAgeSec: NaN }).ok === false);
check("A8. ⭐ snapshotAgeSec null → fail (snapshot necunoscut)", assertBaseData(okResult(baseWorkerData({ snapshotAgeSec: null }))).ok === false);
check("A9. snapshotAgeSec negativ → fail (skew)", assertBaseData(okResult(baseWorkerData({ snapshotAgeSec: -3 }))).ok === false);
check("A10. ⭐⭐ snapshot stale (≥300) → fail", assertBaseData(okResult(baseWorkerData({ snapshotAgeSec: 301 }))).ok === false);
check("A10b. snapshot la limită (299) → ok", assertBaseData(okResult(baseWorkerData({ snapshotAgeSec: 299 }))).ok === true);
check("A11. ⭐⭐ isError REDIS_DOWN → fail cu cod", (() => { const r = assertBaseData(errResult("REDIS_DOWN")); return r.ok === false && /REDIS_DOWN/.test(r.reason); })());
check("A12. ⭐⭐ isError FORBIDDEN (plan/scope) → fail cu cod", (() => { const r = assertBaseData(errResult("FORBIDDEN")); return r.ok === false && /FORBIDDEN/.test(r.reason); })());
check("A12b. isError cu cod din afara setului → 'necunoscut' (nu ecuăm string liber)",
  (() => { const r = assertBaseData(errResult("WEIRD_INTERNAL_LEAK")); return r.ok === false && /necunoscut/.test(r.reason) && !/WEIRD/.test(r.reason); })());
check("A13. ⭐⭐⭐ succes FĂRĂ structuredContent → fail (NU fallback pe content.text)",
  (() => { const r: McpCallResult = { ok: true, content: [{ type: "text", text: JSON.stringify({ ok: true, format: "preflight.response.v1", text: "x", data: baseWorkerData() }) }], isError: false }; return assertBaseData(r).ok === false; })());
check("A14. envelope ok≠true → fail", (() => { const env = { ok: false, format: "preflight.response.v1", text: "x", data: baseWorkerData() }; return assertBaseData({ ok: true, content: [{ type: "text", text: "{}" }], isError: false, structuredContent: env }).ok === false; })());
check("A15. format greșit → fail", (() => { const env = { ok: true, format: "other.v2", text: "x", data: baseWorkerData() }; return assertBaseData({ ok: true, content: [{ type: "text", text: "{}" }], isError: false, structuredContent: env }).ok === false; })());
check("A16. data non-obiect → fail", (() => { const env = { ok: true, format: "preflight.response.v1", text: "x", data: "nope" }; return assertBaseData({ ok: true, content: [{ type: "text", text: "{}" }], isError: false, structuredContent: env }).ok === false; })());
check("A16b. ⭐ envelope fără `text` string → fail (PH-14 incomplet)", (() => { const env = { ok: true, format: "preflight.response.v1", data: baseWorkerData() }; return assertBaseData({ ok: true, content: [{ type: "text", text: "{}" }], isError: false, structuredContent: env }).ok === false; })());
check("A17. apel MCP eșuat (transport) → fail", assertBaseData({ ok: false, stage: "transport", status: null, reason: "transport error" }).ok === false);
check("A18. ⭐ anti-leak: motivul NU conține pairAddress la pereche greșită",
  (() => { const r = assertBaseData(okResult(baseWorkerData({ pairs: [{ chain: "arbitrum", pairAddress: "0xDEADBEEF", symbol: "SECRET" }], total: 1, count: 1 }))); return r.ok === false && !/0xDEADBEEF/.test(r.reason) && !/SECRET/.test(r.reason); })());

// ─────────────────────────────────────────────────────────────────────────────
// B. assertBaseWsSubscriptions
// ─────────────────────────────────────────────────────────────────────────────
check("B1. ⭐ succes base WS (known+live+base.live, connected, pong 15s, v2 confirmed poolCount 4) → ok", assertBaseWsSubscriptions(okResult(baseHealthData())).ok === true);
// ⭐⭐⭐ fix cgpt P1 #2: cross-check knownChains/liveChains/base.live
check("B1a. ⭐⭐⭐ base absent din knownChains (dar perChainWorker.base verde) → fail",
  assertBaseWsSubscriptions(okResult(baseHealthData({}, { knownChains: [], liveChains: ["base"] }))).ok === false);
check("B1b. ⭐⭐⭐ base absent din liveChains → fail",
  assertBaseWsSubscriptions(okResult(baseHealthData({}, { liveChains: [] }))).ok === false);
check("B1c. ⭐⭐⭐ perChainWorker.base.live=false → fail",
  assertBaseWsSubscriptions(okResult(baseHealthData({ live: false }))).ok === false);
check("B1d. knownChains non-string[] → fail (formă invalidă)",
  assertBaseWsSubscriptions(okResult(baseHealthData({}, { knownChains: [7] }))).ok === false);
check("B1e. knownChains absent → fail", assertBaseWsSubscriptions(okResult(baseHealthData({}, { knownChains: undefined }))).ok === false);
check("B1f. ⭐ pongFreshSec NaN → fail (prag invalid)", assertBaseWsSubscriptions(okResult(baseHealthData()), { pongFreshSec: NaN }).ok === false);
check("B2. perChainWorker absent → fail", assertBaseWsSubscriptions(okResult({ workerOnline: true, knownChains: ["base"], liveChains: ["base"], wsStreamStaleSubs: [] })).ok === false);
check("B3. perChainWorker.base absent → fail", assertBaseWsSubscriptions(okResult({ perChainWorker: { arbitrum: {} }, knownChains: ["base"], liveChains: ["base"], wsStreamStaleSubs: [] })).ok === false);
check("B4. ⭐⭐ wsConnected false → fail", assertBaseWsSubscriptions(okResult(baseHealthData({ wsConnected: false }))).ok === false);
check("B5. lastPongAgeSec null → fail (transport nedovedit)", assertBaseWsSubscriptions(okResult(baseHealthData({ lastPongAgeSec: null }))).ok === false);
check("B6. pong negativ → fail (skew)", assertBaseWsSubscriptions(okResult(baseHealthData({ lastPongAgeSec: -2 }))).ok === false);
check("B7. ⭐⭐ pong stale (>120) → fail", assertBaseWsSubscriptions(okResult(baseHealthData({ lastPongAgeSec: 121 }))).ok === false);
check("B7b. pong la limită (120) → ok", assertBaseWsSubscriptions(okResult(baseHealthData({ lastPongAgeSec: 120 }))).ok === true);
check("B8. ⭐⭐ subs null (worker vechi) → fail", assertBaseWsSubscriptions(okResult(baseHealthData({ subs: null }))).ok === false);
check("B9. ⭐⭐⭐ niciun kind confirmed cu poolCount>0 → fail",
  assertBaseWsSubscriptions(okResult(baseHealthData({ subs: { v2: { confirmed: false, poolCount: 0 }, v3: { confirmed: true, poolCount: 0 }, v4: null } }))).ok === false);
check("B9b. confirmed true dar poolCount 0 → fail", assertBaseWsSubscriptions(okResult(baseHealthData({ subs: { v2: { confirmed: true, poolCount: 0 }, v3: null, v4: null } }))).ok === false);
check("B9c. ⭐ doar v4 confirmed cu poolCount>0 → ok (oricare kind)", assertBaseWsSubscriptions(okResult(baseHealthData({ subs: { v2: null, v3: null, v4: { confirmed: true, poolCount: 2 } } }))).ok === true);
check("B9d. ⭐ poolCount Infinity → fail (cere întreg finit)", assertBaseWsSubscriptions(okResult(baseHealthData({ subs: { v2: { confirmed: true, poolCount: Infinity }, v3: null, v4: null } }))).ok === false);
check("B9e. ⭐ poolCount fracționar (0.5) → fail", assertBaseWsSubscriptions(okResult(baseHealthData({ subs: { v2: { confirmed: true, poolCount: 0.5 }, v3: null, v4: null } }))).ok === false);
check("B10. ⭐⭐⭐ base:v2 în wsStreamStaleSubs → fail (subscripție base suspected-stale)",
  assertBaseWsSubscriptions(okResult(baseHealthData({}, { wsStreamStaleSubs: ["base:v2"] }))).ok === false);
check("B10b. alt chain în wsStreamStaleSubs (arbitrum:v2) → ok (nu penalizăm base)",
  assertBaseWsSubscriptions(okResult(baseHealthData({}, { wsStreamStaleSubs: ["arbitrum:v2"] }))).ok === true);
check("B11. wsStreamStaleSubs non-array → fail", assertBaseWsSubscriptions(okResult(baseHealthData({}, { wsStreamStaleSubs: "nope" }))).ok === false);
check("B11b. ⭐ wsStreamStaleSubs cu element non-string → fail (nu ignorăm tăcut)", assertBaseWsSubscriptions(okResult(baseHealthData({}, { wsStreamStaleSubs: ["arbitrum:v2", 7] }))).ok === false);
check("B12. isError REDIS_DOWN → fail", assertBaseWsSubscriptions(errResult("REDIS_DOWN")).ok === false);
check("B13. succes fără structuredContent → fail (fără fallback pe text)",
  assertBaseWsSubscriptions({ ok: true, content: [{ type: "text", text: JSON.stringify({ ok: true, format: "preflight.response.v1", text: "x", data: baseHealthData() }) }], isError: false }).ok === false);

// ─────────────────────────────────────────────────────────────────────────────
// C. parseHealthReport (extensie per-chain) + assertStrictHealthy(requireChains)
// ─────────────────────────────────────────────────────────────────────────────
function baseHealthReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok", httpStatus: 200, scope: "mcp-web + evm-worker",
    checks: {
      web: { ok: true, detail: "ok" }, redis: { ok: true, detail: "ok" },
      worker: { ok: true, detail: "fresh" }, ws: { ok: true, detail: "healthy" },
    },
    expectedChains: ["base"], observedChains: ["base"], staleChains: [],
    wsStaleSubs: [], wsUnavailableChains: [], wsUnknownChains: [], worstSnapshotAgeSec: 20,
    ...over,
  };
}
const R = (o: Record<string, unknown> = {}) => parseHealthReport(baseHealthReport(o))!;

check("C1. ⭐ parseHealthReport păstrează expectedChains/observedChains", (() => { const r = R(); return r.expectedChains[0] === "base" && r.observedChains[0] === "base"; })());
check("C2. ⭐⭐ câmp de chain PREZENT dar corupt (observedChains cu non-string) → null (fail-closed)",
  parseHealthReport(baseHealthReport({ observedChains: ["base", 7] })) === null);
check("C3. worstSnapshotAgeSec non-număr → null", parseHealthReport(baseHealthReport({ worstSnapshotAgeSec: "old" })) === null);
check("C4. ⭐ backward-compat: raport FĂRĂ câmpurile de chain → parseabil (absent → undefined/null, NU [])",
  (() => { const r = parseHealthReport({ status: "ok", httpStatus: 200, scope: "s", checks: { web: { ok: true, detail: "" }, redis: { ok: true, detail: "" }, worker: { ok: true, detail: "" }, ws: { ok: true, detail: "" } } }); return r !== null && r.expectedChains === undefined && r.worstSnapshotAgeSec === null; })());

check("C5. ⭐⭐⭐ strict base: report complet base → ok", assertStrictHealthy(R(), { requireChains: ["base"] }).ok === true);
check("C6. ⭐ strict base FĂRĂ requireChains (byte-compat) → ok (nu cere chain)", assertStrictHealthy(R(), {}).ok === true);
check("C7. ⭐⭐⭐ expectedChains are un chain în plus (base+arbitrum) → fail (monitorizează altceva)",
  assertStrictHealthy(R({ expectedChains: ["base", "arbitrum"] }), { requireChains: ["base"] }).ok === false);
check("C8. ⭐⭐⭐ expectedChains e alt chain (arbitrum) → fail",
  assertStrictHealthy(R({ expectedChains: ["arbitrum"], observedChains: ["arbitrum"] }), { requireChains: ["base"] }).ok === false);
check("C9. ⭐⭐ base nu e în observedChains → fail",
  assertStrictHealthy(R({ observedChains: [] }), { requireChains: ["base"] }).ok === false);
check("C10. ⭐⭐ base în staleChains → fail",
  assertStrictHealthy(R({ staleChains: ["base"] }), { requireChains: ["base"] }).ok === false);
check("C11. ⭐⭐ base:v2 în wsStaleSubs → fail",
  assertStrictHealthy(R({ wsStaleSubs: ["base:v2"] }), { requireChains: ["base"] }).ok === false);
check("C12. base în wsUnavailableChains → fail",
  assertStrictHealthy(R({ wsUnavailableChains: ["base"] }), { requireChains: ["base"] }).ok === false);
check("C13. base în wsUnknownChains → fail",
  assertStrictHealthy(R({ wsUnknownChains: ["base"] }), { requireChains: ["base"] }).ok === false);
check("C14. ⭐⭐ worstSnapshotAgeSec null → fail (snapshot necunoscut)",
  assertStrictHealthy(R({ worstSnapshotAgeSec: null }), { requireChains: ["base"] }).ok === false);
check("C15. ⭐⭐ worstSnapshotAgeSec ≥300 → fail",
  assertStrictHealthy(R({ worstSnapshotAgeSec: 300 }), { requireChains: ["base"] }).ok === false);
check("C16. worstSnapshotAgeSec negativ → fail (skew)",
  assertStrictHealthy(R({ worstSnapshotAgeSec: -5 }), { requireChains: ["base"] }).ok === false);
check("C17. ⭐ status degraded → fail înainte de chain (strict cere ok)",
  assertStrictHealthy(R({ status: "degraded", httpStatus: 503 }), { requireChains: ["base"] }).ok === false);
check("C18. ⭐ ws check ne-ok → fail (cei 4 de bază)",
  assertStrictHealthy(R({ checks: { web: { ok: true, detail: "" }, redis: { ok: true, detail: "" }, worker: { ok: true, detail: "" }, ws: { ok: false, detail: "zombie" } } }), { requireChains: ["base"] }).ok === false);

// ── C+ (fix cgpt #3): ABSENȚA unei dovezi per-chain = fail sub requireChains; byte-compat fără requireChains ──
/** Raport base cu o cheie ȘTEARSĂ (absent, nu gol), apoi parsat. */
function Rmiss(key: string): ReturnType<typeof parseHealthReport> {
  const o = baseHealthReport(); delete (o as Record<string, unknown>)[key]; return parseHealthReport(o);
}
check("C19. ⭐⭐⭐ staleChains ABSENT + requireChains → fail (unknown, NU gol=curat)",
  assertStrictHealthy(Rmiss("staleChains")!, { requireChains: ["base"] }).ok === false);
check("C20. ⭐⭐⭐ wsStaleSubs ABSENT + requireChains → fail",
  assertStrictHealthy(Rmiss("wsStaleSubs")!, { requireChains: ["base"] }).ok === false);
check("C21. ⭐⭐⭐ wsUnavailableChains ABSENT + requireChains → fail",
  assertStrictHealthy(Rmiss("wsUnavailableChains")!, { requireChains: ["base"] }).ok === false);
check("C22. ⭐⭐ expectedChains ABSENT + requireChains → fail",
  assertStrictHealthy(Rmiss("expectedChains")!, { requireChains: ["base"] }).ok === false);
check("C23. ⭐⭐ observedChains ABSENT + requireChains → fail",
  assertStrictHealthy(Rmiss("observedChains")!, { requireChains: ["base"] }).ok === false);
check("C23b. ⭐⭐⭐ wsUnknownChains ABSENT + requireChains → fail (simetrie cu C19–C23)",
  assertStrictHealthy(Rmiss("wsUnknownChains")!, { requireChains: ["base"] }).ok === false);
check("C24. ⭐ staleChains ABSENT dar FĂRĂ requireChains → ok (byte-compat)",
  assertStrictHealthy(Rmiss("staleChains")!, {}).ok === true);
check("C25. ⭐ staleChains PREZENT-GOL ([]) + requireChains → ok (gol = nimic stale, ≠ absent)",
  assertStrictHealthy(R({ staleChains: [] }), { requireChains: ["base"] }).ok === true);
check("C26. ⭐ maxSnapshotAgeSec invalid (0) + requireChains → fail (prag ne-pozitiv)",
  assertStrictHealthy(R(), { requireChains: ["base"], maxSnapshotAgeSec: 0 }).ok === false);
check("C27. maxSnapshotAgeSec NaN + requireChains → fail",
  assertStrictHealthy(R(), { requireChains: ["base"], maxSnapshotAgeSec: NaN }).ok === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
