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

/**
 * E18 (varu R1): metadata stable PER-ADRESĂ (simbol + decimale). ÎNAINTE decimalele erau deduse din chain
 * (`chain.id === "bsc" ? 18 : 6`), ceea ce trata DAI-ul de pe Ethereum (18 dec) drept 6 dec → valoare umflată
 * cu 10^12 → posibil FALS rug-removal alert (exact opusul scopului E18); și eticheta USDT/DAI de pe Ethereum
 * ca "USDC". Adresele de token sunt unice per deployment → registry global pe adresă. (Ideal ar sta în
 * ChainConfig; minimal aici, dar sursă UNICĂ de adevăr pentru simbol+decimale — nu mai ghicim din chain.)
 */
const STABLE_METADATA: Record<string, { symbol: string; decimals: number }> = {
  // Base
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC",   decimals: 6  },
  // Arbitrum
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831": { symbol: "USDC",   decimals: 6  },
  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8": { symbol: "USDC.e", decimals: 6  },
  // BSC (stable-urile pegged sunt 18 dec)
  "0x55d398326f99059ff775485246999027b3197955": { symbol: "USDT",   decimals: 18 },
  "0xe9e7cea3dedca5984780bafc599bd69add087d56": { symbol: "BUSD",   decimals: 18 },
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { symbol: "USDC",   decimals: 18 },
  // Ethereum
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC",   decimals: 6  },
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT",   decimals: 6  },
  "0x6b175474e89094c44da98b954eedeac495271d0f": { symbol: "DAI",    decimals: 18 },
};

