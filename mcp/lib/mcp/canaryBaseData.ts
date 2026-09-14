/**
 * lib/mcp/canaryBaseData.ts — PH-12 12.5c-1 (aserturi PURE „date reale pe Base", peste rezultatul MCP).
 *
 * Gate 2 (Base canary) adaugă peste Gate 1 două PROBE MCP autentificate care dovedesc că Worker Base a indexat efectiv
 * (nu doar „Redis up"):
 *   - `tp_worker_snapshot({chain:"base"})` → `assertBaseData`      (perechi indexate pe base + snapshot fresh);
 *   - `tp_health_check()`                  → `assertBaseWsSubscriptions` (WS base conectat + pong fresh + subscripții
 *      confirmate + fără suspected-stale) — semnalul de subscripție pe care strict-health SINGUR NU-l dovedește
 *      (poate arăta WS „healthy" doar din connected+pong, chiar cu zero subscripții active).
 *
 * PH-14 CONTRACT (sursa de adevăr = `errors.ts`): succesul unui tool poartă `structuredContent` TIPAT
 * `{ ok:true, format:"preflight.response.v1", text, meta, data }`, cu payload-ul structurat în `structuredContent.data`;
 * erorile (`isError:true`) NU poartă `structuredContent` (codul e în `content[0].text` ca `{ok:false,error:{code}}`).
 *
 * DOCTRINĂ (fix cgpt): validăm EXCLUSIV `structuredContent.data`. FĂRĂ fallback la dublu-parse din `content[0].text`
 * pe calea de SUCCES — un succes fără `structuredContent` valid e REFUZAT fail-closed (nu „ghicim" din text).
 * PUR: operează pe `McpCallResult` deja produs de `canaryMcpClient` (zero I/O). Anti-leak: motivele conțin DOAR
 * numărători/booleene/coduri închise — NICIODATĂ `pairAddress`, `symbol` sau alt conținut de piață.
 */

import type { McpCallResult } from "./canaryMcpClient";
import type { GateResult } from "./releaseGate";

const pass = (reason = "ok"): GateResult => ({ ok: true, reason });
const fail = (reason: string): GateResult => ({ ok: false, reason });

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Coduri de eroare de tool pe care le RECUNOAȘTEM (oglindă `ERR` din errors.ts). Un `isError` cu cod în afara setului
// → raportat ca „necunoscut" (nu ecuăm string liber din payload — anti-leak / anti-injection).
const KNOWN_TOOL_ERR = new Set([
  "REDIS_DOWN", "NOT_FOUND", "INVALID_INPUT", "EXTERNAL_API", "INTERNAL", "UNAUTHORIZED", "INVALID_TOKEN",
  "RATE_LIMITED", "FORBIDDEN", "QUOTA_EXCEEDED", "AUTH_UNAVAILABLE", "RATE_LIMIT_UNAVAILABLE", "QUOTA_UNAVAILABLE",
]);

/**
 * Extrage DOAR codul de eroare dintr-un `CallToolResult` cu `isError:true` (payload `{ok:false,error:{code}}` în
 * `content[0].text`). Best-effort + fail-safe: orice formă neașteptată → "necunoscut". Anti-leak: întoarce EXCLUSIV
 * un cod din setul închis (sau "necunoscut"), niciodată `message` sau alt câmp.
 */
function toolErrorCode(content: unknown[]): string {
  const first = content[0];
  if (!isObj(first) || typeof first.text !== "string") return "necunoscut";
  let parsed: unknown;
  try { parsed = JSON.parse(first.text); } catch { return "necunoscut"; }
  if (!isObj(parsed) || !isObj(parsed.error)) return "necunoscut";
  const code = parsed.error.code;
  return typeof code === "string" && KNOWN_TOOL_ERR.has(code) ? code : "necunoscut";
}

/**
 * Reduce un `McpCallResult` la payload-ul de SUCCES (`structuredContent.data`), fail-closed. Refuză, în ordine:
 * apel eșuat (transport/http/jsonrpc/parse), `isError:true` (cu codul închis), `structuredContent` absent/invalid,
 * envelope ne-conform (`ok≠true` / `format` greșit), sau `data` non-obiect. NU cade pe `content[0].text` la succes.
 */
