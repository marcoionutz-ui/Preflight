/**
 * scripts/beta1/harness/evmFixturesDefects.ts — BETA-1, felia 4: fixture sintetice pentru CAZURILE DE DEFECT.
 *
 * Completează `evmFixtures.ts` (neschimbat) cu ce cer cazurile din §7.2–§7.7 ale designului: pool în forma
 * DexScreener, pereche în forma registrului indexerului, loguri ale altor DEX-uri și loguri LP.
 *
 * Felia T1: logurile controalelor `C-PANCAKE-*` (swap PancakeSwap V3 complet, BUY/SELL, și forma trunchiată).
 * Felia T2: logurile controalelor `C-AERO-*` (Aerodrome clasic: Swap, Mint, Burn; forme trunchiate, cu surplus și
 * cu date ne-șir). Sursa semnăturilor: aerodrome-finance/contracts @ 1ba30815, `contracts/interfaces/IPool.sol`.
 * Felia V4L: logul controlului `C-V4-LIQ` (Uniswap V4 `ModifyLiquidity`, eveniment ABI complet) și geamănul lui cu
 * topicul vechi al produsului (`DecreaseLiquidity` din V3 NPM). Sursa: Uniswap/v4-core @ 46c68346,
 * `src/interfaces/IPoolManager.sol` L63–L72 (`PoolId` = `bytes32`, `src/types/PoolId.sol` L6).
 *
 * Ca în `evmFixtures.ts`: totul e scris INDEPENDENT de produs. Topicurile sunt keccak-256 al semnăturii din
 * comentariu; nu se citesc din constantele din `src/` și nu se calculează cu funcții din `src/`.
 *
 * LIMITĂ: logurile sunt construite din ABI, nu capturate de pe chain. Pur: fără I/O. NU importă nimic din `src/`.
 */

import type { RpcLog } from "./localNode";
import { TOKEN, WETH_BASE, E18, uint256Word, int256Word, swapV2Log, foreignLog, V4_POOL_MANAGER_BASE, POOL_V4_ID } from "./evmFixtures";

// ── Adrese ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Pool V2 folosit de D1 și de D1-CONTROL: aceeași adresă, același log; diferă doar sursa metadatelor. */
export const POOL_D1 = "0x" + "d1".repeat(20);
/** Pool PancakeSwap V3 (T1, T1-LP, T1-FORCED — retrase; controalele `C-PANCAKE-*`). */
export const POOL_PANCAKE_V3 = "0x" + "ca".repeat(20);
/** Pool Aerodrome clasic, pe ruta V2 (T2 — retras; controalele `C-AERO-*`). */
export const POOL_AERO_V2 = "0x" + "ae".repeat(20);
/** Pereche din registrul indexerului (X1). */
export const POOL_INDEXED = "0x" + "e1".repeat(20);

const SENDER = "0x" + "00".repeat(12) + "5e".repeat(20);
const TICK_LOWER = "0x" + int256Word(-600n);
const TICK_UPPER = "0x" + int256Word(600n);
const txHash = (n: number): string => "0x" + n.toString(16).padStart(64, "0");

// ── Topicuri: keccak-256 al semnăturii din comentariu ─────────────────────────────────────────────────────────
/** `Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)` — PancakeSwap V3 */
export const T_SWAP_PANCAKE_V3 = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
/** `Swap(address,address,uint256,uint256,uint256,uint256)` — Solidly / Aerodrome clasic */
export const T_SWAP_SOLIDLY = "0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b";
/** Același topic, numit după ținta testată (Aerodrome clasic, `IPool.sol` @ 1ba30815). */
export const T_SWAP_AERODROME = T_SWAP_SOLIDLY;
/** `Burn(address,address,uint256,uint256)` — Aerodrome clasic (`sender` și `to` indexate; date: amount0, amount1) */
export const T_BURN_AERODROME = "0x5d624aa9c148153ab3446c1b154f660ee7701e549fe9b62dab7171b1c80e6fa2";
/** `Mint(address,address,int24,int24,uint128,uint256,uint256)` — Uniswap V3 și PancakeSwap V3 (aceeași semnătură) */
export const T_MINT_V3 = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
/** `Burn(address,int24,int24,uint128,uint256,uint256)` — Uniswap V3 și PancakeSwap V3 (felia T1: lista exactă a filtrului V3) */
export const T_BURN_V3 = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";
/** `Mint(address,uint256,uint256)` — Uniswap V2 (felia D1: controlul LP de adăugare) */
export const T_MINT_V2 = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
/** `Burn(address,uint256,uint256,address)` — Uniswap V2 (felia D1: controlul LP de retragere) */
export const T_BURN_V2 = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";
/** `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)` — Uniswap V4 PoolManager (felia V4L; `PoolId` = `bytes32`) */
export const T_MODIFY_LIQUIDITY_V4 = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
/** `DecreaseLiquidity(uint256,uint128,uint256,uint256)` — V3 NonfungiblePositionManager: valoarea VECHE, greșită, a constantei V4 din produs */
export const T_DECREASE_LIQUIDITY_V3 = "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";

