/**
 * lib/mcp/deployWindowVerify.test.ts — verificatorul local al ferestrei `base-canary` (design rev2 §11), PUR.
 *
 * Hermetic: dovezile sunt construite în memorie (cititor injectat); fără fișiere, rețea, tokenuri sau Railway.
 * Acoperă traseul bun, fiecare criteriu cu teste negative (C1a, C1b, C1c, C2, C3a, C3b, C4, window.json),
 * normalizarea timpilor (UTC → ms, vârste s → ms), anti-leak și runner-ul (gardă de sursă).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  verifyDeployWindow, renderReport, parseUtcMs, toMcpCallResult, checkNativePrice, checkFlow, inventoryKinds,
  snapshotInventory, OUTCOME_EXIT, PROBE_IDS, type EvidenceReader, type ProbeId,
} from "./deployWindowVerify";
import { makeFsEvidenceReader } from "./deployWindowFsReader";
import type { McpCallResult } from "./canaryMcpClient";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name + (detail ? ` — ${detail}` : "")); }
}

console.log("Fereastra base-canary — deployWindowVerify (pur)");

// ── Timpi ────────────────────────────────────────────────────────────────────────────────────────────────────────
const T_M = "2026-11-10T18:00:00Z", T_W = "2026-11-10T18:05:00Z";
const PROBES: Record<ProbeId, string> = { "P-15": "2026-11-10T18:15:00Z", "P-25": "2026-11-10T18:25:00Z", "P-40": "2026-11-10T18:40:00Z" };
const TW = Date.UTC(2026, 10, 10, 18, 5, 0);
const TP = (id: ProbeId): number => parseUtcMs(PROBES[id]) as number;

// ── Fabrici ──────────────────────────────────────────────────────────────────────────────────────────────────────
const LEAK_ADDR = "0xPAIRSECRET", LEAK_SYM = "SYMLEAK", LEAK_SECRET = "wss://base-mainnet.example/v2/SECRETKEY";
function okTool(data: unknown): Record<string, unknown> {
  const env = { ok: true, format: "preflight.response.v1", text: JSON.stringify(data), meta: {}, data };
  return { content: [{ type: "text", text: JSON.stringify(env) }], structuredContent: env, isError: false };
}
function errTool(): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "INTERNAL", message: "x" } }) }], isError: true };
}
type Obj = Record<string, unknown>;
function healthData(id: ProbeId, over: { base?: Obj; np?: Obj | null; subs?: Obj | null } = {}): Obj {
  const tp = TP(id);
  const np = over.np === null ? null : { symbol: "ETH", value: 3000.5, ageSec: 120, sourceAgeSec: 600, observedAt: tp - 30_000, droppedNoPrice: 0, ...(over.np ?? {}) };
  const subs = over.subs === null ? null : {
    v2: { confirmed: true, poolCount: 4, lastMessageAgeSec: 20, confirmedAgeSec: 500 },
    v3: { confirmed: true, poolCount: 3, lastMessageAgeSec: 40, confirmedAgeSec: 500 },
    v4: { confirmed: true, poolCount: 1, lastMessageAgeSec: null, confirmedAgeSec: 500 },
    ...(over.subs ?? {}),
  };
  return {
    knownChains: ["base"], liveChains: ["base"], wsStreamStaleSubs: [],
    perChainWorker: { base: {
      live: true, wsConnected: true, lastPongAgeSec: 10, nativePrice: np, subs,
      subsState: subs ? { v2: "ACTIVE", v3: "ACTIVE", v4: "QUIET_OR_UNKNOWN" } : null, ...(over.base ?? {}),
    } },
    stats: { activeWatch: 7 },
  };
}
function pair(id: ProbeId, over: Obj = {}, flow: Obj | null = {}): Obj {
  return {
    pairAddress: LEAK_ADDR, chain: "base", symbol: LEAK_SYM, phase: "NEW", dexType: "V3",
    flow: flow === null ? null : { pressure: "BUYING", hasData: true, buys5m: 3, sells5m: 1, ...flow },
    updatedAt: TP(id) - 60_000, ...over,
  };
}
function page(pairs: Obj[], over: Obj = {}): Obj {
  return okTool({ total: pairs.length, count: pairs.length, offset: 0, has_more: false, pairs, snapshotAgeSec: 20, workerVersion: "w", ...over });
}
function windowJson(over: { root?: Obj; mcp?: Obj; worker?: Obj; secrets?: Obj; times?: Obj } = {}): Obj {
  return {
    version: 1, commit: "8b1ca61",
    times: { T_m: T_M, T_w: T_W, probes: { ...PROBES }, ...(over.times ?? {}) },
    config: {
      mcp: { configFilePath: "/railway.json", HEALTH_EXPECTED_CHAINS: "base", HEALTH_EXPECT_INDEXER_EVM: null, HEALTH_EXPECT_SOLANA_WORKER: "0", PUBLIC_BASE_URL: "https://preflight.jackspools.lol", ...(over.mcp ?? {}) },
      workerEvm: {
        configFilePath: "/workers/evm/railway.json", ENABLED_CHAINS: "base", PREFLIGHT_MODE: null,
        secrets: { REDIS_URL: { present: true, scheme: "rediss" }, ALCHEMY_BASE_WS: { present: true, scheme: "wss" }, ALCHEMY_BASE_RPC: { present: true, scheme: "https" }, ...(over.secrets ?? {}) },
        ...(over.worker ?? {}),
      },
    },
    ...(over.root ?? {}),
  };
}
/** Set complet de dovezi bune: fiecare probă cu flux legat de fereastră. */
function goodFiles(): Map<string, unknown> {
  const m = new Map<string, unknown>();
  m.set("window.json", windowJson());
  for (const id of PROBE_IDS) {
    m.set(`${id}/health.json`, okTool(healthData(id)));
    m.set(`${id}/snapshot-1.json`, page([pair(id), pair(id, {}, { hasData: false, buys5m: 0, sells5m: 0 })]));
    m.set(`${id}/situation.json`, okTool({ chains: { base: { workerOnline: true } } }));
  }
  return m;
}
function reader(m: Map<string, unknown>, raw: Map<string, string> = new Map()): EvidenceReader {
  const keys = (): string[] => [...new Set([...m.keys(), ...raw.keys()])];
  return {
    read: (rel) => (raw.has(rel) ? raw.get(rel) as string : m.has(rel) ? JSON.stringify(m.get(rel)) : null),
    list: (dir) => {
      const names = keys().filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)).filter((n) => !n.includes("/"));
      return names.length > 0 ? names : null;
    },
  };
}
const run = (m: Map<string, unknown>, raw?: Map<string, string>) => verifyDeployWindow(reader(m, raw), "8b1ca61");
const tool = (v: Obj): McpCallResult => toMcpCallResult(v) as McpCallResult;
const tw = (id: ProbeId) => ({ twMs: TW, probeMs: TP(id) });

