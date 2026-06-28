/**
 * infra/quotePrices.ts
 * USD price resolver pentru quote tokens.
 *
 * Priority order:
 *   1. STATIC_STABLE — stablecoins → $1.00 always
 *   2. CHAINLINK     — ETH/BNB din on-chain Chainlink feed (Redis cache, TTL 5min)
 *   3. ENV_FALLBACK  — INDEXER_WETH_USD / INDEXER_BNB_USD / INDEXER_{SYMBOL}_USD
 *   4. null          — unknown, caller setează priceStatus=QUOTE_PRICE_UNKNOWN
 *
 * Faza 6.11: getQuotePriceResult() async (Chainlink + Redis cache) este sursa primară.
 * getQuotePrice() sync rămâne ca fallback pentru contexte unde async nu e posibil.
 */

import type { Redis } from "ioredis";

// ── Types ─────────────────────────────────────────────────────────────────────

export type QuotePriceSource =
  | "STATIC_STABLE"   // stablecoin → always $1.00, nu se schimbă
  | "CHAINLINK"       // fetched de la Chainlink on-chain oracle (Redis cached)
  | "ENV_FALLBACK"    // citit din env var Railway (INDEXER_WETH_USD etc.)
  | "UNKNOWN";        // fără preț disponibil

export interface QuotePriceResult {
  price:     number;
  source:    QuotePriceSource;
  updatedAt: number;  // ms timestamp când prețul a fost obținut
}

// ── Constants ─────────────────────────────────────────────────────────────────

const NATIVE_ADDRESS          = "0x0000000000000000000000000000000000000000";
const CHAINLINK_CACHE_TTL_SEC = 300;   // 5 min
const CHAINLINK_TIMEOUT_MS    = 4_000;
const SEL_LATEST_ROUND_DATA   = "0xfeaf968c"; // latestRoundData()

// ── Token address sets ────────────────────────────────────────────────────────

const STABLE_ADDRESSES = new Set([
  // Ethereum mainnet
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  // Base
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI
  // Arbitrum
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC native
  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", // USDC.e
  "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
  "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
  // BSC
  "0x55d398326f99059ff775485246999027b3197955", // USDT
  "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC BSC
]);

const WETH_ADDRESSES = new Set([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH Ethereum mainnet
  "0x4200000000000000000000000000000000000006", // WETH Base
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH Arbitrum
]);

const WBNB_ADDRESSES = new Set([
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB BSC
]);

// ── Chainlink ETH/USD + BNB/USD feed addresses per chain ─────────────────────

const CHAINLINK_ETH_FEED: Record<string, string> = {
  ethereum: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", // ETH/USD Ethereum mainnet
  base:     "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  arbitrum: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",
};

const CHAINLINK_BNB_FEED: Record<string, string> = {
  bsc: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
};

// ── Ecosystem tokens — env-gated, no Chainlink feed ──────────────────────────