// ── Pool în forma DexScreener (`/latest/dex/pairs/...`) ──────────────────────────────────────────────────────
export interface DsPairRaw {
  chainId:     string;
  dexId:       string;
  pairAddress: string;
  baseToken:   { address: string; name: string; symbol: string };
  quoteToken:  { address: string; name: string; symbol: string };
  priceUsd:    string;
  priceChange: { m5: number; h1: number; h24: number };
  liquidity:   { usd: number };
  volume:      { h24: number };
  txns:        { m5: { buys: number; sells: number }; h1: { buys: number; sells: number } };
}

/** Pereche brută DexScreener pe `base`, quote WETH. Base și quote sunt OBIECTE `{address, symbol}`, ca în API. */
export function dsPair(address: string, dexId: string): DsPairRaw {
  return {
    chainId: "base", dexId, pairAddress: address,
    baseToken:  { address: TOKEN,     name: "Token", symbol: "TKN" },
    quoteToken: { address: WETH_BASE, name: "Wrapped Ether", symbol: "WETH" },
    priceUsd: "0.5",
    priceChange: { m5: 0, h1: 0, h24: 0 },
    liquidity: { usd: 100_000 },
    volume: { h24: 1_000 },
    txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 } },
  };
}

// ── Pereche în forma registrului indexerului (`preflight:indexed:pair:…`) ────────────────────────────────────
export interface IndexedPairRaw {
  chain: string; dexId: string; pairAddress: string; token0: string; token1: string;
  blockNumber: number; txHash: string; discoveredAt: number;
  baseToken: string; quoteToken: string; baseSymbol: string; quoteSymbol: string;
  priceUsd: number; reserveUsd: number; priceStatus: string; pricedAt: number;
}

export function indexedPair(address: string, dexId: string): IndexedPairRaw {
  return {
    chain: "base", dexId, pairAddress: address, token0: WETH_BASE, token1: TOKEN,
    blockNumber: 1, txHash: txHash(0xe101), discoveredAt: 0,
    baseToken: TOKEN, quoteToken: WETH_BASE, baseSymbol: "TKN", quoteSymbol: "WETH",
    priceUsd: 0.5, reserveUsd: 100_000, priceStatus: "OK", pricedAt: 0,
  };
}

// ── Loguri ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * PancakeSwap V3 `Swap`: topics [sig, sender, recipient]; data = amount0, amount1 (cu semn, convenția POOL),
 * sqrtPriceX96, liquidity, tick, protocolFeesToken0, protocolFeesToken1 (7 cuvinte — două în plus față de Uniswap V3).
 */
export function swapPancakeV3Log(pool: string, a: { amount0: bigint; amount1: bigint }, n: number): RpcLog {
  return {
    address: pool,
    topics: [T_SWAP_PANCAKE_V3, SENDER, SENDER],
    data: "0x" + int256Word(a.amount0) + int256Word(a.amount1) + uint256Word(1n << 96n) + uint256Word(10n ** 12n)
      + int256Word(0n) + uint256Word(0n) + uint256Word(0n),
    transactionHash: txHash(n),
  };
}

/** Solidly / Aerodrome clasic `Swap`: topics [sig, sender, to]; data = amount0In, amount1In, amount0Out, amount1Out. */
export function swapSolidlyLog(pool: string, a: { amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint }, n: number): RpcLog {
  return {
    address: pool,
    topics: [T_SWAP_SOLIDLY, SENDER, SENDER],
    data: "0x" + uint256Word(a.amount0In) + uint256Word(a.amount1In) + uint256Word(a.amount0Out) + uint256Word(a.amount1Out),
    transactionHash: txHash(n),
  };
}