// ── A. Timpi ─────────────────────────────────────────────────────────────────────────────────────────────────────
check("A1. ISO UTC cu secunde → ms (Date.UTC)", parseUtcMs("2026-11-10T18:05:00Z") === TW);
check("A2. milisecunde opționale (.5 → 500 ms)", parseUtcMs("2026-11-10T18:05:00.5Z") === TW + 500);
check("A3. fără Z → refuzat", parseUtcMs("2026-11-10T18:05:00") === null);
check("A4. offset +02:00 → refuzat (doar UTC)", parseUtcMs("2026-11-10T20:05:00+02:00") === null);
check("A5. fără secunde → refuzat", parseUtcMs("2026-11-10T18:05Z") === null);
check("A6. dată imposibilă (30 feb) → refuzat", parseUtcMs("2026-02-30T00:00:00Z") === null);
check("A7. număr (nu șir) → refuzat", parseUtcMs(TW) === null);

// ── B. Traseul bun ───────────────────────────────────────────────────────────────────────────────────────────────
{
  const r = run(goodFiles());
  check("B1. dovezi bune → AUTOMATE_INDEPLINITE, cod 0", r.outcome === "AUTOMATE_INDEPLINITE" && OUTCOME_EXIT[r.outcome] === 0, JSON.stringify(r.inputProblems));
  check("B2. C3a/C3b automat pe toate cele trei probe", r.c3ProbesAutomatic.join(",") === "P-15,P-25,P-40");
  check("B3. precondițiile nesensibile trec, fără semnale manuale", r.preconditions.every((c) => c.ok) && r.manualFlags.length === 0);
  const txt = renderReport(r);
  check("B4. textul spune „criterii automate îndeplinite” și NU conține VERDE", txt.includes("criterii automate îndeplinite") && !/VERDE/.test(txt));
  check("B5. textul listează verificările manuale (C3c, operații, consum)", txt.includes("C3c") && txt.includes("consumul Alchemy") && txt.includes("§5 și §7"));
  check("B6. anti-leak: fără adresă, simbol sau secret în raport", !txt.includes(LEAK_ADDR) && !txt.includes(LEAK_SYM) && !txt.includes("SECRETKEY"));
  const inv = r.probes[0].inventory;
  check("B7. inventar: v2/v3 trafic observat, v4 nedovedit (lastMessageAgeSec null)", inv?.v2.traffic === "observat" && inv?.v3.traffic === "observat" && inv?.v4.traffic === "nedovedit");
}
{
  const m = goodFiles();
  for (const id of PROBE_IDS) m.set(`${id}/snapshot-1.json`, page([pair(id, {}, { buys5m: 0, sells5m: 0 })]));
  const r = run(m);
  check("B8. fără swapuri la nicio probă → AUTOMATE_INDEPLINITE_FARA_FLUX, cod 2 (candidat NECONCLUDENT)", r.outcome === "AUTOMATE_INDEPLINITE_FARA_FLUX" && OUTCOME_EXIT[r.outcome] === 2);
  check("B9. textul fără flux spune NECONCLUDENT, nu ROȘU", renderReport(r).includes("NECONCLUDENT"));
}
{
  const m = goodFiles();
  for (const id of ["P-15", "P-25"] as const) m.set(`${id}/snapshot-1.json`, page([pair(id, {}, { buys5m: 0, sells5m: 0 })]));
  const r = run(m);
  check("B10. flux doar la P-40 → AUTOMATE_INDEPLINITE (C3 la cel puțin o probă)", r.outcome === "AUTOMATE_INDEPLINITE" && r.c3ProbesAutomatic.join(",") === "P-40");
}
{
  const m = goodFiles();
  m.set("P-15/health.json", { jsonrpc: "2.0", id: 7, result: okTool(healthData("P-15")) });
  check("B11. răspuns salvat învelit JSON-RPC → acceptat", run(m).outcome === "AUTOMATE_INDEPLINITE");
}

