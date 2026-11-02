/**
 * scripts/beta1/cases/admissionDefs.ts — BETA-1, treapta 2: definițiile și corpul cazurilor de ADMITERE REALĂ.
 *
 * Design: `BETA1_TREAPTA2_DESIGN.md` rev3 (`d5290d5c…`). Modul fără efecte la import (nu pornește niciun caz); e
 * folosit de `admissionCases.ts` (codul REAL al workerului) și de self-testul treptei 2 (worker fals).
 *
 * Traseul fiecărui caz (§2), cu NIMIC pus direct în hărți, watch, follow-list sau routing-only:
 *   connect → [scan1] scan() → [boosted] runDsBoostedRefresh() → [follow] runFollowRefresh() → [scan2] scan()
 *   → bariera finală (§3.1, contractul pe două coloane, §4.2) → conținutul filtrelor → o livrare → verdict.
 * Intrările cazului: env-ul fix (supraveghetorul), fixture-ul `fetch` per URL exact (`admissionFixtures.ts`), prețul
 * nativ injectat și conectarea managerului WS la nodul local.
 *
 * BARIERA PER PAS (§3.1), după fiecare pas:
 *   1. toate timerele create în faza pasului ajung într-o stare finală (fără `pending`/`running`); la termen →
 *      HARNESS_ERROR cu lista lor. Așa se prinde și „joburi zero, dar timer de reabonare încă pending”:
 *      `activeJobCount()` nu e consultat aici deloc.
 *   2. runda de reabonare e identificată prin timerele EFECTIV programate: triplete consecutive 500/800/1100 ms
 *      (`requestImmediateScopedSubscribe` le creează sincron, unul după altul). Zero triplete = rundă necerută sau
 *      suprimată de limitarea de 2 s (consemnat); un timer 500/800/1100 în afara unui triplet complet = programare
 *      parțială → HARNESS_ERROR. Fiecare timer al rundei: `fires === 1`, `inFlight === 0`, stare `done`, fără eroare.
 *   3. subscripțiile ajung la un punct fix coerent: nimic în `pending`/`latestReq`; pentru fiecare tip, fie ACTIV
 *      coerent (intrarea confirmată = ultima cerere a tipului, filtrul activ la nod = instantaneul confirmat, o singură
 *      subscripție activă la nod pentru tip), fie ABSENT coerent (fără intrare în worker, nimic activ la nod);
 *      fiecare `eth_unsubscribe` primit și confirmat de nod. Apoi ping (client → nod) + santinelă (nod → client) și
 *      RE-verificare: o stare care se mai mișcă → HARNESS_ERROR.
 *   1b. (rev2) nicio operație `fetch` în zbor: fiecare răspuns servit are corpul CITIT complet (observat de gardă pe
 *      instanța `Response`: `json()`/`text()`/… încheiate). Timerele NU sunt criteriu aici: produsul curăță timerul de
 *      abort la primirea răspunsului, înaintea citirii corpului (GoPlus), deci „timer încheiat” ≠ „operație
 *      terminată”. La termen → HARNESS_ERROR cu operațiile rămase.
 *   4. fetch-urile pasului: exact cele prezise, per URL (contorul gărzii), toate servite.
 * Abia la final, starea stabilă trebuie să corespundă INTEGRAL (statut ACTIV/ABSENT pe v2, v3, v4) uneia dintre
 * coloanele contractului; altfel HARNESS_ERROR (barieră). ACTIV/ABSENT NU decide verdictul: conținutul exact al
 * filtrelor se verifică DUPĂ barieră. Exemplu (review cgpt): ținta prezentă simultan în filtrele V2 și V3 dă
 * statutul „v2 ACTIV, v3 ACTIV, v4 ABSENT” = coloana „după fix” a lui A2-F-V3, deci trece bariera de statut; e
 * respinsă la ETAPA DE CONȚINUT (V2 nu corespunde niciunei coloane) → HARNESS_ERROR, niciodată „nereprodus”.
 *
 * MONTAJ (verificat, nu presupus), pe identitatea COMPLETĂ chain + adresă (rev2): după `scan1`, `activeWatch` = exact
 * pool-urile prezise, pe Base (S/D5: ținta; F: martorul);
 * după `follow` (F), ținta e în `activeWatch`; umplutura nu intră niciodată în watch; după fiecare scan umplutura e în
 * `v3PoolMap` și linia „Keeping previous V3/V4 maps” lipsește (reconstruirea a rulat — esențial pentru D5).
 * Orice abatere de montaj → HARNESS_ERROR „montaj”, nu „defect reprodus”.
 *
 * MARTOR ȘI TOTALURI (§4.1): F-V3/F-V4 livrează în aceeași rulare martorul V2, ținta și geamănul; controalele
 * livrează ținta și geamănul. Martorul e verificat individual (o înregistrare, direcție și sume exacte, o linie);
 * geamănul nu e trimis; zero LP; zero swapuri pe alte chei; totalul = suma componentelor coloanei.
 *
 * NU importă nimic din `src/`.
 */

import { HarnessError, waitUntil, withDeadline } from "../harness/observers";
import type { CaseContext, CaseBodyResult, ScopedKind } from "../harness/caseRuntime";
import type { CaseKind, CaseSection, Outcome } from "../harness/caseProtocol";
import type { CapturedRequest, LogFilter, NodeSubscription, RpcLog } from "../harness/localNode";
import type { TimerRecord } from "../harness/observers";
import type { FetchOp } from "../harness/netGuard";
import {
  URL_TRENDING_1, URL_TRENDING_2, URL_NEW_POOLS, URL_DS_BOOSTED, urlGeckoPool, urlDsTokenPairs, urlGoPlus,
  GOPLUS_EMPTY_BODY, PRICE_ETH, EXPECTED_BUY, V2_TOPICS0, V3_TOPICS0, V4_TOPICS0, V4_POOL_MANAGER_BASE,
  A2_TARGET_V3, A2_TARGET_V4, A2_WITNESS_V2, A2_FILLER_V3, TOKEN_TARGET, TOKEN_WITNESS,
  SYM_TARGET, SYM_WITNESS, POOL_TARGET_V3, POOL_TARGET_V4, POOL_WITNESS_V2, POOL_FILLER_V3,
  SWAP_TARGET_V3, TWIN_TARGET_V3, SWAP_TARGET_V4, TWIN_TARGET_V4, SWAP_WITNESS_V2,
  a2DsPair, a2BoostedItem, admissionFixturesSelfCheck, type A2GeckoRaw,
} from "../harness/admissionFixtures";

