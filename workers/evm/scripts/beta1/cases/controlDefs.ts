/**
 * scripts/beta1/cases/controlDefs.ts — BETA-1, felia 3: definițiile și corpul CONTROALELOR POZITIVE.
 *
 * Modul fără efecte la import: nu pornește niciun caz. E folosit de `positiveControls.ts` (codul REAL al
 * workerului) și de controalele proprii ale runtime-ului (worker fals).
 *
 * Fiecare caz pune starea prin funcțiile de producție, lasă workerul să se aboneze pe traseul lui real (timerele de
 * la `open`), livrează prin filtrul nodului local UN swap Uniswap și cere ca acesta să fie ÎNREGISTRAT efectiv, cu
 * direcția și sumele așteptate. Un control care nu înregistrează invalidează rularea: fără controale verzi, niciun
 * caz de defect nu se interpretează.
 *
 * „Înregistrat" cere AMBELE: intrarea din `wsFlow` cu valorile așteptate ȘI linia `[Vx SWAP base] …` din consolă.
 *
 * PRECONDIȚIE DECLARATĂ (treapta 1): pentru V3 și V4, admiterea în `v3PoolMap` / `v4PoolMap` e pusă de CAZ, nu
 * obținută prin `scan()`. Admiterea reală ține de treapta 2.
 *
 * Fiecare caz include un geamăn negativ: un log cu topic străin, de la aceeași adresă, care NU trebuie trimis.
 * Valorile așteptate sunt constante scrise aici; nu se calculează cu funcții din `src/`.
 */

import { jsonEqual, type CaseContext, type CaseBodyResult, type ScopedKind } from "../harness/caseRuntime";
import type { RpcLog, CapturedRequest } from "../harness/localNode";
import {
  WETH_BASE, USDC_BASE, V4_POOL_MANAGER_BASE, POOL_V2, POOL_V3, POOL_V3_STABLE, POOL_V4_ID,
  T_SWAP_V2, T_SWAP_V3, T_SWAP_V4, E18,
  geckoPool, swapV2Log, swapV3Log, swapV4Log, foreignLog, fixturesSelfCheck, type GeckoPoolRaw,
} from "../harness/evmFixtures";

export interface ControlDef {
  /** Pool-ul brut (forma Gecko), trecut prin normalizatorul real. */
  raw:        GeckoPoolRaw;
  /** Cheia perechii: adresa pool-ului sau poolId-ul V4. */
  pair:       string;
  kind:       ScopedKind;
  /** Harta în care cazul pune pool-ul ca precondiție; `null` pentru V2 (nu are hartă). */
  admit:      "v3" | "v4" | null;
  dexType:    "V2" | "V3" | "V4";
  /** Topicul de swap care TREBUIE să fie în filtrul cerut. */
  swapTopic:  string;
  swap:       RpcLog;
  twin:       RpcLog;
  priceEth:   number;
  expected:   { isBuy: boolean; ethAmount: number; usdAmount: number };
  /** Începutul liniei de consolă scrise de worker la înregistrare. */
  linePrefix: string;
}

const PRICE = 2_500;

/**
 * Convenții (TOKEN > WETH, USDC ⇒ quote-ul e token0, deci amount0 e suma de quote):
 *   V2: sume In/Out fără semn; quote IN = cumpărare.
 *   V3: semn în convenția POOL — quote pozitiv (intrat în pool) = cumpărare.
 *   V4: semn din perspectiva SWAPPER-ului — quote NEGATIV (plătit de swapper) = cumpărare.
 */