function readSuccessData(r: McpCallResult): { data: Record<string, unknown> } | { reject: string } {
  if (!r.ok) return { reject: `apel MCP eșuat la ${r.stage} (${r.reason})` }; // r.reason e deja anti-leak (coduri închise)
  if (r.isError) return { reject: `tool a întors isError (cod ${toolErrorCode(r.content)})` };
  const sc = r.structuredContent;
  if (!isObj(sc))                                return { reject: "structuredContent absent/non-obiect (succesul PH-14 trebuie tipat) — fără fallback pe text" };
  if (sc.ok !== true)                            return { reject: "structuredContent.ok ≠ true (envelope ne-conform)" };
  if (sc.format !== "preflight.response.v1")     return { reject: "structuredContent.format necunoscut (nu preflight.response.v1)" };
  if (typeof sc.text !== "string")               return { reject: "structuredContent.text lipsă/non-string (envelope PH-14 incomplet)" };
  if (!isObj(sc.data))                           return { reject: "structuredContent.data absent/non-obiect" };
  return { data: sc.data };
}

/** Chain-ul canonic al tool-ului e EXACT „base" (fix cgpt: `" BASE "` ar ascunde drift de contract → NU normalizăm). */
function isBaseExact(v: unknown): boolean {
  return v === "base";
}
/** Prag configurabil valid: finit + strict pozitiv (fix cgpt: `NaN`/≤0 ar face comparațiile să treacă tăcut). */
function validThreshold(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}
/** Chain prezent într-o listă care TREBUIE să fie `string[]` (fix cgpt: element non-string → invalid, nu ignorat). */
function stringListIncludes(v: unknown, want: string): { has: boolean } | { invalid: true } {
  if (!Array.isArray(v)) return { invalid: true };
  for (const e of v) if (typeof e !== "string") return { invalid: true };
  return { has: (v as string[]).includes(want) };
}

/**
 * `tp_worker_snapshot({chain:"base"})` — dovada că Worker Base a INDEXAT (nu doar Redis up). Cere pe
 * `structuredContent.data`: `total>0` ȘI `count>0`, `pairs` array ne-gol cu `pairs.length===count`, FIECARE pereche
 * pe base, iar `snapshotAgeSec` cunoscut, ne-negativ și `< maxSnapshotAgeSec` (default 300). Fail-closed + anti-leak.
 */
export function assertBaseData(r: McpCallResult, opts: { maxSnapshotAgeSec?: number } = {}): GateResult {
  const maxAge = opts.maxSnapshotAgeSec ?? 300;
  if (!validThreshold(maxAge)) return fail(`Base data: maxSnapshotAgeSec invalid (${maxAge}) — cere finit > 0`);

  const s = readSuccessData(r);
  if ("reject" in s) return fail(`Base data: ${s.reject}`);
  const d = s.data;

  // total/count ÎNTREGI (fix cgpt: `Infinity`/fracționar respinse) + `total ≥ count` (paginare coerentă).
  const total = d.total, count = d.count;
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) return fail("Base data: total ne-întreg/≤0 (Worker Base n-a indexat)");
  if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) return fail("Base data: count ne-întreg/≤0 (pagină goală)");
  if (total < count)                                                        return fail(`Base data: total (${total}) < count (${count}) — paginare incoerentă`);

  const pairs = d.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) return fail("Base data: `pairs` gol/absent");
  if (pairs.length !== count)                      return fail(`Base data: pairs.length (${pairs.length}) ≠ count (${count}) — formă inconsistentă`);
  for (const p of pairs) {
    // Anti-leak: raportăm DOAR că o pereche nu e pe base, niciodată adresa/simbolul. Chain EXACT „base" (fără trim/lower).
    if (!isObj(p) || !isBaseExact(p.chain)) return fail("Base data: pereche cu chain ≠ base exact (agregare/filtrare/drift)");
  }

  const age = d.snapshotAgeSec;
  if (typeof age !== "number" || !Number.isFinite(age)) return fail("Base data: snapshotAgeSec necunoscut (snapshot lipsă)");
  if (age < 0)        return fail(`Base data: snapshotAgeSec ${age} negativ (skew)`);
  if (age >= maxAge)  return fail(`Base data: snapshot stale (${age}s ≥ ${maxAge}s)`);

  return pass(`Base data OK (total ${total}, count ${count}, snapshot ${age}s)`);
}

type WsSubView = { confirmed?: unknown; poolCount?: unknown };

