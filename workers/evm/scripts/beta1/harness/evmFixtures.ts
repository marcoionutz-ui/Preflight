/**
 * scripts/beta1/harness/evmFixtures.ts — BETA-1, felia 3: fixture EVM sintetice pentru cazuri.
 *
 * Tot ce e aici e scris INDEPENDENT de produs: adrese, topicuri (din semnăturile ABI), codări de cuvinte.
 * Valorile NU se calculează cu funcții din `src/` și nu se citesc din constantele lui — dacă produsul și fixture-ul
 * nu se potrivesc, un control pozitiv eșuează, ceea ce e exact rostul lui.
 *
 * LIMITĂ: logurile sunt construite din ABI, nu capturate de pe chain. Dovedesc codul față de ABI.
 * Pur: fără I/O. NU importă nimic din `src/`.
 */

import type { RpcLog } from "./localNode";

// ── Adrese (Base) ────────────────────────────────────────────────────────────────────────────────────────────
export const WETH_BASE = "0x4200000000000000000000000000000000000006";
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** PoolManager Uniswap V4 pe Base. */
export const V4_POOL_MANAGER_BASE = "0x498581ff718922c3f8e6a244956af099b2652b2b";

/** Token sintetic. Ales MAI MARE decât WETH și USDC, deci quote-ul e mereu `token0` (amount0 = suma de quote). */
export const TOKEN = "0xf0000000000000000000000000000000000000a1";

export const POOL_V2 = "0x" + "c2".repeat(20);
export const POOL_V3 = "0x" + "c3".repeat(20);
export const POOL_V3_STABLE = "0x" + "c5".repeat(20);
export const POOL_V4_ID = "0x" + "d4".repeat(32);
const SENDER = "0x" + "00".repeat(12) + "5e".repeat(20);

// ── Topicuri: keccak-256 al semnăturii din comentariu ─────────────────────────────────────────────────────────
/** `Swap(address,uint256,uint256,uint256,uint256,address)` — Uniswap V2 */
export const T_SWAP_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
/** `Swap(address,address,int256,int256,uint160,uint128,int24)` — Uniswap V3 */
export const T_SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
/** `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)` — Uniswap V4 */
export const T_SWAP_V4 = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
/** Topic care nu aparține niciunui eveniment urmărit — pentru geamănul negativ. */
export const T_FOREIGN = "0x" + "cc".repeat(32);

// ── Codări ───────────────────────────────────────────────────────────────────────────────────────────────────
const TWO_256 = 1n << 256n;

/** Un cuvânt ABI de 32 de octeți (64 hex) pentru un întreg cu semn, în complement față de doi. */
export function int256Word(v: bigint): string {
  if (v >= (1n << 255n) || v < -(1n << 255n)) throw new Error("int256 în afara domeniului");
  return (v < 0n ? TWO_256 + v : v).toString(16).padStart(64, "0");
}

/** Un cuvânt ABI de 32 de octeți pentru un întreg fără semn. */
export function uint256Word(v: bigint): string {
  if (v < 0n || v >= TWO_256) throw new Error("uint256 în afara domeniului");
  return v.toString(16).padStart(64, "0");
}

const txHash = (n: number): string => "0x" + n.toString(16).padStart(64, "0");
const E18 = 10n ** 18n;
export { E18 };

// ── Pool-uri brute (forma GeckoTerminal) ─────────────────────────────────────────────────────────────────────
export interface GeckoPoolRaw {
  attributes: Record<string, unknown>;
  relationships: Record<string, unknown>;
}

/** Pool brut în forma GeckoTerminal, pe rețeaua `base`. `quote` = adresa tokenului de quote. */
export function geckoPool(address: string, dexId: string, quote: string, quoteSymbol: string): GeckoPoolRaw {
  return {
    attributes: {
      address,
      name: `TKN / ${quoteSymbol}`,
      base_token_price_usd: "0.5",
      price_change_percentage: { m5: "0", h1: "0", h24: "0" },
      reserve_in_usd: "100000",
      volume_usd: { h24: "1000" },
      transactions: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 } },
    },
    relationships: {
      base_token:  { data: { id: `base_${TOKEN}` } },
      quote_token: { data: { id: `base_${quote}` } },
      dex:         { data: { id: dexId } },
    },
  };
}

