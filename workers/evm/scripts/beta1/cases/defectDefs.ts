/**
 * scripts/beta1/cases/defectDefs.ts — BETA-1, felia 4: definițiile și corpul CAZURILOR DE DEFECT (design §7.2–§7.7).
 *
 * Modul fără efecte la import: nu pornește niciun caz. E folosit de `defectCases.ts` (codul REAL al workerului) și
 * de controalele proprii ale runtime-ului (worker fals).
 *
 * Un caz de defect afirmă o PREDICȚIE din diagnostic (`BETA1_WS_FLOW_DIAGNOSIS.md` rev3, §4). Rezultatul:
 *   DEFECT_REPRODUCED      — toate părțile predicției s-au produs, cu barierele trecute;
 *   DEFECT_NOT_REPRODUCED  — cel puțin o parte a predicției NU s-a produs (analiză greșită sau cod schimbat);
 *   HARNESS_ERROR          — orice altceva: precondiție de montaj neîndeplinită, barieră lipsă sau expirată,
 *                            martor netrimis, eroare de handler/transport. Decis de runtime, NICIODATĂ „reprodus".
 *
 * Regula de separare, aplicată în fiecare corp:
 *   - ce ține de MONTAJ (normalizatorul a dat tipul așteptat, starea a fost pusă, forma cererii acolo unde ea nu
 *     e chiar predicția, martorul și geamănul s-au comportat cum trebuie) → `throw` ⇒ HARNESS_ERROR;
 *   - ce ține de PREDICȚIE → se adună în `failed`; listă goală ⇒ reprodus.
 *
 * „Neînregistrat" cere TOATE: nicio intrare în `wsFlow` pentru pereche, `wsFlow` gol în ansamblu și nicio linie
 * `[Vx SWAP base]` în consolă. Un `wsFlow` gol contează numai după barierele 5.1–5.3 (runtime).
 *
 * PRECONDIȚIE DECLARATĂ (treapta 1): prezența sau absența din `v3PoolMap` / `v4PoolMap` e pusă de CAZ. Admiterea
 * reală (`scan()` / `runFollowRefresh()`) ține de treapta 2 și NU e exercitată aici.
 *
 * Secțiuni de raport, care nu se amestecă: `filter` (prin filtrul nodului local), `forced` (livrare forțată: nu
 * dovedește nimic despre filtru sau despre un nod real), `partial` (X1: fără conectarea workerului și fără
 * subscriere; runtime-ul pornește totuși nodul local, ca pentru orice caz).
 */

import type { CaseContext, CaseBodyResult, ScopedKind } from "../harness/caseRuntime";
import type { CaseKind, CaseSection } from "../harness/caseProtocol";
import type { RpcLog, CapturedRequest } from "../harness/localNode";
import {
  WETH_BASE, V4_POOL_MANAGER_BASE, POOL_V3, POOL_V4_ID, T_SWAP_V2, T_SWAP_V3, T_SWAP_V4, E18,
  geckoPool, swapV2Log, fixturesSelfCheck, type GeckoPoolRaw,
} from "../harness/evmFixtures";
import {
  POOL_D1, POOL_PANCAKE_V3, POOL_AERO_V2, POOL_INDEXED, T_SWAP_PANCAKE_V3, T_SWAP_SOLIDLY, T_MINT_V3, D1_SWAP, D1_TWIN,
  dsPair, indexedPair, swapPancakeV3Log, swapSolidlyLog, mintV3Log, defectFixturesSelfCheck, type DsPairRaw,
} from "../harness/evmFixturesDefects";
import { CONTROLS } from "./controlDefs";

/** Un log oferit prin filtru și rolul lui în caz. */
export interface Offered {
  log: RpcLog;
  /**
   * subject = logul despre care e predicția;
   * witness = log care TREBUIE trimis și primit (dovedește că subscripția livrează în acest proces) și care, prin
   *           construcție, nu înregistrează nimic;
   * twin    = log cu topic străin care NU trebuie trimis (dovedește că filtrul chiar filtrează).
   */
  role: "subject" | "witness" | "twin";
  /** De câte ori trebuie să-l trimită nodul. Pentru `subject` e predicție; pentru celelalte e montaj. */
  expectSent: 0 | 1;
}