// ── C. C1a / C1b (subscripții, contract existent) ────────────────────────────────────────────────────────────────
{
  const only3 = { v2: null, v3: { confirmed: true, poolCount: 2, lastMessageAgeSec: 5, confirmedAgeSec: 100 }, v4: null };
  const m = goodFiles();
  for (const id of PROBE_IDS) m.set(`${id}/health.json`, okTool(healthData(id, { subs: only3 })));
  const r = run(m);
  check("C1. doar V3 confirmat (V2/V4 fără pool-uri) → C1a trece (nu cere toate trei)", r.probes.every((p) => p.c1a.ok), r.probes[0].c1a.reason);
  check("C2. inventarul marchează V2/V4 nedovedite", r.probes[0].inventory?.v2.traffic === "nedovedit" && r.probes[0].inventory?.v4.traffic === "nedovedit");
}
{
  const none = { v2: { confirmed: false, poolCount: 0, lastMessageAgeSec: null, confirmedAgeSec: null }, v3: { confirmed: true, poolCount: 0, lastMessageAgeSec: null, confirmedAgeSec: null }, v4: null };
  const m = goodFiles();
  m.set("P-25/health.json", okTool(healthData("P-25", { subs: none })));
  const r = run(m);
  check("C3. niciun kind confirmat cu poolCount > 0 → C1a pică → AUTOMATE_NEINDEPLINITE (cod 3)", r.outcome === "AUTOMATE_NEINDEPLINITE" && !r.probes[1].c1a.ok && OUTCOME_EXIT[r.outcome] === 3);
}
{
  const m = goodFiles();
  m.set("P-15/health.json", okTool({ ...healthData("P-15"), wsStreamStaleSubs: ["base:v2"] }));
  check("C4. base:v2 suspected-stale → C1a pică", !run(m).probes[0].c1a.ok);
}
{
  // lastMessageAgeSec în SECUNDE: la P-15 (T_w + 10 min), 540 s înapoi = T_w + 1 min − toleranța de 60 s → exact pe T_w.
  const at = (age: number) => inventoryKinds(tool(okTool(healthData("P-15", { subs: { v2: { confirmed: true, poolCount: 1, lastMessageAgeSec: age, confirmedAgeSec: 1 } } }))), tw("P-15"))?.v2.traffic;
  check("C5. vârsta în secunde convertită explicit: 540 s (pe T_w) → observat", at(540) === "observat");
  check("C6. 541 s (înainte de T_w) → nedovedit", at(541) === "nedovedit");
  check("C7. lastMessageAgeSec negativ → nedovedit", at(-1) === "nedovedit");
}

