/**
 * scripts/beta1/harness/evmFixturesDefects.ts — BETA-1, felia 4: fixture sintetice pentru CAZURILE DE DEFECT.
 *
 * Completează `evmFixtures.ts` (neschimbat) cu ce cer cazurile din §7.2–§7.7 ale designului: pool în forma
 * DexScreener, pereche în forma registrului indexerului, loguri ale altor DEX-uri și loguri LP.
 *
 * Felia T1: logurile controalelor `C-PANCAKE-*` (swap PancakeSwap V3 complet, BUY/SELL, și forma trunchiată).
 *
 * Ca în `evmFixtures.ts`: totul e scris INDEPENDENT de produs. Topicurile sunt keccak-256 al semnăturii din
 * comentariu; nu se citesc din constantele din `src/` și nu se calculează cu funcții din `src/`.
 *
 * LIMITĂ: logurile sunt construite din ABI, nu capturate de pe chain. Pur: fără I/O. NU importă nimic din `src/`.
 */

import type { RpcLog } from "./localNode";
import { TOKEN, WETH_BASE, E18, uint256Word, int256Word, swapV2Log, foreignLog } from "./evmFixtures";

// ── Adrese ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Pool V2 folosit de D1 și de D1-CONTROL: aceeași adresă, același log; diferă doar sursa metadatelor. */
export const POOL_D1 = "0x" + "d1".repeat(20);
/** Pool PancakeSwap V3 (T1, T1-LP, T1-FORCED — retrase; controalele `C-PANCAKE-*`). */
export const POOL_PANCAKE_V3 = "0x" + "ca".repeat(20);
/** Pool Aerodrome clasic, pe ruta V2 (T2). */
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
/** `Mint(address,address,int24,int24,uint128,uint256,uint256)` — Uniswap V3 și PancakeSwap V3 (aceeași semnătură) */
export const T_MINT_V3 = "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde";
/** `Burn(address,int24,int24,uint128,uint256,uint256)` — Uniswap V3 și PancakeSwap V3 (felia T1: lista exactă a filtrului V3) */
export const T_BURN_V3 = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";
/** `Mint(address,uint256,uint256)` — Uniswap V2 (felia D1: controlul LP de adăugare) */
export const T_MINT_V2 = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
/** `Burn(address,uint256,uint256,address)` — Uniswap V2 (felia D1: controlul LP de retragere) */
export const T_BURN_V2 = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";

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

/** Controale proprii ale fixture-urilor de aici. Întoarce lista problemelor (goală = în regulă). */
export function defectFixturesSelfCheck(): string[] {
  const p: string[] = [];
  for (const [name, t] of [["T_SWAP_PANCAKE_V3", T_SWAP_PANCAKE_V3], ["T_SWAP_SOLIDLY", T_SWAP_SOLIDLY], ["T_MINT_V3", T_MINT_V3], ["T_BURN_V3", T_BURN_V3]] as const) {
    if (!/^0x[0-9a-f]{64}$/.test(t)) p.push(`${name} nu e un topic valid`);
  }
  if (new Set([T_SWAP_PANCAKE_V3, T_SWAP_SOLIDLY, T_MINT_V3, T_MINT_V2, T_BURN_V2, T_BURN_V3]).size !== 6) p.push("topicuri identice");
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
  const ds = dsPair(POOL_D1, "uniswap");
  if (typeof ds.baseToken !== "object" || typeof ds.quoteToken !== "object") p.push("forma DexScreener: base/quote trebuie să fie obiecte");
  return p;
}