/** V3 `Mint`: topics [sig, owner, tickLower, tickUpper]; data = sender, amount (lichiditate), amount0, amount1. */
export function mintV3Log(pool: string, a: { amount0: bigint; amount1: bigint }, n: number): RpcLog {
  return {
    address: pool,
    topics: [T_MINT_V3, SENDER, TICK_LOWER, TICK_UPPER],
    data: "0x" + SENDER.slice(2) + uint256Word(10n ** 12n) + uint256Word(a.amount0) + uint256Word(a.amount1),
    transactionHash: txHash(n),
  };
}

// ── Loguri PARTAJATE între un caz de defect și controlul lui pereche (același obiect, nu o copie) ─────────────
/** D1 și D1-CONTROL: cumpărare de 1 WETH pe POOL_D1. */
export const D1_SWAP: RpcLog = swapV2Log(POOL_D1, { amount0In: E18, amount1In: 0n, amount0Out: 0n, amount1Out: 5n * E18 }, 0xd101);
export const D1_TWIN: RpcLog = foreignLog(POOL_D1, null, 0xd102);

/** V2 `Mint`: topics [sig, sender]; data = amount0, amount1. */
export function mintV2Log(pool: string, a: { amount0: bigint; amount1: bigint }, n: number): RpcLog {
  return { address: pool, topics: [T_MINT_V2, SENDER], data: "0x" + uint256Word(a.amount0) + uint256Word(a.amount1), transactionHash: txHash(n) };
}

/** V2 `Burn`: topics [sig, sender, to]; data = amount0, amount1. */
export function burnV2Log(pool: string, a: { amount0: bigint; amount1: bigint }, n: number): RpcLog {
  return { address: pool, topics: [T_BURN_V2, SENDER, SENDER], data: "0x" + uint256Word(a.amount0) + uint256Word(a.amount1), transactionHash: txHash(n) };
}

// ── Felia D1: logurile controalelor pe pool-ul DexScreener (WETH < TOKEN ⇒ WETH e token0, deci amount0 = WETH) ──
/** D1-DS-SELL: vânzare de 0,5 WETH. */
export const D1_SWAP_SELL: RpcLog = swapV2Log(POOL_D1, { amount0In: 0n, amount1In: 3n * E18, amount0Out: E18 / 2n, amount1Out: 0n }, 0xd103);
export const D1_TWIN_SELL: RpcLog = foreignLog(POOL_D1, null, 0xd104);
/** D1-DS-LP-ADD: `Mint` cu 1 WETH. */
export const D1_MINT: RpcLog = mintV2Log(POOL_D1, { amount0: E18, amount1: 5n * E18 }, 0xd105);
export const D1_TWIN_MINT: RpcLog = foreignLog(POOL_D1, null, 0xd106);
/** D1-DS-LP-REMOVE: `Burn` cu 2 WETH, dintr-o rezervă de 20 ETH (liquidity.usd 100 000, preț 2500) ⇒ 10%. */
export const D1_BURN: RpcLog = burnV2Log(POOL_D1, { amount0: 2n * E18, amount1: 10n * E18 }, 0xd107);
export const D1_TWIN_BURN: RpcLog = foreignLog(POOL_D1, null, 0xd108);

// ── Felia T1: logurile controalelor `C-PANCAKE-*` pe POOL_PANCAKE_V3 (WETH < TOKEN ⇒ WETH e token0) ──────────────
/** Cumpărare de 1 WETH (convenția POOL: amount0 pozitiv = WETH intrat în pool). ACELAȘI log ca în T1 (retras). */
export const PANCAKE_SWAP: RpcLog = swapPancakeV3Log(POOL_PANCAKE_V3, { amount0: E18, amount1: -5n * E18 }, 0x7101);
export const PANCAKE_TWIN: RpcLog = foreignLog(POOL_PANCAKE_V3, null, 0x7301);
/** Vânzare de 0,5 WETH. */
export const PANCAKE_SWAP_SELL: RpcLog = swapPancakeV3Log(POOL_PANCAKE_V3, { amount0: -(E18 / 2n), amount1: 3n * E18 }, 0x7302);
export const PANCAKE_TWIN_SELL: RpcLog = foreignLog(POOL_PANCAKE_V3, null, 0x7303);
/**
 * Forma TRUNCHIATĂ: topicul Swap PancakeSwap V3, dar doar primele 5 cuvinte (320 hex) din logul de cumpărare —
 * exact forma unui swap Uniswap V3. Decodorul reparat o refuză tăcut (cere exact 448 hex).
 */