export const CONTROLS: Record<string, ControlDef> = {
  "C-V2-BUY": {
    raw: geckoPool(POOL_V2, "uniswap-v2-base", WETH_BASE, "WETH"), pair: POOL_V2, kind: "v2", admit: null, dexType: "V2",
    swapTopic: T_SWAP_V2,
    swap: swapV2Log(POOL_V2, { amount0In: E18, amount1In: 0n, amount0Out: 0n, amount1Out: 5n * E18 }, 0x2001),
    twin: foreignLog(POOL_V2, null, 0x2002),
    priceEth: PRICE, expected: { isBuy: true, ethAmount: 1, usdAmount: 2_500 }, linePrefix: "[V2 SWAP base] TKN BUY",
  },
  "C-V2-SELL": {
    raw: geckoPool(POOL_V2, "uniswap-v2-base", WETH_BASE, "WETH"), pair: POOL_V2, kind: "v2", admit: null, dexType: "V2",
    swapTopic: T_SWAP_V2,
    swap: swapV2Log(POOL_V2, { amount0In: 0n, amount1In: 3n * E18, amount0Out: E18 / 2n, amount1Out: 0n }, 0x2003),
    twin: foreignLog(POOL_V2, null, 0x2004),
    priceEth: PRICE, expected: { isBuy: false, ethAmount: 0.5, usdAmount: 1_250 }, linePrefix: "[V2 SWAP base] TKN SELL",
  },
  "C-V3-BUY": {
    raw: geckoPool(POOL_V3, "uniswap-v3-base", WETH_BASE, "WETH"), pair: POOL_V3, kind: "v3", admit: "v3", dexType: "V3",
    swapTopic: T_SWAP_V3,
    swap: swapV3Log(POOL_V3, { amount0: E18, amount1: -5n * E18 }, 0x3001),
    twin: foreignLog(POOL_V3, null, 0x3002),
    priceEth: PRICE, expected: { isBuy: true, ethAmount: 1, usdAmount: 2_500 }, linePrefix: "[V3 SWAP base] TKN BUY",
  },
  "C-V3-SELL": {
    raw: geckoPool(POOL_V3, "uniswap-v3-base", WETH_BASE, "WETH"), pair: POOL_V3, kind: "v3", admit: "v3", dexType: "V3",
    swapTopic: T_SWAP_V3,
    swap: swapV3Log(POOL_V3, { amount0: -(E18 / 2n), amount1: 3n * E18 }, 0x3003),
    twin: foreignLog(POOL_V3, null, 0x3004),
    priceEth: PRICE, expected: { isBuy: false, ethAmount: 0.5, usdAmount: 1_250 }, linePrefix: "[V3 SWAP base] TKN SELL",
  },
  "C-V4-BUY": {
    raw: geckoPool(POOL_V4_ID, "uniswap-v4-base", WETH_BASE, "WETH"), pair: POOL_V4_ID, kind: "v4", admit: "v4", dexType: "V4",
    swapTopic: T_SWAP_V4,
    swap: swapV4Log(POOL_V4_ID, { amount0: -E18, amount1: 5n * E18 }, 0x4001),
    twin: foreignLog(V4_POOL_MANAGER_BASE, POOL_V4_ID, 0x4002),
    priceEth: PRICE, expected: { isBuy: true, ethAmount: 1, usdAmount: 2_500 }, linePrefix: "[V4 SWAP base] TKN BUY",
  },
  "C-V4-SELL": {
    raw: geckoPool(POOL_V4_ID, "uniswap-v4-base", WETH_BASE, "WETH"), pair: POOL_V4_ID, kind: "v4", admit: "v4", dexType: "V4",
    swapTopic: T_SWAP_V4,
    swap: swapV4Log(POOL_V4_ID, { amount0: E18 / 2n, amount1: -3n * E18 }, 0x4003),
    twin: foreignLog(V4_POOL_MANAGER_BASE, POOL_V4_ID, 0x4004),
    priceEth: PRICE, expected: { isBuy: false, ethAmount: 0.5, usdAmount: 1_250 }, linePrefix: "[V4 SWAP base] TKN SELL",
  },
  // Quote stabil (USDC, 6 zecimale): suma nativă = USD / prețul injectat.
  "C-STABLE-BUY": {
    raw: geckoPool(POOL_V3_STABLE, "uniswap-v3-base", USDC_BASE, "USDC"), pair: POOL_V3_STABLE, kind: "v3", admit: "v3", dexType: "V3",
    swapTopic: T_SWAP_V3,
    swap: swapV3Log(POOL_V3_STABLE, { amount0: 1_000n * 1_000_000n, amount1: -5n * E18 }, 0x5001),
    twin: foreignLog(POOL_V3_STABLE, null, 0x5002),
    priceEth: 2_000, expected: { isBuy: true, ethAmount: 0.5, usdAmount: 1_000 }, linePrefix: "[V3 SWAP base] TKN BUY",
  },
  "C-STABLE-SELL": {
    raw: geckoPool(POOL_V3_STABLE, "uniswap-v3-base", USDC_BASE, "USDC"), pair: POOL_V3_STABLE, kind: "v3", admit: "v3", dexType: "V3",
    swapTopic: T_SWAP_V3,
    swap: swapV3Log(POOL_V3_STABLE, { amount0: -(500n * 1_000_000n), amount1: 3n * E18 }, 0x5003),
    twin: foreignLog(POOL_V3_STABLE, null, 0x5004),
    priceEth: 2_000, expected: { isBuy: false, ethAmount: 0.25, usdAmount: 500 }, linePrefix: "[V3 SWAP base] TKN SELL",
  },
};