interface CommonDef {
  kind:          CaseKind;
  section:       CaseSection;
  /** Paragraful din diagnostic pe care îl exercită. */
  diagnosis:     string;
  /** Controlul pozitiv cu care face pereche (același traseu, fără defect). */
  pairedControl: string;
  /** Predicția, în cuvinte — ajunge în observații. */
  prediction:    string;
}

/** Pool urmărit → subscriere pe traseul real → loguri oferite prin filtru și/sau forțate. */
export interface DeliverDef extends CommonDef {
  shape:   "deliver";
  source:  "gecko" | "dexscreener";
  raw:     GeckoPoolRaw | DsPairRaw;
  pair:    string;
  /** Tipul pe care TREBUIE să-l dea normalizatorul (montaj). */
  dexType: "V2" | "V3" | "V4";
  /** Harta în care cazul pune pool-ul; `null` = nepus (pentru V3/V4, asta e chiar condiția defectului). */
  admit:   "v3" | "v4" | null;
  priceEth: number | null;
  /** Subscripția pe care se așteaptă pool-ul. */
  subKind: ScopedKind;
  /** `true` = ruta (pe ce subscripție ajunge pool-ul) e chiar predicția; `false` = e montaj. */
  routeIsPrediction: boolean;
  /** Topicuri care TREBUIE să fie în poziția 0 a filtrului (montaj). */
  requiredTopics: string[];
  /** Topicuri care, conform predicției, LIPSESC din poziția 0 a filtrului. */
  absentTopics:   string[];
  offered: Offered[];
  /** Loguri trimise ocolind filtrul (doar în secțiunea `forced`). */
  forced:  RpcLog[];
}

/** Pool urmărit care, conform predicției, nu apare în NICIO cerere. */
export interface NoRequestDef extends CommonDef {
  shape: "no-request";
  raw:   GeckoPoolRaw;
  pair:  string;
  dexType: "V4";
  priceEth: number;
  /** Log oferit după barieră: fără nicio subscripție, nu poate fi trimis. */
  subject: RpcLog;
}

/** Observație parțială, fără conectarea workerului și fără subscriere (nodul local pornește, dar nu e folosit). */
export interface PartialDef extends CommonDef {
  shape: "partial";
  dexId: string;
  /** Un `dexId` care TREBUIE să fie admis — controlul din interiorul observației. */
  admittedDexId: string;
  notVerified: string;
}

export type DefectDef = DeliverDef | NoRequestDef | PartialDef;

const PRICE = 2_500;
const C_V3_BUY = CONTROLS["C-V3-BUY"];
const C_V4_BUY = CONTROLS["C-V4-BUY"];

/** Martor pe ruta V2: `Swap` Uniswap V2 cu ambele sume de intrare zero — trece de filtru, e ignorat de handler. */
const v2Witness = (pool: string, n: number): RpcLog =>
  swapV2Log(pool, { amount0In: 0n, amount1In: 0n, amount0Out: 0n, amount1Out: 0n }, n);

const PANCAKE_SWAP = swapPancakeV3Log(POOL_PANCAKE_V3, { amount0: E18, amount1: -5n * E18 }, 0x7101);
const PANCAKE_MINT = mintV3Log(POOL_PANCAKE_V3, { amount0: 2n * E18, amount1: 10n * E18 }, 0x7102);
const SOLIDLY_SWAP = swapSolidlyLog(POOL_AERO_V2, { amount0In: E18, amount1In: 0n, amount0Out: 0n, amount1Out: 5n * E18 }, 0x7201);

const M1_MONTAGE = {
  shape: "deliver" as const, source: "gecko" as const,
  raw: geckoPool(POOL_V3, "uniswap-v3-base", WETH_BASE, "WETH"), pair: POOL_V3, dexType: "V3" as const,
  admit: null, priceEth: PRICE, subKind: "v2" as const, requiredTopics: [T_SWAP_V2], absentTopics: [],
};
const T1_MONTAGE = {
  shape: "deliver" as const, source: "gecko" as const,
  raw: geckoPool(POOL_PANCAKE_V3, "pancakeswap-v3-base", WETH_BASE, "WETH"), pair: POOL_PANCAKE_V3, dexType: "V3" as const,
  admit: "v3" as const, priceEth: PRICE, subKind: "v3" as const, requiredTopics: [T_SWAP_V3],
};