export const PANCAKE_SHORT: RpcLog = { ...PANCAKE_SWAP, data: PANCAKE_SWAP.data.slice(0, 2 + 5 * 64), transactionHash: txHash(0x7304) };
export const PANCAKE_TWIN_SHORT: RpcLog = foreignLog(POOL_PANCAKE_V3, null, 0x7305);

// ── Felia T2: logurile controalelor `C-AERO-*` pe POOL_AERO_V2 (WETH < TOKEN ⇒ WETH e token0) ─────────────────────
/** Aerodrome `Burn`: topics [sig, sender, to]; data = amount0, amount1 (tokenurile ieșite). */
export function burnAerodromeLog(pool: string, a: { amount0: bigint; amount1: bigint }, n: number): RpcLog {
  return { address: pool, topics: [T_BURN_AERODROME, SENDER, SENDER], data: "0x" + uint256Word(a.amount0) + uint256Word(a.amount1), transactionHash: txHash(n) };
}
/** Log cu `data` ne-șir (număr, obiect): forma e invalidă prin construcție; nodul local îl trimite ca atare. */
const withData = (l: RpcLog, data: unknown, n: number): RpcLog => ({ ...l, data: data as string, transactionHash: txHash(n) });

/** Cumpărare de 1 WETH: 1 WETH intră (`amount0In`), 5 TKN ies. ACELAȘI log ca în T2 (retras). */
export const AERO_SWAP: RpcLog = swapSolidlyLog(POOL_AERO_V2, { amount0In: E18, amount1In: 0n, amount0Out: 0n, amount1Out: 5n * E18 }, 0x7201);
export const AERO_TWIN: RpcLog = foreignLog(POOL_AERO_V2, null, 0x7401);
/** Vânzare de 0,5 WETH: 3 TKN intră, 0,5 WETH iese. */
export const AERO_SWAP_SELL: RpcLog = swapSolidlyLog(POOL_AERO_V2, { amount0In: 0n, amount1In: 3n * E18, amount0Out: E18 / 2n, amount1Out: 0n }, 0x7402);
export const AERO_TWIN_SELL: RpcLog = foreignLog(POOL_AERO_V2, null, 0x7403);
/** Swap TRUNCHIAT: primele 3 cuvinte (192 hex) din cumpărare. */
export const AERO_SWAP_SHORT: RpcLog = { ...AERO_SWAP, data: AERO_SWAP.data.slice(0, 2 + 3 * 64), transactionHash: txHash(0x7404) };
export const AERO_TWIN_SHORT: RpcLog = foreignLog(POOL_AERO_V2, null, 0x7405);
/** Swap cu SURPLUS: cumpărarea validă + un cuvânt (320 hex). O parsare permisivă (≥ 256) l-ar înregistra. */
export const AERO_SWAP_LONG: RpcLog = { ...AERO_SWAP, data: AERO_SWAP.data + uint256Word(0n), transactionHash: txHash(0x7406) };
export const AERO_TWIN_LONG: RpcLog = foreignLog(POOL_AERO_V2, null, 0x7407);
/** Swap cu `data` NE-ȘIR (`7`). */
export const AERO_SWAP_NONSTRING: RpcLog = withData(AERO_SWAP, 7, 0x7408);
export const AERO_TWIN_NONSTRING: RpcLog = foreignLog(POOL_AERO_V2, null, 0x7409);
/** `Mint` (topic COMUN cu Uniswap V2) cu 1 WETH. */
export const AERO_MINT: RpcLog = mintV2Log(POOL_AERO_V2, { amount0: E18, amount1: 5n * E18 }, 0x740a);
export const AERO_TWIN_MINT: RpcLog = foreignLog(POOL_AERO_V2, null, 0x740b);
/** `Burn` Aerodrome cu 2 WETH, dintr-o rezervă de 20 ETH (reserve_in_usd 100 000, preț 2500) ⇒ 10%. */
export const AERO_BURN: RpcLog = burnAerodromeLog(POOL_AERO_V2, { amount0: 2n * E18, amount1: 10n * E18 }, 0x740c);
export const AERO_TWIN_BURN: RpcLog = foreignLog(POOL_AERO_V2, null, 0x740d);
/** Burn cu SURPLUS: Burn-ul valid + un cuvânt (192 hex). O parsare permisivă (primele 128) l-ar înregistra. */
export const AERO_BURN_LONG: RpcLog = { ...AERO_BURN, data: AERO_BURN.data + uint256Word(0n), transactionHash: txHash(0x740e) };
export const AERO_TWIN_BURN_LONG: RpcLog = foreignLog(POOL_AERO_V2, null, 0x740f);
/** Burn cu `data` NE-ȘIR (`{}`). */
export const AERO_BURN_NONSTRING: RpcLog = withData(AERO_BURN, {}, 0x7410);
export const AERO_TWIN_BURN_NONSTRING: RpcLog = foreignLog(POOL_AERO_V2, null, 0x7411);