// ── D. C1c (preț ETH efectiv) ────────────────────────────────────────────────────────────────────────────────────
const np = (o: Obj | null, base: Obj = {}) => checkNativePrice(tool(okTool(healthData("P-15", { np: o, base }))), tw("P-15"));
check("D1. preț bun → C1c trece", np({}).ok);
check("D2. value null → pică (obiect prezent, preț indisponibil)", !np({ value: null }).ok);
check("D3. symbol BNB → pică", !np({ symbol: "BNB" }).ok);
check("D4. value 0 → pică", !np({ value: 0 }).ok);
check("D5. value Infinity → pică", !np({ value: Infinity }).ok);
check("D6. ageSec 900 → trece (limita E25, inclusiv)", np({ ageSec: 900 }).ok);
check("D7. ageSec 901 → pică (E25)", !np({ ageSec: 901 }).ok);
check("D8. ageSec 1.5 → pică (întreg cerut)", !np({ ageSec: 1.5 }).ok);
check("D9. ageSec −1 → pică", !np({ ageSec: -1 }).ok);
check("D10. observedAt < T_w → pică (observație din altă rulare)", !np({ observedAt: TW - 1 }).ok);
check("D11. observedAt = T_w → trece", np({ observedAt: TW }).ok);
check("D12. observedAt > T_p + 60 s → pică", !np({ observedAt: TP("P-15") + 60_001 }).ok);
check("D13. observedAt ca șir ISO → pică (ms numeric cerut)", !np({ observedAt: PROBES["P-15"] }).ok);
check("D14. sourceAgeSec foarte mare → trece (fără TTL nou pe oracol)", np({ sourceAgeSec: 86_400 }).ok);
check("D15. sourceAgeSec șir → pică (formă)", !np({ sourceAgeSec: "600" }).ok);
check("D16. nativePrice absent → pică", !np(null).ok);
check("D17. base.live false → pică", !np({}, { live: false }).ok);
{
  const m = goodFiles();
  m.set("P-40/health.json", okTool(healthData("P-40", { np: { value: null } })));
  check("D18. preț null la o singură probă → AUTOMATE_NEINDEPLINITE", run(m).outcome === "AUTOMATE_NEINDEPLINITE");
}

// ── E. C2 și C3a/C3b (flux pe Base, legat de fereastră) ─────────────────────────────────────────────────────────
const fl = (pages: Obj[], id: ProbeId = "P-15") => checkFlow(pages.map(tool), tw(id)).result;
check("E1. pereche cu swapuri, updatedAt în fereastră → trece", fl([page([pair("P-15")])]).ok);
check("E2. buys5m 1.5 → pică (întreg nenegativ, validat individual)", !fl([page([pair("P-15", {}, { buys5m: 1.5 })])]).ok);
check("E3. sells5m −1 → pică", !fl([page([pair("P-15", {}, { sells5m: -1 })])]).ok);
check("E4. buys5m șir → pică", !fl([page([pair("P-15", {}, { buys5m: "3" })])]).ok);
check("E5. sells5m invalid pe o pereche FĂRĂ date → pică (formă, fail-closed)", !fl([page([pair("P-15"), pair("P-15", {}, { hasData: false, buys5m: 0, sells5m: null })])]).ok);
check("E6. hasData true, buys5m + sells5m = 0 → C3a pică", !fl([page([pair("P-15", {}, { buys5m: 0, sells5m: 0 })])]).ok);
check("E7. hasData false cu swapuri → nu contează (C3a pică)", !fl([page([pair("P-15", {}, { hasData: false })])]).ok);
check("E8. updatedAt − 300 s < T_w → C3b pică (flux posibil dinainte)", !fl([page([pair("P-15", { updatedAt: TW + 299_999 })])]).ok);
check("E9. updatedAt − 300 s = T_w → trece", fl([page([pair("P-15", { updatedAt: TW + 300_000 })])]).ok);
check("E10. updatedAt > T_p + 60 s → C3b pică", !fl([page([pair("P-15", { updatedAt: TP("P-15") + 60_001 })])]).ok);
check("E11. updatedAt null → C3b pică", !fl([page([pair("P-15", { updatedAt: null })])]).ok);
check("E12. flux doar pe o pereche de pe alt chain → pică", !fl([page([pair("P-15", { chain: "arbitrum" })])]).ok);
check("E13. snapshot stale (300 s) → pică (C2/C3)", !fl([page([pair("P-15")], { snapshotAgeSec: 300 })]).ok);
check("E14. pagină cu isError → pică", !fl([errTool()]).ok);
{
  const p1 = page([pair("P-15", {}, { buys5m: 0, sells5m: 0 })], { total: 2, has_more: true });
  const p2 = page([pair("P-15")], { total: 2, offset: 1 });
  check("E15. flux pe pagina 2, pagini contigue → trece", fl([p1, p2]).ok);
  check("E16. pagina 2 cu offset greșit → pică", !fl([p1, page([pair("P-15")], { total: 2, offset: 0 })]).ok);
  check("E17. has_more=true pe ultima pagină salvată (< 5) → pică (pagini lipsă)", !fl([p1]).ok);
  const five = [0, 1, 2, 3, 4].map((i) => page([pair("P-15", {}, i === 4 ? {} : { buys5m: 0, sells5m: 0 })], { total: 9, offset: i, has_more: true }));
  const res = checkFlow(five.map(tool), tw("P-15"));
  check("E18. 5 pagini cu has_more=true → trunchiat consemnat, trece", res.result.ok && res.counts?.truncated === true);
}
{
  const m = goodFiles();
  m.set("P-25/snapshot-1.json", page([pair("P-25")], { snapshotAgeSec: 301 }));
  const r = run(m);
  check("E19. C2 pică la o probă (snapshot stale) → AUTOMATE_NEINDEPLINITE", r.outcome === "AUTOMATE_NEINDEPLINITE" && !r.probes[1].c2.ok);
}

