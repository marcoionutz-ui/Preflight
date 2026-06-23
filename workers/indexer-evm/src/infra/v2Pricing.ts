/**
 * infra/v2Pricing.ts
 * Pricing router: V2-style pools via getReserves(), V3 pools via v3Pricing.ts.
 *
 * V2 / Aerodrome V2 / Camelot V2:
 *   getReserves() → reserve0/reserve1 → priceUsd
 *   getReserves() ABI:
 *     selector: 0x0902f1ac
 *     returns: (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
 *     encoded: 3 × 32 bytes (96 bytes = 192 hex chars)
 *   Price formula (constant product):
 *     priceUsd   = (reserveQuote_adj × quotePriceUsd) / reserveBase_adj
 *     reserveUsd = reserveQuote_adj × quotePriceUsd × 2
 *
 * V3 (UniswapV3, PancakeV3):
 *   Routed → v3Pricing.ts (slot0 + balanceOf)
 *   priceStatus=OK + ammVersion=V3 + pricingSource=V3_SLOT0
 *
 * Faza 6.9b: V3_SKIP eliminat din output nou — historical Redis entries îl pot păstra.
 * Faza 6.9c: V4 routing via v4Pricing.ts (StateView.getSlot0 + getLiquidity).
 */

import { fetchV3Price } from "./v3Pricing";
import { fetchV4Price } from "./v4Pricing";

const SEL_GET_RESERVES = "0x0902f1ac";