// ── Felia V4L: logul controlului `C-V4-LIQ` pe POOL_V4_ID, emis de PoolManager-ul Base ──────────────────────────────
/**
 * Uniswap V4 `ModifyLiquidity`: topics [sig, id (PoolId), sender]; data = tickLower, tickUpper (int24 extinse cu semn pe
 * 256 de biți), liquidityDelta (int256), salt (bytes32) = 4 cuvinte, 256 hex.
 */
export function modifyLiquidityV4Log(poolId: string, a: { tickLower: bigint; tickUpper: bigint; liquidityDelta: bigint; salt: bigint }, n: number): RpcLog {
  return {
    address: V4_POOL_MANAGER_BASE,
    topics: [T_MODIFY_LIQUIDITY_V4, poolId, SENDER],
    data: "0x" + int256Word(a.tickLower) + int256Word(a.tickUpper) + int256Word(a.liquidityDelta) + uint256Word(a.salt),
    transactionHash: txHash(n),
  };
}
/** Adăugare de lichiditate (delta 10^18) pe intervalul [-600, 600]. Valoarea delta nu contează pentru ramura diagnostică. */
export const V4L_LOG: RpcLog = modifyLiquidityV4Log(POOL_V4_ID, { tickLower: -600n, tickUpper: 600n, liquidityDelta: E18, salt: 1n }, 0x7601);
/**
 * Geamănul: ACELAȘI eveniment (adresă, pool, date), cu topicul VECHI al produsului și `transactionHash` DISTINCT — runtime-ul
 * numără livrările după hash-ul tranzacției; cu același hash, contoarele geamănului și ale logului s-ar uni.
 */
export const V4L_TWIN_OLD_TOPIC: RpcLog = { ...V4L_LOG, topics: [T_DECREASE_LIQUIDITY_V3, ...V4L_LOG.topics.slice(1)], transactionHash: txHash(0x7602) };
/** Linia diagnostică EXACTĂ a ramurii `[V4 LIQ]` pentru `V4L_LOG` (simbolul pool-ului din `memory`: TKN). */
export const V4L_DIAG_LINE = `[V4 LIQ] TKN len=256 data=${V4L_LOG.data.slice(2, 2 + 192)} tx=${V4L_LOG.transactionHash}`;

// ── Felia V4LR: `data` null / absent / ne-șir pe ramura `[V4 LIQ]` (design `BETA1_V4LR_ROBUSTNESS_DESIGN.md` rev1, §3) ──
// Același eveniment ca `V4L_LOG` (PoolManager, pool, topicuri), cu un singur lucru schimbat: câmpul `data`. După fix,
// toate se comportă ca `null`/absent: exact linia `len=0 data=` și nimic înregistrat. Fiecare log are geamănul lui cu
// topicul VECHI (aceleași date sau aceeași absență) și un `transactionHash` DISTINCT (0x7603–0x760c).
/** Log cu câmpul `data` ȘTERS: cheia lipsește din obiect, deci și din JSON-ul trimis de nodul local. */
const withoutData = (l: RpcLog, n: number): RpcLog => {
  const o: Record<string, unknown> = { ...l, transactionHash: txHash(n) };
  delete o.data;
  return o as unknown as RpcLog;
};
/** Geamănul cu topicul VECHI (`DecreaseLiquidity` V3): același eveniment, alt `transactionHash`. */
const v4lTwin = (l: RpcLog, n: number): RpcLog => ({ ...l, topics: [T_DECREASE_LIQUIDITY_V3, ...l.topics.slice(1)], transactionHash: txHash(n) });
/** Linia diagnostică EXACTĂ pentru date goale (`len=0`), pe tranzacția logului. */
const v4lEmptyLine = (l: RpcLog): string => `[V4 LIQ] TKN len=0 data= tx=${l.transactionHash}`;

