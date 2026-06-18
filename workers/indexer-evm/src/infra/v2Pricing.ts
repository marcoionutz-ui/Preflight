/**
 * infra/v2Pricing.ts
 * V2-style price + liquidity via getReserves() eth_call.
 *
 * Scope Faza 6.5: V2 / Aerodrome V2 only.
 * V3 pools (UniswapV3, PancakeV3) → priceStatus="V3_SKIP", priceUsd=0.
 * V3 pricing (tick math) este OUT OF SCOPE — se adaugă în faza ulterioară.
 *
 * getReserves() ABI:
 *   selector: 0x0902f1ac
 *   returns: (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
 *   encoded: 3 × 32 bytes (96 bytes total = 192 hex chars)
 *
 * Price formula (V2 constant product):
 *   priceUsd   = (reserveQuote_adj × quotePriceUsd) / reserveBase_adj
 *   reserveUsd = reserveQuote_adj × quotePriceUsd × 2   (total pool = 2× quote side)
 */

const SEL_GET_RESERVES = "0x0902f1ac";

/** Shares INDEXER_METADATA_RPC_TIMEOUT_MS pentru consistență. */
const TIMEOUT_MS = (() => {
  const n = Number(process.env.INDEXER_METADATA_RPC_TIMEOUT_MS ?? 4_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4_000;
})();

/** dexIds care folosesc V3 pool style — getReserves nu există pe ele. */
const V3_DEX_IDS = new Set(["uniswap-v3", "pancakeswap-v3"]);

// ── Types ─────────────────────────────────────────────────────────────────────

export type PriceStatus =
  | "OK"                    // price computed successfully
  | "V3_SKIP"               // V3 pool — nu facem tick math în 6.5
  | "AMBIGUOUS_QUOTE"       // ambele tokens sunt quote (ex: USDC/DAI) — skip pricing
  | "NO_QUOTE"              // quoteStatus=NO_KNOWN_QUOTE
  | "QUOTE_PRICE_UNKNOWN"   // quoteToken recunoscut dar quotePriceUsd=null (WETH fără env)
  | "MISSING_DECIMALS"      // baseDecimals sau quoteDecimals lipsă
  | "PAIR_TOKEN_MISMATCH"   // base + quote nu sunt pe laturi opuse — data corruption guard
  | "NO_RESERVES";          // getReserves a eșuat sau rezervele sunt 0

export interface V2PriceResult {
  priceUsd:    number;
  reserveUsd:  number;
  priceStatus: PriceStatus;
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
  return { priceUsd: 0, reserveUsd: 0, priceStatus };
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
  rpcUrl:        string;
  pairAddress:   string;
  dexId:         string;
  token0:        string;
  baseToken:     string;
  baseDecimals:  number | null | undefined;
  quoteToken:    string | null | undefined;
  quoteDecimals: number | null | undefined;
  quoteStatus:   "OK" | "NO_KNOWN_QUOTE" | "AMBIGUOUS_QUOTE";
  quotePriceUsd: number | null;
}): Promise<V2PriceResult> {
  const { rpcUrl, pairAddress, dexId, token0, baseToken,
          baseDecimals, quoteToken, quoteDecimals, quoteStatus, quotePriceUsd } = args;

  // V3: skip — no tick math
  if (V3_DEX_IDS.has(dexId)) {
    return zero("V3_SKIP");
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

  return { priceUsd, reserveUsd, priceStatus: "OK" };
}
