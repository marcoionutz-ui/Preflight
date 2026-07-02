/**
 * discovery/priceTracker.ts
 * 8.0h-b4: Price snapshots — preț aproximativ per pool din vault deltas.
 *
 * Formula: priceInQuote = quoteAmount_normalized / baseAmount_normalized
 *   QUOTE_IN:  quoteAmt = inputAmount,  baseAmt = outputAmount
 *   QUOTE_OUT: quoteAmt = outputAmount, baseAmt = inputAmount
 *
 * Precizie: Number (float64) — suficient pentru b4 aproximare.
 * priceUsd: direct doar pentru USDC/USDT quoted pools.
 *           null pentru SOL-quoted (SOL/USD nu e in scope b4).
 * source: "SWAP_VAULT_DELTA" — nu orderbook, nu TWAP.
 *
 * Apelat pentru knownPool=true si flow !== "UNKNOWN", alaturi de recordSwapActivity.
 * Redis key: preflight:solana:price:{pool}   (TTL 10min, refresh per write)
 */

import { getRedis }             from "../infra/redis";
import { KEY_PRICE_SNAPSHOT }   from "../config/constants";
import { resolveTokenMeta }     from "../infra/tokenMetadata";
import { SwapParseResult }      from "./swapParser";
import { USDC_MINT, USDT_MINT, WSOL_MINT } from "../config/programs";

// ── Tipuri ────────────────────────────────────────────────────────────────────

export interface PriceSnapshot {
  poolAddress:   string;
  program:       "raydium_cpmm" | "raydium_clmm";
  baseMint:      string;
  quoteMint:     string;
  baseSymbol:    string;
  quoteSymbol:   string;
  priceInQuote:  number;        // preț base in unitati quote (ex: 0.000012 SOL per token)
  priceUsd:      number | null; // direct doar pentru USDC/USDT quoted, null pentru SOL
  lastUpdatedAt: number;
  lastSignature: string;
  source:        "SWAP_VAULT_DELTA";
  coverage:      "SAMPLED";     // din TX sample (nu firehose) — nu pretinde precizie TWAP
}

// ── Constante ─────────────────────────────────────────────────────────────────

const TTL_SEC = 10 * 60;

// Decimale hardcodate pentru quote mints cunoscute — evita resolveTokenMeta call extra
const KNOWN_DECIMALS: Record<string, number> = {
  [WSOL_MINT]: 9,
  [USDC_MINT]: 6,
  [USDT_MINT]: 6,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function programLabel(prog: SwapParseResult["program"]): "raydium_cpmm" | "raydium_clmm" {
  return prog === "cpmm" ? "raydium_cpmm" : "raydium_clmm";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Calculeaza si salveaza un price snapshot pentru un pool dupa un swap parsed.
 * Apelat doar cand result.knownPool === true si flow !== "UNKNOWN".
 *
 * Nu arunca erori — toate path-urile de esec returneaza silentios.
 */
export async function recordPriceSnapshot(
  result:    SwapParseResult,
  signature: string,
): Promise<void> {
  // knownPool nu mai e required — price e util și pentru pooluri nedescoperite încă
  if (result.flow === "UNKNOWN") return;

  // Extrage quote si base amounts in functie de directia fluxului
  let quoteAmt: bigint;
  let baseAmt:  bigint;

  if (result.flow === "QUOTE_IN") {
    quoteAmt = result.inputAmount  ?? 0n;
    baseAmt  = result.outputAmount ?? 0n;
  } else {
    // QUOTE_OUT
    baseAmt  = result.inputAmount  ?? 0n;
    quoteAmt = result.outputAmount ?? 0n;
  }

  if (baseAmt === 0n || quoteAmt === 0n) return;

  // Meta pentru ambele mints — din cache Redis (aprox. intotdeauna disponibil)
  const [quoteMeta, baseMeta] = await Promise.all([
    resolveTokenMeta(result.quoteMint),
    resolveTokenMeta(result.baseMint),
  ]);

  const quoteDecimals = KNOWN_DECIMALS[result.quoteMint] ?? quoteMeta.decimals ?? 9;
  const baseDecimals  = KNOWN_DECIMALS[result.baseMint]  ?? baseMeta.decimals  ?? 9;

  // Normalizare la unitati reale — Number() suficient pentru aproximare b4
  const quoteNorm = Number(quoteAmt) / Math.pow(10, quoteDecimals);
  const baseNorm  = Number(baseAmt)  / Math.pow(10, baseDecimals);

  if (baseNorm === 0 || !isFinite(quoteNorm) || !isFinite(baseNorm)) return;

  const priceInQuote = quoteNorm / baseNorm;
  if (!isFinite(priceInQuote) || priceInQuote <= 0) return;

  // priceUsd direct doar pentru USDC/USDT quoted pools
  const isUsdQuote = result.quoteMint === USDC_MINT || result.quoteMint === USDT_MINT;
  const priceUsd   = isUsdQuote ? priceInQuote : null;

  const progLabel = result.program === "cpmm" ? "CPMM" : "CLMM";

  const snapshot: PriceSnapshot = {
    poolAddress:   result.pool,
    program:       programLabel(result.program),
    baseMint:      result.baseMint,
    quoteMint:     result.quoteMint,
    baseSymbol:    baseMeta.symbol  ?? result.baseMint.slice(0, 8),
    quoteSymbol:   quoteMeta.symbol ?? result.quoteMint.slice(0, 8),
    priceInQuote,
    priceUsd,
    lastUpdatedAt: Date.now(),
    lastSignature: signature,
    source:        "SWAP_VAULT_DELTA",
    coverage:      "SAMPLED",
  };

  await getRedis().set(
    KEY_PRICE_SNAPSHOT(result.pool),
    JSON.stringify(snapshot),
    "EX",
    TTL_SEC,
  );

  console.log(
    "[SOLANA][SWAP][" + progLabel + "][PRICE]"
    + " pool=" + result.pool.slice(0, 8) + "..."
    + " base=" + snapshot.baseSymbol
    + " price=" + priceInQuote.toExponential(4)
    + " " + snapshot.quoteSymbol
    + (priceUsd !== null ? " priceUsd=" + priceUsd.toExponential(4) : "")
    + " sig=" + signature.slice(0, 12) + "...",
  );
}
