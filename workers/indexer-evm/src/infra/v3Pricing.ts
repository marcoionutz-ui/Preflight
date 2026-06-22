/**
 * infra/v3Pricing.ts
 * V3 price via slot0() + reserve approximation via balanceOf().
 *
 * slot0() ABI:
 *   selector: 0x3850c7bd  [keccak256("slot0()")[0..3]]
 *   returns: (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)
 *   sqrtPriceX96 = first 32 bytes (64 hex chars, no 0x)
 *
 * balanceOf(address) ABI:
 *   selector: 0x70a08231  [keccak256("balanceOf(address)")[0..3]]
 *   param: address zero-padded to 32 bytes
 *   returns: uint256 (32 bytes)
 *
 * Price formula (BigInt — no Number precision issues):
 *   price_raw   = sqrtPriceX96² / 2¹⁹²          (token1_raw per token0_raw)
 *   price_human = price_raw × 10^(dec0 − dec1)   (token1_human per token0_human)
 *   quoteToken = token1: priceUsd = price_human × quotePriceUsd
 *   quoteToken = token0: priceUsd = quotePriceUsd / price_human
 *
 * Reserve approximation (two-sided — mai onest decât quote×2 pentru concentrated liquidity):
 *   reserveUsd = quoteBalance × quotePriceUsd + baseBalance × priceUsd
 *   reserveSource = "BALANCE_OF" (honest — not "active liquidity")
 *
 * Result statuses:
 *   OK            — price + reserve both computed
 *   V3_PRICE_ONLY — price computed, balanceOf failed → not served by indexed.ts
 *   V3_NO_SLOT0   — slot0() failed → not priceable
 *   AMBIGUOUS_QUOTE / NO_QUOTE / QUOTE_PRICE_UNKNOWN / MISSING_DECIMALS — same as V2
 */

// ── ABI selectors ─────────────────────────────────────────────────────────────

const SEL_SLOT0      = "0x3850c7bd"; // slot0()
const SEL_BALANCE_OF = "0x70a08231"; // balanceOf(address)

// ── BigInt math constants ─────────────────────────────────────────────────────

const Q96  = 2n ** 96n;
const Q192 = Q96 * Q96;
const PREC = 10n ** 18n; // precision factor for BigInt → Number conversion

// ── Timeout ───────────────────────────────────────────────────────────────────

const TIMEOUT_MS = (() => {
  const n = Number(process.env.INDEXER_METADATA_RPC_TIMEOUT_MS ?? 4_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4_000;
})();

// ── eth_call ──────────────────────────────────────────────────────────────────

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string | null> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        jsonrpc: "2.0",
        id:      1,
        method:  "eth_call",
        params:  [{ to, data }, "latest"],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: string; error?: unknown };
    if (json.error || !json.result || json.result === "0x") return null;
    return json.result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── ABI decode ────────────────────────────────────────────────────────────────

/** slot0() → sqrtPriceX96 as bigint, or null if call failed / pool uninitialized. */
function decodeSlot0(hex: string): bigint | null {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length < 64) return null;
  try {
    const v = BigInt("0x" + raw.slice(0, 64));
    return v === 0n ? null : v; // sqrtPriceX96=0 means pool is uninitialized
  } catch {
    return null;
  }
}

/** uint256 (balanceOf) → bigint, or null on failure. */
function decodeUint256(hex: string): bigint | null {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length < 64) return null;
  try {
    return BigInt("0x" + raw.slice(0, 64));
  } catch {
    return null;
  }
}

// ── ABI encode ────────────────────────────────────────────────────────────────

/** ABI-encodes balanceOf(address) calldata. */
function encodeBalanceOf(ownerAddress: string): string {
  const addr = ownerAddress.toLowerCase().replace("0x", "").padStart(40, "0");
  // 32 bytes = 24 hex chars zero-pad + 40 hex chars address
  return SEL_BALANCE_OF + "000000000000000000000000" + addr;
}

// ── Price math ────────────────────────────────────────────────────────────────

/**
 * sqrtPriceX96 → USD price of base token.
 *
 * All intermediate math in BigInt to avoid Number overflow/precision loss.
 * Only converts to Number at the final step.
 *
 * @param sqrtPriceX96  from slot0()
 * @param decimals0     token0 decimals (in pool order)
 * @param decimals1     token1 decimals (in pool order)
 * @param quoteIsToken0 true when quoteToken === token0 (base is token1)
 * @param quotePriceUsd USD price of the quote token
 */