const ECOSYSTEM_TOKEN_ENV: Record<string, string> = {
  "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b": "INDEXER_VIRTUAL_USD", // VIRTUAL (Base)
  "0x1111111111166b7fe7bd91427724b487980afc69": "INDEXER_ZORA_USD",    // ZORA (Base)
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function chainlinkCacheKey(chain: string, symbol: "ETH" | "BNB"): string {
  return `preflight:indexer:quoteprice:${chain}:${symbol}`;
}

function readEnvPrice(key: string): number | null {
  const v = Number(process.env[key] ?? 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function fetchChainlink(rpcUrl: string, feedAddress: string): Promise<number | null> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), CHAINLINK_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method:  "eth_call",
        params:  [{ to: feedAddress, data: SEL_LATEST_ROUND_DATA }, "latest"],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string; error?: unknown };
    if (json.error || !json.result || json.result === "0x") return null;
    // Decode: 5 × 32 bytes — answer (int256) la offset 32 bytes (chars 64–127)
    const hex = json.result.startsWith("0x") ? json.result.slice(2) : json.result;
    if (hex.length < 320) return null;
    const raw    = BigInt("0x" + hex.slice(64, 128));
    const signed = raw > (1n << 255n) - 1n ? raw - (1n << 256n) : raw; // int256 sign fix
    const price  = Number(signed) / 1e8;
    return price > 0 ? price : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Async price resolver — sursa primară pentru enrichment.
 * Priority: STATIC_STABLE → CHAINLINK (Redis cache) → ENV_FALLBACK → null
 *
 * @param tokenAddress  lowercase token address (sau address(0) pentru native)
 * @param chain         chain id (obligatoriu pentru address(0) și routing Chainlink)
 * @param rpcUrl        RPC URL pentru Chainlink fetch
 * @param r             Redis client pentru cache (opțional)
 */
export async function getQuotePriceResult(
  tokenAddress: string,
  chain:        string,
  rpcUrl?:      string,
  r?:           Redis | null,
): Promise<QuotePriceResult | null> {
  const addr = tokenAddress.toLowerCase();
  const now  = Date.now();

  // 1. Stables → always $1.00
  if (STABLE_ADDRESSES.has(addr)) {
    return { price: 1.0, source: "STATIC_STABLE", updatedAt: now };
  }

  // Determină dacă e ETH sau BNB (wrapped sau native)
  const isEth = WETH_ADDRESSES.has(addr) || (addr === NATIVE_ADDRESS && chain !== "bsc");
  const isBnb = WBNB_ADDRESSES.has(addr) || (addr === NATIVE_ADDRESS && chain === "bsc");

  if (isEth || isBnb) {
    const symbol   = isEth ? "ETH" as const : "BNB" as const;
    const feedMap  = isEth ? CHAINLINK_ETH_FEED : CHAINLINK_BNB_FEED;
    const feedAddr = feedMap[chain];
    const envKey   = isEth ? "INDEXER_WETH_USD" : "INDEXER_BNB_USD";
    const cacheKey = chainlinkCacheKey(chain, symbol);

    // 2a. Redis cache (serve if fresh + stale guard)
    if (r) {
      try {
        const cached = await r.get(cacheKey);
        if (cached) {
          const p      = JSON.parse(cached) as { price: number; updatedAt: number };
          const ageMs  = now - Number(p.updatedAt ?? 0);
          if (
            Number.isFinite(p.price) && p.price > 0 &&
            Number.isFinite(ageMs)  && ageMs >= 0 &&
            ageMs <= CHAINLINK_CACHE_TTL_SEC * 1000
          ) {
            return { price: p.price, source: "CHAINLINK", updatedAt: p.updatedAt };
          }
        }
      } catch { /* ignoră Redis errors */ }
    }

    // 2b. Fetch Chainlink on-chain
    if (feedAddr && rpcUrl) {
      const chainlinkPrice = await fetchChainlink(rpcUrl, feedAddr);
      if (chainlinkPrice) {
        if (r) {
          try {
            await r.set(cacheKey, JSON.stringify({ price: chainlinkPrice, updatedAt: now }), "EX", CHAINLINK_CACHE_TTL_SEC);
          } catch { /* ignoră */ }
        }
        return { price: chainlinkPrice, source: "CHAINLINK", updatedAt: now };
      }
    }

    // 3. Env fallback
    const envPrice = readEnvPrice(envKey);
    if (envPrice) return { price: envPrice, source: "ENV_FALLBACK", updatedAt: now };

    return null;
  }

  // ── Ecosystem tokens (VIRTUAL, ZORA) — env only ───────────────────────────
  const envKey = ECOSYSTEM_TOKEN_ENV[addr];
  if (envKey) {
    const envPrice = readEnvPrice(envKey);
    if (envPrice) return { price: envPrice, source: "ENV_FALLBACK", updatedAt: now };
    return null;
  }

  return null;
}

/**
 * Sync wrapper — env only, fără Chainlink și Redis.
 * Folosit doar unde async nu e posibil. Preferă getQuotePriceResult() pentru enrichment.
 */
export function getQuotePrice(tokenAddress: string, chain?: string): number | null {
  const addr = tokenAddress.toLowerCase();
  if (STABLE_ADDRESSES.has(addr)) return 1.0;
  if (WETH_ADDRESSES.has(addr))   return readEnvPrice("INDEXER_WETH_USD");
  if (WBNB_ADDRESSES.has(addr))   return readEnvPrice("INDEXER_BNB_USD");
  if (addr === NATIVE_ADDRESS) {
    return chain?.toLowerCase() === "bsc"
      ? readEnvPrice("INDEXER_BNB_USD")
      : readEnvPrice("INDEXER_WETH_USD");
  }
  const envKey = ECOSYSTEM_TOKEN_ENV[addr];
  if (envKey) return readEnvPrice(envKey);
  return null;
}