export const DEFECTS: Record<string, DefectDef> = {
  // ── §7.2 Hărți lipsă (diagnostic §4.2) ─────────────────────────────────────────────────────────────────────
  "M1": {
    ...M1_MONTAGE, kind: "defect", section: "filter", diagnosis: "§4.2", pairedControl: "C-V3-BUY",
    prediction: "pool V3 urmărit dar nepus în v3PoolMap: adresa apare în cererea V2 și în nicio cerere V3; swapul V3 nu e trimis; nimic înregistrat",
    routeIsPrediction: true,
    offered: [
      { log: v2Witness(POOL_V3, 0x6101), role: "witness", expectSent: 1 },
      { log: C_V3_BUY.swap, role: "subject", expectSent: 0 },   // ACELAȘI log pe care C-V3-BUY îl înregistrează
    ],
    forced: [],
  },
  "M2": {
    shape: "no-request", kind: "defect", section: "filter", diagnosis: "§4.2", pairedControl: "C-V4-BUY",
    prediction: "poolId V4 urmărit dar nepus în v4PoolMap: nu apare în nicio cerere eth_subscribe; swapul V4 nu poate fi trimis; nimic înregistrat",
    raw: geckoPool(POOL_V4_ID, "uniswap-v4-base", WETH_BASE, "WETH"), pair: POOL_V4_ID, dexType: "V4", priceEth: PRICE,
    subject: C_V4_BUY.swap,                                      // ACELAȘI log pe care C-V4-BUY îl înregistrează
  },

  // ── §7.3 Metadata DexScreener (diagnostic §4.5) ────────────────────────────────────────────────────────────
  "D1": {
    shape: "deliver", kind: "defect", section: "filter", diagnosis: "§4.5", pairedControl: "D1-CONTROL",
    prediction: "pool V2 cu metadate din normalizatorul DexScreener: swapul e trimis și primit, dar NU e înregistrat",
    source: "dexscreener", raw: dsPair(POOL_D1, "uniswap"), pair: POOL_D1, dexType: "V2",
    admit: null, priceEth: PRICE, subKind: "v2", routeIsPrediction: false,
    requiredTopics: [T_SWAP_V2], absentTopics: [],
    offered: [
      { log: D1_TWIN, role: "twin", expectSent: 0 },
      { log: D1_SWAP, role: "subject", expectSent: 1 },         // ACELAȘI log pe care D1-CONTROL îl înregistrează
    ],
    forced: [],
  },

  // ── §7.4 Topicuri per DEX (diagnostic §4.4) ────────────────────────────────────────────────────────────────
  "T1": {
    ...T1_MONTAGE, kind: "defect", section: "filter", diagnosis: "§4.4", pairedControl: "C-V3-BUY",
    prediction: "pool PancakeSwap V3 pe subscripția V3: topicul Swap PancakeSwap V3 lipsește din filtru; swapul nu e trimis; nimic înregistrat",
    routeIsPrediction: false, absentTopics: [T_SWAP_PANCAKE_V3],
    offered: [{ log: PANCAKE_SWAP, role: "subject", expectSent: 0 }],
    forced: [],
  },
  "T1-LP": {
    ...T1_MONTAGE, kind: "defect", section: "filter", diagnosis: "§4.4", pairedControl: "C-V3-BUY",
    prediction: "același pool PancakeSwap V3: un log Mint e trimis și primit (log LP sosit), fără niciun swap înregistrat",
    routeIsPrediction: false, requiredTopics: [T_SWAP_V3, T_MINT_V3], absentTopics: [T_SWAP_PANCAKE_V3],
    offered: [{ log: PANCAKE_MINT, role: "subject", expectSent: 1 }],
    forced: [],
  },
  "T2": {
    shape: "deliver", kind: "defect", section: "filter", diagnosis: "§4.4", pairedControl: "C-V2-BUY",
    prediction: "pool Aerodrome clasic pe ruta V2: topicul Swap Solidly lipsește din filtru; swapul nu e trimis; nimic înregistrat",
    source: "gecko", raw: geckoPool(POOL_AERO_V2, "aerodrome-base", WETH_BASE, "WETH"), pair: POOL_AERO_V2, dexType: "V2",
    admit: null, priceEth: PRICE, subKind: "v2", routeIsPrediction: false,
    requiredTopics: [T_SWAP_V2], absentTopics: [T_SWAP_SOLIDLY],
    offered: [
      { log: v2Witness(POOL_AERO_V2, 0x6201), role: "witness", expectSent: 1 },
      { log: SOLIDLY_SWAP, role: "subject", expectSent: 0 },
    ],
    forced: [],
  },

  // ── §7.5 Preț absent (diagnostic §4.1) ─────────────────────────────────────────────────────────────────────
  "P1": {
    shape: "deliver", kind: "defect", section: "filter", diagnosis: "§4.1", pairedControl: "P1-CONTROL",
    prediction: "montajul C-V3-BUY cu prețul ETH absent (null): swapul e trimis și primit, dar NU e înregistrat",
    source: "gecko", raw: C_V3_BUY.raw, pair: C_V3_BUY.pair, dexType: "V3",
    admit: "v3", priceEth: null, subKind: "v3", routeIsPrediction: false,
    requiredTopics: [T_SWAP_V3], absentTopics: [],
    offered: [
      { log: C_V3_BUY.twin, role: "twin", expectSent: 0 },
      { log: C_V3_BUY.swap, role: "subject", expectSent: 1 },   // ACELAȘI log pe care P1-CONTROL îl înregistrează
    ],
    forced: [],
  },

  // ── §7.6 Livrare forțată — secțiune separată ───────────────────────────────────────────────────────────────
  "M1-FORCED": {
    ...M1_MONTAGE, kind: "defect", section: "forced", diagnosis: "§4.2", pairedControl: "C-V3-BUY",
    prediction: "montajul M1, cu swapul V3 trimis OCOLIND filtrul: e primit și procesat, dar NU e înregistrat",
    routeIsPrediction: false, offered: [], forced: [C_V3_BUY.swap],
  },
  "T1-FORCED": {
    ...T1_MONTAGE, kind: "defect", section: "forced", diagnosis: "§4.4", pairedControl: "C-V3-BUY",
    prediction: "montajul T1, cu swapul PancakeSwap V3 trimis OCOLIND filtrul: e primit și procesat, dar NU e înregistrat",
    routeIsPrediction: false, absentTopics: [T_SWAP_PANCAKE_V3], offered: [], forced: [PANCAKE_SWAP],
  },

  // ── §7.7 Observație parțială — secțiune separată ───────────────────────────────────────────────────────────
  "X1": {
    shape: "partial", kind: "partial", section: "partial", diagnosis: "§4.3", pairedControl: "(niciunul: fără conectarea workerului)",
    prediction: "toSourcePool pe o pereche din indexer cu dexId pancakeswap-v3 dă dexType V3, iar V3_DEXES nu conține acel dexId",
    dexId: "pancakeswap-v3", admittedDexId: "uniswap-v3",
    notVerified: "condiția din scan.ts L125 și admiterea în v3PoolMap; nu conectează workerul, nu se abonează și nu trece prin scan(); nu e dovadă cap-coadă și nu se adună la defectele reproduse",
  },
};