export const V4L_NULL: RpcLog = withData(V4L_LOG, null, 0x7603);
export const V4L_TWIN_NULL: RpcLog = v4lTwin(V4L_NULL, 0x7604);
export const V4L_NODATA: RpcLog = withoutData(V4L_LOG, 0x7605);
export const V4L_TWIN_NODATA: RpcLog = v4lTwin(V4L_NODATA, 0x7606);
export const V4L_NUM: RpcLog = withData(V4L_LOG, 7, 0x7607);
export const V4L_TWIN_NUM: RpcLog = v4lTwin(V4L_NUM, 0x7608);
export const V4L_OBJ: RpcLog = withData(V4L_LOG, {}, 0x7609);
export const V4L_TWIN_OBJ: RpcLog = v4lTwin(V4L_OBJ, 0x760a);
/** Matricea NU aruncă pe baseline: `["a","b","c"].slice(2)` = `["c"]` → linia veche `len=1 data=c` (schimbare documentată). */
export const V4L_ARRAY: RpcLog = withData(V4L_LOG, ["a", "b", "c"], 0x760b);
export const V4L_TWIN_ARRAY: RpcLog = v4lTwin(V4L_ARRAY, 0x760c);
export const V4L_NULL_LINE = v4lEmptyLine(V4L_NULL);
export const V4L_NODATA_LINE = v4lEmptyLine(V4L_NODATA);
export const V4L_NUM_LINE = v4lEmptyLine(V4L_NUM);
export const V4L_OBJ_LINE = v4lEmptyLine(V4L_OBJ);
export const V4L_ARRAY_LINE = v4lEmptyLine(V4L_ARRAY);

