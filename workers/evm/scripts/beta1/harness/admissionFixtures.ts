/**
 * scripts/beta1/harness/admissionFixtures.ts — BETA-1, treapta 2: fixture-urile ADMITERII REALE (design rev3, §3).
 *
 * Răspunsuri `fetch` (Gecko, DexScreener, GoPlus) pe URL EXACT, pool-uri brute și loguri pentru cazurile A2-*.
 * Tot ce e aici e scris INDEPENDENT de produs: URL-urile, topicurile și pragurile sunt copiate din codul citit la
 * `f679f4b` (referințele sunt în comentarii), nu importate din `src/` — dacă produsul și fixture-ul nu se potrivesc,
 * cazul pică pe montaj (HARNESS_ERROR) sau pe control, nu trece tăcut.
 *
 * VALORILE DE PIAȚĂ (alese din pragurile reale, nu testate — §6):
 *   pool „activ” (țintă, martor): preț 0,5 USD, m5 = +12 %, h1 = +20 %, h24 = 0, rezervă 600 000 USD.
 *     `computeAttentionScore` (risk/attention.ts): min(12·2, 30) + min(20·0,45, 30) + min(0, 15) = 33; lichiditate
 *     ≥ 500k → 20; continuare (m5 > 0 și h1 > 0) → 10; văzut o dată → 1 ⇒ 64 (la al doilea scan: 65).
 *     `getMonitoringTier`: nu EVENT (< 75), nu CONTINUATION (seenCount < 3), FRESH_WATCH (≥ 60, m5 > 0, h1 > 0,
 *     rezervă ≥ 25k).
 *     `classifyMomentumEvent` (risk/momentum.ts): m5 ≤ 30 și h24 ≤ 200 ⇒ NO_MOMENTUM ⇒ ramura de atenție din
 *     `processPool` (pipeline/scan.ts) ⇒ FRESH_WATCH: `addWatchCandidate` + `requestImmediateScopedSubscribe` +
 *     `triggerPoolRisk` (GoPlus).
 *     `shouldFollow` fals (64 < FOLLOW_ADD_SCORE 70, nu EVENT, fără mișcare majoră) ⇒ pool-urile din scan NU intră
 *     în follow-list; `seedFollowListFromMemory` nu le adaugă (h1 < 200, h24 < 500).
 *   umplutură: preț 0 ⇒ `processPool` iese la prima linie (`!price`) ⇒ fără memorie, fără watch; dar e în scan, deci
 *     `rebuildPoolMaps` rulează (scanul e nevid) și o pune în `v3PoolMap` (V3, `uniswap-v3-base`) — dovada că
 *     reconstruirea a avut loc.
 *
 * Tokenurile de bază sunt DISTINCTE per pool (GoPlus se cere o dată per token, fără deduplicare dependentă de timp)
 * și toate mai mari decât WETH ⇒ quote-ul (WETH) e `token0`, ca în treapta 1 (aceleași convenții de semn).
 *
 * Pur: fără I/O. NU importă nimic din `src/`.
 */

import {
  WETH_BASE, V4_POOL_MANAGER_BASE, T_SWAP_V2, T_SWAP_V3, T_SWAP_V4, E18,
  swapV2Log, swapV3Log, swapV4Log, foreignLog,
} from "./evmFixtures";
import {
  T_SWAP_PANCAKE_V3, T_MINT_V3, T_BURN_V3, T_MINT_V2, T_BURN_V2, T_SWAP_AERODROME, T_BURN_AERODROME,
  T_MODIFY_LIQUIDITY_V4,
} from "./evmFixturesDefects";
import type { RpcLog } from "./localNode";

// ── URL-uri (copiate din cod, `f679f4b`) ─────────────────────────────────────────────────────────────────────
/** `GECKO_BASE` (config/constants.ts); rețeaua Gecko a lanțului `base` = „base” (config/chains.ts). */
export const GECKO_API = "https://api.geckoterminal.com/api/v2";
/** `DS_API` (sources/dexscreener.ts). */
export const DS_API = "https://api.dexscreener.com";
/** `GOPLUS_BASE` (packages/risk-layer/src/goplus.ts); `GOPLUS_CHAIN_IDS.base` = „8453”. */
export const GOPLUS_API = "https://api.gopluslabs.io/api/v1";

/** `fetchDiscoveryPools` (sources/gecko.ts): trei cereri per scan, în ordine. */
export const URL_TRENDING_1 = `${GECKO_API}/networks/base/trending_pools?page=1`;
export const URL_TRENDING_2 = `${GECKO_API}/networks/base/trending_pools?page=2`;
export const URL_NEW_POOLS  = `${GECKO_API}/networks/base/new_pools?page=1`;
/** `fetchPoolByAddressStatus` (sources/gecko.ts), din `runFollowRefresh`. */
export const urlGeckoPool = (addr: string): string => `${GECKO_API}/networks/base/pools/${addr}`;
/** `fetchDsBoostedTokens` (sources/dexscreener.ts). */
export const URL_DS_BOOSTED = `${DS_API}/token-boosts/v1/latest`;
/** `fetchDsTokenPairs` (sources/dexscreener.ts): ruta luată când elementul boosted nu are adresă de pool în `url`. */
export const urlDsTokenPairs = (token: string): string => `${DS_API}/token-pairs/v1/base/${token}`;
/** `fetchGoPlusRaw` (packages/risk-layer/src/goplus.ts). */
export const urlGoPlus = (token: string): string => `${GOPLUS_API}/token_security/8453?contract_addresses=${token}`;