// ── Tipuri ───────────────────────────────────────────────────────────────────────────────────────────────────
export const STEPS = ["scan1", "boosted", "follow", "scan2"] as const;
export type StepName = typeof STEPS[number];
export const KINDS: readonly ScopedKind[] = ["v2", "v3", "v4"];

/** O coloană a contractului de subscripții (§4.2): `null` = ABSENT; listă = ACTIV, cu mulțimea EXACTĂ de pool-uri. */
export type Column = Record<ScopedKind, string[] | null>;
export type ColumnName = "baseline" | "fix";

export interface AdmissionDef {
  id:      string;
  kind:    Extract<CaseKind, "control" | "defect">;
  section: CaseSection;
  target:  { pair: string; kind: "v3" | "v4"; raw: A2GeckoRaw; swap: RpcLog; twin: RpcLog; linePrefix: string };
  /** Martorul V2 (doar F): urmărit pe ruta reală (scan), cu un swap livrat. */
  witness: { pair: string; raw: A2GeckoRaw; swap: RpcLog; linePrefix: string } | null;
  /** Pool-urile din `trending_pools?page=1` la fiecare scan (pagina 2 și `new_pools` sunt goale). */
  scan1:   A2GeckoRaw[];
  scan2:   A2GeckoRaw[];
  /** F: ținta ajunge în follow-list prin DexScreener boosted → token-pairs. */
  boosted: boolean;
  /** `activeWatch` exact după fiecare pas (montaj): adrese pe Base; comparate ca `base:<adresă>` cu TOATE cheile. */
  watch:   Record<StepName, string[]>;
  /** Fetch-uri servite per pas, per URL exact. */
  fetches: Record<StepName, Record<string, number>>;
  /** Contractul de subscripții după ultima rundă: baseline (`f679f4b`) și după fixul M1/M2. Controale: identice. */
  columns: Record<ColumnName, Column>;
  /** Harta în care ținta trebuie să fie după `scan2`, per coloană (`null` = în nicio hartă). */
  mapAfterScan2: Record<ColumnName, "v3" | "v4" | null>;
  /** D5: ținta marcată routing-only după `scan2`. */
  routingOnly: boolean;
}

const V3 = (pair: string): AdmissionDef["target"] => ({ pair, kind: "v3", raw: POOL_TARGET_V3, swap: SWAP_TARGET_V3, twin: TWIN_TARGET_V3, linePrefix: `[V3 SWAP base] ${SYM_TARGET} BUY` });
const V4 = (pair: string): AdmissionDef["target"] => ({ pair, kind: "v4", raw: POOL_TARGET_V4, swap: SWAP_TARGET_V4, twin: TWIN_TARGET_V4, linePrefix: `[V4 SWAP base] ${SYM_TARGET} BUY` });
const WITNESS: NonNullable<AdmissionDef["witness"]> = { pair: A2_WITNESS_V2, raw: POOL_WITNESS_V2, swap: SWAP_WITNESS_V2, linePrefix: `[V2 SWAP base] ${SYM_WITNESS} BUY` };

const SCAN_URLS = { [URL_TRENDING_1]: 1, [URL_TRENDING_2]: 1, [URL_NEW_POOLS]: 1 };
const same = (c: Column): Record<ColumnName, Column> => ({ baseline: c, fix: c });

/** Controlul S: ținta în trending, la ambele scanuri. */
function scanControl(id: string, target: AdmissionDef["target"]): AdmissionDef {
  const col: Column = { v2: null, v3: target.kind === "v3" ? [target.pair] : null, v4: target.kind === "v4" ? [target.pair] : null };
  return {
    id, kind: "control", section: "filter", target, witness: null,
    scan1: [target.raw, POOL_FILLER_V3], scan2: [target.raw, POOL_FILLER_V3], boosted: false,
    watch: { scan1: [target.pair], boosted: [target.pair], follow: [target.pair], scan2: [target.pair] },
    fetches: {
      scan1: { ...SCAN_URLS, [urlGoPlus(TOKEN_TARGET)]: 1 }, boosted: { [URL_DS_BOOSTED]: 1 }, follow: {}, scan2: { ...SCAN_URLS },
    },
    columns: same(col), mapAfterScan2: { baseline: target.kind, fix: target.kind }, routingOnly: false,
  };
}

/** Cazul F: ținta absentă din trending; ajunge în follow-list prin boosted și în watch prin follow-refresh. */
function followDefect(id: string, target: AdmissionDef["target"]): AdmissionDef {
  const baseline: Column = target.kind === "v3"
    ? { v2: [A2_WITNESS_V2, target.pair], v3: null, v4: null }
    : { v2: [A2_WITNESS_V2], v3: null, v4: null };   // poolId-ul eliminat de `length === 42` din V2 și absent din V4
  const fix: Column = target.kind === "v3"
    ? { v2: [A2_WITNESS_V2], v3: [target.pair], v4: null }
    : { v2: [A2_WITNESS_V2], v3: null, v4: [target.pair] };
  return {
    id, kind: "defect", section: "filter", target, witness: WITNESS,
    scan1: [POOL_WITNESS_V2, POOL_FILLER_V3], scan2: [POOL_WITNESS_V2, POOL_FILLER_V3], boosted: true,
    watch: { scan1: [A2_WITNESS_V2], boosted: [A2_WITNESS_V2], follow: [A2_WITNESS_V2, target.pair], scan2: [A2_WITNESS_V2, target.pair] },
    fetches: {
      scan1:   { ...SCAN_URLS, [urlGoPlus(TOKEN_WITNESS)]: 1 },
      boosted: { [URL_DS_BOOSTED]: 1, [urlDsTokenPairs(TOKEN_TARGET)]: 1 },
      follow:  { [urlGeckoPool(target.pair)]: 1, [urlGoPlus(TOKEN_TARGET)]: 1 },
      scan2:   { ...SCAN_URLS },
    },
    columns: { baseline, fix }, mapAfterScan2: { baseline: null, fix: target.kind }, routingOnly: false,
  };
}

