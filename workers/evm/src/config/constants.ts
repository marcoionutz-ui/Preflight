/**
 * config/constants.ts
 * Toate constantele și thresholds-urile workerului.
 * Zero imports din alte module interne.
 */

export const WORKER_VERSION = "v5.39";

export const GECKO_BASE = "https://api.geckoterminal.com/api/v2";

// ── Scan ──────────────────────────────────────────────────────────────────────
export const SCAN_INTERVAL       = 30_000;

// ── Shadow trades ─────────────────────────────────────────────────────────────
export const MAX_SHADOW_PER_SCAN = 5;
export const COOLDOWN_MS         = 2 * 60 * 60_000;
export const SECOND_WAVE_COOLDOWN_MS = 60 * 60_000;
export const MAX_HOLD_MS         = 4 * 60 * 60_000;

// ── Watch lifecycle ───────────────────────────────────────────────────────────
export const WATCH_MAX_AGE_MS         = 20 * 60_000;
export const WATCH_NO_FLOW_MAX_AGE_MS =  8 * 60_000;
export const WATCH_SELLING_MAX_AGE_MS =  5 * 60_000;

// ── FOMO watch ────────────────────────────────────────────────────────────────
export const FOMO_WATCH_TTL_MS        = 10 * 60_000;
export const FOMO_RECHECK_MIN_AGE_MS  = 60_000;
export const FOMO_RECHECK_MAX_AGE_MS  = 10 * 60_000;
export const FOMO_NO_WS_DROP_MS       =  3 * 60_000;
export const MAX_FOMO_WATCH     = 15;

// ── Watch limits ──────────────────────────────────────────────────────────────
export const MAX_ACTIVE_WATCH       = 60;

export const MAX_ACTIVE_WATCH_BY_CHAIN: Record<string, number> = {
  base:     20,
  arbitrum: 12,
  bsc:      25,
};
export const MAX_VERTICAL_WATCH     = 20;
export const MAX_LATE_WATCH         = 10;
export const MAX_V3_WATCH           = 30;
export const MAX_V4_WATCH           = 60;
export const MAX_EVENT_WATCH        = 5;
export const MAX_SHORT_WATCH        = 5;
export const MAX_CONTINUATION_WATCH = 15;
export const MAX_FRESH_WATCH_ATT    = 15;  // FRESH_WATCH din attention system
export const SHORT_WATCH_TTL_MS     = 90_000;
export const FOLLOW_TTL_MS        = 12 * 60 * 60_000;
export const FOLLOW_REFRESH_MS    = 60_000;
export const FOLLOW_REFRESH_LIMIT = 20;
export const FOLLOW_ADD_SCORE     = 70;
export const FOLLOW_REMOVE_SCORE  = 50;
export const FOLLOW_MAX_MISSES    = 5;


// ── Scores ────────────────────────────────────────────────────────────────────
export const WATCH_MIN_SCORE      = 70;
export const FOMO_WATCH_MIN_SCORE = 45;

// ── LP ────────────────────────────────────────────────────────────────────────
export const MIN_LP_REMOVE_ETH   = 0.05;
export const INSTANT_LP_EXIT_PCT = 0.30;

// ── Flow ──────────────────────────────────────────────────────────────────────
export const MIN_FLOW_ETH        = 0.001;
export const MIN_TOTAL_FLOW_ETH  = 0.01;
export const FLOW_IMBALANCE      = 0.20;

// ── Armed entries ─────────────────────────────────────────────────────────────
export const ARM_CONFIRM_MS        = 30_000;
export const ARM_TTL_MS            = 2 * 60_000;
export const ARM_MIN_PRICE_CONFIRM = 0.997;

// ── Momentum buffer ───────────────────────────────────────────────────────────
export const MAX_MOMENTUM_BUFFER = 100;
export const MAX_QUALIFIED_BUFFER = 20;

// ── Chainlink ─────────────────────────────────────────────────────────────────
export const CHAINLINK_ETH_USD           = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
export const CHAINLINK_LATEST_ROUND_DATA = "0xfeaf968c";

// ── Blocked symbols ───────────────────────────────────────────────────────────
export const BLUECHIP_SYMBOLS = new Set([
  "usdc", "weth", "wbtc", "eth", "usdt", "dai", "arb", "pendle",
]);

export const BLOCKED_SYMBOLS = new Set([
  "usdc", "usdt", "dai", "weth", "wbtc", "eth",
  "arb", "op", "matic", "bnb", "avax", "pendle",
  "cbbtc", "cbeth", "usdbc",
]);

// ── V3 DEXes ──────────────────────────────────────────────────────────────────
export const V3_DEXES = new Set([
  "uniswap-v3-base",
  "aerodrome-slipstream",
  "pancakeswap-v3-base",
  "uniswap_v3_arbitrum",
  "pancakeswap-v3-arbitrum",
  "camelot-v3",
  "ramses-v3-arbitrum",
  "sushiswap_arbitrum",
  "pancakeswap-v3-bsc",
]);

// ── V4 constants ──────────────────────────────────────────────────────────────
export const UNISWAP_V4_POOL_MANAGER   = "0x498581ff718922c3f8e6a244956af099b2652b2b";
export const SWAP_V4_TOPIC             = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
export const MODIFY_LIQUIDITY_V4_TOPIC = "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";
