/**
 * lib/mcp/deployWindowVerify.ts — verificatorul LOCAL read-only al ferestrei de deploy `base-canary`
 * (design `PREFLIGHT_DEPLOY_WINDOW_DESIGN.md` rev2, §6 și §11).
 *
 * PUR: primește conținutul fișierelor de dovezi printr-un cititor INJECTAT (cale relativă → text sau `null`) și
 * întoarce un raport. Fără rețea, fără tokenuri, fără Railway, fără Redis. Reutilizează asertorii existenți
 * `assertBaseWsSubscriptions` (C1a) și `assertBaseData` (C2) și adaugă C1c (preț ETH efectiv), C1b (inventar pe kind),
 * C3a/C3b (flux pe Base legat în timp de `T_w`), C4 (succes `tp_situation_report`) și verificarea valorilor
 * NESENSIBILE din `window.json`.
 *
 * NU verifică (raportul o spune explicit): liniile din log (C3c), operațiile manuale (§5, §7), bugetul de 60 min,
 * consumul Alchemy, P4/P5/P7/P8. De aceea raportul spune „criterii automate îndeplinite”, niciodată VERDE.
 *
 * Timpi: orele UTC din `window.json` se normalizează la MILISECUNDE (ISO 8601 strict, cu `Z` și secunde); vârstele din
 * răspunsuri (secunde) se convertesc explicit cu `* 1000`. `observedAt` / `updatedAt` din răspunsuri sunt deja ms.
 * Anti-leak: motivele conțin doar numărători, booleene și coduri închise — niciodată adrese, simboluri sau valori de env.
 */
import { assertBaseData, assertBaseWsSubscriptions } from "./canaryBaseData";
import type { McpCallResult } from "./canaryMcpClient";

// ── Constante (design rev2) ───────────────────────────────────────────────────────────────────────────────────────
export const PROBE_IDS = ["P-15", "P-25", "P-40"] as const;
export type ProbeId = typeof PROBE_IDS[number];
export const MAX_SNAPSHOT_PAGES = 5;
/** E25: `NATIVE_PRICE_MAX_AGE_MS` din worker (15 min), în secunde. */
export const NATIVE_PRICE_MAX_AGE_SEC = 15 * 60;
/** Toleranța ceasului manual al probei (doar pe marginile care depind de `T_p`). */
export const PROBE_CLOCK_TOLERANCE_MS = 60_000;
/** Fereastra de flux a stării (`buys5m`/`sells5m`). */
export const FLOW_WINDOW_MS = 5 * 60_000;
export const EXPECTED_PUBLIC_BASE_URL = "https://preflight.jackspools.lol";
export const EXPECTED_CONFIG_FILE = { mcp: "/railway.json", workerEvm: "/workers/evm/railway.json" } as const;

/**
 * Cititorul de dovezi (INJECTAT). `read` → conținutul fișierului sau `null` (lipsă / în afara directorului);
 * `list` → numele intrărilor dintr-un subdirector sau `null` (lipsă / în afara directorului). rev2 (cgpt P2): `list`
 * permite inventarul COMPLET al paginilor salvate (o pagină lipsă în mijloc nu mai ascunde paginile de după ea).
 */
export interface EvidenceReader {
  read(relPath: string): string | null;
  list(relDir: string): string[] | null;
}

/** rev2 (cgpt P2): câmpuri din dovezi raportate DOAR prin enumuri închise; orice altă valoare → etichetă fixă. */
export const DEX_TYPES = ["V2", "V3", "V4"] as const;
export type DexLabel = typeof DEX_TYPES[number] | "ALTUL";
export const SUB_STATES = ["ACTIVE", "SUSPECTED_STALE", "QUIET_OR_UNKNOWN"] as const;
export type SubStateLabel = typeof SUB_STATES[number] | "ABSENT" | "NECUNOSCUT";
export function dexLabel(v: unknown): DexLabel {
  return typeof v === "string" && (DEX_TYPES as readonly string[]).includes(v) ? v as DexLabel : "ALTUL";
}
export function subStateLabel(v: unknown): SubStateLabel {
  if (v === null || v === undefined) return "ABSENT";
  return typeof v === "string" && (SUB_STATES as readonly string[]).includes(v) ? v as SubStateLabel : "NECUNOSCUT";
}

