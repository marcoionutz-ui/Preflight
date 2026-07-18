/**
 * ws/quoteFlow.ts
 * Clasificarea flow-ului unui swap (buy/sell + volum native/USD) din amounts.
 * Extras din manager.ts (A5) ca să fie testabil izolat.
 *
 * CONVENȚIE DE SEMN (important):
 *   getQuoteFlowAsEth folosește convenția POOL (ca Uniswap V3): amount al
 *   tokenului quote POZITIV = quote plătit ÎN pool = BUY al tokenului base.
 *   - V3 Swap event emite deja delta pool-ului → se pasează direct.
 *   - V2 handler reconstruiește delta pool-ului din amountIn/amountOut → direct.
 *   - V4 Swap event emite delta din perspectiva SWAPPER-ului (negativ = plătit
 *     în pool, pozitiv = primit) — OPUS lui V3. Deci amounts V4 trebuie NEGATE
 *     înainte (vezi toPoolConventionAmounts).
 *
 *   Sursă convenție V4: Uniswap v4-core BalanceDelta (swapDelta caller-facing) +
 *   ghidul de indexare Uniswap Foundation ("the sign convention in v4 is from the
 *   user's perspective... this is opposite of v3, so watch out!") + exemplu Cyfrin
 *   (vânzare 1e7 WBTC → amount0(WBTC) = -10_000_000).
 */

import type { ChainConfig } from "../config/chains";
import { getNativePrice }    from "../infra/nativePrice";

/**
 * Aduce amounts la convenția POOL (V3) pe care o așteaptă getQuoteFlowAsEth.
 * Pentru V4 (perspectiva swapper-ului, opusă) negăm ambele; altfel pass-through.
 */
export function toPoolConventionAmounts(
  amount0: bigint,
  amount1: bigint,
  isV4:    boolean,
): [bigint, bigint] {
  return isV4 ? [-amount0, -amount1] : [amount0, amount1];
}

export function getQuoteFlowAsEth(
  chain:      ChainConfig,
  baseToken:  string,
  quoteToken: string,
  amount0:    bigint,
  amount1:    bigint,
): { ok: boolean; ethAmount: number; usdAmount: number; isBuy: boolean; quote: string | null } {
  const base   = baseToken.toLowerCase();
  const quoteT = quoteToken.toLowerCase();
  const token0 = base < quoteT ? base : quoteT;
  const amountFor = (t: string) => t === token0 ? amount0 : amount1;

  const stableAddrs = [
    chain.usdc?.toLowerCase(),
    chain.usdcLegacy?.toLowerCase(),
    ...(chain.stableQuotes ?? []).map(a => a.toLowerCase()),
  ].filter(Boolean) as string[];

  const quoteMetaFor = (addr: string): { symbol: string; decimals: number; kind: "native" | "stable" } | null => {
    const a = addr.toLowerCase();
    if (a === chain.weth.toLowerCase()) {
      return { symbol: chain.id === "bsc" ? "WBNB" : "WETH", decimals: 18, kind: "native" };
    }
    if (stableAddrs.includes(a)) {
      let symbol = "STABLE";
      if (chain.id === "bsc") {
        if (a === "0x55d398326f99059ff775485246999027b3197955") symbol = "USDT";
        else if (a === "0xe9e7cea3dedca5984780bafc599bd69add087d56") symbol = "BUSD";
        else if (a === "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d") symbol = "USDC";
      } else {
        symbol = a === chain.usdcLegacy?.toLowerCase() ? "USDC.e" : "USDC";
      }
      return { symbol, decimals: chain.id === "bsc" ? 18 : 6, kind: "stable" };
    }
    return null;
  };

  const baseMeta   = quoteMetaFor(base);
  const quoteMetaT = quoteMetaFor(quoteT);
  const quoteMeta  = baseMeta ?? quoteMetaT;

  if (!quoteMeta) return { ok: false, ethAmount: 0, usdAmount: 0, isBuy: false, quote: null };

  const quoteAddr   = baseMeta ? base : quoteT;
  const amt         = amountFor(quoteAddr);
  const abs         = amt < 0n ? -amt : amt;
  const quoteAmount = Number(abs) / (10 ** quoteMeta.decimals);
  // legacy name: ethAmount is native-equivalent (ETH or BNB depending on chain/quote).
  // usdAmount is the canonical cross-chain volume field.
  const nativeSymbol = chain.id === "bsc" ? "BNB" : "ETH";
  const ethAmount    = quoteMeta.kind === "native" ? quoteAmount : quoteAmount / getNativePrice(nativeSymbol);
  const usdAmount    = quoteMeta.kind === "stable"
    ? quoteAmount
    : quoteAmount * getNativePrice(nativeSymbol);

  return { ok: true, ethAmount, usdAmount, isBuy: amt > 0n, quote: quoteMeta.symbol };
}