// ── F. C4 ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const m = goodFiles();
  m.set("P-15/situation.json", errTool());
  check("F1. tp_situation_report isError → C4 pică → AUTOMATE_NEINDEPLINITE", run(m).outcome === "AUTOMATE_NEINDEPLINITE");
  m.set("P-15/situation.json", { content: [{ type: "text", text: "{}" }], isError: false });
  check("F2. succes fără structuredContent → C4 pică (fără fallback pe text)", !run(m).probes[0].c4.ok);
}

// ── G. window.json ───────────────────────────────────────────────────────────────────────────────────────────────
const withWin = (w: Obj) => { const m = goodFiles(); m.set("window.json", w); return run(m); };
{
  const r = withWin(windowJson({ secrets: { ALCHEMY_BASE_WS: { present: true, scheme: "wss", value: LEAK_SECRET } } }));
  check("G1. valoare de secret în window.json → INTRARE_INVALIDA, cod 4", r.outcome === "INTRARE_INVALIDA" && OUTCOME_EXIT[r.outcome] === 4);
  check("G2. … iar valoarea nu apare în raport", !renderReport(r).includes("SECRETKEY"));
}
check("G3. cheie necunoscută în secrets → INTRARE_INVALIDA", withWin(windowJson({ secrets: { ALCHEMY_ARB_WS: { present: true } } })).outcome === "INTRARE_INVALIDA");
check("G4. ENABLED_CHAINS base,arbitrum → AUTOMATE_NEINDEPLINITE", withWin(windowJson({ worker: { ENABLED_CHAINS: "base,arbitrum" } })).outcome === "AUTOMATE_NEINDEPLINITE");
check("G5. PREFLIGHT_MODE DEV → AUTOMATE_NEINDEPLINITE", withWin(windowJson({ worker: { PREFLIGHT_MODE: "DEV" } })).outcome === "AUTOMATE_NEINDEPLINITE");
check("G6. PREFLIGHT_MODE LIVE → trece", withWin(windowJson({ worker: { PREFLIGHT_MODE: "LIVE" } })).outcome === "AUTOMATE_INDEPLINITE");
check("G7. ALCHEMY_BASE_WS cu schema https → AUTOMATE_NEINDEPLINITE", withWin(windowJson({ secrets: { ALCHEMY_BASE_WS: { present: true, scheme: "https" } } })).outcome === "AUTOMATE_NEINDEPLINITE");
check("G8. ALCHEMY_BASE_RPC absent → AUTOMATE_NEINDEPLINITE", withWin(windowJson({ secrets: { ALCHEMY_BASE_RPC: { present: false } } })).outcome === "AUTOMATE_NEINDEPLINITE");
check("G9. HEALTH_EXPECT_INDEXER_EVM = 1 → AUTOMATE_NEINDEPLINITE", withWin(windowJson({ mcp: { HEALTH_EXPECT_INDEXER_EVM: "1" } })).outcome === "AUTOMATE_NEINDEPLINITE");
check("G10. HEALTH_EXPECTED_CHAINS base,arbitrum → AUTOMATE_NEINDEPLINITE", withWin(windowJson({ mcp: { HEALTH_EXPECTED_CHAINS: "base,arbitrum" } })).outcome === "AUTOMATE_NEINDEPLINITE");
check("G11. commit diferit → AUTOMATE_NEINDEPLINITE", withWin(windowJson({ root: { commit: "390a32b" } })).outcome === "AUTOMATE_NEINDEPLINITE");
{
  const r = withWin(windowJson({ worker: { configFilePath: null } }));
  check("G12. Config File Path diferit → semnal MANUAL, nu cădere", r.outcome === "AUTOMATE_INDEPLINITE" && r.manualFlags.some((f) => f.includes("Worker EVM Config File Path")));
}
check("G13. T_w fără secunde → INTRARE_INVALIDA", withWin(windowJson({ times: { T_w: "2026-11-10T18:05Z" } })).outcome === "INTRARE_INVALIDA");
check("G14. probe în ordine greșită → INTRARE_INVALIDA", withWin(windowJson({ times: { probes: { ...PROBES, "P-25": "2026-11-10T18:45:00Z" } } })).outcome === "INTRARE_INVALIDA");
check("G15. T_w înainte de T_m → INTRARE_INVALIDA", withWin(windowJson({ times: { T_w: "2026-11-10T17:59:59Z" } })).outcome === "INTRARE_INVALIDA");
check("G16. version 2 → INTRARE_INVALIDA", withWin(windowJson({ root: { version: 2 } })).outcome === "INTRARE_INVALIDA");