/**
 * `tp_health_check()` — dovada de SUBSCRIPȚIE WS pe base pe care strict-health singur NU o dă. Pe
 * `structuredContent.data.perChainWorker.base` cere: `wsConnected===true`, `lastPongAgeSec` cunoscut/ne-negativ/
 * `≤ pongFreshSec` (default 120), `subs !== null` (worker nu-i vechi), cel puțin un kind v2/v3/v4 cu
 * `confirmed===true && poolCount>0`, iar top-level `wsStreamStaleSubs` FĂRĂ nicio intrare `base:*`. Fail-closed.
 */
export function assertBaseWsSubscriptions(r: McpCallResult, opts: { pongFreshSec?: number } = {}): GateResult {
  const pongFresh = opts.pongFreshSec ?? 120;
  if (!validThreshold(pongFresh)) return fail(`Base WS: pongFreshSec invalid (${pongFresh}) — cere finit > 0`);

  const s = readSuccessData(r);
  if ("reject" in s) return fail(`Base WS: ${s.reject}`);
  const d = s.data;

  // ⭐ fix cgpt P1 #2: corelăm TOATE cele trei reprezentări ale liveness-ului base. Un `perChainWorker.base` fabricat
  // verde, dar cu base absent din knownChains/liveChains (sau `live:false`), NU mai trece.
  const known = stringListIncludes(d.knownChains, "base");
  if ("invalid" in known) return fail("Base WS: knownChains absent/non-string[] (formă invalidă)");
  if (!known.has)         return fail("Base WS: base nu e în knownChains (nicio amprentă worker pe base)");
  const live = stringListIncludes(d.liveChains, "base");
  if ("invalid" in live)  return fail("Base WS: liveChains absent/non-string[] (formă invalidă)");
  if (!live.has)          return fail("Base WS: base nu e în liveChains (heartbeat runtime base absent)");

  const pcw = d.perChainWorker;
  if (!isObj(pcw))       return fail("Base WS: perChainWorker absent/non-obiect");
  const base = pcw.base;
  if (!isObj(base))      return fail("Base WS: perChainWorker.base absent (base necunoscut la worker)");
  if (base.live !== true) return fail("Base WS: perChainWorker.base.live ≠ true (base nu e live)");

  if (base.wsConnected !== true) return fail("Base WS: wsConnected ≠ true (socket base neconectat)");

  const pong = base.lastPongAgeSec;
  if (typeof pong !== "number" || !Number.isFinite(pong)) return fail("Base WS: lastPongAgeSec necunoscut (transport nedovedit)");
  if (pong < 0)          return fail(`Base WS: lastPongAgeSec ${pong} negativ (skew)`);
  if (pong > pongFresh)  return fail(`Base WS: pong stale (${pong}s > ${pongFresh}s)`);

  const subs = base.subs;
  if (!isObj(subs)) return fail("Base WS: subs=null/non-obiect (worker vechi fără wsSubs)");
  const kinds = ["v2", "v3", "v4"] as const;
  // poolCount ÎNTREG finit pozitiv (fix cgpt: `Infinity`/`0.5` respinse).
  const confirmedActive = kinds.some((k) => {
    const sv = subs[k] as WsSubView | null | undefined;
    return isObj(sv) && sv.confirmed === true && typeof sv.poolCount === "number" && Number.isInteger(sv.poolCount) && sv.poolCount > 0;
  });
  if (!confirmedActive) return fail("Base WS: niciun kind v2/v3/v4 confirmed cu poolCount întreg>0 (fără subscripție dovedită)");

  // wsStreamStaleSubs TREBUIE `string[]` (fix cgpt: element non-string → invalid, nu ignorat). Chain-ul e prefixul
  // canonic `base:` (exact, fără trim/lower — driftul nu trebuie mascat).
  const stale = d.wsStreamStaleSubs;
  if (!Array.isArray(stale)) return fail("Base WS: wsStreamStaleSubs absent/non-array (formă invalidă)");
  for (const x of stale) if (typeof x !== "string") return fail("Base WS: wsStreamStaleSubs cu element non-string (formă invalidă)");
  if ((stale as string[]).some((x) => x.startsWith("base:"))) {
    return fail("Base WS: subscripție base suspected-stale în wsStreamStaleSubs");
  }

  return pass("Base WS OK (known+live+base.live, connected, pong fresh, ≥1 kind confirmed poolCount>0, fără base:* stale)");
}
