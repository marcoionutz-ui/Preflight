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
 *
 * Felia 4 adaugă două controale PERECHE (`D1-CONTROL`, `P1-CONTROL`): același montaj și același log ca în cazul de
 * defect, cu o singură variabilă schimbată. Ca orice control, rulează înaintea cazurilor de defect.
 *
 * Felia D1 (fixul §4.5) adaugă patru controale `D1-DS-*` pe un pool trecut prin `normalizeDsPair`: swap BUY și
 * SELL, plus LP V2 `Mint` și `Burn` (schimbarea declarată: LP-ul pool-urilor DexScreener devine activ). Un control
 * LP cere exact un eveniment în `lpEvents`, cu sensul și suma exacte, ZERO swapuri și linia exactă a workerului;
 * la `Burn`, rezerva e verificată întâi (montaj), iar procentul retras e verificat prin linia exactă.
 *
 * Felia T1 (fixul §4.4, design `BETA1_T1_FIX_DESIGN.md` rev3, §4.1) adaugă trei controale `C-PANCAKE-*` pe un pool
 * `pancakeswap-v3-base` pus în `v3PoolMap` (precondiție, treapta 1): swap BUY și SELL (exact 448 hex) și forma
 * TRUNCHIATĂ (320 hex), care trebuie refuzată tăcut. Toate trei cer: poziția 0 a filtrului exact lista V3 așteptată;
 * logul trimis și primit exact o dată; `wsLastMessageAtByKind` nemarcat înainte și marcat după livrare pentru
 * `base:v3`; verificări GLOBALE (toate cheile `wsFlow`/`lpEvents`, liniile de swap și LP pe orice chain). Absența
 * liniilor `[WS ERR` NU e verificată aici: e invariant de validitate al cazului în runtime (→ HARNESS_ERROR).
 *
 * Felia T2 (design `BETA1_T2_FIX_DESIGN.md` rev3, §5.1) adaugă nouă controale `C-AERO-*` pe un pool Aerodrome clasic
 * (`aerodrome-base`, ruta V2, fără hartă): swap BUY/SELL, swap trunchiat (192 hex), cu surplus (320 hex) și cu date
 * ne-șir; Mint (topic comun — așteptat `CONTROL_OK` și pe baseline, fără lista exactă a filtrului); Burn valid, cu
 * surplus (192 hex) și cu date ne-șir. Liniile LP sunt verificate ÎNTREGI. La controalele cu date ne-șir, lipsa
 * `[WS ERR` (invariantul runtime-ului) e chiar dovada că dispatch-ul Aerodrome precede orice operație nesigură.
 *
 * Felia V4L (design `BETA1_V4L_FIX_DESIGN.md` rev2, §6) adaugă controlul `C-V4-LIQ`: un `ModifyLiquidity` V4 complet,
 * emis de PoolManager pe pool-ul V4 admis în `v4PoolMap`. Rezultatul cerut e RUTARE DIAGNOSTICĂ, nu suport LP: poziția
 * 0 a filtrului exact `[Swap V4, ModifyLiquidity]`; geamănul cu topicul vechi (`DecreaseLiquidity` V3, alt
 * `transactionHash`) refuzat de filtru; logul trimis și primit exact o dată; `base:v4` nemarcat înainte și marcat după;
 * exact o linie `[V4 LIQ]`, identică cu linia așteptată (pool, date, tranzacție); zero swapuri și zero LP, global.
 * Marcajul `v4` dovedește doar activitatea fluxului: în produs el PRECEDE verificarea PoolManager-ului, deci dovada
 * că ramura a acceptat logul e linia diagnostică, nu marcajul.
 *
 * Felia V4LR (design `BETA1_V4LR_ROBUSTNESS_DESIGN.md` rev1, §3) adaugă cinci controale pe același pool și același
 * filtru exact, cu un singur lucru schimbat față de `C-V4-LIQ`: câmpul `data` — `null`, absent, `7`, `{}` și
 * `["a","b","c"]`. După fix, toate cer exact linia `[V4 LIQ] TKN len=0 data= tx=<hash>` și zero efecte. Pe baseline:
 * `null`/absent dau deja această linie (CONTROL_OK); `7`/`{}` aruncă la `slice` → `[WS ERR` → HARNESS_ERROR; matricea
 * NU aruncă, dar dă linia `len=1 data=c` → CONTROL_FAILED (schimbare de comportament documentată).
 */