// ── H. Intrare ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  const m = goodFiles(); m.delete("P-25/health.json");
  check("H1. health.json lipsă → INTRARE_INVALIDA", run(m).outcome === "INTRARE_INVALIDA");
  const m2 = goodFiles();
  check("H2. JSON invalid → INTRARE_INVALIDA", run(m2, new Map([["P-15/situation.json", "{nu e json"]])).outcome === "INTRARE_INVALIDA");
  const m3 = goodFiles(); m3.delete("P-40/snapshot-1.json");
  check("H3. snapshot-1 lipsă → INTRARE_INVALIDA", run(m3).outcome === "INTRARE_INVALIDA");
  const m4 = goodFiles(); m4.set("P-15/health.json", { content: "nu e array" });
  check("H4. răspuns care nu e CallToolResult → INTRARE_INVALIDA", run(m4).outcome === "INTRARE_INVALIDA");
  const m5 = goodFiles(); for (let i = 2; i <= 6; i++) m5.set(`P-15/snapshot-${i}.json`, page([pair("P-15")]));
  check("H5. mai mult de 5 pagini salvate → INTRARE_INVALIDA", run(m5).outcome === "INTRARE_INVALIDA");
  const m6 = new Map<string, unknown>();
  check("H6. director gol → INTRARE_INVALIDA", run(m6).outcome === "INTRARE_INVALIDA");
}