export interface CheckResult { ok: boolean; reason: string; }
export type KindTraffic = "observat" | "nedovedit";
export interface KindInventory {
  confirmed: boolean | null; poolCount: number | null; lastMessageAgeSec: number | null;
  confirmedAgeSec: number | null; subsState: SubStateLabel; traffic: KindTraffic;
}
export interface FlowCounts {
  pages: number; truncated: boolean; pairs: number; pairsWithFlowData: number; pairsWithSwaps: number;
  pairsBoundToWindow: number; boundByDexType: Record<DexLabel, number>;
}
/**
 * rev2 (cgpt P1): dovada de flux a unei probe e `invalid` (formă / pagină / tool / aritmetica paginării), `fara_flux`
 * (dovezi VALIDE, dar fără pereche legată de fereastră) sau `flux`. Doar `invalid` blochează codurile 0 și 2.
 */
export type FlowEvidence = "invalid" | "fara_flux" | "flux";
export interface ProbeReport {
  id: ProbeId; probeAtMs: number;
  c1a: CheckResult; c1c: CheckResult; c2: CheckResult; c3ab: CheckResult; c3Evidence: FlowEvidence; c4: CheckResult;
  inventory: Record<"v2" | "v3" | "v4", KindInventory> | null;
  flow: FlowCounts | null;
}
export type AutoOutcome = "AUTOMATE_INDEPLINITE" | "AUTOMATE_INDEPLINITE_FARA_FLUX" | "AUTOMATE_NEINDEPLINITE" | "INTRARE_INVALIDA";
export interface WindowReport {
  outcome: AutoOutcome;
  inputProblems: string[];
  preconditions: CheckResult[];
  manualFlags: string[];
  probes: ProbeReport[];
  c3ProbesAutomatic: ProbeId[];
  manualChecksRequired: string[];
}

export const MANUAL_CHECKS: readonly string[] = Object.freeze([
  "C3c: liniile [V2|V3|V4 SWAP base] din logul Worker EVM în [T_w, T_p], la probele care trec C3a/C3b",
  "§5 și §7: deploy, oprire, repornire, revenire la parked (din dashboard și din strict health salvat)",
  "bugetul de 60 min de funcționare cumulată a workerului",
  "consumul Alchemy față de pragul din P6 și absența 429 / rate-limit",
  "P4 (fără schimbări pending), P5 (acces client), P7 (monitor, dacă a fost activ), P8 (starea inițială)",
  "STOP-urile din §8 care se văd doar în dashboard sau în log (crash-loop, [WS ERR, reconectări)",
]);

// ── Utilitare ────────────────────────────────────────────────────────────────────────────────────────────────────
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const pass = (reason = "ok"): CheckResult => ({ ok: true, reason });
const fail = (reason: string): CheckResult => ({ ok: false, reason });
const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
/** ISO 8601 UTC strict (`YYYY-MM-DDTHH:MM:SS[.mmm]Z`) → milisecunde; altfel `null` (inclusiv date imposibile). */
export function parseUtcMs(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = ISO_UTC.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  const ms = m[7] !== undefined ? Number(m[7].padEnd(3, "0")) : 0;
  const t = Date.UTC(y, mo - 1, d, h, mi, se, ms);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
      || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== se) return null;
  return t;
}

/** Răspunsul salvat (CallToolResult, opțional învelit în JSON-RPC `{jsonrpc, id, result}`) → `McpCallResult`. */
export function toMcpCallResult(saved: unknown): McpCallResult | null {
  let r: unknown = saved;
  if (isObj(r) && r.jsonrpc === "2.0" && "result" in r) r = r.result;
  if (!isObj(r) || !Array.isArray(r.content)) return null;
  if (r.isError !== undefined && typeof r.isError !== "boolean") return null;
  const out: McpCallResult = { ok: true, content: r.content as unknown[], isError: r.isError === true };
  if ("structuredContent" in r) out.structuredContent = r.structuredContent;
  return out;
}

