/**
 * infra/v4Pricing.ts
 * V4 price via StateView.getSlot0(poolId) + reserve estimate via getLiquidity(poolId).
 *
 * Architecture:
 *   No pool contract — V4 uses PoolManager singleton.
 *   StateView is the offchain lens contract for reads (price, liquidity).
 *
 * Selectors (keccak256-verified, 2026-06-23):
 *   getSlot0(bytes32):    0xc815641c
 *   getLiquidity(bytes32): 0xfa6793d5
 *
 * Price formula (identical to V3 — same sqrtPriceX96 math):
 *   price_raw   = sqrtPriceX96² / 2¹⁹²          (token1_raw per token0_raw)
 *   price_human = price_raw × 10^(dec0 − dec1)   (human units)
 *   priceUsd    = price_human × quotePriceUsd     (if quoteIsToken1)
 *              OR quotePriceUsd / price_human      (if quoteIsToken0)
 *
 * Reserve estimate (virtual reserves from liquidity — approximate, sufficient for filtering):
 *   sqrtPrice = sqrtPriceX96 / 2^96
 *   virtual_token1 = liquidity × sqrtPrice        (in raw token1 units)
 *   virtual_token0 = liquidity / sqrtPrice        (in raw token0 units)
 *   reserveUsd ≈ 2 × (virtual_quote / 10^decQuote) × quotePriceUsd
 *   reserveSource = "V4_STATE_LIQUIDITY" — not precise TVL, but proportional to pool size
 *
 * Note on address(0):
 *   V4 currencies can be native ETH/BNB (address(0)).
 *   tokenMetadata.ts returns hardcoded ETH/BNB for address(0).
 *   quotePrices.ts maps address(0) → INDEXER_WETH_USD or INDEXER_BNB_USD.
 *   quotes.ts includes address(0) as known quote per chain.
 */

// ── ABI selectors ─────────────────────────────────────────────────────────────

const SEL_GET_SLOT0     = "0xc815641c"; // getSlot0(bytes32)
const SEL_GET_LIQUIDITY = "0xfa6793d5"; // getLiquidity(bytes32)

// ── BigInt math constants ─────────────────────────────────────────────────────

const Q96  = 2n ** 96n;
const Q192 = Q96 * Q96;
const PREC = 10n ** 18n;

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

// ── ABI encode ────────────────────────────────────────────────────────────────

/**
 * ABI-encodes a bytes32 argument (for getSlot0/getLiquidity calls).
 * poolId is already a 66-char hex string (0x + 64 hex chars).
 */
function encodeBytes32Arg(bytes32: string): string {
  // bytes32 is already 32 bytes — just strip 0x and use as the single 32-byte slot
  return bytes32.startsWith("0x") ? bytes32 : "0x" + bytes32;
}

// ── ABI decode ────────────────────────────────────────────────────────────────

/**
 * Decode getSlot0(bytes32) response.
 * Returns: (uint160 sqrtPriceX96, int24 tick, uint8 protocolFee, uint8 lpFee)
 * First 32 bytes = sqrtPriceX96 (uint160, right-aligned).
 */
function decodeSlot0(hex: string): bigint | null {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length < 64) return null;
  try {
    const v = BigInt("0x" + raw.slice(0, 64));
    return v === 0n ? null : v; // sqrtPriceX96=0 means pool uninitialized
  } catch {
    return null;
  }
}

/**
 * Decode getLiquidity(bytes32) response.
 * Returns: uint128 liquidity — first 32 bytes.
 */
function decodeLiquidity(hex: string): bigint | null {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length < 64) return null;
  try {
    return BigInt("0x" + raw.slice(0, 64));
  } catch {
    return null;
  }
}

// ── Price math (identical to V3) ──────────────────────────────────────────────

function computePriceUsd(
  sqrtPriceX96:  bigint,
  decimals0:     number,
  decimals1:     number,
  quoteIsToken0: boolean,
  quotePriceUsd: number,
): number | null {
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

  return quoteIsToken0
    ? quotePriceUsd / priceHuman
    : priceHuman * quotePriceUsd;
}