export const DEFECT_IDS = Object.keys(DEFECTS);

// ── Unelte comune ────────────────────────────────────────────────────────────────────────────────────────────
interface SubShape { kind: ScopedKind | null; addresses: string[]; topics0: string[]; topics1: string[]; }

const lowerList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(x => x.toLowerCase()) : [];

/** Forma unei cereri `eth_subscribe`, citită DOAR din ce a capturat nodul. `kind: null` = formă nerecunoscută. */
function subShape(req: CapturedRequest): SubShape {
  const none: SubShape = { kind: null, addresses: [], topics0: [], topics1: [] };
  const p = req.params;
  if (!Array.isArray(p) || p[0] !== "logs" || typeof p[1] !== "object" || p[1] === null) return none;
  const f = p[1] as { address?: unknown; topics?: unknown };
  const topics = Array.isArray(f.topics) ? f.topics : [];
  const topics0 = lowerList(topics[0]);
  const topics1 = lowerList(topics[1]);
  if (typeof f.address === "string") {
    const a = f.address.toLowerCase();
    return { kind: a === V4_POOL_MANAGER_BASE && topics0.includes(T_SWAP_V4) ? "v4" : null, addresses: [a], topics0, topics1 };
  }
  const addresses = lowerList(f.address);
  const kind: ScopedKind | null = topics0.includes(T_SWAP_V3) ? "v3" : topics0.includes(T_SWAP_V2) ? "v2" : null;
  return { kind, addresses, topics0, topics1 };
}