// ── I. Runner (gardă de sursă: doar fișiere locale) ──────────────────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "verifyDeployWindow.ts"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
  check("I1. runner-ul importă doar verificatorul și cititorul de dovezi", imports.join(",") === "../lib/mcp/deployWindowFsReader,../lib/mcp/deployWindowVerify", imports.join(","));
  check("I2. runner-ul nu folosește rețea, env sau scriere", !/fetch\(|https?:|process\.env|writeFile|appendFile|spawn|exec\(/.test(src));
  check("I3. runner-ul cere commitul deployat ca argument (nu e fixat în cod)", src.includes('argOf("commit")') && src.includes("/^[0-9a-f]{7,40}$/.test(commit)") && !/[0-9a-f]{40}|"8b1ca61"/.test(src));
  check("I5. commit așteptat gol sau ne-hex → INTRARE_INVALIDA (startsWith(\"\") ar trece orice)",
    verifyDeployWindow(reader(goodFiles()), "").outcome === "INTRARE_INVALIDA" && verifyDeployWindow(reader(goodFiles()), "8B1CA61").outcome === "INTRARE_INVALIDA");
  const FULL = "8b1ca611c81aa1f506267ce93a2381828a692cab";
  const withCommit = (c: string) => { const m = goodFiles(); m.set("window.json", windowJson({ root: { commit: c } })); return verifyDeployWindow(reader(m), FULL).outcome; };
  check("I7. SHA complet dat: window.json cu SHA complet + caractere în plus → pică (egalitate exactă, nu startsWith)", withCommit(FULL + "00") === "AUTOMATE_NEINDEPLINITE");
  check("I8. SHA complet dat: window.json doar cu prefixul scurt → pică", withCommit("8b1ca61") === "AUTOMATE_NEINDEPLINITE");
  check("I6. commit așteptat complet (40 hex) față de window.json cu sha complet → acceptat", (() => {
    const m = goodFiles(); m.set("window.json", windowJson({ root: { commit: "8b1ca611c81aa1f506267ce93a2381828a692cab" } }));
    return verifyDeployWindow(reader(m), "8b1ca611c81aa1f506267ce93a2381828a692cab").outcome === "AUTOMATE_INDEPLINITE";
  })());
  const rsrc = fs.readFileSync(path.join(__dirname, "deployWindowFsReader.ts"), "utf8");
  check("I4. cititorul de pe disc nu scrie și nu folosește rețea", !/writeFile|appendFile|mkdir|rmSync|unlink|fetch\(|https?:|process\.env/.test(rsrc));
}

// ── J. rev2 (cgpt P1): o probă bună NU maschează dovezi de flux invalide la altă probă ─────────────────────────
{
  const m = goodFiles();
  m.set("P-25/snapshot-1.json", page([pair("P-25", {}, { buys5m: -1 })]));
  const r = run(m);
  check("J1. buys5m −1 doar la P-25 (P-15/P-40 cu flux valid) → AUTOMATE_NEINDEPLINITE, nu cod 0", r.outcome === "AUTOMATE_NEINDEPLINITE" && r.probes[1].c3Evidence === "invalid" && OUTCOME_EXIT[r.outcome] === 3);
  check("J2. … raportul numește dovezile de flux invalide la P-25", renderReport(r).includes("dovezi de flux: invalid"));
}
{
  const m = goodFiles();
  m.set("P-25/snapshot-1.json", page([pair("P-25")], { total: 2, has_more: true }));
  m.set("P-25/snapshot-2.json", errTool());
  check("J3. pagina 2 cu isError la P-25 → AUTOMATE_NEINDEPLINITE", run(m).outcome === "AUTOMATE_NEINDEPLINITE");
}
{
  const m = goodFiles();
  for (const id of PROBE_IDS) m.set(`${id}/snapshot-1.json`, page([pair(id, {}, { buys5m: -2, sells5m: -1 })]));
  const r = run(m);
  check("J4. contoare negative la toate probele → AUTOMATE_NEINDEPLINITE, nu „fără flux” (cod 2)", r.outcome === "AUTOMATE_NEINDEPLINITE" && OUTCOME_EXIT[r.outcome] === 3);
}
{
  const m = goodFiles();
  for (const id of ["P-15", "P-25"] as const) m.set(`${id}/snapshot-1.json`, page([pair(id, {}, { buys5m: 0, sells5m: 0 })]));
  const r = run(m);
  check("J5. flux valid la o singură probă, celelalte valide fără flux → cod 0 (păstrat)", r.outcome === "AUTOMATE_INDEPLINITE" && r.probes[0].c3Evidence === "fara_flux" && r.probes[2].c3Evidence === "flux");
}
{
  const m = goodFiles();
  m.set("P-40/snapshot-1.json", page([pair("P-40", {}, { hasData: "da" })]));
  check("J6. hasData ne-boolean la P-40 → AUTOMATE_NEINDEPLINITE", run(m).outcome === "AUTOMATE_NEINDEPLINITE");
}

// ── K. rev2 (cgpt P2): inventarul tuturor paginilor și aritmetica paginării, pe verificatorul complet ───────────
{
  const m = goodFiles();
  m.set("P-25/snapshot-1.json", page([pair("P-25")], { total: 3, has_more: true }));
  m.set("P-25/snapshot-3.json", errTool());
  const r = run(m);
  check("K1. pagina 2 absentă și pagina 3 cu eroare → INTRARE_INVALIDA (cod 4), nu cod 0", r.outcome === "INTRARE_INVALIDA" && OUTCOME_EXIT[r.outcome] === 4, JSON.stringify(r.inputProblems));
}
{
  const m = goodFiles();
  m.set("P-15/snapshot-1.json", page([pair("P-15")], { total: 500, count: 1, offset: 0, has_more: false }));
  check("K2. total 500, count 1, offset 0, has_more false → AUTOMATE_NEINDEPLINITE (has_more ≠ total > offset + count)", run(m).outcome === "AUTOMATE_NEINDEPLINITE");
}
{
  const m = goodFiles();
  m.set("P-15/snapshot-1.json", page([pair("P-15")], { total: 1, has_more: true }));
  m.set("P-15/snapshot-2.json", page([pair("P-15")], { total: 1, offset: 1 }));
  check("K3. has_more true deși total = offset + count → AUTOMATE_NEINDEPLINITE", run(m).outcome === "AUTOMATE_NEINDEPLINITE");
}
{
  const m = goodFiles();
  m.set("P-15/snapshot-1.json", page([pair("P-15")], { total: 2, has_more: true }));
  m.set("P-15/snapshot-2.json", page([pair("P-15")], { total: 1, offset: 1, has_more: false }));
  check("K4. total diferit între pagini (restul aritmeticii coerent pe fiecare pagină) → AUTOMATE_NEINDEPLINITE", run(m).outcome === "AUTOMATE_NEINDEPLINITE");
}
{
  const m = goodFiles();
  m.set("P-15/snapshot-1.json", page([pair("P-15")], { total: 2, has_more: true }));
  m.set("P-15/snapshot-2.json", page([pair("P-15")], { total: 2, offset: 1 }));
  check("K5. două pagini corecte (total 2, has_more true → false) → cod 0", run(m).outcome === "AUTOMATE_INDEPLINITE");
}
{
  const m = goodFiles(); m.set("P-40/snapshot-01.json", page([pair("P-40")]));
  check("K6. nume de pagină nestandard (snapshot-01) → INTRARE_INVALIDA", run(m).outcome === "INTRARE_INVALIDA");
  const m2 = goodFiles(); m2.set("P-40/snapshot-7.json", page([pair("P-40")]));
  check("K7. pagina 7 izolată (fără 2–6) → INTRARE_INVALIDA", run(m2).outcome === "INTRARE_INVALIDA");
  check("K8. inventar: [1,2,3] → 3 pagini; [1,3] → problemă; [] → problemă",
    (snapshotInventory(["snapshot-1.json", "snapshot-2.json", "snapshot-3.json", "health.json"], "P-15") as { pages: number }).pages === 3
    && "problem" in snapshotInventory(["snapshot-1.json", "snapshot-3.json"], "P-15")
    && "problem" in snapshotInventory(["health.json"], "P-15"));
}
{
  const m = goodFiles(); m.delete("P-25/health.json"); m.delete("P-25/situation.json"); m.delete("P-25/snapshot-1.json");
  check("K9. directorul unei probe lipsă → INTRARE_INVALIDA", run(m).outcome === "INTRARE_INVALIDA");
}

// ── L. rev2 (cgpt P2): fără text liber din dovezi în raport (enumuri închise) ───────────────────────────────────
{
  const MARK = "LEAK_MARKER\nlinie injectată";
  const m = goodFiles();
  for (const id of PROBE_IDS) {
    const h = healthData(id); (((h.perChainWorker as Obj).base as Obj).subsState as Obj).v2 = MARK;
    m.set(`${id}/health.json`, okTool(h));
    m.set(`${id}/snapshot-1.json`, page([pair(id, { dexType: MARK })]));
  }
  const r = run(m);
  const txt = renderReport(r);
  check("L1. dexType și subsState cu text liber (cu newline) → nu apar în raport", !txt.includes("LEAK_MARKER") && !txt.includes("linie injectată"), txt.split("\n").filter((l) => l.includes("LEAK")).join(" | "));
  check("L2. … etichete fixe: ALTUL pentru dexType, NECUNOSCUT pentru subsState", txt.includes("\"ALTUL\":1") && txt.includes("subsState=NECUNOSCUT"));
  check("L3. … iar raportul are exact liniile structurale (newline-ul injectat nu adaugă linii)", txt.split("\n").every((l) => !l.startsWith("linie")));
  check("L4. subsState null → ABSENT; V4 rămâne V4", inventoryKinds(tool(okTool(healthData("P-15", { base: { subsState: { v2: null, v3: "ACTIVE", v4: "QUIET_OR_UNKNOWN" } } }))), tw("P-15"))?.v2.subsState === "ABSENT");
}

// ── M. rev2 (cgpt P2): limita directorului pe destinația REALĂ (symlink-uri), comportamental ────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-verify-"));
  try {
    const ev = path.join(tmp, "evidence"), out = path.join(tmp, "afara");
    fs.mkdirSync(ev); fs.mkdirSync(out);
    const write = (base: string, rel: string, v: unknown): void => {
      fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
      fs.writeFileSync(path.join(base, rel), typeof v === "string" ? v : JSON.stringify(v));
    };
    for (const [rel, v] of goodFiles()) write(ev, rel, v);
    const fsr = makeFsEvidenceReader(ev) as EvidenceReader;
    check("M1. dovezi bune pe disc → cod 0 prin cititorul real", fsr !== null && verifyDeployWindow(fsr, "8b1ca61").outcome === "AUTOMATE_INDEPLINITE");
    check("M2. cale cu ../ în afara directorului → null", fsr.read("../afara/x.json") === null && fsr.list("..") === null);
    check("M3. cale absolută → null", fsr.read(path.join(ev, "window.json")) === null);

    // fișier legat în afară
    write(out, "health-afara.json", okTool(healthData("P-15")));
    fs.rmSync(path.join(ev, "P-15", "health.json"));
    fs.symlinkSync(path.join(out, "health-afara.json"), path.join(ev, "P-15", "health.json"));
    check("M4. P-15/health.json symlink spre afară → read null", fsr.read("P-15/health.json") === null);
    check("M5. … verificatorul complet → INTRARE_INVALIDA", verifyDeployWindow(fsr, "8b1ca61").outcome === "INTRARE_INVALIDA");
    fs.rmSync(path.join(ev, "P-15", "health.json"));
    write(ev, "P-15/health.json", okTool(healthData("P-15")));

    // subdirector legat în afară (cu dovezi „bune” acolo)
    for (const [rel, v] of goodFiles()) if (rel.startsWith("P-25/")) write(out, rel.replace("P-25/", "p25/"), v);
    fs.rmSync(path.join(ev, "P-25"), { recursive: true });
    fs.symlinkSync(path.join(out, "p25"), path.join(ev, "P-25"), "dir");
    check("M6. subdirectorul P-25 symlink spre afară → list și read null", fsr.list("P-25") === null && fsr.read("P-25/health.json") === null);
    check("M7. … verificatorul complet → INTRARE_INVALIDA (nu citește dovezile din afară)", verifyDeployWindow(fsr, "8b1ca61").outcome === "INTRARE_INVALIDA");

    // symlink INTERN (destinația reală rămâne în director) → acceptat
    fs.rmSync(path.join(ev, "P-25"));
    write(ev, "copii/P-25/health.json", okTool(healthData("P-25")));
    for (const [rel, v] of goodFiles()) if (rel.startsWith("P-25/")) write(ev, "copii/" + rel, v);
    fs.symlinkSync(path.join(ev, "copii", "P-25"), path.join(ev, "P-25"), "dir");
    check("M8. symlink intern (destinație în director) → acceptat, cod 0", verifyDeployWindow(fsr, "8b1ca61").outcome === "AUTOMATE_INDEPLINITE");
    check("M9. director de dovezi inexistent → cititor null", makeFsEvidenceReader(path.join(tmp, "nu-exista")) === null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