export const CONTROL_IDS = Object.keys(CONTROLS);

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

/** Filtrul cerut are forma minimă cerută de control: adresa corectă și topicul de swap prezent pe poziția 0. */
function filterProblem(def: ControlDef, req: CapturedRequest): string | null {
  const p = req.params;
  if (!Array.isArray(p) || p[0] !== "logs" || typeof p[1] !== "object" || p[1] === null) return "parametri eth_subscribe neașteptați";
  const f = p[1] as { address?: unknown; topics?: unknown };
  const wantAddr: unknown = def.kind === "v4" ? V4_POOL_MANAGER_BASE : [def.pair];
  const sameAddr = def.kind === "v4"
    ? typeof f.address === "string" && f.address.toLowerCase() === V4_POOL_MANAGER_BASE
    : jsonEqual(f.address, wantAddr);
  if (!sameAddr) return "adresa din filtru nu e cea așteptată";
  if (!Array.isArray(f.topics) || !Array.isArray(f.topics[0]) || !(f.topics[0] as unknown[]).includes(def.swapTopic)) {
    return "topicul de swap lipsește din poziția 0 a filtrului";
  }
  if (def.kind === "v4" ? !jsonEqual(f.topics[1], [def.pair]) || f.topics.length !== 2 : f.topics.length !== 1) {
    return "pozițiile de topic ale filtrului nu sunt cele așteptate";
  }
  return null;
}