/** Shares INDEXER_METADATA_RPC_TIMEOUT_MS pentru consistență. */
const TIMEOUT_MS = (() => {
  const n = Number(process.env.INDEXER_METADATA_RPC_TIMEOUT_MS ?? 4_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4_000;
})();

/** dexIds care folosesc V3 pool style — rutate spre v3Pricing.ts (slot0 + balanceOf). */
const V3_DEX_IDS = new Set(["uniswap-v3", "pancakeswap-v3"]);

/** dexIds care folosesc V4 PoolManager — rutate spre v4Pricing.ts (StateView). */
const V4_DEX_IDS = new Set(["uniswap-v4"]);

// ── Types ─────────────────────────────────────────────────────────────────────

export type PriceStatus =
  | "OK"                    // price + reserve computed successfully
  | "V3_SKIP"               // deprecated (Faza 6.5) — historical Redis entries only
  | "V3_NO_SLOT0"           // V3 pool — slot0() failed or pool uninitialized
  | "V3_PRICE_ONLY"         // V3 pool — price OK, balanceOf reserve failed → not served
  | "V4_NO_SLOT0"           // V4 pool — StateView.getSlot0() failed or pool uninitialized
  | "V4_PRICE_ONLY"         // V4 pool — price OK, getLiquidity=0 or reserve=0 → not served
  | "AMBIGUOUS_QUOTE"       // ambele tokens sunt quote (ex: USDC/DAI) — skip pricing
  | "NO_QUOTE"              // quoteStatus=NO_KNOWN_QUOTE
  | "QUOTE_PRICE_UNKNOWN"   // quoteToken recunoscut dar quotePriceUsd=null (WETH fără env)
  | "MISSING_DECIMALS"      // baseDecimals sau quoteDecimals lipsă
  | "PAIR_TOKEN_MISMATCH"   // base + quote nu sunt pe laturi opuse — data corruption guard
  | "NO_RESERVES";          // getReserves a eșuat sau rezervele sunt 0

export type AmmVersion    = "V2" | "V3" | "V4";
export type PricingSource = "V2_RESERVES" | "V3_SLOT0" | "V4_STATE_VIEW";
export type ReserveSource = "V2_RESERVES" | "BALANCE_OF" | "UNKNOWN" | "UNKNOWN_V4" | "V4_STATE_LIQUIDITY";

export interface V2PriceResult {
  priceUsd:       number;
  reserveUsd:     number;
  priceStatus:    PriceStatus;
  ammVersion?:    AmmVersion;
  pricingSource?: PricingSource;
  reserveSource?: ReserveSource;
}

// ── eth_call (single attempt, timeout-guarded) ────────────────────────────────

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

function decodeGetReserves(hex: string): { reserve0: bigint; reserve1: bigint } | null {
  const raw = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (raw.length < 192) return null; // need at least 96 bytes (3 × 32)
  try {
    const reserve0 = BigInt("0x" + raw.slice(0, 64));
    const reserve1 = BigInt("0x" + raw.slice(64, 128));
    return { reserve0, reserve1 };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function zero(priceStatus: PriceStatus): V2PriceResult {
  return { priceUsd: 0, reserveUsd: 0, priceStatus }; // no ammVersion/pricingSource on error
}

/**
 * Fetches V2 reserves and computes price + liquidity for one pair.
 *
 * @param rpcUrl        RPC HTTP endpoint
 * @param pairAddress   pair/pool contract address
 * @param dexId         dex identifier — V3 dexIds return V3_SKIP immediately
 * @param token0        token0 as stored in pair (determines reserve0/reserve1 mapping)
 * @param baseToken     enriched base token address (from chooseBaseQuote)
 * @param baseDecimals  token decimals for base (null → MISSING_DECIMALS)
 * @param quoteToken    enriched quote token address (null → NO_QUOTE)
 * @param quoteDecimals token decimals for quote (null → MISSING_DECIMALS)
 * @param quoteStatus   "OK" | "NO_KNOWN_QUOTE" | "AMBIGUOUS_QUOTE"
 * @param quotePriceUsd USD price for quote token (null → QUOTE_PRICE_UNKNOWN)
 */
export async function fetchV2Price(args: {
  rpcUrl:            string;
  pairAddress:       string;    // V2/V3: pool address; V4: poolId (bytes32, 66 chars)
  dexId:             string;
  token0:            string;
  token1:            string;
  baseToken:         string;
  baseDecimals:      number | null | undefined;
  quoteToken:        string | null | undefined;
  quoteDecimals:     number | null | undefined;
  quoteStatus:       "OK" | "NO_KNOWN_QUOTE" | "AMBIGUOUS_QUOTE";
  quotePriceUsd:     number | null;
  stateViewAddress?: string;    // V4 only — StateView lens contract address
}): Promise<V2PriceResult> {
  const { rpcUrl, pairAddress, dexId, token0, token1, baseToken,
          baseDecimals, quoteToken, quoteDecimals, quoteStatus, quotePriceUsd,
          stateViewAddress } = args;

  // V4: route to v4Pricing (StateView.getSlot0 + getLiquidity) — Faza 6.9c
  if (V4_DEX_IDS.has(dexId)) {
    if (!stateViewAddress) {
      // No StateView configured for this chain — cannot price
      return zero("NO_RESERVES");
    }
    const v4 = await fetchV4Price({
      rpcUrl,
      stateViewAddress,
      poolId:        pairAddress,
      token0,
      token1,
      baseToken,
      quoteToken,
      baseDecimals,
      quoteDecimals,
      quoteStatus,
      quotePriceUsd,
    });
    return {
      priceUsd:      v4.priceUsd,
      reserveUsd:    v4.reserveUsd,
      priceStatus:   v4.priceStatus as PriceStatus,
      ammVersion:    v4.ammVersion,
      pricingSource: v4.pricingSource ?? undefined,
      reserveSource: v4.reserveSource ?? undefined,
    };
  }

  // V3: route to v3Pricing (slot0 + balanceOf) — Faza 6.9b
  if (V3_DEX_IDS.has(dexId)) {
    const v3 = await fetchV3Price({
      rpcUrl,
      poolAddress:   pairAddress,
      token0,
      token1,
      baseToken,
      quoteToken,
      baseDecimals,
      quoteDecimals,
      quoteStatus,
      quotePriceUsd,
    });
    return {
      priceUsd:      v3.priceUsd,
      reserveUsd:    v3.reserveUsd,
      priceStatus:   v3.priceStatus as PriceStatus,
      ammVersion:    v3.ammVersion,
      pricingSource: v3.pricingSource ?? undefined,
      reserveSource: v3.reserveSource ?? undefined,
    };
  }

  // Both tokens are quote (e.g. USDC/DAI) — skip, not a tradeable base token
  if (quoteStatus === "AMBIGUOUS_QUOTE") {
    return zero("AMBIGUOUS_QUOTE");
  }

  // No known quote token
  if (quoteStatus === "NO_KNOWN_QUOTE" || !quoteToken) {
    return zero("NO_QUOTE");
  }

  // Quote price unknown (WETH with no env)
  if (quotePriceUsd === null) {
    return zero("QUOTE_PRICE_UNKNOWN");
  }

  // Need decimals for both sides
  if (baseDecimals == null || quoteDecimals == null) {
    return zero("MISSING_DECIMALS");
  }

  // Fetch reserves via getReserves()
  const raw = await ethCall(rpcUrl, pairAddress, SEL_GET_RESERVES);
  if (!raw) return zero("NO_RESERVES");

  const reserves = decodeGetReserves(raw);
  if (!reserves || reserves.reserve0 === 0n || reserves.reserve1 === 0n) {
    return zero("NO_RESERVES");
  }

  // Verify base and quote are on opposite sides of the pair (data corruption guard)
  const t0           = token0.toLowerCase();
  const baseIsToken0 = baseToken.toLowerCase()  === t0;
  const quoteIsToken0 = quoteToken.toLowerCase() === t0;

  if (baseIsToken0 === quoteIsToken0) {
    // Both map to same side — enrichment bug, skip pricing
    return zero("PAIR_TOKEN_MISMATCH");
  }

  // getReserves() returns (reserve0, reserve1) always in token0/token1 order
  const reserveBase  = baseIsToken0 ? reserves.reserve0 : reserves.reserve1;
  const reserveQuote = baseIsToken0 ? reserves.reserve1 : reserves.reserve0;

  // Adjust for decimals
  const baseAdj  = Number(reserveBase)  / 10 ** baseDecimals;
  const quoteAdj = Number(reserveQuote) / 10 ** quoteDecimals;

  if (baseAdj === 0) return zero("NO_RESERVES");

  const priceUsd   = (quoteAdj * quotePriceUsd) / baseAdj;
  const reserveUsd = quoteAdj * quotePriceUsd * 2; // total TVL = 2× quote side

  return {
    priceUsd,
    reserveUsd,
    priceStatus:   "OK",
    ammVersion:    "V2",
    pricingSource: "V2_RESERVES",
    reserveSource: "V2_RESERVES",
  };
}