export const ADMISSION_DEFS: Record<string, AdmissionDef> = {
  "A2-S-V3": scanControl("A2-S-V3", V3(A2_TARGET_V3)),
  "A2-S-V4": scanControl("A2-S-V4", V4(A2_TARGET_V4)),
  "A2-D5": {
    ...scanControl("A2-D5", V3(A2_TARGET_V3)),
    id: "A2-D5",
    // Al doilea scan e NEVID (umplutura, care nu intră în watch), cu ținta ABSENTĂ: altfel produsul păstrează hărțile
    // fără rebuild („Keeping previous V3/V4 maps”) și marcarea routing-only nu ar fi demonstrată.
    scan2: [POOL_FILLER_V3],
    routingOnly: true,
  },
  "A2-F-V3": followDefect("A2-F-V3", V3(A2_TARGET_V3)),
  "A2-F-V4": followDefect("A2-F-V4", V4(A2_TARGET_V4)),
};
export const ADMISSION_IDS = ["A2-S-V3", "A2-S-V4", "A2-D5", "A2-F-V3", "A2-F-V4"] as const;

/** Coerența definițiilor (pură). Întoarce lista problemelor. */
export function admissionDefsSelfCheck(): string[] {
  const p = [...admissionFixturesSelfCheck()];
  const addrOf = (r: A2GeckoRaw): string => String(r.attributes.address);
  for (const id of ADMISSION_IDS) {
    const d = ADMISSION_DEFS[id];
    if (!d || d.id !== id) { p.push(`definiție lipsă sau cu id greșit: ${id}`); continue; }
    if (d.scan1.length === 0 || d.scan2.length === 0) p.push(`${id}: un scan gol nu reconstruiește hărțile`);
    if (!d.scan2.some(r => addrOf(r) === A2_FILLER_V3)) p.push(`${id}: al doilea scan fără umplutură`);
    const inScan2 = d.scan2.some(r => addrOf(r) === d.target.pair);
    if (d.routingOnly && inScan2) p.push(`${id}: D5 cere ținta ABSENTĂ din al doilea scan`);
    if (d.boosted && (inScan2 || d.scan1.some(r => addrOf(r) === d.target.pair))) p.push(`${id}: ținta F nu are voie să fie în trending`);
    if (d.kind === "control" && JSON.stringify(d.columns.baseline) !== JSON.stringify(d.columns.fix)) p.push(`${id}: un control are aceeași predicție în ambele coloane`);
    if (d.kind === "defect" && JSON.stringify(d.columns.baseline) === JSON.stringify(d.columns.fix)) p.push(`${id}: un defect are coloane diferite`);
    if ((d.kind === "defect") !== (d.witness !== null)) p.push(`${id}: martorul există exact la cazurile de defect`);
    for (const w of Object.values(d.watch)) if (w.includes(A2_FILLER_V3)) p.push(`${id}: umplutura nu intră în watch`);
  }
  return p;
}

// ── Utilitare ────────────────────────────────────────────────────────────────────────────────────────────────
const STEP_DEADLINE_MS = 30_000;
const SETTLE_DEADLINE_MS = 5_000;
const ROUND_DELAYS = [500, 800, 1_100];
const OTHER_PAIR_GUARD = "(alte chei)";
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
const lc = (s: string): string => s.toLowerCase();
const sameSet = (a: string[], b: string[]): boolean => {
  const A = new Set(a.map(lc)), B = new Set(b.map(lc));
  return A.size === a.length && A.size === B.size && [...A].every(x => B.has(x));
};
const short = (a: string): string => a.slice(0, 6) + "…" + a.slice(-4);

/** Tipul unei subscripții (filtru capturat de nod), după forma produsului; `null` = formă necunoscută. */
function kindOfFilter(f: LogFilter): ScopedKind | null {
  if (typeof f.address === "string" && lc(f.address) === lc(V4_POOL_MANAGER_BASE)) return "v4";
  const t0 = Array.isArray(f.topics) ? f.topics[0] : undefined;
  const first = Array.isArray(t0) ? t0[0] : t0;
  if (typeof first !== "string") return null;
  if (lc(first) === lc(V2_TOPICS0[0])) return "v2";
  if (lc(first) === lc(V3_TOPICS0[0])) return "v3";
  return null;
}
/** Pool-urile acoperite de un filtru: V2/V3 = `address`; V4 = `topics[1]`. */
function poolsOfFilter(kind: ScopedKind, f: LogFilter): string[] {
  if (kind === "v4") { const t1 = f.topics?.[1]; return Array.isArray(t1) ? [...t1] : typeof t1 === "string" ? [t1] : []; }
  return Array.isArray(f.address) ? [...f.address] : typeof f.address === "string" ? [f.address] : [];
}
function topics0Of(f: LogFilter): string[] {
  const t0 = f.topics?.[0];
  return Array.isArray(t0) ? [...t0] : typeof t0 === "string" ? [t0] : [];
}
function filterOfRequest(r: CapturedRequest): LogFilter | null {
  const p = r.params as unknown[] | undefined;
  return Array.isArray(p) && p[0] === "logs" && typeof p[1] === "object" && p[1] !== null ? p[1] as LogFilter : null;
}

interface SubsState {
  problems: string[];
  status:   Record<ScopedKind, "ACTIV" | "ABSENT">;
  /** Pool-urile din filtrul ACTIV la nod (ordinea cererii), pe tip. */
  pools:    Record<ScopedKind, string[] | null>;
  topics0:  Record<ScopedKind, string[] | null>;
  unsubscribes: number;
}

