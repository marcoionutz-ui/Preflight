/**
 * infra/quotePrices.ts
 * USD price lookup pentru quote tokens cunoscuți.
 *
 * Stablecoins → 1.0 (hardcodat, nu fetch extern)
 * WETH/WBNB   → INDEXER_WETH_USD env (0 = unknown, pair rămâne priceUsd=0)
 *
 * Motivul pentru env în loc de feed extern:
 *   - Faza 6.5 minimal, fără dependențe externe de price
 *   - La deploy Railway setezi INDEXER_WETH_USD=3500
 *   - Dacă env lipsește, WETH pairs au priceStatus=QUOTE_PRICE_UNKNOWN (corect, nu fake)
 */

// ── Stablecoins ───────────────────────────────────────────────────────────────

const STABLE_ADDRESSES = new Set([
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

// ── WETH / native wrapped ─────────────────────────────────────────────────────

const WETH_ADDRESSES = new Set([
  "0x4200000000000000000000000000000000000006", // WETH Base
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH Arbitrum
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB BSC
]);

// ── WETH price from env (cached on first read) ────────────────────────────────

let _wethUsd: number | null = null;

function readWethUsd(): number {
  if (_wethUsd !== null) return _wethUsd;
  const v = Number(process.env.INDEXER_WETH_USD ?? 0);
  _wethUsd = Number.isFinite(v) && v > 0 ? v : 0;
  return _wethUsd;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the USD price of a known quote token:
 *   stable → 1.0
 *   WETH   → INDEXER_WETH_USD env value, or null if not configured
 *   other  → null (unknown)
 *
 * Returning null signals caller to set priceStatus="QUOTE_PRICE_UNKNOWN"
 * rather than writing a fake 0 price.
 */
export function getQuotePrice(tokenAddress: string): number | null {
  const addr = tokenAddress.toLowerCase();
  if (STABLE_ADDRESSES.has(addr)) return 1.0;
  if (WETH_ADDRESSES.has(addr)) {
    const price = readWethUsd();
    return price > 0 ? price : null;
  }
  return null;
}
