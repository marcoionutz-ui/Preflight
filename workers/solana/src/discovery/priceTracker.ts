/**
 * discovery/priceTracker.ts
 * 8.0h-b4: Price snapshots — preț aproximativ per pool din vault deltas.
 * 8.0h-b5: Ring buffer history + ZSET index per pool (fara KEYS scan in movers job).
 * 8.0j:    WSOL-quoted pools get priceUsd via cached SOL/USD oracle (Jupiter Price API v2).
 *
 * Formula: priceInQuote = quoteAmount_normalized / baseAmount_normalized
 *   QUOTE_IN:  quoteAmt = inputAmount,  baseAmt = outputAmount
 *   QUOTE_OUT: quoteAmt = outputAmount, baseAmt = inputAmount
 *
 * Redis keys (b5):
 *   preflight:solana:price:{pool}           — current snapshot (TTL 10m)
 *   preflight:solana:price:history:{pool}   — ring buffer max 60 intrări (TTL 2h)
 *   preflight:solana:price:pools            — ZSET index (score = lastUpdatedAt ms)
 */

import { getRedis }             from "../infra/redis";
import {
  KEY_PRICE_SNAPSHOT,
  KEY_PRICE_HISTORY,
  KEY_PRICE_POOLS,
}                               from "../config/constants";
import { resolveTokenMeta }     from "../infra/tokenMetadata";
import { SwapParseResult }      from "./swapParser";
import { USDC_MINT, USDT_MINT, WSOL_MINT } from "../config/programs";
import { maybeCalculateMovers } from "./moversTracker";
import { readSolPrice }         from "../infra/solPriceOracle";

// ── Tipuri ────────────────────────────────────────────────────────────────────

export interface PriceSnapshot {
  poolAddress:   string;
  program:       "raydium_cpmm" | "raydium_clmm";
  baseMint:      string;
  quoteMint:     string;
  baseSymbol:    string;
  quoteSymbol:   string;
  priceInQuote:  number;        // preț base in unitati quote (ex: 0.000012 SOL per token)
  priceUsd:      number | null; // USDC/USDT direct; WSOL via cached SOL/USD oracle; null dacă oracle indisponibil
  usdSource:     "STABLE_QUOTE" | "SOL_USD_ORACLE" | null;
  solUsdPrice?:  number;        // prețul SOL/USD folosit (doar dacă usdSource = SOL_USD_ORACLE)
  lastUpdatedAt: number;
  lastSignature: string;
  source:        "SWAP_VAULT_DELTA";
  coverage:      "SAMPLED";     // din TX sample (nu firehose) — nu pretinde precizie TWAP
  knownPool:     boolean;       // true = pool indexat in preflight, false = sampled unknown
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
 * Apelat pentru orice pool cu flow !== "UNKNOWN" (b4b: nu mai e gated pe knownPool).
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

  // 8.0j: priceUsd — USD/STABLE direct, WSOL via oracle
  const isUsdQuote  = result.quoteMint === USDC_MINT || result.quoteMint === USDT_MINT;
  const isWsolQuote = result.quoteMint === WSOL_MINT;
  let priceUsd:    number | null = null;
  let usdSource:   PriceSnapshot["usdSource"] = null;
  let solUsdPrice: number | undefined;

  if (isUsdQuote) {
    priceUsd  = priceInQuote;
    usdSource = "STABLE_QUOTE";
  } else if (isWsolQuote) {
    const solUsd = await readSolPrice();
    if (solUsd !== null) {
      solUsdPrice = solUsd;
      priceUsd    = priceInQuote * solUsd;
      usdSource   = "SOL_USD_ORACLE";
    }
  }

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
    usdSource,
    solUsdPrice,
    lastUpdatedAt: Date.now(),
    lastSignature: signature,
    source:        "SWAP_VAULT_DELTA",
    coverage:      "SAMPLED",
    knownPool:     result.knownPool,
  };

  const redis = getRedis();

  // b4: current snapshot
  await redis.set(
    KEY_PRICE_SNAPSHOT(result.pool),
    JSON.stringify(snapshot),
    "EX",
    TTL_SEC,
  );

  // b5: ring buffer history (max 60 intrări, TTL 2h) + ZSET index
  const historyEntry = JSON.stringify({ p: priceInQuote, ts: snapshot.lastUpdatedAt });
  const pipeline = redis.pipeline();
  pipeline.lpush(KEY_PRICE_HISTORY(result.pool), historyEntry);
  pipeline.ltrim(KEY_PRICE_HISTORY(result.pool), 0, 59);
  pipeline.expire(KEY_PRICE_HISTORY(result.pool), 2 * 60 * 60);
  pipeline.zadd(KEY_PRICE_POOLS, snapshot.lastUpdatedAt, result.pool);
  await pipeline.exec();

  console.log(
    "[SOLANA][SWAP][" + progLabel + "][PRICE]"
    + " pool=" + result.pool.slice(0, 8) + "..."
    + " base=" + snapshot.baseSymbol
    + " price=" + priceInQuote.toExponential(4)
    + " " + snapshot.quoteSymbol
    + (priceUsd !== null ? " priceUsd=" + priceUsd.toExponential(4) + " (" + usdSource + ")" : "")
    + " sig=" + signature.slice(0, 12) + "...",
  );

  // b5: trigger movers calculation (throttled la 60s in moversTracker)
  maybeCalculateMovers().catch((err: Error) => {
    console.warn("[SOLANA][MOVERS] trigger error:", err.message);
  });
}