const carries = (s: SubShape, pair: string): boolean => s.addresses.includes(pair) || s.topics1.includes(pair);

function checkFixtures(): void {
  const fx = [...fixturesSelfCheck(), ...defectFixturesSelfCheck()];
  if (fx.length > 0) throw new Error("fixture invalide: " + fx.join("; "));
}

const failedOutcome = (kind: CaseKind): "DEFECT_NOT_REPRODUCED" | "PARTIAL_NOT_OBSERVED" =>
  kind === "partial" ? "PARTIAL_NOT_OBSERVED" : "DEFECT_NOT_REPRODUCED";
const heldOutcome = (kind: CaseKind): "DEFECT_REPRODUCED" | "PARTIAL_OBSERVED" =>
  kind === "partial" ? "PARTIAL_OBSERVED" : "DEFECT_REPRODUCED";

function verdict(def: CommonDef, failed: string[], observations: Record<string, unknown>): CaseBodyResult {
  if (def.kind !== "defect" && def.kind !== "partial") throw new Error("definiție de defect cu fel neașteptat");
  return failed.length === 0
    ? { outcome: heldOutcome(def.kind), reasons: [], observations }
    : { outcome: failedOutcome(def.kind), reasons: failed.map(f => "predicție neîndeplinită: " + f), observations };
}

/** Ce a rămas înregistrat ca swap, citit din starea workerului și din consolă. */
function recordedState(ctx: CaseContext, pair: string): { forPair: number; flowPairs: number; swapLines: number } {
  const st = ctx.src.stores;
  return {
    forPair:   st.wsFlow.get(ctx.chain.id, pair)?.length ?? 0,
    flowPairs: st.wsFlow.size,
    swapLines: ctx.cons.count(` SWAP ${ctx.chain.id}] `),
  };
}