/** Controale proprii ale fixture-urilor de aici. Întoarce lista problemelor (goală = în regulă). */
export function defectFixturesSelfCheck(): string[] {
  const p: string[] = [];
  for (const [name, t] of [["T_SWAP_PANCAKE_V3", T_SWAP_PANCAKE_V3], ["T_SWAP_SOLIDLY", T_SWAP_SOLIDLY], ["T_MINT_V3", T_MINT_V3], ["T_BURN_V3", T_BURN_V3], ["T_BURN_AERODROME", T_BURN_AERODROME]] as const) {
    if (!/^0x[0-9a-f]{64}$/.test(t)) p.push(`${name} nu e un topic valid`);
  }
  if (new Set([T_SWAP_PANCAKE_V3, T_SWAP_SOLIDLY, T_MINT_V3, T_MINT_V2, T_BURN_V2, T_BURN_V3, T_BURN_AERODROME]).size !== 7) p.push("topicuri identice");
  for (const [name, l] of [["D1_MINT", D1_MINT], ["D1_BURN", D1_BURN]] as const) {
    if (l.data.length !== 2 + 2 * 64 || l.topics.some(t => t.length !== 66)) p.push(`forma logului ${name}`);
  }
  if (swapPancakeV3Log(POOL_PANCAKE_V3, { amount0: 1n, amount1: -1n }, 1).data.length !== 2 + 7 * 64) p.push("lungimea datelor PancakeSwap V3");
  if (swapSolidlyLog(POOL_AERO_V2, { amount0In: 1n, amount1In: 0n, amount0Out: 0n, amount1Out: 1n }, 1).data.length !== 2 + 4 * 64) p.push("lungimea datelor Solidly");
  const mint = mintV3Log(POOL_PANCAKE_V3, { amount0: 1n, amount1: 1n }, 1);
  if (mint.data.length !== 2 + 4 * 64 || mint.topics.length !== 4 || mint.topics.some(t => t.length !== 66)) p.push("forma logului Mint V3");
  for (const [name, a] of [["POOL_D1", POOL_D1], ["POOL_PANCAKE_V3", POOL_PANCAKE_V3], ["POOL_AERO_V2", POOL_AERO_V2], ["POOL_INDEXED", POOL_INDEXED]] as const) {
    if (!/^0x[0-9a-f]{40}$/.test(a)) p.push(`${name} nu e o adresă validă`);
  }
  // Felia T1: formele logurilor Pancake ale controalelor.
  for (const [name, l] of [["PANCAKE_SWAP", PANCAKE_SWAP], ["PANCAKE_SWAP_SELL", PANCAKE_SWAP_SELL]] as const) {
    if (l.data.length !== 2 + 7 * 64 || l.topics[0] !== T_SWAP_PANCAKE_V3) p.push(`forma logului ${name}`);
  }
  if (PANCAKE_SHORT.data.length !== 2 + 5 * 64 || PANCAKE_SHORT.topics[0] !== T_SWAP_PANCAKE_V3 || !PANCAKE_SWAP.data.startsWith(PANCAKE_SHORT.data)) p.push("forma logului PANCAKE_SHORT");
  if (new Set([PANCAKE_SWAP, PANCAKE_TWIN, PANCAKE_SWAP_SELL, PANCAKE_TWIN_SELL, PANCAKE_SHORT, PANCAKE_TWIN_SHORT].map(l => l.transactionHash)).size !== 6) p.push("hash-uri de tranzacție Pancake duplicate");
  // Felia T2: formele logurilor Aerodrome ale controalelor.
  const aeroLen: Array<[string, RpcLog, string, number | null]> = [
    ["AERO_SWAP", AERO_SWAP, T_SWAP_AERODROME, 4 * 64], ["AERO_SWAP_SELL", AERO_SWAP_SELL, T_SWAP_AERODROME, 4 * 64],
    ["AERO_SWAP_SHORT", AERO_SWAP_SHORT, T_SWAP_AERODROME, 3 * 64], ["AERO_SWAP_LONG", AERO_SWAP_LONG, T_SWAP_AERODROME, 5 * 64],
    ["AERO_SWAP_NONSTRING", AERO_SWAP_NONSTRING, T_SWAP_AERODROME, null],
    ["AERO_MINT", AERO_MINT, T_MINT_V2, 2 * 64], ["AERO_BURN", AERO_BURN, T_BURN_AERODROME, 2 * 64],
    ["AERO_BURN_LONG", AERO_BURN_LONG, T_BURN_AERODROME, 3 * 64], ["AERO_BURN_NONSTRING", AERO_BURN_NONSTRING, T_BURN_AERODROME, null],
  ];
  for (const [name, l, topic, hexLen] of aeroLen) {
    const okData = hexLen === null ? typeof l.data !== "string" : typeof l.data === "string" && l.data.length === 2 + hexLen;
    if (!okData || l.topics[0] !== topic || l.address !== POOL_AERO_V2) p.push(`forma logului ${name}`);
  }
  if (!AERO_SWAP_LONG.data.startsWith(AERO_SWAP.data) || !AERO_SWAP.data.startsWith(AERO_SWAP_SHORT.data) || !AERO_BURN_LONG.data.startsWith(AERO_BURN.data)) p.push("formele Aerodrome derivate nu pornesc de la logul valid");
  const aeroAll = [AERO_SWAP, AERO_TWIN, AERO_SWAP_SELL, AERO_TWIN_SELL, AERO_SWAP_SHORT, AERO_TWIN_SHORT, AERO_SWAP_LONG, AERO_TWIN_LONG,
    AERO_SWAP_NONSTRING, AERO_TWIN_NONSTRING, AERO_MINT, AERO_TWIN_MINT, AERO_BURN, AERO_TWIN_BURN, AERO_BURN_LONG, AERO_TWIN_BURN_LONG,
    AERO_BURN_NONSTRING, AERO_TWIN_BURN_NONSTRING];
  if (new Set(aeroAll.map(l => l.transactionHash)).size !== aeroAll.length) p.push("hash-uri de tranzacție Aerodrome duplicate");
  // Felia V4L: forma logului `ModifyLiquidity` și a geamănului cu topicul vechi.
  for (const [name, t] of [["T_MODIFY_LIQUIDITY_V4", T_MODIFY_LIQUIDITY_V4], ["T_DECREASE_LIQUIDITY_V3", T_DECREASE_LIQUIDITY_V3]] as const) {
    if (!/^0x[0-9a-f]{64}$/.test(t)) p.push(`${name} nu e un topic valid`);
  }
  if (new Set<string>([T_MODIFY_LIQUIDITY_V4, T_DECREASE_LIQUIDITY_V3]).size !== 2) p.push("topicurile V4L identice");
  if (V4L_LOG.data.length !== 2 + 4 * 64 || V4L_LOG.topics.length !== 3 || V4L_LOG.topics.some(t => t.length !== 66)
    || V4L_LOG.topics[0] !== T_MODIFY_LIQUIDITY_V4 || V4L_LOG.topics[1] !== POOL_V4_ID || V4L_LOG.address !== V4_POOL_MANAGER_BASE) p.push("forma logului V4L_LOG");
  if (V4L_LOG.data.slice(2, 66) !== "f".repeat(61) + "da8") p.push("tickLower (-600) nu e codificat în complement față de doi");
  if (V4L_TWIN_OLD_TOPIC.topics[0] !== T_DECREASE_LIQUIDITY_V3 || V4L_TWIN_OLD_TOPIC.data !== V4L_LOG.data
    || V4L_TWIN_OLD_TOPIC.address !== V4L_LOG.address || V4L_TWIN_OLD_TOPIC.topics[1] !== V4L_LOG.topics[1]) p.push("forma geamănului V4L");
  if (V4L_TWIN_OLD_TOPIC.transactionHash === V4L_LOG.transactionHash) p.push("geamănul V4L are același transactionHash ca logul");
  if (!V4L_DIAG_LINE.endsWith(` tx=${V4L_LOG.transactionHash}`) || V4L_DIAG_LINE.length !== "[V4 LIQ] TKN len=256 data=".length + 192 + 4 + 66) p.push("forma liniei diagnostice V4L");
  // Felia V4LR: un singur lucru schimbat față de V4L_LOG (câmpul `data`); gemeni cu topicul vechi; hash-uri distincte.
  const v4lr: Array<[string, RpcLog, RpcLog, string, (d: unknown) => boolean, boolean]> = [
    ["V4L_NULL", V4L_NULL, V4L_TWIN_NULL, V4L_NULL_LINE, d => d === null, true],
    ["V4L_NODATA", V4L_NODATA, V4L_TWIN_NODATA, V4L_NODATA_LINE, d => d === undefined, false],
    ["V4L_NUM", V4L_NUM, V4L_TWIN_NUM, V4L_NUM_LINE, d => d === 7, true],
    ["V4L_OBJ", V4L_OBJ, V4L_TWIN_OBJ, V4L_OBJ_LINE, d => typeof d === "object" && d !== null && !Array.isArray(d) && Object.keys(d).length === 0, true],
    ["V4L_ARRAY", V4L_ARRAY, V4L_TWIN_ARRAY, V4L_ARRAY_LINE, d => Array.isArray(d) && JSON.stringify(d) === '["a","b","c"]', true],
  ];
  for (const [name, l, twin, line, dataOk, hasKey] of v4lr) {
    const d = (l as unknown as { data?: unknown }).data;
    if (!dataOk(d) || ("data" in l) !== hasKey || l.address !== V4L_LOG.address || JSON.stringify(l.topics) !== JSON.stringify(V4L_LOG.topics)) p.push(`forma logului ${name}`);
    if (twin.topics[0] !== T_DECREASE_LIQUIDITY_V3 || twin.address !== l.address || JSON.stringify(twin.topics.slice(1)) !== JSON.stringify(l.topics.slice(1))
      || ("data" in twin) !== hasKey || JSON.stringify((twin as unknown as { data?: unknown }).data) !== JSON.stringify(d)) p.push(`forma geamănului ${name}`);
    if (line !== `[V4 LIQ] TKN len=0 data= tx=${l.transactionHash}`) p.push(`linia așteptată pentru ${name}`);
  }
  const v4lAll = [V4L_LOG, V4L_TWIN_OLD_TOPIC, ...v4lr.flatMap(([, l, t]) => [l, t])];
  if (new Set(v4lAll.map(l => l.transactionHash)).size !== v4lAll.length) p.push("hash-uri de tranzacție V4L/V4LR duplicate");
  const ds = dsPair(POOL_D1, "uniswap");
  if (typeof ds.baseToken !== "object" || typeof ds.quoteToken !== "object") p.push("forma DexScreener: base/quote trebuie să fie obiecte");
  return p;
}