// ── Adrese și tokenuri ───────────────────────────────────────────────────────────────────────────────────────
export const A2_TARGET_V3  = "0x" + "a3".repeat(20);
export const A2_TARGET_V4  = "0x" + "a4".repeat(32);
export const A2_WITNESS_V2 = "0x" + "a2".repeat(20);
export const A2_FILLER_V3  = "0x" + "af".repeat(20);
export const TOKEN_TARGET  = "0xf0000000000000000000000000000000000000b1";
export const TOKEN_WITNESS = "0xf0000000000000000000000000000000000000b2";
export const TOKEN_FILLER  = "0xf0000000000000000000000000000000000000b3";
export const SYM_TARGET = "TGT";
export const SYM_WITNESS = "WIT";
export const SYM_FILLER = "FIL";

/** Prețul nativ injectat (ca în treapta 1 — prețul e §4.1, tratat de P1). */
export const PRICE_ETH = 2_500;

// ── Poziția 0 a filtrelor, exact ca în produs (ws/subscriptions.ts, `f679f4b`) ───────────────────────────────
/** `V2_SCOPED_TOPICS`: Swap V2, Swap Aerodrome, Mint, Burn V2, Burn Aerodrome. */
export const V2_TOPICS0: readonly string[] = Object.freeze([T_SWAP_V2, T_SWAP_AERODROME, T_MINT_V2, T_BURN_V2, T_BURN_AERODROME]);
/** `V3_SCOPED_TOPICS`: Swap V3, Swap Pancake V3, Mint V3, Burn V3. */
export const V3_TOPICS0: readonly string[] = Object.freeze([T_SWAP_V3, T_SWAP_PANCAKE_V3, T_MINT_V3, T_BURN_V3]);
/** Filtrul V4: `[SWAP_V4_TOPIC, MODIFY_LIQUIDITY_V4_TOPIC]`, emis de PoolManager. */
export const V4_TOPICS0: readonly string[] = Object.freeze([T_SWAP_V4, T_MODIFY_LIQUIDITY_V4]);
export { V4_POOL_MANAGER_BASE };

// ── Pool-uri brute ───────────────────────────────────────────────────────────────────────────────────────────
export interface A2Market { price: string; m5: string; h1: string; h24: string; reserve: string; }
export const MARKET_ACTIVE: A2Market = Object.freeze({ price: "0.5", m5: "12", h1: "20", h24: "0", reserve: "600000" });
export const MARKET_FILLER: A2Market = Object.freeze({ price: "0", m5: "0", h1: "0", h24: "0", reserve: "600000" });

export interface A2GeckoRaw { id: string; type: string; attributes: Record<string, unknown>; relationships: Record<string, unknown>; }

/** Pool brut în forma GeckoTerminal (citită de `normalizePool`), quote WETH, pe `base`. */
export function a2GeckoPool(address: string, dexId: string, token: string, symbol: string, m: A2Market): A2GeckoRaw {
  return {
    id: `base_${address}`, type: "pool",
    attributes: {
      address,
      name: `${symbol} / WETH`,
      base_token_price_usd: m.price,
      price_change_percentage: { m5: m.m5, h1: m.h1, h24: m.h24 },
      reserve_in_usd: m.reserve,
      volume_usd: { h24: "1000" },
      transactions: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 } },
    },
    relationships: {
      base_token:  { data: { id: `base_${token}`, type: "token" } },
      quote_token: { data: { id: `base_${WETH_BASE}`, type: "token" } },
      dex:         { data: { id: dexId, type: "dex" } },
    },
  };
}

/** Pereche DexScreener (forma citită de `normalizeDsPair`), pentru `token-pairs`. */
export function a2DsPair(address: string, dexId: string, token: string, symbol: string): Record<string, unknown> {
  return {
    chainId: "base", dexId, pairAddress: address,
    baseToken:  { address: token, name: symbol, symbol },
    quoteToken: { address: WETH_BASE, name: "Wrapped Ether", symbol: "WETH" },
    priceUsd: "0.5",
    priceChange: { m5: 12, h1: 20, h24: 0 },
    liquidity: { usd: 600_000 },
    volume: { h24: 1_000 },
    txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 } },
  };
}

/**
 * Element boosted DexScreener: `url` fără adresă în ultimul segment ⇒ `pairAddress` nedefinit ⇒ `runDsBoostedRefresh`
 * ia ruta `fetchDsTokenPairs` (traseul din design, §2).
 */