// ── Corpul: pool urmărit → subscriere reală → livrare ────────────────────────────────────────────────────────
async function deliverBody(def: DeliverDef, ctx: CaseContext): Promise<CaseBodyResult> {
  const { src, chain } = ctx;
  const st = src.stores;
  if ((def.section === "forced") !== (def.forced.length > 0)) throw new Error("livrarea forțată se folosește doar în secțiunea «forced», și acolo obligatoriu");
  if (def.section === "forced" && def.offered.length > 0) throw new Error("un caz forțat nu oferă loguri prin filtru");

  // ── Stare, prin funcțiile de producție ───────────────────────────────────────────────────────────────────
  src.nativePrice.__setNativePriceForTest("ETH", def.priceEth);
  const pool = def.source === "dexscreener"
    ? src.dexscreener.normalizeDsPair(def.raw, chain)
    : src.normalize.normalizePool(def.raw, chain);
  if (!pool) throw new Error("normalizatorul a respins fixture-ul");
  if (pool.pairAddress !== def.pair || pool.dexType !== def.dexType) throw new Error(`normalizator: pereche/tip neașteptate (${pool.dexType})`);
  src.memory.updateMemory(pool, pool.priceUsd);
  if (def.admit === "v3") st.v3PoolMap.set(chain.id, def.pair, pool);   // precondiție declarată (treapta 1)
  if (def.admit === "v4") st.v4PoolMap.set(chain.id, def.pair, pool);   // precondiție declarată (treapta 1)
  src.transitions.addWatchCandidate(def.pair, { chain: chain.id, addedAt: Date.now(), kind: "NORMAL" }, pool);
  if (!st.activeWatch.has(chain.id, def.pair) || !st.memory.has(chain.id, def.pair)) throw new Error("starea de urmărire nu a fost pusă");
  if (st.v3PoolMap.has(chain.id, def.pair) !== (def.admit === "v3") || st.v4PoolMap.has(chain.id, def.pair) !== (def.admit === "v4")) {
    throw new Error("starea hărților nu e cea declarată de caz");
  }

  // ── Subscriere pe traseul real + barierele 5.1 ───────────────────────────────────────────────────────────
  await ctx.connect();
  await ctx.awaitOpenSubscribes();
  const requests = await ctx.clientBarrier("beta1-după-subscriere");
  const subs = requests.filter(r => r.method === "eth_subscribe");
  const shapes = subs.map(subShape);
  const observations: Record<string, unknown> = {
    diagnosis: def.diagnosis, prediction: def.prediction, pairedControl: def.pairedControl,
    metadataSource: def.source, priceEth: def.priceEth,
    mapAdmission: def.admit === null
      ? (def.dexType === "V2" ? "fără hartă (V2)" : `NEPUSĂ în ${def.dexType.toLowerCase()}PoolMap (condiția cazului, treapta 1)`)
      : `pusă de caz în ${def.admit}PoolMap (precondiție, treapta 1)`,
    requestedFilters: subs.map(r => r.params),
    requestKinds: shapes.map(s => s.kind),
  };
  if (requests.length !== subs.length) throw new Error("cereri neașteptate pe lângă eth_subscribe");

  // Ruta: pe ce subscripție a ajuns pool-ul.
  const route: string[] = [];
  if (subs.length !== 1) route.push(`cereri eth_subscribe: ${subs.length} (se aștepta exact una, de tip ${def.subKind})`);
  const target = shapes.findIndex(s => s.kind === def.subKind && carries(s, def.pair));
  if (target < 0) route.push(`perechea nu apare în nicio cerere de tip ${def.subKind}`);
  const elsewhere = shapes.filter(s => s.kind !== def.subKind && carries(s, def.pair)).map(s => s.kind ?? "necunoscut");
  if (elsewhere.length > 0) route.push(`perechea apare și în cereri de alt tip: ${elsewhere.join(", ")}`);
  observations.routeProblems = route;
  if (route.length > 0) {
    if (def.routeIsPrediction) return verdict(def, route, observations);
    throw new Error("montaj: " + route.join("; "));
  }
  const sub = subs[target];
  const shape = shapes[target];
  if (shape.addresses.length !== 1 && def.subKind !== "v4") throw new Error("filtrul conține și alte adrese decât cea a cazului");
  for (const t of def.requiredTopics) if (!shape.topics0.includes(t)) throw new Error(`montaj: topicul ${t.slice(0, 10)}… lipsește din filtrul cerut`);

  const failed: string[] = [];
  const present = def.absentTopics.filter(t => shape.topics0.includes(t));
  observations.absentTopicsExpected = def.absentTopics;
  observations.absentTopicsFoundInFilter = present;
  for (const t of present) failed.push(`topicul ${t.slice(0, 10)}… ESTE în filtrul cerut (predicția: lipsește)`);

  await ctx.awaitPromoted(def.subKind, sub, def.pair);
  if (sub.subId === null) throw new Error("cererea nu are id de subscripție");
  const before = recordedState(ctx, def.pair);
  if (before.forPair !== 0 || before.flowPairs !== 0 || before.swapLines !== 0) throw new Error("existau swapuri înregistrate înainte de livrare");

  // ── Livrare prin filtru + bariera 5.2 ────────────────────────────────────────────────────────────────────
  if (def.offered.length > 0) {
    const d = await ctx.deliver(def.offered.map(o => o.log), "beta1-după-loguri");
    observations.logsSent = d.logsSent;
    observations.logsReceived = d.logsReceived;
    observations.delivery = def.offered.map(o => ({ role: o.role, expectSent: o.expectSent, ...d.perLog[o.log.transactionHash] }));
    for (const o of def.offered) {
      const got = d.perLog[o.log.transactionHash];
      if (got.sent === o.expectSent) continue;
      if (o.role === "witness") throw new Error("martorul nu a fost trimis exact o dată prin filtru: subscripția nu livrează în acest proces");
      if (o.role === "twin")    throw new Error("geamănul negativ (topic străin) a fost trimis de nod");
      failed.push(o.expectSent === 0
        ? `logul cazului A FOST trimis prin filtru (de ${got.sent} ori; predicția: netrimis)`
        : `logul cazului NU a fost trimis exact o dată prin filtru (de ${got.sent} ori; predicția: trimis și primit)`);
    }
  }

  // ── Livrare forțată (ocolește filtrul) + aceeași barieră 5.2 ─────────────────────────────────────────────
  if (def.forced.length > 0) {
    const d = await ctx.deliverForced(def.forced, sub.subId, "beta1-după-loguri-forțate");
    observations.forcedSent = d.logsSent;
    observations.forcedReceived = d.logsReceived;
    observations.forcedNote = "livrare forțată: ocolește filtrul; nu dovedește nimic despre filtru sau despre un nod real";
    if (d.logsReceived !== def.forced.length) throw new Error("nu toate logurile forțate au ajuns la client");
  }

  // ── Ce s-a înregistrat ───────────────────────────────────────────────────────────────────────────────────
  const after = recordedState(ctx, def.pair);
  const events = st.wsFlow.get(chain.id, def.pair) ?? [];
  Object.assign(observations, {
    swapsRecorded: after.forPair, pairsWithFlow: after.flowPairs, swapLogLines: after.swapLines,
    recorded: events.map(e => ({ isBuy: e.isBuy, ethAmount: e.ethAmount, usdAmount: e.usdAmount ?? null })),
    lpEventsRecorded: st.lpEvents.get(chain.id, def.pair)?.length ?? 0,
    lastWsMessageSeen: st.wsLastMessageAt.has(chain.id),
    lastKindMessageSeen: st.wsLastMessageAtByKind.has(`${chain.id}:${def.subKind}`),
    recognizedNote: "starea «swap recunoscut» nu are semnal în cod; se observă doar trimis / primit / înregistrat",
  });
  if (after.forPair !== 0 || after.flowPairs !== 0) failed.push(`swapuri înregistrate: ${after.forPair} (predicția: 0)`);
  if (after.swapLines !== 0) failed.push(`linii de swap în consolă: ${after.swapLines} (predicția: 0)`);

  // „Primit" trebuie să se vadă și în semnalul de transport al workerului, acolo unde un log a ajuns la el.
  const anyArrived = def.forced.length > 0 || def.offered.some(o => o.expectSent === 1);
  if (anyArrived && !st.wsLastMessageAt.has(chain.id)) throw new Error("un log a ajuns la client, dar wsLastMessageAt nu a fost marcat");

  return verdict(def, failed, observations);
}