/** Metadata unei monede stable după ADRESĂ (simbol + decimale reale). `null` dacă nu-i o stable cunoscută. */
export function stableMetaFor(address: string): { symbol: string; decimals: number } | null {
  return STABLE_METADATA[address.toLowerCase()] ?? null;
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

  // E18 (varu R2): allowlist PER-CHAIN. Adresele EVM NU sunt unice între rețele — aceeași adresă hex poate fi
  // USDC pe un chain și alt contract pe altul. Deci recunoaștem o stable DOAR dacă chain-ul o autorizează
  // explicit (usdc/usdcLegacy/stableQuotes), iar simbolul+decimalele vin din registry-ul per-adresă.
  const stableAddrs = new Set(
    [chain.usdc, chain.usdcLegacy, ...(chain.stableQuotes ?? [])]
      .filter((x): x is string => Boolean(x))
      .map(x => x.toLowerCase()),
  );

  const quoteMetaFor = (addr: string): { symbol: string; decimals: number; kind: "native" | "stable" } | null => {
    const a = addr.toLowerCase();
    if (a === chain.weth.toLowerCase()) {
      return { symbol: chain.id === "bsc" ? "WBNB" : "WETH", decimals: 18, kind: "native" };
    }
    // E18: chain-ul autorizează adresa ca quote (allowlist) + registry-ul dă simbolul & decimalele reale
    // (nu mai `bsc?18:6`). Ambele necesare: config-ul spune „e quote acceptat aici", registry-ul „ce e".
    const stable = stableAddrs.has(a) ? stableMetaFor(a) : null;
    if (stable) return { symbol: stable.symbol, decimals: stable.decimals, kind: "stable" };
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
  // E25 (fail-closed): preț nativ absent/stale → NU înregistrăm flow-ul cu evaluare incompletă.
  // AMBELE câmpuri depind de preț (native: usdAmount = amt × preț; stable: ethAmount = amt ÷ preț),
  // deci fără un preț valid rezultatul ar fi NaN/Infinity/inventat → ok:false.
  const nativePrice = getNativePrice(nativeSymbol);
  if (nativePrice === null) {
    return { ok: false, ethAmount: 0, usdAmount: 0, isBuy: false, quote: quoteMeta.symbol };
  }
  const ethAmount = quoteMeta.kind === "native" ? quoteAmount : quoteAmount / nativePrice;
  const usdAmount = quoteMeta.kind === "stable" ? quoteAmount : quoteAmount * nativePrice;

  return { ok: true, ethAmount, usdAmount, isBuy: amt > 0n, quote: quoteMeta.symbol };
}

/**
 * Extrage baseToken + quoteToken dintr-un SourcePool. (Mutată din manager.ts — pură, testabilă izolat.)
 * INDEXER pools au _raw.baseToken / _raw.quoteToken direct (IndexedPair format).
 * Gecko pools au _raw.relationships.{base,quote}_token.data.id cu prefix rețea ("eth_0x…", "base_0x…").
 */
export function extractBaseQuote(
  pool: { discoverySource?: string; _raw?: unknown; tokenAddress?: string },
): { baseToken: string; quoteToken: string } {
  const raw = pool._raw as Record<string, unknown> | undefined;
  if (!raw) return { baseToken: pool.tokenAddress?.toLowerCase() ?? "", quoteToken: "" };

  // IndexedPair format: baseToken / quoteToken direct pe _raw (indiferent de discoverySource)
  const indexedBase  = typeof raw.baseToken  === "string" ? raw.baseToken.toLowerCase()  : "";
  const indexedQuote = typeof raw.quoteToken === "string" ? raw.quoteToken.toLowerCase() : "";
  if (indexedBase || indexedQuote) {
    return {
      baseToken:  indexedBase  || pool.tokenAddress?.toLowerCase() || "",
      quoteToken: indexedQuote,
    };
  }

  // Gecko format: relationships.{base,quote}_token.data.id are prefixul rețelei Gecko (chain.gecko, ex. "eth").
  // A1: strip generic al prefixului "{alnum}_" — înainte se folosea chain.id ("ethereum"), dar prefixul e
  // chain.gecko ("eth"), deci pe Ethereum adresa nu era curățată → quoteMetaFor nu potrivea → flow WS tăcut.
  const stripGeckoPrefix = (id: string | undefined): string =>
    id?.replace(/^[a-z0-9-]+_/i, "").toLowerCase() ?? "";
  const rel = raw.relationships as Record<string, unknown> | undefined;
  const base  = stripGeckoPrefix(((rel?.base_token  as Record<string, unknown>)?.data as Record<string, unknown>)?.id  as string | undefined);
  const quote = stripGeckoPrefix(((rel?.quote_token as Record<string, unknown>)?.data as Record<string, unknown>)?.id as string | undefined);
  return { baseToken: base, quoteToken: quote };
}

/**
 * E18: valoarea NATIVE-echivalentă a unui eveniment LP V2 (Mint/Burn), QUOTE-AGNOSTIC.
 *
 * Bug (Intern M10): path-ul de LP V2 presupunea mereu WETH-quoted (`wethIsT0 = weth < token`, apoi
 * `/1e18`). Pe perechile stable-quoted (ex. token/USDT pe BSC) WETH/WBNB NU e nici măcar o rezervă a
 * pool-ului → comparația alegea rezerva GREȘITĂ și o interpreta ca „ETH" → detecția de rug (LP removed %)
 * calcula gunoi → moartă pe stable-quoted. Fix: reutilizează `extractBaseQuote` + `getQuoteFlowAsEth`
 * exact ca path-ul de swap și ca V3 Mint/Burn — quote-ul (native SAU stable) e rezolvat corect, cu
 * decimalele lui, iar stable-ul e convertit în native-echivalent prin oracolul de preț.
 *
 * `amount0`/`amount1` = rezervele token0/token1 din event (pozitive). `{ok:false}` dacă pool-ul n-are
 * base/quote rezolvabil sau quote-ul nu e recunoscut (nici native nici stable) → apelantul sare `recordLp`.
 */
export function resolveLpNativeAmount(
  chain:   ChainConfig,
  pool:    { discoverySource?: string; _raw?: unknown; tokenAddress?: string } | undefined,
  amount0: bigint,
  amount1: bigint,
): { ok: boolean; ethAmount: number; quote: string | null } {
  if (!pool) return { ok: false, ethAmount: 0, quote: null };
  const { baseToken, quoteToken } = extractBaseQuote(pool);
  if (!baseToken || !quoteToken) return { ok: false, ethAmount: 0, quote: null };
  const q = getQuoteFlowAsEth(chain, baseToken, quoteToken, amount0, amount1);
  if (!q.ok || q.ethAmount <= 0) return { ok: false, ethAmount: 0, quote: q.quote };
  return { ok: true, ethAmount: q.ethAmount, quote: q.quote };
}