export function a2BoostedItem(token: string): Record<string, unknown> {
  return { chainId: "base", tokenAddress: token, url: "https://dexscreener.com/base/a2-boost", amount: 10 };
}

/** Răspuns GoPlus valid, fără date pentru token (ramura „no data” — rezultat `unavailable`, fără altă rețea). */
export const GOPLUS_EMPTY_BODY = JSON.stringify({ code: 1, message: "OK", result: {} });

export const POOL_TARGET_V3 = a2GeckoPool(A2_TARGET_V3, "uniswap-v3-base", TOKEN_TARGET, SYM_TARGET, MARKET_ACTIVE);
export const POOL_TARGET_V4 = a2GeckoPool(A2_TARGET_V4, "uniswap-v4-base", TOKEN_TARGET, SYM_TARGET, MARKET_ACTIVE);
export const POOL_WITNESS_V2 = a2GeckoPool(A2_WITNESS_V2, "uniswap-v2-base", TOKEN_WITNESS, SYM_WITNESS, MARKET_ACTIVE);
export const POOL_FILLER_V3 = a2GeckoPool(A2_FILLER_V3, "uniswap-v3-base", TOKEN_FILLER, SYM_FILLER, MARKET_FILLER);

// ── Loguri (convențiile treptei 1: quote = token0) ───────────────────────────────────────────────────────────
/** V3: semn în convenția POOL — quote intrat (pozitiv) = cumpărare. */
export const SWAP_TARGET_V3: RpcLog = swapV3Log(A2_TARGET_V3, { amount0: E18, amount1: -5n * E18 }, 0xa301);
export const TWIN_TARGET_V3: RpcLog = foreignLog(A2_TARGET_V3, null, 0xa302);
/** V4: semn din perspectiva SWAPPER-ului — quote plătit (negativ) = cumpărare. */
export const SWAP_TARGET_V4: RpcLog = swapV4Log(A2_TARGET_V4, { amount0: -E18, amount1: 5n * E18 }, 0xa401);
export const TWIN_TARGET_V4: RpcLog = foreignLog(V4_POOL_MANAGER_BASE, A2_TARGET_V4, 0xa402);
/** V2: quote intrat = cumpărare. */
export const SWAP_WITNESS_V2: RpcLog = swapV2Log(A2_WITNESS_V2, { amount0In: E18, amount1In: 0n, amount0Out: 0n, amount1Out: 5n * E18 }, 0xa201);

/** Ce trebuie înregistrat pentru fiecare swap livrat și primit: cumpărare de 1 ETH = 2 500 USD. */
export const EXPECTED_BUY = Object.freeze({ isBuy: true, ethAmount: 1, usdAmount: 2_500 });

/** Controale proprii ale fixture-urilor treptei 2. Întoarce lista problemelor (goală = în regulă). */
export function admissionFixturesSelfCheck(): string[] {
  const p: string[] = [];
  const addrs = [A2_TARGET_V3, A2_WITNESS_V2, A2_FILLER_V3];
  for (const a of addrs) if (!/^0x[0-9a-f]{40}$/.test(a)) p.push(`adresă de pool invalidă: ${a}`);
  if (!/^0x[0-9a-f]{64}$/.test(A2_TARGET_V4)) p.push("poolId V4 invalid");
  if (new Set([...addrs, A2_TARGET_V4]).size !== 4) p.push("adrese de pool nedistincte");
  const tokens = [TOKEN_TARGET, TOKEN_WITNESS, TOKEN_FILLER];
  if (new Set(tokens).size !== 3) p.push("tokenuri nedistincte");
  for (const t of tokens) {
    if (!/^0x[0-9a-f]{40}$/.test(t)) p.push(`token invalid: ${t}`);
    if (!(t > WETH_BASE.toLowerCase())) p.push(`tokenul ${t} nu e mai mare decât WETH (quote-ul n-ar mai fi token0)`);
  }
  const logs = [SWAP_TARGET_V3, TWIN_TARGET_V3, SWAP_TARGET_V4, TWIN_TARGET_V4, SWAP_WITNESS_V2];
  if (new Set(logs.map(l => l.transactionHash)).size !== logs.length) p.push("transactionHash nedistincte");
  if (new Set([SYM_TARGET, SYM_WITNESS, SYM_FILLER]).size !== 3) p.push("simboluri nedistincte");
  if (Number(MARKET_FILLER.price) !== 0) p.push("umplutura trebuie să fie fără preț (nu intră în processPool)");
  if (!(Number(MARKET_ACTIVE.m5) <= 30 && Number(MARKET_ACTIVE.h24) <= 200)) p.push("piața activă nu mai e NO_MOMENTUM");
  for (const u of [URL_TRENDING_1, URL_TRENDING_2, URL_NEW_POOLS, URL_DS_BOOSTED, urlGeckoPool(A2_TARGET_V3), urlDsTokenPairs(TOKEN_TARGET), urlGoPlus(TOKEN_TARGET)]) {
    if (!u.startsWith("https://")) p.push(`URL invalid: ${u}`);
  }
  return p;
}