// ── Corpul: pool urmărit care nu apare în nicio cerere (M2) ──────────────────────────────────────────────────
async function noRequestBody(def: NoRequestDef, ctx: CaseContext): Promise<CaseBodyResult> {
  const { src, chain } = ctx;
  const st = src.stores;
  src.nativePrice.__setNativePriceForTest("ETH", def.priceEth);
  const pool = src.normalize.normalizePool(def.raw, chain);
  if (!pool) throw new Error("normalizePool a respins fixture-ul");
  if (pool.pairAddress !== def.pair || pool.dexType !== def.dexType) throw new Error(`normalizePool: pereche/tip neașteptate (${pool.dexType})`);
  src.memory.updateMemory(pool, pool.priceUsd);
  src.transitions.addWatchCandidate(def.pair, { chain: chain.id, addedAt: Date.now(), kind: "NORMAL" }, pool);
  if (!st.activeWatch.has(chain.id, def.pair) || !st.memory.has(chain.id, def.pair)) throw new Error("starea de urmărire nu a fost pusă");
  if (st.v4PoolMap.has(chain.id, def.pair) || st.v3PoolMap.has(chain.id, def.pair)) throw new Error("starea hărților nu e cea declarată de caz");

  await ctx.connect();
  await ctx.awaitOpenSubscribes();
  // Bariera 5.1.2 dovedește și ABSENȚA: tot ce ar fi trimis clientul până aici a ajuns deja la nod.
  const requests = await ctx.clientBarrier("beta1-după-subscriere");
  const mentioning = requests.filter(r => JSON.stringify(r.params).toLowerCase().includes(def.pair));
  const observations: Record<string, unknown> = {
    diagnosis: def.diagnosis, prediction: def.prediction, pairedControl: def.pairedControl,
    mapAdmission: "NEPUSĂ în v4PoolMap (condiția cazului, treapta 1)",
    requestsSeen: requests.length, requestedFilters: requests.map(r => r.params),
    requestsMentioningPair: mentioning.length,
  };
  const failed: string[] = [];
  if (mentioning.length > 0) {
    failed.push(`poolId-ul APARE în ${mentioning.length} cerere/cereri (predicția: în niciuna)`);
    return verdict(def, failed, observations);
  }
  if (requests.length > 0) throw new Error("montaj: clientul a trimis cereri care nu privesc perechea cazului");
  if (st.scopedSubStore.active.size !== 0 || st.scopedSubStore.pending.size !== 0) throw new Error("subscripții scoped fără nicio cerere capturată");

  // Fără nicio subscripție, logul nu are pe unde pleca; bariera 5.2 confirmă că nici nu a sosit ceva.
  const d = await ctx.deliver([def.subject], "beta1-după-loguri");
  const after = recordedState(ctx, def.pair);
  Object.assign(observations, {
    logsSent: d.logsSent, logsReceived: d.logsReceived,
    swapsRecorded: after.forPair, pairsWithFlow: after.flowPairs, swapLogLines: after.swapLines,
  });
  if (d.logsSent !== 0) failed.push(`logul cazului a fost trimis de ${d.logsSent} ori (predicția: netrimis)`);
  if (after.forPair !== 0 || after.flowPairs !== 0) failed.push(`swapuri înregistrate: ${after.forPair} (predicția: 0)`);
  if (after.swapLines !== 0) failed.push(`linii de swap în consolă: ${after.swapLines} (predicția: 0)`);
  return verdict(def, failed, observations);
}