export async function controlBody(def: ControlDef, ctx: CaseContext): Promise<CaseBodyResult> {
  const { src, chain } = ctx;
  const st = src.stores;
  const fx = fixturesSelfCheck();
  if (fx.length > 0) throw new Error("fixture invalide: " + fx.join("; "));

  // ── Stare, prin funcțiile de producție ─────────────────────────────────────────────────────────────────────
  src.nativePrice.__setNativePriceForTest("ETH", def.priceEth);
  const pool = src.normalize.normalizePool(def.raw, chain);
  if (!pool) throw new Error("normalizePool a respins fixture-ul");
  if (pool.pairAddress !== def.pair || pool.dexType !== def.dexType) {
    throw new Error(`normalizePool: pereche/tip neașteptate (${pool.dexType})`);
  }
  src.memory.updateMemory(pool, pool.priceUsd);
  if (def.admit === "v3") st.v3PoolMap.set(chain.id, def.pair, pool);   // precondiție declarată (treapta 1)
  if (def.admit === "v4") st.v4PoolMap.set(chain.id, def.pair, pool);   // precondiție declarată (treapta 1)
  src.transitions.addWatchCandidate(def.pair, { chain: chain.id, addedAt: Date.now(), kind: "NORMAL" }, pool);
  if (!st.activeWatch.has(chain.id, def.pair) || !st.memory.has(chain.id, def.pair)) throw new Error("starea de urmărire nu a fost pusă");

  // ── Subscriere pe traseul real + barierele 5.1 ─────────────────────────────────────────────────────────────
  await ctx.connect();
  await ctx.awaitOpenSubscribes();
  const requests = await ctx.clientBarrier("beta1-după-subscriere");
  const subs = requests.filter(r => r.method === "eth_subscribe");
  const observations: Record<string, unknown> = {
    mapAdmission: def.admit === null ? "fără hartă (V2)" : `pusă de caz în ${def.admit}PoolMap (precondiție, treapta 1)`,
    requestedFilters: subs.map(r => r.params),
    unsubscribes: requests.filter(r => r.method === "eth_unsubscribe").length,
  };
  if (subs.length !== 1) throw new Error(`se aștepta exact o cerere eth_subscribe, au fost ${subs.length}`);
  if (requests.length !== 1) throw new Error("cereri neașteptate pe lângă eth_subscribe");
  const fp = filterProblem(def, subs[0]);
  if (fp) return { outcome: "CONTROL_FAILED", reasons: [fp], observations };
  await ctx.awaitPromoted(def.kind, subs[0], def.pair);

  // ── Livrare prin filtru + bariera 5.2 ──────────────────────────────────────────────────────────────────────
  const before = st.wsFlow.get(chain.id, def.pair)?.length ?? 0;
  const d = await ctx.deliver([def.twin, def.swap], "beta1-după-loguri");
  const events = st.wsFlow.get(chain.id, def.pair) ?? [];
  const lines = ctx.cons.count(def.linePrefix);
  const swapLines = ctx.cons.count(" SWAP base] ");
  Object.assign(observations, {
    logsSent: d.logsSent, logsReceived: d.logsReceived,
    swapDelivery: d.perLog[def.swap.transactionHash], twinDelivery: d.perLog[def.twin.transactionHash],
    swapsRecordedBefore: before, swapsRecorded: events.length,
    recorded: events.map(e => ({ isBuy: e.isBuy, ethAmount: e.ethAmount, usdAmount: e.usdAmount ?? null })),
    swapLogLines: swapLines, expectedLineCount: lines,
    lastWsMessageSeen: st.wsLastMessageAt.has(chain.id),
    lastKindMessageSeen: st.wsLastMessageAtByKind.has(`${chain.id}:${def.kind}`),
  });

  const reasons: string[] = [];
  if (d.perLog[def.twin.transactionHash].sent !== 0) reasons.push("geamănul negativ (topic străin) a fost trimis de nod");
  if (d.perLog[def.swap.transactionHash].sent !== 1) reasons.push("swapul nu a fost trimis exact o dată prin filtru");
  if (before !== 0) reasons.push("existau swapuri înregistrate înainte de livrare");
  if (events.length !== 1) reasons.push(`swapuri înregistrate: ${events.length} (se cere exact 1)`);
  else {
    const e = events[0];
    if (e.isBuy !== def.expected.isBuy) reasons.push(`direcție înregistrată: ${e.isBuy ? "BUY" : "SELL"}`);
    if (!near(e.ethAmount, def.expected.ethAmount)) reasons.push(`sumă nativă înregistrată: ${e.ethAmount} (așteptat ${def.expected.ethAmount})`);
    if (typeof e.usdAmount !== "number" || !near(e.usdAmount, def.expected.usdAmount)) reasons.push(`sumă USD înregistrată: ${String(e.usdAmount)} (așteptat ${def.expected.usdAmount})`);
  }
  if (lines !== 1 || swapLines !== 1) reasons.push(`linii de swap în consolă: ${swapLines}, dintre care cu prefixul așteptat ${lines} (se cere exact 1 și 1)`);
  if (!st.wsLastMessageAt.has(chain.id)) reasons.push("wsLastMessageAt nu a fost marcat");

  return reasons.length === 0
    ? { outcome: "CONTROL_OK", reasons: [], observations }
    : { outcome: "CONTROL_FAILED", reasons, observations };
}