function computePriceUsd(
  sqrtPriceX96:  bigint,
  decimals0:     number,
  decimals1:     number,
  quoteIsToken0: boolean,
  quotePriceUsd: number,
): number | null {
  // price_raw = sqrtPriceX96² / 2¹⁹² (token1_raw per token0_raw)
  // price_human = price_raw × 10^(dec0 − dec1) (token1_human per token0_human)
  //
  // BigInt representation (PREC for sub-integer precision):
  //   priceHumanPrec = sqrtPriceX96² × PREC × 10^(dec0−dec1) / Q192
  //   priceHuman = priceHumanPrec / PREC (as Number)

  const decDiff = decimals0 - decimals1;
  const num     = sqrtPriceX96 * sqrtPriceX96 * PREC;

  let priceHumanPrec: bigint;
  if (decDiff >= 0) {
    priceHumanPrec = (num * (10n ** BigInt(decDiff))) / Q192;
  } else {
    priceHumanPrec = num / (Q192 * (10n ** BigInt(-decDiff)));
  }

  if (priceHumanPrec === 0n) return null;

  const priceHuman = Number(priceHumanPrec) / 1e18;
  if (!Number.isFinite(priceHuman) || priceHuman <= 0) return null;

  // quoteToken = token1 → priceHuman = quote per base → multiply
  // quoteToken = token0 → priceHuman = base per quote → invert
  return quoteIsToken0
    ? quotePriceUsd / priceHuman
    : priceHuman * quotePriceUsd;
}

// ── Public types ──────────────────────────────────────────────────────────────

/** Subset of PriceStatus relevant to V3. Compatible with PriceStatus from v2Pricing.ts. */
type V3Status =
  | "OK"
  | "V3_NO_SLOT0"
  | "V3_PRICE_ONLY"
  | "AMBIGUOUS_QUOTE"
  | "NO_QUOTE"
  | "QUOTE_PRICE_UNKNOWN"
  | "MISSING_DECIMALS"
  | "PAIR_TOKEN_MISMATCH";

export interface V3PriceResult {
  priceUsd:      number;
  reserveUsd:    number;
  priceStatus:   V3Status;
  ammVersion:    "V3";
  pricingSource: "V3_SLOT0" | null;
  reserveSource: "BALANCE_OF" | "UNKNOWN" | null;
}

// ── Public API ────────────────────────────────────────────────────────────────

function zeroV3(status: V3Status): V3PriceResult {
  return {
    priceUsd: 0, reserveUsd: 0, priceStatus: status,
    ammVersion: "V3", pricingSource: null, reserveSource: null,
  };
}

/**
 * Computes V3 pool price via slot0() and reserve via balanceOf() on both tokens.
 *
 * @param rpcUrl        RPC HTTP endpoint
 * @param poolAddress   V3 pool contract address
 * @param token0        token0 as stored in pool (determines sqrtPriceX96 orientation)
 * @param token1        token1 as stored in pool (used for PAIR_TOKEN_MISMATCH guard + reserve)
 * @param baseToken     enriched base token address
 * @param quoteToken    enriched quote token address (null → NO_QUOTE)
 * @param baseDecimals  base token decimals (null → MISSING_DECIMALS)
 * @param quoteDecimals quote token decimals (null → MISSING_DECIMALS)
 * @param quoteStatus   result from chooseBaseQuote
 * @param quotePriceUsd USD price of quote token (null → QUOTE_PRICE_UNKNOWN)
 */