import { jsonEqual, type CaseContext, type CaseBodyResult, type ScopedKind } from "../harness/caseRuntime";
import type { RpcLog, CapturedRequest } from "../harness/localNode";
import {
  WETH_BASE, USDC_BASE, V4_POOL_MANAGER_BASE, POOL_V2, POOL_V3, POOL_V3_STABLE, POOL_V4_ID,
  T_SWAP_V2, T_SWAP_V3, T_SWAP_V4, E18,
  geckoPool, swapV2Log, swapV3Log, swapV4Log, foreignLog, fixturesSelfCheck, type GeckoPoolRaw,
} from "../harness/evmFixtures";
import {
  POOL_D1, D1_SWAP, D1_TWIN, D1_SWAP_SELL, D1_TWIN_SELL, D1_MINT, D1_TWIN_MINT, D1_BURN, D1_TWIN_BURN, T_MINT_V2, T_BURN_V2,
  POOL_PANCAKE_V3, T_SWAP_PANCAKE_V3, T_MINT_V3, T_BURN_V3, PANCAKE_SWAP, PANCAKE_TWIN, PANCAKE_SWAP_SELL, PANCAKE_TWIN_SELL,
  PANCAKE_SHORT, PANCAKE_TWIN_SHORT, dsPair, defectFixturesSelfCheck, type DsPairRaw,
  T_MODIFY_LIQUIDITY_V4, V4L_LOG, V4L_TWIN_OLD_TOPIC, V4L_DIAG_LINE,
  V4L_NULL, V4L_TWIN_NULL, V4L_NODATA, V4L_TWIN_NODATA, V4L_NUM, V4L_TWIN_NUM, V4L_OBJ, V4L_TWIN_OBJ, V4L_ARRAY, V4L_TWIN_ARRAY,
  V4L_NULL_LINE, V4L_NODATA_LINE, V4L_NUM_LINE, V4L_OBJ_LINE, V4L_ARRAY_LINE,
  POOL_AERO_V2, T_SWAP_AERODROME, T_BURN_AERODROME, AERO_SWAP, AERO_TWIN, AERO_SWAP_SELL, AERO_TWIN_SELL, AERO_SWAP_SHORT,
  AERO_TWIN_SHORT, AERO_SWAP_LONG, AERO_TWIN_LONG, AERO_SWAP_NONSTRING, AERO_TWIN_NONSTRING, AERO_MINT, AERO_TWIN_MINT,
  AERO_BURN, AERO_TWIN_BURN, AERO_BURN_LONG, AERO_TWIN_BURN_LONG, AERO_BURN_NONSTRING, AERO_TWIN_BURN_NONSTRING,
} from "../harness/evmFixturesDefects";

