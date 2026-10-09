/**
 * scripts/beta1/harness/evmFixturesDefects.ts — BETA-1, felia 4: fixture sintetice pentru CAZURILE DE DEFECT.
 *
 * Completează `evmFixtures.ts` (neschimbat) cu ce cer cazurile din §7.2–§7.7 ale designului: pool în forma
 * DexScreener, pereche în forma registrului indexerului, loguri ale altor DEX-uri și loguri LP.
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
/** Pool PancakeSwap V3 (T1, T1-LP, T1-FORCED). */
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

/** Controale proprii ale fixture-urilor de aici. Întoarce lista problemelor (goală = în regulă). */
export function defectFixturesSelfCheck(): string[] {
  const p: string[] = [];
  for (const [name, t] of [["T_SWAP_PANCAKE_V3", T_SWAP_PANCAKE_V3], ["T_SWAP_SOLIDLY", T_SWAP_SOLIDLY], ["T_MINT_V3", T_MINT_V3]] as const) {
    if (!/^0x[0-9a-f]{64}$/.test(t)) p.push(`${name} nu e un topic valid`);
  }
  if (new Set([T_SWAP_PANCAKE_V3, T_SWAP_SOLIDLY, T_MINT_V3]).size !== 3) p.push("topicuri identice");
  if (swapPancakeV3Log(POOL_PANCAKE_V3, { amount0: 1n, amount1: -1n }, 1).data.length !== 2 + 7 * 64) p.push("lungimea datelor PancakeSwap V3");
  if (swapSolidlyLog(POOL_AERO_V2, { amount0In: 1n, amount1In: 0n, amount0Out: 0n, amount1Out: 1n }, 1).data.length !== 2 + 4 * 64) p.push("lungimea datelor Solidly");
  const mint = mintV3Log(POOL_PANCAKE_V3, { amount0: 1n, amount1: 1n }, 1);
  if (mint.data.length !== 2 + 4 * 64 || mint.topics.length !== 4 || mint.topics.some(t => t.length !== 66)) p.push("forma logului Mint V3");
  for (const [name, a] of [["POOL_D1", POOL_D1], ["POOL_PANCAKE_V3", POOL_PANCAKE_V3], ["POOL_AERO_V2", POOL_AERO_V2], ["POOL_INDEXED", POOL_INDEXED]] as const) {
    if (!/^0x[0-9a-f]{40}$/.test(a)) p.push(`${name} nu e o adresă validă`);
  }
  const ds = dsPair(POOL_D1, "uniswap");
  if (typeof ds.baseToken !== "object" || typeof ds.quoteToken !== "object") p.push("forma DexScreener: base/quote trebuie să fie obiecte");
  return p;
}