// ── Reserve estimation from liquidity ─────────────────────────────────────────

/**
 * Estimates reserveUsd from active liquidity using virtual reserves.
 *
 * Virtual reserves at current price (Uniswap constant-product model):
 *   virtual_token0 = L / sqrt(P)   ← sqrt(P) = sqrtPriceX96 / 2^96
 *   virtual_token1 = L × sqrt(P)
 *
 * Both sides contribute to TVL; we compute 2× the quote side for simplicity
 * (equivalent to V2 formula — reasonable approximation for filtering purposes).
 *
 * Marked reserveSource="V4_STATE_LIQUIDITY" — callers should not treat as precise TVL.
 */
function computeReserveUsd(
  liquidity:     bigint,
  sqrtPriceX96:  bigint,
  quoteIsToken0: boolean,
  quoteDecimals: number,
  quotePriceUsd: number,
): number {
  if (liquidity === 0n) return 0;
  try {
    // Use PREC for BigInt→Number precision
    let virtualQuotePrec: bigint;
    if (quoteIsToken0) {
      // quote = token0: virtual_token0 = L * Q96 / sqrtPriceX96
      virtualQuotePrec = (liquidity * Q96 * PREC) / sqrtPriceX96;
    } else {
      // quote = token1: virtual_token1 = L * sqrtPriceX96 / Q96
      virtualQuotePrec = (liquidity * sqrtPriceX96 * PREC) / Q96;
    }
    const virtualQuoteRaw = Number(virtualQuotePrec) / 1e18;
    const virtualQuoteHuman = virtualQuoteRaw / (10 ** quoteDecimals);
    const reserveUsd = virtualQuoteHuman * quotePriceUsd * 2; // × 2 = both sides
    return Number.isFinite(reserveUsd) && reserveUsd > 0 ? reserveUsd : 0;
  } catch {
    return 0;
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

type V4Status =
  | "OK"
  | "V4_NO_SLOT0"        // StateView.getSlot0() failed or pool uninitialized
  | "V4_PRICE_ONLY"      // price OK, getLiquidity=0 or reserveUsd=0 → not served
  | "AMBIGUOUS_QUOTE"
  | "NO_QUOTE"
  | "QUOTE_PRICE_UNKNOWN"
  | "MISSING_DECIMALS"
  | "PAIR_TOKEN_MISMATCH";

export interface V4PriceResult {
  priceUsd:      number;
  reserveUsd:    number;
  priceStatus:   V4Status;
  ammVersion:    "V4";
  pricingSource: "V4_STATE_VIEW" | null;
  reserveSource: "V4_STATE_LIQUIDITY" | "UNKNOWN_V4" | null;
}

function zeroV4(status: V4Status): V4PriceResult {
  return {
    priceUsd: 0, reserveUsd: 0, priceStatus: status,
    ammVersion: "V4", pricingSource: null, reserveSource: null,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Computes V4 pool price via StateView.getSlot0(poolId) and reserve estimate
 * via StateView.getLiquidity(poolId).
 *
 * @param rpcUrl           RPC HTTP endpoint
 * @param stateViewAddress StateView lens contract address for this chain
 * @param poolId           bytes32 pool identifier (66-char hex string)
 * @param token0           currency0 as stored in pool (from Initialize event)
 * @param token1           currency1 as stored in pool
 * @param baseToken        enriched base token address
 * @param quoteToken       enriched quote token address (null → NO_QUOTE)
 * @param baseDecimals     base token decimals (null → MISSING_DECIMALS)
 * @param quoteDecimals    quote token decimals (null → MISSING_DECIMALS)
 * @param quoteStatus      result from chooseBaseQuote
 * @param quotePriceUsd    USD price of quote token (null → QUOTE_PRICE_UNKNOWN)
 */
export async function fetchV4Price(args: {
  rpcUrl:           string;
  stateViewAddress: string;
  poolId:           string;
  token0:           string;
  token1:           string;
  baseToken:        string;
  quoteToken:       string | null | undefined;
  baseDecimals:     number | null | undefined;
  quoteDecimals:    number | null | undefined;
  quoteStatus:      "OK" | "NO_KNOWN_QUOTE" | "AMBIGUOUS_QUOTE";
  quotePriceUsd:    number | null;
}): Promise<V4PriceResult> {
  const { rpcUrl, stateViewAddress, poolId, token0, token1, baseToken, quoteToken,
          baseDecimals, quoteDecimals, quoteStatus, quotePriceUsd } = args;

  // Pre-flight guards (same as V3)
  if (quoteStatus === "AMBIGUOUS_QUOTE")               return zeroV4("AMBIGUOUS_QUOTE");
  if (quoteStatus === "NO_KNOWN_QUOTE" || !quoteToken) return zeroV4("NO_QUOTE");
  if (quotePriceUsd === null)                          return zeroV4("QUOTE_PRICE_UNKNOWN");
  if (baseDecimals == null || quoteDecimals == null)   return zeroV4("MISSING_DECIMALS");

  // PAIR_TOKEN_MISMATCH guard
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  const quoteAddr   = quoteToken.toLowerCase();
  const baseAddr    = baseToken.toLowerCase();
  const quoteIsToken0 = quoteAddr === t0;
  const quoteIsToken1 = quoteAddr === t1;
  const baseIsToken0  = baseAddr  === t0;
  const baseIsToken1  = baseAddr  === t1;
  if (!quoteIsToken0 && !quoteIsToken1) return zeroV4("PAIR_TOKEN_MISMATCH");
  if (!baseIsToken0  && !baseIsToken1)  return zeroV4("PAIR_TOKEN_MISMATCH");
  if (baseAddr === quoteAddr)           return zeroV4("PAIR_TOKEN_MISMATCH");

  // ── StateView.getSlot0(poolId) → sqrtPriceX96 ────────────────────────────
  const calldata = SEL_GET_SLOT0 + encodeBytes32Arg(poolId).slice(2); // strip 0x from poolId
  const slot0Raw = await ethCall(rpcUrl, stateViewAddress, calldata);
  if (!slot0Raw) return zeroV4("V4_NO_SLOT0");

  const sqrtPriceX96 = decodeSlot0(slot0Raw);
  if (sqrtPriceX96 === null) return zeroV4("V4_NO_SLOT0");

  // Decimals must be in pool's token order for formula correctness
  const decimals0 = quoteIsToken0 ? quoteDecimals : baseDecimals;
  const decimals1 = quoteIsToken0 ? baseDecimals  : quoteDecimals;

  const priceUsd = computePriceUsd(sqrtPriceX96, decimals0, decimals1, quoteIsToken0, quotePriceUsd);
  if (priceUsd === null || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return zeroV4("V4_NO_SLOT0");
  }

  // ── StateView.getLiquidity(poolId) → uint128 liquidity ───────────────────
  const liqCalldata = SEL_GET_LIQUIDITY + encodeBytes32Arg(poolId).slice(2);
  const liqRaw      = await ethCall(rpcUrl, stateViewAddress, liqCalldata);
  const liquidity   = liqRaw ? decodeLiquidity(liqRaw) : null;

  if (liquidity === null || liquidity === 0n) {
    // Price OK but no active liquidity — mark as V4_PRICE_ONLY (not served by indexed.ts)
    return {
      priceUsd, reserveUsd: 0, priceStatus: "V4_PRICE_ONLY",
      ammVersion: "V4", pricingSource: "V4_STATE_VIEW", reserveSource: "UNKNOWN_V4",
    };
  }

  const reserveUsd = computeReserveUsd(
    liquidity, sqrtPriceX96, quoteIsToken0, quoteDecimals, quotePriceUsd,
  );

  if (reserveUsd === 0) {
    return {
      priceUsd, reserveUsd: 0, priceStatus: "V4_PRICE_ONLY",
      ammVersion: "V4", pricingSource: "V4_STATE_VIEW", reserveSource: "UNKNOWN_V4",
    };
  }

  return {
    priceUsd,
    reserveUsd,
    priceStatus:   "OK",
    ammVersion:    "V4",
    pricingSource: "V4_STATE_VIEW",
    reserveSource: "V4_STATE_LIQUIDITY",
  };
}