// ── Corpul: observație parțială (X1) — fără conectarea workerului, fără subscriere ──────────────────────────
function partialBody(def: PartialDef, ctx: CaseContext): CaseBodyResult {
  const { src, chain } = ctx;
  const v3Dexes = src.constants.V3_DEXES;
  // Controlul din interiorul observației: un dexId care TREBUIE să fie V3 și admis. Altfel observația nu spune nimic.
  const admitted = src.indexed.toSourcePool(indexedPair(POOL_INDEXED, def.admittedDexId), chain);
  if (admitted.dexType !== "V3" || !v3Dexes.has(def.admittedDexId)) {
    throw new Error(`controlul observației: ${def.admittedDexId} ar trebui să fie V3 și în V3_DEXES`);
  }
  const pool = src.indexed.toSourcePool(indexedPair(POOL_INDEXED, def.dexId), chain);
  if (pool.pairAddress !== POOL_INDEXED || pool.dexId !== def.dexId) throw new Error("toSourcePool: pereche/dexId neașteptate");
  const observations: Record<string, unknown> = {
    diagnosis: def.diagnosis, prediction: def.prediction,
    dexId: def.dexId, dexTypeFromIndexer: pool.dexType, inV3Dexes: v3Dexes.has(def.dexId),
    controlDexId: def.admittedDexId, controlDexType: admitted.dexType, controlInV3Dexes: true,
    notVerified: def.notVerified,
  };
  const failed: string[] = [];
  if (pool.dexType !== "V3") failed.push(`toSourcePool dă dexType ${pool.dexType} (predicția: V3)`);
  if (v3Dexes.has(def.dexId)) failed.push(`V3_DEXES CONȚINE ${def.dexId} (predicția: nu îl conține)`);
  return verdict(def, failed, observations);
}

export async function defectBody(def: DefectDef, ctx: CaseContext): Promise<CaseBodyResult> {
  checkFixtures();
  if (def.shape === "deliver")    return deliverBody(def, ctx);
  if (def.shape === "no-request") return noRequestBody(def, ctx);
  return partialBody(def, ctx);
}