// ── Loguri ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Uniswap V2 `Swap`: topics [sig, sender, to]; data = amount0In, amount1In, amount0Out, amount1Out. */
export function swapV2Log(pool: string, a: { amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint }, n: number): RpcLog {
  return {
    address: pool,
    topics: [T_SWAP_V2, SENDER, SENDER],
    data: "0x" + uint256Word(a.amount0In) + uint256Word(a.amount1In) + uint256Word(a.amount0Out) + uint256Word(a.amount1Out),
    transactionHash: txHash(n),
  };
}

/** Uniswap V3 `Swap`: topics [sig, sender, recipient]; data = amount0, amount1 (cu semn, convenția POOL), sqrtPriceX96, liquidity, tick. */
export function swapV3Log(pool: string, a: { amount0: bigint; amount1: bigint }, n: number): RpcLog {
  return {
    address: pool,
    topics: [T_SWAP_V3, SENDER, SENDER],
    data: "0x" + int256Word(a.amount0) + int256Word(a.amount1) + uint256Word(1n << 96n) + uint256Word(10n ** 12n) + int256Word(0n),
    transactionHash: txHash(n),
  };
}

/** Uniswap V4 `Swap`: emis de PoolManager; topics [sig, poolId, sender]; data = amount0, amount1 (cu semn, perspectiva SWAPPER-ului), sqrtPriceX96, liquidity, tick, fee. */
export function swapV4Log(poolId: string, a: { amount0: bigint; amount1: bigint }, n: number): RpcLog {
  return {
    address: V4_POOL_MANAGER_BASE,
    topics: [T_SWAP_V4, poolId, SENDER],
    data: "0x" + int256Word(a.amount0) + int256Word(a.amount1) + uint256Word(1n << 96n) + uint256Word(10n ** 12n) + int256Word(0n) + uint256Word(3000n),
    transactionHash: txHash(n),
  };
}

/** Log cu topic0 străin, de la aceeași adresă (și, opțional, cu același `topics[1]`) — geamănul negativ. */
export function foreignLog(address: string, topic1: string | null, n: number): RpcLog {
  return {
    address,
    topics: topic1 === null ? [T_FOREIGN] : [T_FOREIGN, topic1],
    data: "0x" + uint256Word(1n) + uint256Word(2n) + uint256Word(3n) + uint256Word(4n),
    transactionHash: txHash(n),
  };
}

/** Controale proprii ale codărilor. Întoarce lista problemelor (goală = în regulă). */
export function fixturesSelfCheck(): string[] {
  const p: string[] = [];
  const eq = (name: string, got: string, want: string): void => { if (got !== want) p.push(`${name}: ${got} ≠ ${want}`); };
  eq("int256Word(0)", int256Word(0n), "0".repeat(64));
  eq("int256Word(1)", int256Word(1n), "0".repeat(63) + "1");
  eq("int256Word(-1)", int256Word(-1n), "f".repeat(64));
  eq("int256Word(-2)", int256Word(-2n), "f".repeat(63) + "e");
  eq("int256Word(1e18)", int256Word(E18), "0".repeat(49) + "de0b6b3a7640000");
  eq("uint256Word(255)", uint256Word(255n), "0".repeat(62) + "ff");
  if (!(TOKEN > WETH_BASE && TOKEN > USDC_BASE)) p.push("TOKEN trebuie să fie mai mare decât WETH și USDC");
  if (swapV3Log(POOL_V3, { amount0: 1n, amount1: -1n }, 1).data.length !== 2 + 5 * 64) p.push("lungimea datelor V3");
  if (swapV2Log(POOL_V2, { amount0In: 1n, amount1In: 0n, amount0Out: 0n, amount1Out: 1n }, 1).data.length !== 2 + 4 * 64) p.push("lungimea datelor V2");
  if (swapV4Log(POOL_V4_ID, { amount0: 1n, amount1: -1n }, 1).data.length !== 2 + 6 * 64) p.push("lungimea datelor V4");
  for (const [name, t] of [["T_SWAP_V2", T_SWAP_V2], ["T_SWAP_V3", T_SWAP_V3], ["T_SWAP_V4", T_SWAP_V4]] as const) {
    if (!/^0x[0-9a-f]{64}$/.test(t)) p.push(`${name} nu e un topic valid`);
  }
  if (POOL_V4_ID.length !== 66 || POOL_V3.length !== 42) p.push("lungimea adreselor de pool");
  return p;
}
