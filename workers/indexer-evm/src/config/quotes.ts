/**
 * config/quotes.ts
 * Quote token registry pentru base/quote detection la pair discovery.
 *
 * Folosit de pairRegistry.ts pentru a determina care token e "base" (tranzacționat)
 * și care e "quote" (stablecoin/WETH folosit ca referință de preț).
 *
 * Adresele sunt lowercase pentru comparații directe.
 * Nu importă din worker-evm — menține independența workspace-urilor.
 */

/** Quote token addresses per chain (all lowercase). */
const QUOTE_TOKENS: Record<string, Set<string>> = {
  base: new Set([
    "0x4200000000000000000000000000000000000006", // WETH
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC (bridged USDC)
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI
    "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b", // VIRTUAL (Virtuals Protocol) — verificat din Redis
  ]),
  arbitrum: new Set([
    "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
    "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC native
    "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", // USDC.e (bridged)
    "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT
    "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1", // DAI
  ]),
  bsc: new Set([
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
    "0x55d398326f99059ff775485246999027b3197955", // USDT (BSC)
    "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC (BSC)
  ]),
};

export type QuoteStatus = "OK" | "NO_KNOWN_QUOTE" | "AMBIGUOUS_QUOTE";

/** Returns true if the token is a known quote token on this chain. */
export function isQuoteToken(chain: string, token: string): boolean {
  return QUOTE_TOKENS[chain.toLowerCase()]?.has(token.toLowerCase()) ?? false;
}

/**
 * Determines which token is the base (tradeable) and which is the quote (reference).
 *
 * Rules:
 *   token0 quote, token1 not → base=token1, quote=token0, status=OK
 *   token1 quote, token0 not → base=token0, quote=token1, status=OK
 *   both quote               → base=token0, quote=token1, status=AMBIGUOUS_QUOTE
 *   neither quote            → base=token0, quote=null,   status=NO_KNOWN_QUOTE
 */
export function chooseBaseQuote(
  chain:  string,
  token0: string,
  token1: string,
): { baseToken: string; quoteToken: string | null; quoteStatus: QuoteStatus } {
  const t0q = isQuoteToken(chain, token0);
  const t1q = isQuoteToken(chain, token1);

  if  (t0q && !t1q) return { baseToken: token1, quoteToken: token0, quoteStatus: "OK" };
  if  (t1q && !t0q) return { baseToken: token0, quoteToken: token1, quoteStatus: "OK" };
  if  (t0q &&  t1q) return { baseToken: token0, quoteToken: token1, quoteStatus: "AMBIGUOUS_QUOTE" };
  return              { baseToken: token0, quoteToken: null,   quoteStatus: "NO_KNOWN_QUOTE" };
}