/** Payload-ul de SUCCES PH-14 (aceleași reguli ca `canaryBaseData`), fail-closed; fără fallback pe text. */
function successData(r: McpCallResult): { data: Record<string, unknown> } | { reject: string } {
  if (!r.ok) return { reject: "apel eșuat" };
  if (r.isError) return { reject: "tool a întors isError" };
  const sc = r.structuredContent;
  if (!isObj(sc)) return { reject: "structuredContent absent/non-obiect" };
  if (sc.ok !== true) return { reject: "structuredContent.ok ≠ true" };
  if (sc.format !== "preflight.response.v1") return { reject: "format necunoscut" };
  if (typeof sc.text !== "string") return { reject: "structuredContent.text lipsă" };
  if (!isObj(sc.data)) return { reject: "structuredContent.data absent/non-obiect" };
  return { data: sc.data };
}

// ── window.json ──────────────────────────────────────────────────────────────────────────────────────────────────
export interface WindowTimes { tmMs: number; twMs: number; probesMs: Record<ProbeId, number>; }
interface ParsedWindow { times: WindowTimes; preconditions: CheckResult[]; manualFlags: string[]; }

const SECRET_KEYS = ["REDIS_URL", "ALCHEMY_BASE_WS", "ALCHEMY_BASE_RPC"] as const;
const SECRET_SCHEME: Record<typeof SECRET_KEYS[number], string | null> = {
  REDIS_URL: null, ALCHEMY_BASE_WS: "wss", ALCHEMY_BASE_RPC: "https",
};
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** Citește `window.json`: timpi (ms), valori nesensibile, prezența secretelor. Orice valoare de secret → refuz. */
export function parseWindow(raw: unknown, expectedCommit: string): ParsedWindow | { problems: string[] } {
  const problems: string[] = [];
  if (!isObj(raw)) return { problems: ["window.json: nu e obiect"] };
  if (raw.version !== 1) problems.push("window.json: version ≠ 1");
  const t = raw.times;
  if (!isObj(t)) return { problems: [...problems, "window.json: times absent"] };
  const tmMs = parseUtcMs(t.T_m), twMs = parseUtcMs(t.T_w);
  if (tmMs === null) problems.push("window.json: times.T_m nu e ISO UTC strict cu secunde");
  if (twMs === null) problems.push("window.json: times.T_w nu e ISO UTC strict cu secunde");
  const probesRaw = t.probes;
  const probesMs = {} as Record<ProbeId, number>;
  if (!isObj(probesRaw)) problems.push("window.json: times.probes absent");
  else for (const id of PROBE_IDS) {
    const v = parseUtcMs(probesRaw[id]);
    if (v === null) problems.push(`window.json: times.probes.${id} nu e ISO UTC strict cu secunde`);
    else probesMs[id] = v;
  }
  const cfg = raw.config;
  if (!isObj(cfg) || !isObj(cfg.mcp) || !isObj(cfg.workerEvm)) problems.push("window.json: config.mcp / config.workerEvm absent");
  // Anti-leak: blocul de secrete acceptă DOAR `present` (boolean) și `scheme` (enum); orice altă cheie → refuz total.
  const secrets = isObj(cfg) && isObj(cfg.workerEvm) ? cfg.workerEvm.secrets : undefined;
  if (!isObj(secrets)) problems.push("window.json: config.workerEvm.secrets absent");
  else for (const [k, v] of Object.entries(secrets)) {
    if (!(SECRET_KEYS as readonly string[]).includes(k)) { problems.push("window.json: cheie necunoscută în secrets (refuzat — doar prezență și schemă)"); continue; }
    if (!isObj(v) || Object.keys(v).some((x) => x !== "present" && x !== "scheme")) {
      problems.push(`window.json: secrets.${k} conține altceva decât present/scheme (refuzat — nu se consemnează valori)`);
      continue;
    }
    if (typeof v.present !== "boolean") problems.push(`window.json: secrets.${k}.present nu e boolean`);
    if (v.scheme !== undefined && v.scheme !== null && v.scheme !== "wss" && v.scheme !== "https" && v.scheme !== "redis" && v.scheme !== "rediss") {
      problems.push(`window.json: secrets.${k}.scheme în afara listei (wss/https/redis/rediss/null)`);
    }
  }
  if (problems.length > 0 || tmMs === null || twMs === null || !isObj(cfg) || !isObj(cfg.mcp) || !isObj(cfg.workerEvm) || !isObj(secrets)) {
    return { problems };
  }
  if (!(tmMs <= twMs && twMs < probesMs["P-15"] && probesMs["P-15"] < probesMs["P-25"] && probesMs["P-25"] < probesMs["P-40"])) {
    return { problems: ["window.json: ordinea timpilor nu e T_m ≤ T_w < P-15 < P-25 < P-40"] };
  }

  const pre: CheckResult[] = [];
  const manual: string[] = [];
  const mcp = cfg.mcp, w = cfg.workerEvm;
  const add = (name: string, ok: boolean, detail: string): void => { pre.push(ok ? pass(name) : fail(`${name}: ${detail}`)); };

  // Lotul canary (cgpt): SHA complet (40 hex) → egalitate EXACTĂ; un prefix scurt → doar `startsWith`.
  const commitOk = typeof raw.commit === "string"
    && (expectedCommit.length === 40 ? raw.commit === expectedCommit : raw.commit.startsWith(expectedCommit));
  add("commit", commitOk, expectedCommit.length === 40 ? "commitul consemnat nu e exact SHA-ul dat" : `commitul consemnat nu începe cu ${expectedCommit}`);
  add("P2 ENABLED_CHAINS = base", w.ENABLED_CHAINS === "base", "valoarea consemnată nu e exact „base”");
  add("P2 PREFLIGHT_MODE absent sau LIVE", w.PREFLIGHT_MODE === null || w.PREFLIGHT_MODE === "LIVE", "valoare diferită de null/LIVE (sau câmp lipsă)");
  add("P3 HEALTH_EXPECTED_CHAINS = base", mcp.HEALTH_EXPECTED_CHAINS === "base", "valoarea consemnată nu e exact „base”");
  for (const k of ["HEALTH_EXPECT_INDEXER_EVM", "HEALTH_EXPECT_SOLANA_WORKER"] as const) {
    add(`P3 ${k} absent sau 0`, mcp[k] === null || mcp[k] === "0", "valoare diferită de null/0 (sau câmp lipsă)");
  }
  for (const k of SECRET_KEYS) {
    const v = secrets[k];
    const want = SECRET_SCHEME[k];
    const present = isObj(v) && v.present === true;
    const schemeOk = want === null || (isObj(v) && v.scheme === want);
    add(`P2 ${k} prezent${want ? ` (${want}://)` : ""}`, present && schemeOk, present ? `schema consemnată nu e ${want}` : "absent sau neconsemnat");
  }
  // Valori care, dacă diferă, se LĂMURESC manual înainte de start (design §4 P1, P3) — semnalate, nu picate.
  if (!strOrNull(mcp.PUBLIC_BASE_URL) || mcp.PUBLIC_BASE_URL !== EXPECTED_PUBLIC_BASE_URL) manual.push("P3 PUBLIC_BASE_URL diferă de domeniul așteptat — de lămurit manual");
  if (mcp.configFilePath !== EXPECTED_CONFIG_FILE.mcp) manual.push("P1 MCP Config File Path diferă de /railway.json — comparația build/start se face manual");
  if (w.configFilePath !== EXPECTED_CONFIG_FILE.workerEvm) manual.push("P1 Worker EVM Config File Path diferă de /workers/evm/railway.json — comparația build/start se face manual");

  return { times: { tmMs, twMs, probesMs }, preconditions: pre, manualFlags: manual };
}

// ── Criteriile pe probă ──────────────────────────────────────────────────────────────────────────────────────────
function baseWorker(health: McpCallResult): Record<string, unknown> | string {
  const s = successData(health);
  if ("reject" in s) return s.reject;
  const pcw = s.data.perChainWorker;
  if (!isObj(pcw) || !isObj(pcw.base)) return "perChainWorker.base absent";
  return pcw.base;
}

/** C1c — preț ETH efectiv în observația din această fereastră (E25; fără TTL nou pe `sourceAgeSec`). */
export function checkNativePrice(health: McpCallResult, t: { twMs: number; probeMs: number }): CheckResult {
  const base = baseWorker(health);
  if (typeof base === "string") return fail(`${base}`);
  if (base.live !== true) return fail("perChainWorker.base.live ≠ true");
  const np = base.nativePrice;
  if (!isObj(np)) return fail("nativePrice absent");
  if (np.symbol !== "ETH") return fail("symbol ≠ ETH");
  if (!isFiniteNum(np.value) || np.value <= 0) return fail("value nu e număr finit > 0 (preț indisponibil)");
  if (!isNonNegInt(np.ageSec) || np.ageSec > NATIVE_PRICE_MAX_AGE_SEC) return fail(`ageSec nu e întreg în [0, ${NATIVE_PRICE_MAX_AGE_SEC}] (E25)`);
  if (!(np.sourceAgeSec === null || isFiniteNum(np.sourceAgeSec))) return fail("sourceAgeSec nu e număr sau null (formă)");
  if (!isFiniteNum(np.observedAt)) return fail("observedAt nu e număr finit (ms)");
  if (np.observedAt < t.twMs) return fail("observedAt înainte de T_w (observație din altă rulare)");
  if (np.observedAt > t.probeMs + PROBE_CLOCK_TOLERANCE_MS) return fail("observedAt după T_p (+60 s)");
  return pass("ETH, valoare > 0, E25, observație din fereastră");
}

/** C1b — inventarul pe kind (consemnat, nu criteriu). Trafic observat = mesaj după T_w (cu toleranța ceasului probei). */
export function inventoryKinds(health: McpCallResult, t: { twMs: number; probeMs: number }): Record<"v2" | "v3" | "v4", KindInventory> | null {
  const base = baseWorker(health);
  if (typeof base === "string" || !isObj(base.subs)) return null;
  const subs = base.subs;
  const states = isObj(base.subsState) ? base.subsState : {};
  const out = {} as Record<"v2" | "v3" | "v4", KindInventory>;
  for (const k of ["v2", "v3", "v4"] as const) {
    const sv = isObj(subs[k]) ? subs[k] : null;
    const num = (v: unknown): number | null => (isFiniteNum(v) ? v : null);
    const lastAge = sv ? num(sv.lastMessageAgeSec) : null;
    const traffic: KindTraffic = lastAge !== null && lastAge >= 0
      && (t.probeMs - PROBE_CLOCK_TOLERANCE_MS) - lastAge * 1000 >= t.twMs ? "observat" : "nedovedit";
    out[k] = {
      confirmed: sv && typeof sv.confirmed === "boolean" ? sv.confirmed : null,
      poolCount: sv ? num(sv.poolCount) : null,
      lastMessageAgeSec: lastAge,
      confirmedAgeSec: sv ? num(sv.confirmedAgeSec) : null,
      subsState: subStateLabel(states[k]),
      traffic,
    };
  }
  return out;
}

/**
 * C3a + C3b pe paginile `tp_worker_snapshot` ale unei probe. rev2 (cgpt P1/P2): orice eroare de formă, de tool sau de
 * paginare → `evidence: "invalid"` (nu „fără flux”). Paginarea cere: offset contiguu de la 0; `total` identic pe toate
 * paginile; `has_more === (total > offset + count)` pe FIECARE pagină; doar ultima pagină poate avea `has_more` fals;
 * `has_more` adevărat pe ultima pagină doar la plafonul de 5 pagini (trunchiat).
 */
export function checkFlow(pages: McpCallResult[], t: { twMs: number; probeMs: number }): { evidence: FlowEvidence; result: CheckResult; counts: FlowCounts | null } {
  const invalid = (reason: string) => ({ evidence: "invalid" as const, result: fail(`dovezi de flux invalide: ${reason}`), counts: null });
  if (pages.length === 0) return invalid("nicio pagină tp_worker_snapshot");
  if (pages.length > MAX_SNAPSHOT_PAGES) return invalid(`mai mult de ${MAX_SNAPSHOT_PAGES} pagini`);
  const counts: FlowCounts = { pages: pages.length, truncated: false, pairs: 0, pairsWithFlowData: 0, pairsWithSwaps: 0, pairsBoundToWindow: 0, boundByDexType: { V2: 0, V3: 0, V4: 0, ALTUL: 0 } };
  let expectedOffset = 0;
  let total0: number | null = null;
  for (let i = 0; i < pages.length; i++) {
    const shape = assertBaseData(pages[i]);
    if (!shape.ok) return invalid(`pagina ${i + 1}: ${shape.reason}`);
    const s = successData(pages[i]);
    if ("reject" in s) return invalid(`pagina ${i + 1}: ${s.reject}`);
    const d = s.data;
    const total = d.total as number, count = d.count as number;          // întregi > 0, validați de assertBaseData
    if (total0 === null) total0 = total;
    else if (total !== total0) return invalid(`pagina ${i + 1}: total diferit de pagina 1`);
    if (d.offset !== expectedOffset) return invalid(`pagina ${i + 1}: offset ≠ ${expectedOffset} (pagini necontigue)`);
    if (typeof d.has_more !== "boolean") return invalid(`pagina ${i + 1}: has_more nu e boolean`);
    if (d.has_more !== (total > expectedOffset + count)) return invalid(`pagina ${i + 1}: has_more ≠ (total > offset + count)`);
    const last = i === pages.length - 1;
    if (!last && d.has_more !== true) return invalid(`pagina ${i + 1}: has_more=false, dar există pagina următoare`);
    if (last && d.has_more === true) {
      if (pages.length < MAX_SNAPSHOT_PAGES) return invalid("has_more=true pe ultima pagină salvată (pagini lipsă)");
      counts.truncated = true;
    }
    const pairs = d.pairs as unknown[];
    expectedOffset += count;
    for (const p of pairs) {
      counts.pairs++;
      if (!isObj(p) || p.flow === null || p.flow === undefined) continue;
      const f = p.flow;
      if (!isObj(f)) return invalid("flow non-obiect");
      if (typeof f.hasData !== "boolean") return invalid("flow.hasData nu e boolean");
      // cgpt: buys5m și sells5m validate INDIVIDUAL ca întregi nenegativi (pe orice pereche cu flow, fail-closed).
      if (!isNonNegInt(f.buys5m)) return invalid("flow.buys5m nu e întreg nenegativ");
      if (!isNonNegInt(f.sells5m)) return invalid("flow.sells5m nu e întreg nenegativ");
      if (f.hasData !== true) continue;
      counts.pairsWithFlowData++;
      if (f.buys5m + f.sells5m <= 0) continue;
      counts.pairsWithSwaps++;
      const u = p.updatedAt;
      if (!isFiniteNum(u)) continue;
      if (u - FLOW_WINDOW_MS < t.twMs) continue;                     // C3b: fereastra de 5 min începe după T_w
      if (u > t.probeMs + PROBE_CLOCK_TOLERANCE_MS) continue;          // C3b: nu după probă
      counts.pairsBoundToWindow++;
      counts.boundByDexType[dexLabel(p.dexType)]++;
    }
  }
  if (counts.pairsWithSwaps === 0) return { evidence: "fara_flux", result: fail(`nicio pereche Base cu flow.hasData și swapuri > 0 (perechi ${counts.pairs}, cu date ${counts.pairsWithFlowData})`), counts };
  if (counts.pairsBoundToWindow === 0) return { evidence: "fara_flux", result: fail(`${counts.pairsWithSwaps} pereche(i) cu swapuri, niciuna cu updatedAt − 300 s ≥ T_w și ≤ T_p`), counts };
  return { evidence: "flux", result: pass(`${counts.pairsBoundToWindow} pereche(i) Base cu swapuri, legate de fereastră`), counts };
}

export function checkSituation(r: McpCallResult): CheckResult {
  const s = successData(r);
  return "reject" in s ? fail(s.reject) : pass("succes preflight.response.v1");
}

// ── Încărcarea dovezilor și raportul ─────────────────────────────────────────────────────────────────────────────
function loadJson(reader: EvidenceReader, rel: string, problems: string[]): unknown {
  const text = reader.read(rel);
  if (text === null) { problems.push(`${rel}: lipsește`); return undefined; }
  try { return JSON.parse(text) as unknown; } catch { problems.push(`${rel}: JSON invalid`); return undefined; }
}
function loadTool(reader: EvidenceReader, rel: string, problems: string[]): McpCallResult | null {
  const raw = loadJson(reader, rel, problems);
  if (raw === undefined) return null;
  const r = toMcpCallResult(raw);
  if (!r) problems.push(`${rel}: nu e un CallToolResult (content[] / isError)`);
  return r;
}

const SNAPSHOT_FILE = /^snapshot-([1-9][0-9]*)\.json$/;
/**
 * rev2 (cgpt P2): inventarul COMPLET al paginilor unei probe din listarea directorului — paginile trebuie să fie exact
 * `snapshot-1.json` … `snapshot-n.json`, contigue, 1 ≤ n ≤ 5. Orice gol, index peste 5 sau nume `snapshot*` nestandard
 * → problemă de intrare (nu se mai oprește la primul fișier lipsă).
 */
export function snapshotInventory(names: readonly string[], id: ProbeId): { pages: number } | { problem: string } {
  const idx: number[] = [];
  for (const n of names) {
    if (!n.startsWith("snapshot")) continue;
    const m = SNAPSHOT_FILE.exec(n);
    if (!m) return { problem: `${id}: fișier de pagină cu nume nestandard` };
    idx.push(Number(m[1]));
  }
  idx.sort((a, b) => a - b);
  if (idx.length === 0) return { problem: `${id}/snapshot-1.json: lipsește` };
  if (idx[idx.length - 1] > MAX_SNAPSHOT_PAGES) return { problem: `${id}: pagini peste ${MAX_SNAPSHOT_PAGES}` };
  for (let i = 0; i < idx.length; i++) if (idx[i] !== i + 1) return { problem: `${id}: pagini lipsă sau repetate (se cer snapshot-1 … snapshot-n contigue)` };
  return { pages: idx.length };
}

/** Verifică întregul director de dovezi. Căile sunt relative la `evidence/`. */
export function verifyDeployWindow(reader: EvidenceReader, expectedCommit: string): WindowReport {
  const empty = (problems: string[]): WindowReport => ({
    outcome: "INTRARE_INVALIDA", inputProblems: problems, preconditions: [], manualFlags: [], probes: [],
    c3ProbesAutomatic: [], manualChecksRequired: [...MANUAL_CHECKS],
  });
  // Lotul canary: commitul așteptat vine din runner; un șir gol sau ne-hex ar face `startsWith` adevărat pentru orice.
  if (!/^[0-9a-f]{7,40}$/.test(expectedCommit)) return empty(["commitul așteptat nu e 7–40 caractere hex"]);
  const problems: string[] = [];
  const winRaw = loadJson(reader, "window.json", problems);
  if (winRaw === undefined) return empty(problems);
  const win = parseWindow(winRaw, expectedCommit);
  if ("problems" in win) return empty(win.problems);

  const loaded: Array<{ id: ProbeId; health: McpCallResult; situation: McpCallResult; pages: McpCallResult[] }> = [];
  for (const id of PROBE_IDS) {
    const names = reader.list(id);
    if (names === null) { problems.push(`${id}/: director lipsă`); continue; }
    const health = loadTool(reader, `${id}/health.json`, problems);
    const situation = loadTool(reader, `${id}/situation.json`, problems);
    const inv = snapshotInventory(names, id);
    if ("problem" in inv) { problems.push(inv.problem); continue; }
    const pages: McpCallResult[] = [];
    for (let i = 1; i <= inv.pages; i++) {
      const pg = loadTool(reader, `${id}/snapshot-${i}.json`, problems);
      if (pg) pages.push(pg);
    }
    if (health && situation && pages.length === inv.pages) loaded.push({ id, health, situation, pages });
  }
  if (problems.length > 0) return empty(problems);

  const probes: ProbeReport[] = loaded.map(({ id, health, situation, pages }) => {
    const t = { twMs: win.times.twMs, probeMs: win.times.probesMs[id] };
    const flow = checkFlow(pages, t);
    return {
      id, probeAtMs: t.probeMs,
      c1a: assertBaseWsSubscriptions(health),
      c1c: checkNativePrice(health, t),
      c2: assertBaseData(pages[0]),
      c3ab: flow.result,
      c3Evidence: flow.evidence,
      c4: checkSituation(situation),
      inventory: inventoryKinds(health, t),
      flow: flow.counts,
    };
  });
  const c3Probes = probes.filter((p) => p.c3Evidence === "flux").map((p) => p.id);
  const preOk = win.preconditions.every((c) => c.ok);
  // rev2 (cgpt P1): dovezile de flux INVALIDE la oricare probă blochează codurile 0 și 2, indiferent de celelalte.
  const flowEvidenceOk = probes.every((p) => p.c3Evidence !== "invalid");
  const perProbeOk = probes.every((p) => p.c1a.ok && p.c1c.ok && p.c2.ok && p.c4.ok);
  const outcome: AutoOutcome = !preOk || !perProbeOk || !flowEvidenceOk ? "AUTOMATE_NEINDEPLINITE"
    : c3Probes.length > 0 ? "AUTOMATE_INDEPLINITE" : "AUTOMATE_INDEPLINITE_FARA_FLUX";
  return {
    outcome, inputProblems: [], preconditions: win.preconditions, manualFlags: win.manualFlags, probes,
    c3ProbesAutomatic: c3Probes, manualChecksRequired: [...MANUAL_CHECKS],
  };
}

export const OUTCOME_TEXT: Readonly<Record<AutoOutcome, string>> = Object.freeze({
  AUTOMATE_INDEPLINITE: "criterii automate îndeplinite (inclusiv C3a/C3b) — NU e verdictul final: urmează verificările manuale",
  AUTOMATE_INDEPLINITE_FARA_FLUX: "criterii automate îndeplinite, fără C3a/C3b la nicio probă — candidat NECONCLUDENT pe flux, după verificările manuale",
  AUTOMATE_NEINDEPLINITE: "criterii automate neîndeplinite — candidat ROȘU",
  INTRARE_INVALIDA: "dovezi incomplete sau invalide — nicio concluzie",
});
export const OUTCOME_EXIT: Readonly<Record<AutoOutcome, number>> = Object.freeze({
  AUTOMATE_INDEPLINITE: 0, AUTOMATE_INDEPLINITE_FARA_FLUX: 2, AUTOMATE_NEINDEPLINITE: 3, INTRARE_INVALIDA: 4,
});

/** Textul raportului (doar enumuri, numere, motive anti-leak). Nu conține niciodată cuvântul de verdict final. */
export function renderReport(r: WindowReport): string {
  const L: string[] = [];
  const mark = (c: CheckResult): string => (c.ok ? "ok  " : "PICĂ");
  L.push("Fereastra base-canary — verificator local read-only (design rev2 §11)");
  L.push(`rezultat: ${OUTCOME_TEXT[r.outcome]}`);
  for (const p of r.inputProblems) L.push(`  intrare: ${p}`);
  for (const c of r.preconditions) L.push(`  ${mark(c)} ${c.reason}`);
  for (const f of r.manualFlags) L.push(`  manual: ${f}`);
  for (const p of r.probes) {
    L.push(`${p.id} (${new Date(p.probeAtMs).toISOString()}):`);
    for (const [k, c] of [["C1a", p.c1a], ["C1c", p.c1c], ["C2", p.c2], ["C3a/b", p.c3ab], ["C4", p.c4]] as const) {
      L.push(`  ${mark(c)} ${k}: ${c.reason}`);
    }
    L.push(`  dovezi de flux: ${p.c3Evidence}`);
    if (p.inventory) {
      for (const k of ["v2", "v3", "v4"] as const) {
        const i = p.inventory[k];
        L.push(`  inventar ${k}: confirmed=${String(i.confirmed)} poolCount=${String(i.poolCount)} lastMessageAgeSec=${String(i.lastMessageAgeSec)} subsState=${String(i.subsState)} trafic=${i.traffic}`);
      }
    } else L.push("  inventar: indisponibil");
    if (p.flow) L.push(`  flux: pagini=${p.flow.pages}${p.flow.truncated ? " (trunchiat)" : ""} perechi=${p.flow.pairs} cuDate=${p.flow.pairsWithFlowData} cuSwapuri=${p.flow.pairsWithSwaps} legateDeFereastră=${p.flow.pairsBoundToWindow} peDex=${JSON.stringify(p.flow.boundByDexType)}`);
  }
  L.push(`probe cu C3a/C3b automat: ${r.c3ProbesAutomatic.length > 0 ? r.c3ProbesAutomatic.join(", ") : "niciuna"}`);
  L.push("Verificări MANUALE necesare înaintea verdictului (acest instrument NU le face):");
  for (const m of r.manualChecksRequired) L.push(`  - ${m}`);
  return L.join("\n");
}