/** §3.1.3: citește punctul fix al subscripțiilor; `problems` gol = coerent. */
function readSubs(ctx: CaseContext): SubsState {
  const st = ctx.src.stores.scopedSubStore;
  const subs = ctx.node.subscriptions();
  const reqs = ctx.node.requests();
  const problems: string[] = [];
  const status = { v2: "ABSENT", v3: "ABSENT", v4: "ABSENT" } as SubsState["status"];
  const pools: SubsState["pools"] = { v2: null, v3: null, v4: null };
  const topics0: SubsState["topics0"] = { v2: null, v3: null, v4: null };
  if (st.pending.size !== 0) problems.push(`cereri rămase în pending: ${[...st.pending.entries()].map(([id, p]) => `#${id} ${p.key}`).join(", ")}`);
  if (st.latestReq.size !== 0) problems.push(`latestReq nevid: ${[...st.latestReq.keys()].join(", ")}`);
  for (const key of st.active.keys()) if (!KINDS.some(k => key === `base:${k}`)) problems.push(`intrare activă necunoscută în worker: ${key}`);
  const subKind = new Map<string, ScopedKind | null>();
  for (const s of subs) {
    const k = kindOfFilter(s.filter);
    subKind.set(s.subId, k);
    if (k === null && s.active) problems.push(`subscripție activă la nod cu formă necunoscută: ${s.subId}`);
  }
  for (const k of KINDS) {
    const active = st.active.get(`base:${k}`);
    const nodeActive = subs.filter(s => s.active && subKind.get(s.subId) === k);
    const lastReq = reqs.filter(r => r.method === "eth_subscribe" && r.subId !== null && subKind.get(r.subId) === k).pop();
    if (active) {
      status[k] = "ACTIV";
      const n: NodeSubscription | undefined = nodeActive.find(s => s.subId === active.subId);
      if (!n) { problems.push(`${k}: intrarea activă din worker (${active.subId}) nu e activă la nod`); continue; }
      if (nodeActive.length !== 1) problems.push(`${k}: ${nodeActive.length} subscripții active la nod (se cere una — cea veche nedezabonată)`);
      if (!lastReq || lastReq.subId !== active.subId) problems.push(`${k}: subscripția confirmată nu e ultima cerere a tipului`);
      const ps = poolsOfFilter(k, n.filter);
      if (ps.join(",") !== active.snapshot) problems.push(`${k}: filtrul activ la nod (${ps.length} pool-uri) ≠ instantaneul confirmat în worker`);
      pools[k] = ps; topics0[k] = topics0Of(n.filter);
    } else if (nodeActive.length !== 0) {
      problems.push(`${k}: ${nodeActive.length} subscripție(i) activă(e) la nod fără intrare activă în worker (subscripție veche nedezabonată)`);
    }
  }
  const unsubs = reqs.filter(r => r.method === "eth_unsubscribe");
  for (const u of unsubs) {
    const target = Array.isArray(u.params) ? (u.params as unknown[])[0] : undefined;
    const s = subs.find(x => x.subId === target);
    if (!s || s.active) problems.push(`dezabonare neconfirmată de nod: ${String(target)}`);
  }
  return { problems, status, pools, topics0, unsubscribes: unsubs.length };
}

interface StepObservation {
  rounds: number;
  /** Operații `fetch` cu corpul încă necitit în momentul în care funcția pasului a returnat (bariera le-a așteptat). */
  fetchInFlightAtReturn: number;
  roundNote: string;
  fetches: Record<string, number>;
  status: SubsState["status"];
  pools: SubsState["pools"];
  unsubscribes: number;
  watch: string[];
  v3Map: string[];
  v4Map: string[];
  routingOnly: string[];
  followList: string[];
}

/** §3.1.1–§3.1.3 pentru un pas. Aruncă `HarnessError` cu motivul exact. */
async function settleStep(ctx: CaseContext, step: StepName): Promise<{ rounds: number; subs: SubsState }> {
  const phase = `step:${step}`;
  const mine = (): TimerRecord[] => ctx.timers.records().filter(t => t.phase === phase);
  const live = (): TimerRecord[] => mine().filter(t => t.state === "pending" || t.state === "running" || t.inFlight > 0);
  try {
    await waitUntil(() => live().length === 0, SETTLE_DEADLINE_MS, `timerele pasului ${step}`);
  } catch {
    throw new HarnessError(`barieră ${step}: timere neîncheiate la termen (activeJobCount nu e criteriu): `
      + live().map(t => `#${t.id} ${t.kind} ${t.delayMs}ms stare=${t.state} fires=${t.fires} inFlight=${t.inFlight}`).join(", "));
  }
  // rev2 (cgpt P2): operațiile `fetch` terminate = corpul fiecărui răspuns citit complet. NU prin timere.
  const flying = (): FetchOp[] => ctx.net.fetchOps().filter(fetchInFlight);
  try {
    await waitUntil(() => flying().length === 0, SETTLE_DEADLINE_MS, `fetch-urile pasului ${step}`);
  } catch {
    throw new HarnessError(`barieră ${step}: fetch în zbor la termen (timerele pasului sunt încheiate — nu sunt criteriu): `
      + flying().map(o => `#${o.seq} ${o.url} corp=${o.body}`).join(", "));
  }
  // §3.1.1: rundele = triplete CONSECUTIVE 500/800/1100 (create sincron de `requestImmediateScopedSubscribe`).
  const timers = mine().filter(t => t.kind === "timeout").sort((a, b) => a.id - b.id);
  const inRound = new Set<number>();
  let rounds = 0;
  for (let i = 0; i + 2 < timers.length; i++) {
    const [a, b, c] = [timers[i], timers[i + 1], timers[i + 2]];
    if (a.delayMs === 500 && b.delayMs === 800 && c.delayMs === 1_100 && b.id === a.id + 1 && c.id === a.id + 2) {
      rounds++; inRound.add(a.id); inRound.add(b.id); inRound.add(c.id); i += 2;
    }
  }
  const stray = timers.filter(t => ROUND_DELAYS.includes(t.delayMs) && !inRound.has(t.id));
  if (stray.length > 0) {
    throw new HarnessError(`barieră ${step}: rundă de reabonare parțială — ${stray.length} timer(e) ${stray.map(t => `${t.delayMs}ms`).join("/")} în afara unui triplet complet 500/800/1100`);
  }
  const faults = ctx.timers.faults();
  for (const t of timers.filter(x => inRound.has(x.id))) {
    const f = faults.find(x => x.timerId === t.id);
    if (f || t.state !== "done" || t.fires !== 1 || t.inFlight !== 0) {
      throw new HarnessError(`barieră ${step}: timerul rundei #${t.id} (${t.delayMs}ms) nu a rulat complet: stare=${t.state} fires=${t.fires} inFlight=${t.inFlight}${f ? ` eroare=${f.message}` : ""}`);
    }
  }
  // §3.1.3: punctul fix al subscripțiilor, apoi confirmarea că nu se mai mișcă.
  let last = readSubs(ctx);
  try {
    await waitUntil(() => { last = readSubs(ctx); return last.problems.length === 0; }, SETTLE_DEADLINE_MS, `subscripțiile după ${step}`);
  } catch {
    throw new HarnessError(`barieră ${step}: subscripțiile nu ajung la o stare coerentă: ${last.problems.join("; ")}`);
  }
  await ctx.clientBarrier(`A2-${step}-client`);
  await ctx.deliver([], `A2-${step}-nod`);
  const again = readSubs(ctx);
  if (again.problems.length > 0 || JSON.stringify(again.pools) !== JSON.stringify(last.pools)) {
    throw new HarnessError(`barieră ${step}: starea subscripțiilor s-a schimbat după confirmare: ${again.problems.join("; ") || "alt conținut"}`);
  }
  return { rounds, subs: again };
}

function setStepFixtures(def: AdmissionDef, step: StepName, ctx: CaseContext): void {
  const json = (v: unknown): { status: number; body: string } => ({ status: 200, body: JSON.stringify(v) });
  const set = (url: string, fx: { status: number; body: string }): void => { ctx.net.setFetchFixture(url, fx); };
  if (step === "scan1" || step === "scan2") {
    set(URL_TRENDING_1, json({ data: step === "scan1" ? def.scan1 : def.scan2 }));
    set(URL_TRENDING_2, json({ data: [] }));
    set(URL_NEW_POOLS, json({ data: [] }));
    set(urlGoPlus(TOKEN_TARGET), { status: 200, body: GOPLUS_EMPTY_BODY });
    set(urlGoPlus(TOKEN_WITNESS), { status: 200, body: GOPLUS_EMPTY_BODY });
  }
  if (step === "boosted") {
    set(URL_DS_BOOSTED, json(def.boosted ? [a2BoostedItem(TOKEN_TARGET)] : []));
    if (def.boosted) {
      const dexId = String((def.target.raw.relationships.dex as { data: { id: string } }).data.id);
      set(urlDsTokenPairs(TOKEN_TARGET), json([a2DsPair(def.target.pair, dexId, TOKEN_TARGET, SYM_TARGET)]));
    }
  }
  if (step === "follow" && def.boosted) {
    set(urlGeckoPool(def.target.pair), json({ data: def.target.raw }));
    set(urlGoPlus(TOKEN_TARGET), { status: 200, body: GOPLUS_EMPTY_BODY });
  }
}

/**
 * rev2 (cgpt P1): identitatea COMPLETĂ a unei intrări — `chain:adresă` (adresa în litere mici). Un pool urmărit pe alt
 * chain nu poate trece drept pool urmărit pe Base.
 */
export const pairKeys = (m: { entries(): Iterable<[{ chain: string; address: string }, unknown]> }): string[] =>
  [...m.entries()].map(([k]) => `${k.chain}:${lc(k.address)}`);
export const baseKey = (addr: string): string => `base:${lc(addr)}`;
const shortKey = (k: string): string => { const i = k.indexOf(":"); return `${k.slice(0, i)}:${short(k.slice(i + 1))}`; };

/** rev2 (cgpt P2): operație `fetch` încă în zbor = răspuns cu corpul necitit complet. */
export const fetchInFlight = (o: FetchOp): boolean => o.body === "unread" || o.body === "reading" || o.body === "stream";

// ── Corpul ───────────────────────────────────────────────────────────────────────────────────────────────────
export async function admissionBody(def: AdmissionDef, ctx: CaseContext): Promise<CaseBodyResult> {
  const fx = admissionDefsSelfCheck();
  if (fx.length > 0) throw new Error("definiții/fixture invalide: " + fx.join("; "));
  const { src } = ctx;
  const st = src.stores;
  const scanMod = src.scan;
  if (!scanMod) throw new HarnessError("montaj: modulul pipeline/scan nu a fost încărcat");
  const pre: string[] = [];
  if (st.routingOnlyPools.size !== 0) pre.push(`routingOnlyPools=${st.routingOnlyPools.size}`);
  if (st.marketFollowList.size !== 0) pre.push(`marketFollowList=${st.marketFollowList.size}`);
  if (st.lastDsBoostedFetchAt !== 0) pre.push(`lastDsBoostedFetchAt=${st.lastDsBoostedFetchAt}`);
  if (pre.length > 0) throw new HarnessError("precondiții treapta 2: store nevid la pornire: " + pre.join(", "));

  src.nativePrice.__setNativePriceForTest("ETH", PRICE_ETH);
  await ctx.connect();
  await ctx.awaitOpenSubscribes();
  const atOpen = await ctx.clientBarrier("A2-open");
  if (atOpen.length !== 0) throw new HarnessError(`montaj: ${atOpen.length} cerere(i) de subscriere înainte de primul scan (nimic urmărit)`);

  const steps: Partial<Record<StepName, StepObservation>> = {};
  const run: Record<StepName, () => Promise<void>> = {
    scan1: () => scanMod.scan(), boosted: () => scanMod.runDsBoostedRefresh(),
    follow: () => scanMod.runFollowRefresh(), scan2: () => scanMod.scan(),
  };
  let keepingLinesBefore = 0;
  for (const step of STEPS) {
    setStepFixtures(def, step, ctx);
    const servedBefore = ctx.net.fetchServedByUrl();
    const callsBefore = ctx.net.fetchCalls(), servedTotalBefore = ctx.net.fetchServed();
    ctx.timers.setPhase(`step:${step}`);
    await withDeadline(run[step](), STEP_DEADLINE_MS, `pasul ${step}`);
    const fetchInFlightAtReturn = ctx.net.fetchOps().filter(fetchInFlight).length;
    const { rounds, subs } = await settleStep(ctx, step);

    // §3.1.4: fetch-urile pasului, exact, per URL; toate servite.
    const servedAfter = ctx.net.fetchServedByUrl();
    const delta: Record<string, number> = {};
    for (const [u, n] of Object.entries(servedAfter)) { const d = n - (servedBefore[u] ?? 0); if (d !== 0) delta[u] = d; }
    const calls = ctx.net.fetchCalls() - callsBefore, served = ctx.net.fetchServed() - servedTotalBefore;
    if (calls !== served) throw new HarnessError(`fetch ${step}: ${calls - served} apel(uri) neservite de fixture`);
    const want = def.fetches[step];
    const urls = new Set([...Object.keys(want), ...Object.keys(delta)]);
    const diff = [...urls].filter(u => (want[u] ?? 0) !== (delta[u] ?? 0)).map(u => `${u} ×${delta[u] ?? 0} (prezis ×${want[u] ?? 0})`);
    const fetchNote = diff.length > 0 ? ` (fetch: ${diff.join("; ")})` : "";

    const watch = pairKeys(st.activeWatch);
    const obs: StepObservation = {
      rounds, fetchInFlightAtReturn,
      roundNote: rounds === 0 ? "zero timere de rundă: rundă necerută sau suprimată de limitarea de 2 s" : `${rounds} rundă(e) completă(e)`,
      fetches: delta, status: subs.status, pools: subs.pools, unsubscribes: subs.unsubscribes,
      watch, v3Map: pairKeys(st.v3PoolMap), v4Map: pairKeys(st.v4PoolMap), routingOnly: pairKeys(st.routingOnlyPools),
      followList: pairKeys(st.marketFollowList),
    };
    steps[step] = obs;

    // Montaj, verificat după fiecare pas, ÎNAINTEA contorului de fetch: un pool neadmis nu mai cere GoPlus, deci
    // abaterea de fetch e o consecință; motivul raportat e cauza (montajul), cu abaterea de fetch atașată.
    const wantWatch = def.watch[step].map(baseKey);
    if (!sameSet(watch, wantWatch)) {
      throw new HarnessError(`montaj ${step}: activeWatch = [${watch.map(shortKey).join(", ")}], prezis [${wantWatch.map(shortKey).join(", ")}] (identitate chain + adresă; clasificatorul nu a ales nivelul de watch prezis)${fetchNote}`);
    }
    // rev2: admiterea țintei și a martorului, explicit pe Base, la pașii unde designul o cere.
    if (def.watch[step].includes(def.target.pair) && !st.activeWatch.has("base", def.target.pair)) throw new HarnessError(`montaj ${step}: ținta nu e urmărită pe Base${fetchNote}`);
    if (def.witness && def.watch[step].includes(def.witness.pair) && !st.activeWatch.has("base", def.witness.pair)) throw new HarnessError(`montaj ${step}: martorul nu e urmărit pe Base${fetchNote}`);
    if (step === "boosted" && def.boosted && !(st.marketFollowList.size === 1 && st.marketFollowList.has("base", def.target.pair))) {
      throw new HarnessError(`montaj boosted: ținta nu a ajuns în marketFollowList prin DexScreener boosted → token-pairs${fetchNote}`);
    }
    if (step === "scan1" || step === "scan2") {
      const keeping = ctx.cons.count("Keeping previous V3/V4 maps");
      if (keeping !== keepingLinesBefore) throw new HarnessError(`montaj ${step}: scanul a păstrat hărțile fără rebuild („Keeping previous V3/V4 maps”) — reconstruirea nu a rulat${fetchNote}`);
      keepingLinesBefore = keeping;
      if (!st.v3PoolMap.has("base", A2_FILLER_V3)) throw new HarnessError(`montaj ${step}: umplutura lipsește din v3PoolMap — reconstruirea hărților nu e dovedită${fetchNote}`);
    }
    if (diff.length > 0) throw new HarnessError(`fetch ${step}: apeluri per URL diferite de predicție: ${diff.join("; ")}`);
  }

  // ── Bariera finală: starea stabilă corespunde INTEGRAL unei coloane (doar statutul ACTIV/ABSENT) ────────────
  const fin = readSubs(ctx);
  const statusOf = (c: Column): string => KINDS.map(k => `${k} ${c[k] === null ? "ABSENT" : "ACTIV"}`).join(", ");
  const actual = KINDS.map(k => `${k} ${fin.status[k]}`).join(", ");
  const statusMatches = (["baseline", "fix"] as const).filter(c => statusOf(def.columns[c]) === actual);
  // rev3: starea finală a tuturor operațiilor `fetch` (inclusiv refuzul deliberat al controlului de gardă `g-fetch`).
  const fetchBodyStates: Record<string, number> = {};
  for (const o of ctx.net.fetchOps()) fetchBodyStates[o.body] = (fetchBodyStates[o.body] ?? 0) + 1;
  const observations: Record<string, unknown> = { steps, finalStatus: fin.status, finalPools: fin.pools, fetchBodyStates };
  if (statusMatches.length === 0) {
    throw new HarnessError(`barieră finală: starea stabilă (${actual}) nu corespunde niciunei coloane — baseline: ${statusOf(def.columns.baseline)}; după fix: ${statusOf(def.columns.fix)}`);
  }

  // ── Etapa de CONȚINUT (după barieră): mulțimile exacte și poziția 0 a filtrelor ─────────────────────────────
  const expectedTopics: Record<ScopedKind, readonly string[]> = { v2: V2_TOPICS0, v3: V3_TOPICS0, v4: V4_TOPICS0 };
  const topicProblems: string[] = [];
  for (const k of KINDS) {
    const t = fin.topics0[k];
    if (t !== null && (t.length !== expectedTopics[k].length || t.some((x, i) => lc(x) !== lc(expectedTopics[k][i])))) topicProblems.push(`${k}: poziția 0 a filtrului diferă de lista produsului`);
  }
  const contentMatches = (["baseline", "fix"] as const).filter(c => KINDS.every(k => {
    const want = def.columns[c][k], have = fin.pools[k];
    return want === null ? have === null : have !== null && sameSet(have, want);
  }));
  const fillerInFilter = KINDS.some(k => (fin.pools[k] ?? []).some(a => lc(a) === A2_FILLER_V3));
  const targetIn = KINDS.filter(k => (fin.pools[k] ?? []).some(a => lc(a) === lc(def.target.pair)));
  Object.assign(observations, { statusColumns: statusMatches, contentColumns: contentMatches, targetInFilters: targetIn, fillerInFilter });
  const contentProblem = (): string => {
    const parts: string[] = [];
    if (targetIn.length > 1) parts.push(`ținta e simultan în filtrele ${targetIn.map(k => k.toUpperCase()).join(" și ")} (amestec între coloane)`);
    if (fillerInFilter) parts.push("umplutura (nu e în watch) apare într-un filtru");
    for (const k of KINDS) {
      const have = fin.pools[k];
      if (have !== null) parts.push(`${k.toUpperCase()} = [${have.map(short).join(", ")}]`);
    }
    return `conținutul filtrelor nu corespunde niciunei coloane (detectat la etapa de conținut, după barieră): ${parts.join("; ")}`;
  };

  // ── Hărțile după scan2 ─────────────────────────────────────────────────────────────────────────────────────
  const inV3 = st.v3PoolMap.has("base", def.target.pair), inV4 = st.v4PoolMap.has("base", def.target.pair);
  const mapNow: "v3" | "v4" | "v3+v4" | null = inV3 && inV4 ? "v3+v4" : inV3 ? "v3" : inV4 ? "v4" : null;
  const routing = st.routingOnlyPools.has("base", def.target.pair);
  const mapNeverSeen = STEPS.filter(s => s === "scan1" || s === "scan2").every(s => {
    const o = steps[s] as StepObservation;
    // Pe ORICE chain: o țintă admisă într-o hartă de pe alt chain nu e „absentă” în sensul baseline-ului.
    const isTarget = (k: string): boolean => k.slice(k.indexOf(":") + 1) === lc(def.target.pair);
    return !o.v3Map.some(isTarget) && !o.v4Map.some(isTarget);
  });
  Object.assign(observations, { targetMapAfterScan2: mapNow ?? "niciuna", targetRoutingOnly: routing, targetAbsentFromMapsAfterBothScans: mapNeverSeen });

  // ── O singură livrare: (martor) + țintă + geamăn ───────────────────────────────────────────────────────────
  const logs = [...(def.witness ? [def.witness.swap] : []), def.target.swap, def.target.twin];
  const swapsBefore = [...st.wsFlow.values()].reduce((n, a) => n + a.length, 0);
  if (swapsBefore !== 0) throw new HarnessError(`montaj: ${swapsBefore} swap(uri) înregistrate înainte de livrare`);
  const d = await ctx.deliver(logs, "A2-livrare");
  const lines = ctx.cons.lines().map(l => l.text);
  const swapLinesAll = lines.filter(t => /\[V[234] SWAP [^\]]*\]/.test(t)).length;
  const lpLines = lines.filter(t => /\b(?:V3 )?LP (?:ADD|REMOVE) [^\]]*\]/.test(t)).length;
  const swapTotal = [...st.wsFlow.values()].reduce((n, a) => n + a.length, 0);
  const lpTotal = [...st.lpEvents.values()].reduce((n, a) => n + a.length, 0);
  const tEv = st.wsFlow.get("base", def.target.pair) ?? [];
  const wEv = def.witness ? st.wsFlow.get("base", def.witness.pair) ?? [] : [];
  const tLines = lines.filter(t => t.includes(def.target.linePrefix)).length;
  const wLines = def.witness ? lines.filter(t => t.includes((def.witness as NonNullable<AdmissionDef["witness"]>).linePrefix)).length : 0;
  const tD = d.perLog[def.target.swap.transactionHash], twD = d.perLog[def.target.twin.transactionHash];
  const wD = def.witness ? d.perLog[def.witness.swap.transactionHash] : null;
  const otherSwaps = swapTotal - tEv.length - wEv.length;
  Object.assign(observations, {
    delivery: { target: tD, twin: twD, witness: wD }, swapsAllKeys: swapTotal, lpEventsAllKeys: lpTotal,
    swapLinesAllChains: swapLinesAll, lpLines, targetRecorded: tEv.map(e => ({ isBuy: e.isBuy, ethAmount: e.ethAmount, usdAmount: e.usdAmount ?? null })),
    witnessRecorded: wEv.map(e => ({ isBuy: e.isBuy, ethAmount: e.ethAmount, usdAmount: e.usdAmount ?? null })),
    targetLines: tLines, witnessLines: wLines, otherSwaps,
  });
  const recordedExact = (ev: typeof tEv): boolean => ev.length === 1 && ev[0].isBuy === EXPECTED_BUY.isBuy
    && near(ev[0].ethAmount, EXPECTED_BUY.ethAmount) && typeof ev[0].usdAmount === "number" && near(ev[0].usdAmount, EXPECTED_BUY.usdAmount);

  // Gărzi comune (orice caz): geamănul nu e trimis.
  if (twD.sent !== 0) throw new HarnessError("geamănul negativ (topic străin) a fost trimis de nod");

  const result = (outcome: Outcome, reasons: string[]): CaseBodyResult => ({ outcome, reasons, observations });

  // ── Controale ──────────────────────────────────────────────────────────────────────────────────────────────
  if (def.kind === "control") {
    const r: string[] = [];
    if (topicProblems.length > 0) r.push(...topicProblems);
    if (contentMatches.length === 0) r.push(contentProblem());
    if (mapNow !== def.mapAfterScan2.baseline) r.push(`ținta după scan2: ${mapNow ?? "în nicio hartă"} (prezis ${def.mapAfterScan2.baseline}PoolMap)`);
    if (routing !== def.routingOnly) r.push(def.routingOnly ? "ținta nu e marcată routing-only după ce a dispărut din scan" : "ținta e marcată routing-only deși e în scan");
    if (tD.sent !== 1 || tD.received !== 1) r.push(`swapul țintei: trimis ${tD.sent}, primit ${tD.received} (se cere 1 și 1)`);
    if (!recordedExact(tEv)) r.push(`swapul țintei înregistrat: ${JSON.stringify(observations.targetRecorded)} (se cere exact o cumpărare de 1 ETH = 2500 USD)`);
    if (tLines !== 1 || swapLinesAll !== 1) r.push(`linii de swap: ${swapLinesAll} pe toate chain-urile, ${tLines} ale țintei (se cere 1 și 1)`);
    if (otherSwaps !== 0) r.push(`swapuri pe ${OTHER_PAIR_GUARD}: ${otherSwaps} (se cer 0)`);
    if (swapTotal !== 1) r.push(`total swapuri pe toate cheile: ${swapTotal} (se cere exact 1)`);
    if (lpTotal !== 0 || lpLines !== 0) r.push(`evenimente LP: ${lpTotal}, linii LP: ${lpLines} (se cer 0)`);
    return result(r.length > 0 ? "CONTROL_FAILED" : "CONTROL_OK", r);
  }

  // ── Defecte: martorul și totalurile întâi (fără martor, absența țintei nu înseamnă nimic) ──────────────────
  const w = def.witness as NonNullable<AdmissionDef["witness"]>;
  const wit: string[] = [];
  if (!wD || wD.sent !== 1 || wD.received !== 1) wit.push(`martorul: trimis ${wD?.sent ?? 0}, primit ${wD?.received ?? 0} (se cere 1 și 1)`);
  if (!recordedExact(wEv)) wit.push(`martorul înregistrat: ${JSON.stringify(observations.witnessRecorded)} (se cere exact o cumpărare de 1 ETH = 2500 USD)`);
  if (wLines !== 1) wit.push(`linii de swap ale martorului: ${wLines} (se cere 1)`);
  if (wit.length > 0) throw new HarnessError(`martor (${short(w.pair)}): fluxul nu e dovedit funcțional — ${wit.join("; ")}`);
  if (otherSwaps !== 0) throw new HarnessError(`swapuri pe ${OTHER_PAIR_GUARD}: ${otherSwaps} (se cer 0)`);
  if (lpTotal !== 0 || lpLines !== 0) throw new HarnessError(`evenimente LP: ${lpTotal}, linii LP: ${lpLines} (se cer 0)`);
  if (topicProblems.length > 0) throw new HarnessError(`conținut: ${topicProblems.join("; ")}`);
  if (contentMatches.length !== 1) throw new HarnessError(contentProblem());
  const col = contentMatches[0];
  if (!statusMatches.includes(col)) throw new HarnessError(`conținutul corespunde coloanei ${col}, statutul nu`);

  if (col === "baseline") {
    const r: string[] = [];
    if (!mapNeverSeen || mapNow !== null) r.push("ținta apare într-o hartă, deși filtrele corespund baseline-ului");
    if (routing) r.push("ținta e marcată routing-only");
    if (tD.sent !== 0 || tEv.length !== 0 || tLines !== 0) r.push(`ținta: trimis ${tD.sent}, înregistrat ${tEv.length}, linii ${tLines} (baseline cere 0)`);
    if (swapTotal !== 1 || swapLinesAll !== 1) r.push(`total swapuri ${swapTotal}, linii ${swapLinesAll} (baseline cere exact 1 — martorul)`);
    if (r.length > 0) throw new HarnessError(`stare baseline incoerentă: ${r.join("; ")}`);
    const where = def.target.kind === "v3"
      ? "adresa în filtrul V2, absentă din V3; swapul V3 nelivrat"
      : "poolId-ul în niciun filtru (eliminat de length === 42 din V2, absent din V4); swapul V4 nelivrat";
    return result("DEFECT_REPRODUCED", [
      `ținta a intrat în activeWatch prin runFollowRefresh, dar e absentă din ${def.target.kind}PoolMap după ambele scanuri și nemarcată routing-only; ${where}; nimic înregistrat pentru ea`,
      "martorul V2 de pe aceeași rută: exact o înregistrare, cu direcția și sumele exacte",
    ]);
  }
  const r: string[] = [];
  if (mapNow !== def.mapAfterScan2.fix) r.push(`ținta după scan2: ${mapNow ?? "în nicio hartă"} (după fix: ${def.mapAfterScan2.fix}PoolMap)`);
  if (tD.sent !== 1 || tD.received !== 1 || !recordedExact(tEv) || tLines !== 1) r.push(`ținta: trimis ${tD.sent}, primit ${tD.received}, înregistrat ${JSON.stringify(observations.targetRecorded)}, linii ${tLines}`);
  if (swapTotal !== 2 || swapLinesAll !== 2) r.push(`total swapuri ${swapTotal}, linii ${swapLinesAll} (după fix: exact 2)`);
  if (r.length > 0) throw new HarnessError(`stare „după fix” incoerentă: ${r.join("; ")}`);
  return result("DEFECT_NOT_REPRODUCED", [`ținta admisă în ${def.target.kind}PoolMap și în filtrul ${def.target.kind.toUpperCase()}; swapul ei înregistrat (comportamentul corect)`]);
}