export interface ControlDef {
  /** Normalizatorul real prin care trece pool-ul brut. Implicit `gecko` (`normalizePool`). */
  source?:    "gecko" | "dexscreener";
  /** Pool-ul brut (forma Gecko sau DexScreener), trecut prin normalizatorul real. */
  raw:        GeckoPoolRaw | DsPairRaw;
  /** Cheia perechii: adresa pool-ului sau poolId-ul V4. */
  pair:       string;
  kind:       ScopedKind;
  /** Harta în care cazul pune pool-ul ca precondiție; `null` pentru V2 (nu are hartă). */
  admit:      "v3" | "v4" | null;
  dexType:    "V2" | "V3" | "V4";
  /** Topicul logului livrat (swap sau LP), care TREBUIE să fie în filtrul cerut. */
  swapTopic:  string;
  /** Logul livrat prin filtru: un swap sau, pentru controalele LP, un `Mint` / `Burn`. */
  swap:       RpcLog;
  twin:       RpcLog;
  priceEth:   number;
  /** Pentru swap: ce trebuie înregistrat în `wsFlow`. Lipsește la controalele LP. */
  expected?:  { isBuy: boolean; ethAmount: number; usdAmount: number };
  /** Începutul liniei de consolă scrise de worker la înregistrare (swap sau LP). */
  linePrefix: string;
  /**
   * Control LP (felia D1): ce trebuie înregistrat în `lpEvents` — exact un eveniment, zero swapuri. `reserveEth` =
   * rezerva pe care montajul o verifică ÎNAINTE de livrare (pusă de `updateMemory` → `updatePoolLiquidity`).
   */
  lp?:        { isAdd: boolean; ethAmount: number; reserveEth?: number };
  /**
   * Control STRICT (felia T1, extins la T2): recepție exact o dată, marcaj per-kind obligatoriu (nemarcat înainte,
   * marcat după), verificări GLOBALE. `topics0` = lista EXACTĂ din poziția 0 a filtrului cerut (absent = doar
   * prezența topicului propriu, ex. `C-AERO-LP-ADD`); `lineField` = câmpul obligatoriu din linia de swap; `none` =
   * formă invalidă: nicio înregistrare, nicăieri. Cu `lp` (T2): exact un eveniment LP, iar `linePrefix` e linia LP
   * ÎNTREAGĂ, comparată prin egalitate exactă (inclusiv sufixul ` ⚠️` la REMOVE). `diagLine` (felia V4L) = linia
   * diagnostică EXACTĂ cerută (exact una cu același prefix pe toată consola, identică), plus „zero efecte" ca la `none`.
   */
  strict?:    { topics0?: string[]; lineField?: string; none?: true; diagLine?: string };
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

// ── Controalele PERECHE ale cazurilor de defect (felia 4) ────────────────────────────────────────────────────
// Același montaj și ACELAȘI log ca în cazul de defect; o singură variabilă diferă.
/** Perechea lui D1: aceeași adresă și același log, dar metadate din normalizatorul Gecko (nu DexScreener). */
CONTROLS["D1-CONTROL"] = {
  raw: geckoPool(POOL_D1, "uniswap-v2-base", WETH_BASE, "WETH"), pair: POOL_D1, kind: "v2", admit: null, dexType: "V2",
  swapTopic: T_SWAP_V2, swap: D1_SWAP, twin: D1_TWIN,
  priceEth: PRICE, expected: { isBuy: true, ethAmount: 1, usdAmount: 2_500 }, linePrefix: "[V2 SWAP base] TKN BUY",
};
/** Perechea lui P1: montajul și logul din C-V3-BUY, cu prețul injectat (P1 îl pune `null`). */
CONTROLS["P1-CONTROL"] = { ...CONTROLS["C-V3-BUY"] };

// ── Felia D1: acceptarea fixului pe traseul real (design `BETA1_D1_FIX_DESIGN.md` rev3, §4.1) ──────────────────
// Pool-ul trece prin `normalizeDsPair`. Pe baseline (fără fix), toate patru dau CONTROL_FAILED: metadatele
// DexScreener nu sunt citite, deci nimic nu se înregistrează. După fix: CONTROL_OK. Logul BUY e același obiect
// `D1_SWAP` ca în D1 (retras) și D1-CONTROL.
const D1_DS = { source: "dexscreener" as const, raw: dsPair(POOL_D1, "uniswap"), pair: POOL_D1, kind: "v2" as const, admit: null, dexType: "V2" as const, priceEth: PRICE };
CONTROLS["D1-DS-BUY"] = {
  ...D1_DS, swapTopic: T_SWAP_V2, swap: D1_SWAP, twin: D1_TWIN,
  expected: { isBuy: true, ethAmount: 1, usdAmount: 2_500 }, linePrefix: "[V2 SWAP base] TKN BUY",
};
CONTROLS["D1-DS-SELL"] = {
  ...D1_DS, swapTopic: T_SWAP_V2, swap: D1_SWAP_SELL, twin: D1_TWIN_SELL,
  expected: { isBuy: false, ethAmount: 0.5, usdAmount: 1_250 }, linePrefix: "[V2 SWAP base] TKN SELL",
};
CONTROLS["D1-DS-LP-ADD"] = {
  ...D1_DS, swapTopic: T_MINT_V2, swap: D1_MINT, twin: D1_TWIN_MINT,
  linePrefix: "[LP ADD base] TKN +1.000 ETH quote=WETH",
  lp: { isAdd: true, ethAmount: 1 },
};
CONTROLS["D1-DS-LP-REMOVE"] = {
  ...D1_DS, swapTopic: T_BURN_V2, swap: D1_BURN, twin: D1_TWIN_BURN,
  // Procentul nu e stocat nicăieri altundeva: linia exactă e verificarea lui (2 / 20 ETH = 10,0%).
  linePrefix: "[LP REMOVE base] TKN -2.000 ETH (quote=WETH) (10.0% of pool)",
  lp: { isAdd: false, ethAmount: 2, reserveEth: 20 },
};

// ── Felia T1: acceptarea fixului pe traseul real (design `BETA1_T1_FIX_DESIGN.md` rev3, §4.1) ──────────────────
// Pool PancakeSwap V3, pus în v3PoolMap (precondiție, treapta 1), cu montajul T1. Pe baseline (fără fix), toate trei
// dau CONTROL_FAILED pe filtru: topicul Swap PancakeSwap V3 lipsește din poziția 0. După fix: CONTROL_OK. Logul
// BUY e același obiect `PANCAKE_SWAP` ca în T1 (retras).
const V3_TOPICS0 = [T_SWAP_V3, T_SWAP_PANCAKE_V3, T_MINT_V3, T_BURN_V3];
const PCS = {
  raw: geckoPool(POOL_PANCAKE_V3, "pancakeswap-v3-base", WETH_BASE, "WETH"), pair: POOL_PANCAKE_V3, kind: "v3" as const,
  admit: "v3" as const, dexType: "V3" as const, swapTopic: T_SWAP_PANCAKE_V3, priceEth: PRICE,
};
CONTROLS["C-PANCAKE-BUY"] = {
  ...PCS, swap: PANCAKE_SWAP, twin: PANCAKE_TWIN,
  expected: { isBuy: true, ethAmount: 1, usdAmount: 2_500 }, linePrefix: "[V3 SWAP base] TKN BUY",
  strict: { topics0: V3_TOPICS0, lineField: "swapVariant=pancake-v3" },
};
CONTROLS["C-PANCAKE-SELL"] = {
  ...PCS, swap: PANCAKE_SWAP_SELL, twin: PANCAKE_TWIN_SELL,
  expected: { isBuy: false, ethAmount: 0.5, usdAmount: 1_250 }, linePrefix: "[V3 SWAP base] TKN SELL",
  strict: { topics0: V3_TOPICS0, lineField: "swapVariant=pancake-v3" },
};
CONTROLS["C-PANCAKE-SHORT"] = {
  ...PCS, swap: PANCAKE_SHORT, twin: PANCAKE_TWIN_SHORT,
  linePrefix: "[V3 SWAP base]",
  strict: { topics0: V3_TOPICS0, none: true },
};

// ── Felia T2: acceptarea fixului pe traseul real (design `BETA1_T2_FIX_DESIGN.md` rev3, §5.1) ──────────────────
// Pool Aerodrome clasic pe ruta V2 (fără hartă). Pe baseline, toate în afară de LP-ADD dau CONTROL_FAILED pe filtru
// (topicul Aerodrome lipsește din poziția 0); LP-ADD (Mint, topic comun) dă CONTROL_OK. După fix: toate CONTROL_OK.
// Logul BUY e același obiect `AERO_SWAP` ca în T2 (retras).
const V2_TOPICS0 = [T_SWAP_V2, T_SWAP_AERODROME, T_MINT_V2, T_BURN_V2, T_BURN_AERODROME];
const AERO = {
  raw: geckoPool(POOL_AERO_V2, "aerodrome-base", WETH_BASE, "WETH"), pair: POOL_AERO_V2, kind: "v2" as const,
  admit: null, dexType: "V2" as const, priceEth: PRICE,
};
const AERO_SWAP_STRICT = { topics0: V2_TOPICS0, lineField: "swapVariant=aerodrome-classic" };
const AERO_NONE = { topics0: V2_TOPICS0, none: true as const };
CONTROLS["C-AERO-BUY"] = {
  ...AERO, swapTopic: T_SWAP_AERODROME, swap: AERO_SWAP, twin: AERO_TWIN,
  expected: { isBuy: true, ethAmount: 1, usdAmount: 2_500 }, linePrefix: "[V2 SWAP base] TKN BUY", strict: AERO_SWAP_STRICT,
};
CONTROLS["C-AERO-SELL"] = {
  ...AERO, swapTopic: T_SWAP_AERODROME, swap: AERO_SWAP_SELL, twin: AERO_TWIN_SELL,
  expected: { isBuy: false, ethAmount: 0.5, usdAmount: 1_250 }, linePrefix: "[V2 SWAP base] TKN SELL", strict: AERO_SWAP_STRICT,
};
CONTROLS["C-AERO-SHORT"] = { ...AERO, swapTopic: T_SWAP_AERODROME, swap: AERO_SWAP_SHORT, twin: AERO_TWIN_SHORT, linePrefix: "[V2 SWAP base]", strict: AERO_NONE };
CONTROLS["C-AERO-SWAP-LONG"] = { ...AERO, swapTopic: T_SWAP_AERODROME, swap: AERO_SWAP_LONG, twin: AERO_TWIN_LONG, linePrefix: "[V2 SWAP base]", strict: AERO_NONE };
CONTROLS["C-AERO-SWAP-NONSTRING"] = { ...AERO, swapTopic: T_SWAP_AERODROME, swap: AERO_SWAP_NONSTRING, twin: AERO_TWIN_NONSTRING, linePrefix: "[V2 SWAP base]", strict: AERO_NONE };
CONTROLS["C-AERO-LP-ADD"] = {
  ...AERO, swapTopic: T_MINT_V2, swap: AERO_MINT, twin: AERO_TWIN_MINT,
  linePrefix: "[LP ADD base] TKN +1.000 ETH quote=WETH",
  lp: { isAdd: true, ethAmount: 1 }, strict: {},             // fără `topics0`: izolează compatibilitatea Mint de lista filtrului
};
CONTROLS["C-AERO-LP-REMOVE"] = {
  ...AERO, swapTopic: T_BURN_AERODROME, swap: AERO_BURN, twin: AERO_TWIN_BURN,
  linePrefix: "[LP REMOVE base] TKN -2.000 ETH (quote=WETH) (10.0% of pool) ⚠️",
  lp: { isAdd: false, ethAmount: 2, reserveEth: 20 }, strict: { topics0: V2_TOPICS0 },
};
CONTROLS["C-AERO-BURN-LONG"] = { ...AERO, swapTopic: T_BURN_AERODROME, swap: AERO_BURN_LONG, twin: AERO_TWIN_BURN_LONG, linePrefix: "[LP REMOVE base]", strict: AERO_NONE };
CONTROLS["C-AERO-BURN-NONSTRING"] = { ...AERO, swapTopic: T_BURN_AERODROME, swap: AERO_BURN_NONSTRING, twin: AERO_TWIN_BURN_NONSTRING, linePrefix: "[LP REMOVE base]", strict: AERO_NONE };

// ── Felia V4L: rutarea diagnostică `ModifyLiquidity` (design `BETA1_V4L_FIX_DESIGN.md` rev2, §6) ─────────────────
// Același pool V4 ca `C-V4-*` (admis în `v4PoolMap`, precondiție). Pe baseline: CONTROL_FAILED pe filtru (topicul
// corect lipsește din poziția 0). După fix: CONTROL_OK. `C-V4-BUY/SELL` rămân neschimbate (fără lista exactă).
CONTROLS["C-V4-LIQ"] = {
  raw: geckoPool(POOL_V4_ID, "uniswap-v4-base", WETH_BASE, "WETH"), pair: POOL_V4_ID, kind: "v4", admit: "v4", dexType: "V4",
  swapTopic: T_MODIFY_LIQUIDITY_V4, swap: V4L_LOG, twin: V4L_TWIN_OLD_TOPIC, priceEth: PRICE,
  linePrefix: V4L_DIAG_LINE,
  strict: { topics0: [T_SWAP_V4, T_MODIFY_LIQUIDITY_V4], diagLine: V4L_DIAG_LINE },
};

// ── Felia V4LR: `data` null / absent / ne-șir pe ramura `[V4 LIQ]` (design `BETA1_V4LR_ROBUSTNESS_DESIGN.md` rev1, §3) ──
/** Ca `C-V4-LIQ` (pool, kind, filtru exact), cu alt log, alt geamăn și linia diagnostică exactă `len=0`. */
const v4lrControl = (swap: RpcLog, twin: RpcLog, line: string): ControlDef => ({
  raw: geckoPool(POOL_V4_ID, "uniswap-v4-base", WETH_BASE, "WETH"), pair: POOL_V4_ID, kind: "v4", admit: "v4", dexType: "V4",
  swapTopic: T_MODIFY_LIQUIDITY_V4, swap, twin, priceEth: PRICE,
  linePrefix: line,
  strict: { topics0: [T_SWAP_V4, T_MODIFY_LIQUIDITY_V4], diagLine: line },
});
CONTROLS["C-V4-LIQ-NULL"]   = v4lrControl(V4L_NULL, V4L_TWIN_NULL, V4L_NULL_LINE);
CONTROLS["C-V4-LIQ-NODATA"] = v4lrControl(V4L_NODATA, V4L_TWIN_NODATA, V4L_NODATA_LINE);
CONTROLS["C-V4-LIQ-NUM"]    = v4lrControl(V4L_NUM, V4L_TWIN_NUM, V4L_NUM_LINE);
CONTROLS["C-V4-LIQ-OBJ"]    = v4lrControl(V4L_OBJ, V4L_TWIN_OBJ, V4L_OBJ_LINE);
CONTROLS["C-V4-LIQ-ARRAY"]  = v4lrControl(V4L_ARRAY, V4L_TWIN_ARRAY, V4L_ARRAY_LINE);

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
  if (def.strict?.topics0 && !jsonEqual(f.topics[0], def.strict.topics0)) return `poziția 0 a filtrului ${def.kind.toUpperCase()} nu e exact lista așteptată`;
  if (def.kind === "v4" ? !jsonEqual(f.topics[1], [def.pair]) || f.topics.length !== 2 : f.topics.length !== 1) {
    return "pozițiile de topic ale filtrului nu sunt cele așteptate";
  }
  return null;
}