export async function fetchV3Price(args: {
  rpcUrl:        string;
  poolAddress:   string;
  token0:        string;
  token1:        string;
  baseToken:     string;
  quoteToken:    string | null | undefined;
  baseDecimals:  number | null | undefined;
  quoteDecimals: number | null | undefined;
  quoteStatus:   "OK" | "NO_KNOWN_QUOTE" | "AMBIGUOUS_QUOTE";
  quotePriceUsd: number | null;
}): Promise<V3PriceResult> {
  const { rpcUrl, poolAddress, token0, token1, baseToken, quoteToken,
          baseDecimals, quoteDecimals, quoteStatus, quotePriceUsd } = args;

  // Pre-flight checks (same guards as V2)
  if (quoteStatus === "AMBIGUOUS_QUOTE")               return zeroV3("AMBIGUOUS_QUOTE");
  if (quoteStatus === "NO_KNOWN_QUOTE" || !quoteToken) return zeroV3("NO_QUOTE");
  if (quotePriceUsd === null)                          return zeroV3("QUOTE_PRICE_UNKNOWN");
  if (baseDecimals == null || quoteDecimals == null)   return zeroV3("MISSING_DECIMALS");

  // Guard: quote must be exactly one of token0/token1 (data corruption check)
  const t0          = token0.toLowerCase();
  const t1          = token1.toLowerCase();
  const quoteAddr   = quoteToken.toLowerCase();
  const baseAddr    = baseToken.toLowerCase();
  const quoteIsToken0 = quoteAddr === t0;
  const quoteIsToken1 = quoteAddr === t1;
  const baseIsToken0  = baseAddr  === t0;
  const baseIsToken1  = baseAddr  === t1;
  if (!quoteIsToken0 && !quoteIsToken1) return zeroV3("PAIR_TOKEN_MISMATCH");
  if (!baseIsToken0  && !baseIsToken1)  return zeroV3("PAIR_TOKEN_MISMATCH");
  if (baseAddr === quoteAddr)           return zeroV3("PAIR_TOKEN_MISMATCH");

  // ── slot0 → sqrtPriceX96 → priceUsd ──────────────────────────────────────
  const slot0Raw = await ethCall(rpcUrl, poolAddress, SEL_SLOT0);
  if (!slot0Raw) return zeroV3("V3_NO_SLOT0");

  const sqrtPriceX96 = decodeSlot0(slot0Raw);
  if (sqrtPriceX96 === null) return zeroV3("V3_NO_SLOT0");

  // decimals0/decimals1 must match pool's actual token order for formula correctness
  const decimals0 = quoteIsToken0 ? quoteDecimals : baseDecimals;
  const decimals1 = quoteIsToken0 ? baseDecimals  : quoteDecimals;

  const priceUsd = computePriceUsd(sqrtPriceX96, decimals0, decimals1, quoteIsToken0, quotePriceUsd);
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return zeroV3("V3_NO_SLOT0");
  }

  // ── balanceOf(pool) for both tokens → two-sided reserve ──────────────────
  // V3 concentrated liquidity can be heavily skewed — quote×2 would be inaccurate.
  // Fetch both sides and use priceUsd (already computed) for base side.
  const [quoteBal, baseBal] = await Promise.all([
    ethCall(rpcUrl, quoteAddr, encodeBalanceOf(poolAddress)),
    ethCall(rpcUrl, baseAddr,  encodeBalanceOf(poolAddress)),
  ]);

  const quoteBigInt = quoteBal ? decodeUint256(quoteBal) : null;
  const baseBigInt  = baseBal  ? decodeUint256(baseBal)  : null;

  if (quoteBigInt === null || baseBigInt === null) {
    // Price calculable but reserve incomplete — mark V3_PRICE_ONLY (not served by indexed.ts)
    return {
      priceUsd, reserveUsd: 0, priceStatus: "V3_PRICE_ONLY",
      ammVersion: "V3", pricingSource: "V3_SLOT0", reserveSource: "UNKNOWN",
    };
  }

  const quoteAmt = quoteBigInt !== null ? Number(quoteBigInt) / (10 ** quoteDecimals) : 0;
  const baseAmt  = baseBigInt  !== null ? Number(baseBigInt)  / (10 ** baseDecimals)  : 0;

  const reserveUsd =
    quoteAmt * quotePriceUsd +  // quote side (USD)
    baseAmt  * priceUsd;        // base side (USD via slot0 price — honest, not fake)

  if (reserveUsd === 0) {
    return {
      priceUsd, reserveUsd: 0, priceStatus: "V3_PRICE_ONLY",
      ammVersion: "V3", pricingSource: "V3_SLOT0", reserveSource: "UNKNOWN",
    };
  }

  return {
    priceUsd,
    reserveUsd,
    priceStatus:   "OK",
    ammVersion:    "V3",
    pricingSource: "V3_SLOT0",
    reserveSource: "BALANCE_OF",
  };
}