export async function controlBody(def: ControlDef, ctx: CaseContext): Promise<CaseBodyResult> {
  const { src, chain } = ctx;
  const st = src.stores;
  const fx = [...fixturesSelfCheck(), ...(def.strict ? defectFixturesSelfCheck() : [])];
  if (fx.length > 0) throw new Error("fixture invalide: " + fx.join("; "));

  // ── Stare, prin funcțiile de producție ─────────────────────────────────────────────────────────────────────
  src.nativePrice.__setNativePriceForTest("ETH", def.priceEth);
  const pool = def.source === "dexscreener"
    ? src.dexscreener.normalizeDsPair(def.raw, chain)
    : src.normalize.normalizePool(def.raw, chain);
  if (!pool) throw new Error("normalizatorul a respins fixture-ul");
  if (pool.pairAddress !== def.pair || pool.dexType !== def.dexType) {
    throw new Error(`normalizePool: pereche/tip neașteptate (${pool.dexType})`);
  }
  src.memory.updateMemory(pool, pool.priceUsd);
  if (def.admit === "v3") st.v3PoolMap.set(chain.id, def.pair, pool);   // precondiție declarată (treapta 1)
  if (def.admit === "v4") st.v4PoolMap.set(chain.id, def.pair, pool);   // precondiție declarată (treapta 1)
  src.transitions.addWatchCandidate(def.pair, { chain: chain.id, addedAt: Date.now(), kind: "NORMAL" }, pool);
  if (!st.activeWatch.has(chain.id, def.pair) || !st.memory.has(chain.id, def.pair)) throw new Error("starea de urmărire nu a fost pusă");
  if (def.lp?.reserveEth !== undefined) {
    // Montaj: rezerva cunoscută, pusă pe traseul de producție (`updateMemory` → `updatePoolLiquidity`).
    const reserve = st.poolLiquidity.get(chain.id, def.pair)?.reserveEth;
    if (typeof reserve !== "number" || !near(reserve, def.lp.reserveEth)) throw new Error(`rezerva pool-ului: ${String(reserve)} (montajul cere ${def.lp.reserveEth} ETH)`);
  }

  // ── Subscriere pe traseul real + barierele 5.1 ─────────────────────────────────────────────────────────────
  await ctx.connect();
  await ctx.awaitOpenSubscribes();
  const requests = await ctx.clientBarrier("beta1-după-subscriere");
  const subs = requests.filter(r => r.method === "eth_subscribe");
  const observations: Record<string, unknown> = {
    metadataSource: def.source ?? "gecko",
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
  const kindKey = `${chain.id}:${def.kind}`;
  const kindMarkedBefore = st.wsLastMessageAtByKind.has(kindKey);
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
  if (d.perLog[def.swap.transactionHash].sent !== 1) reasons.push("logul controlului nu a fost trimis exact o dată prin filtru");
  if (before !== 0) reasons.push("existau swapuri înregistrate înainte de livrare");
  if (def.strict) {
    // Control STRICT (felia T1 / T2): recepție exact o dată, marcaj per-kind, verificări GLOBALE.
    const strict = def.strict;
    const swapTotal = [...st.wsFlow.values()].reduce((n, evs) => n + evs.length, 0);
    const lpTotal = [...st.lpEvents.values()].reduce((n, evs) => n + evs.length, 0);
    const consoleTexts = ctx.cons.lines().map(l => l.text);
    const swapLinesAll = consoleTexts.filter(t => /\[V[234] SWAP [^\]]*\]/.test(t)).length;
    const lpLines = consoleTexts.filter(t => /\b(?:V3 )?LP (?:ADD|REMOVE) [^\]]*\]/.test(t)).length;
    const fieldLines = strict.lineField ? consoleTexts.filter(t => t.includes(def.linePrefix) && t.includes(strict.lineField as string)).length : null;
    const kindMarkedAfter = st.wsLastMessageAtByKind.has(kindKey);
    Object.assign(observations, {
      swapReceived: d.perLog[def.swap.transactionHash].received,
      kindMarkedBefore, kindMarkedAfter, swapsAllKeys: swapTotal, lpEventsAllKeys: lpTotal,
      swapLogLinesAllChains: swapLinesAll, lpLogLines: lpLines, lineFieldLines: fieldLines,
    });
    if (d.perLog[def.swap.transactionHash].received !== 1) reasons.push("logul controlului nu a fost primit exact o dată de worker");
    if (kindMarkedBefore) reasons.push(`wsLastMessageAtByKind era deja marcat pentru ${kindKey} înainte de livrare`);
    if (!kindMarkedAfter) reasons.push(`wsLastMessageAtByKind nu a fost marcat pentru ${kindKey}`);
    if (strict.none || strict.diagLine !== undefined) {
      // Forma trunchiată (`none`) sau rutarea diagnostică (`diagLine`, felia V4L): NICIO înregistrare, nicăieri.
      if (swapTotal !== 0) reasons.push(`swapuri înregistrate în wsFlow, pe toate cheile: ${swapTotal} (se cer 0)`);
      if (lpTotal !== 0) reasons.push(`evenimente LP pe toate cheile: ${lpTotal} (se cer 0)`);
      if (swapLinesAll !== 0) reasons.push(`linii de swap în consolă, pe toate chain-urile: ${swapLinesAll} (se cer 0)`);
      if (lpLines !== 0) reasons.push(`linii LP în consolă, pe toate chain-urile: ${lpLines} (se cer 0)`);
      if (strict.diagLine !== undefined) {
        // Exact o linie diagnostică pe toată consola (același prefix, ex. `[V4 LIQ]`), identică cu linia așteptată.
        const diag = strict.diagLine;
        const diagPrefix = diag.slice(0, diag.indexOf("]") + 1);
        const diagLines = consoleTexts.filter(t => t.startsWith(diagPrefix)).length;
        const exactDiagLines = consoleTexts.filter(t => t === diag).length;
        Object.assign(observations, { diagLines, exactDiagLines });
        if (diagLines !== 1 || exactDiagLines !== 1) {
          reasons.push(`linii ${diagPrefix} în consolă: ${diagLines}, dintre care identice cu linia exactă așteptată ${exactDiagLines} (se cere exact 1 și 1)`);
        }
      }
    } else if (def.lp) {
      // LP strict (T2): exact un eveniment LP, cu sensul și suma exacte; ZERO swapuri; linia LP ÎNTREAGĂ, exactă.
      const lpEv = st.lpEvents.get(chain.id, def.pair) ?? [];
      const exactLpLines = consoleTexts.filter(t => t === def.linePrefix).length;
      Object.assign(observations, {
        lpEventsRecorded: lpEv.length, lpRecorded: lpEv.map(e => ({ isAdd: e.isAdd, ethAmount: e.ethAmount })),
        exactLpLines, reserveEth: st.poolLiquidity.get(chain.id, def.pair)?.reserveEth ?? null,
      });
      if (lpEv.length !== 1) reasons.push(`evenimente LP înregistrate: ${lpEv.length} (se cere exact 1)`);
      else {
        if (lpEv[0].isAdd !== def.lp.isAdd) reasons.push(`sens LP înregistrat: ${lpEv[0].isAdd ? "adăugare" : "retragere"}`);
        if (!near(lpEv[0].ethAmount, def.lp.ethAmount)) reasons.push(`sumă nativă LP înregistrată: ${lpEv[0].ethAmount} (așteptat ${def.lp.ethAmount})`);
        if (lpTotal !== 1) reasons.push(`evenimente LP pe toate cheile: ${lpTotal} (se cere exact 1, cel al perechii controlului)`);
      }
      if (swapTotal !== 0) reasons.push(`swapuri înregistrate în wsFlow, pe toate cheile: ${swapTotal} (se cer 0)`);
      if (swapLinesAll !== 0) reasons.push(`linii de swap în consolă, pe toate chain-urile: ${swapLinesAll} (se cer 0)`);
      if (exactLpLines !== 1 || lpLines !== 1) reasons.push(`linii LP în consolă: ${lpLines}, dintre care identice cu linia exactă așteptată ${exactLpLines} (se cere exact 1 și 1)`);
    } else {
      if (!def.expected) throw new Error("control strict de swap fără valori așteptate");
      if (events.length !== 1) reasons.push(`swapuri înregistrate: ${events.length} (se cere exact 1)`);
      else {
        const e = events[0];
        if (e.isBuy !== def.expected.isBuy) reasons.push(`direcție înregistrată: ${e.isBuy ? "BUY" : "SELL"}`);
        if (!near(e.ethAmount, def.expected.ethAmount)) reasons.push(`sumă nativă înregistrată: ${e.ethAmount} (așteptat ${def.expected.ethAmount})`);
        if (typeof e.usdAmount !== "number" || !near(e.usdAmount, def.expected.usdAmount)) reasons.push(`sumă USD înregistrată: ${String(e.usdAmount)} (așteptat ${def.expected.usdAmount})`);
        if (swapTotal !== 1) reasons.push(`swapuri înregistrate în wsFlow, pe toate cheile: ${swapTotal} (se cere exact 1, cel al perechii controlului)`);
      }
      if (lpTotal !== 0) reasons.push(`evenimente LP pe toate cheile: ${lpTotal} (se cer 0)`);
      if (lines !== 1 || swapLinesAll !== 1) reasons.push(`linii de swap în consolă, pe toate chain-urile: ${swapLinesAll}, dintre care cu prefixul așteptat ${lines} (se cere exact 1 și 1)`);
      else if (fieldLines !== 1) reasons.push(`linia de swap nu conține câmpul ${String(strict.lineField)}`);
      if (lpLines !== 0) reasons.push(`linii LP în consolă, pe toate chain-urile: ${lpLines} (se cer 0)`);
    }
  } else if (def.lp) {
    // Control LP: exact un eveniment LP, pe perechea controlului, cu sensul și suma exacte; ZERO swapuri.
    // Verificările sunt GLOBALE (toate cheile `wsFlow` / `lpEvents`, toate liniile din consolă, orice chain): un
    // swap sau un eveniment LP înregistrat sub altă pereche sau alt chain nu poate trece neobservat.
    const lpEv = st.lpEvents.get(chain.id, def.pair) ?? [];
    const lpTotal = [...st.lpEvents.values()].reduce((n, evs) => n + evs.length, 0);
    const swapTotal = [...st.wsFlow.values()].reduce((n, evs) => n + evs.length, 0);
    const consoleTexts = ctx.cons.lines().map(l => l.text);
    const swapLinesAll = consoleTexts.filter(t => /\[V[234] SWAP [^\]]*\]/.test(t)).length;
    const lpLines = consoleTexts.filter(t => /\b(?:V3 )?LP (?:ADD|REMOVE) [^\]]*\]/.test(t)).length;
    Object.assign(observations, {
      lpEventsRecorded: lpEv.length, lpEventsAllKeys: lpTotal, lpRecorded: lpEv.map(e => ({ isAdd: e.isAdd, ethAmount: e.ethAmount })),
      lpLogLines: lpLines, swapsAllKeys: swapTotal, swapLogLinesAllChains: swapLinesAll,
      reserveEth: st.poolLiquidity.get(chain.id, def.pair)?.reserveEth ?? null,
    });
    if (lpEv.length !== 1) reasons.push(`evenimente LP înregistrate: ${lpEv.length} (se cere exact 1)`);
    else {
      if (lpEv[0].isAdd !== def.lp.isAdd) reasons.push(`sens LP înregistrat: ${lpEv[0].isAdd ? "adăugare" : "retragere"}`);
      if (!near(lpEv[0].ethAmount, def.lp.ethAmount)) reasons.push(`sumă nativă LP înregistrată: ${lpEv[0].ethAmount} (așteptat ${def.lp.ethAmount})`);
      if (lpTotal !== 1) reasons.push(`evenimente LP pe toate cheile: ${lpTotal} (se cere exact 1, cel al perechii controlului)`);
    }
    if (swapTotal !== 0) reasons.push(`swapuri înregistrate în wsFlow, pe toate cheile: ${swapTotal} (se cer 0)`);
    if (swapLinesAll !== 0) reasons.push(`linii de swap în consolă, pe toate chain-urile: ${swapLinesAll} (se cer 0)`);
    if (lines !== 1 || lpLines !== 1) reasons.push(`linii LP în consolă: ${lpLines}, dintre care cu textul exact așteptat ${lines} (se cere exact 1 și 1)`);
  } else {
    if (!def.expected) throw new Error("control de swap fără valori așteptate");
    if (events.length !== 1) reasons.push(`swapuri înregistrate: ${events.length} (se cere exact 1)`);
    else {
      const e = events[0];
      if (e.isBuy !== def.expected.isBuy) reasons.push(`direcție înregistrată: ${e.isBuy ? "BUY" : "SELL"}`);
      if (!near(e.ethAmount, def.expected.ethAmount)) reasons.push(`sumă nativă înregistrată: ${e.ethAmount} (așteptat ${def.expected.ethAmount})`);
      if (typeof e.usdAmount !== "number" || !near(e.usdAmount, def.expected.usdAmount)) reasons.push(`sumă USD înregistrată: ${String(e.usdAmount)} (așteptat ${def.expected.usdAmount})`);
    }
    if (lines !== 1 || swapLines !== 1) reasons.push(`linii de swap în consolă: ${swapLines}, dintre care cu prefixul așteptat ${lines} (se cere exact 1 și 1)`);
  }
  if (!st.wsLastMessageAt.has(chain.id)) reasons.push("wsLastMessageAt nu a fost marcat");

  return reasons.length === 0
    ? { outcome: "CONTROL_OK", reasons: [], observations }
    : { outcome: "CONTROL_FAILED", reasons, observations };
}
