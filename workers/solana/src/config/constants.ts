/**
 * config/constants.ts
 * Namespace Redis + parametri operaționali pentru indexer-solana.
 * Zero imports din alte module interne.
 */

// ── Redis namespace ───────────────────────────────────────────────────────────
// Consistentă cu EVM: preflight:indexed:pairs:{chain}

export const CHAIN = "solana" as const;

/** ZSET cu toate pool-urile indexate (score = slot descoperire) */
export const KEY_PAIRS    = `preflight:indexed:pairs:${CHAIN}`;

/** ZSET sortat după timestamp descoperire (score = Unix ms) — pentru recent pools / health sample */
export const KEY_PAIRS_TS = `preflight:indexed:pairs:ts:${CHAIN}`;

/** Hash JSON per pool: preflight:indexed:pair:solana:{poolId} */
export const KEY_PAIR     = (poolId: string) => `preflight:indexed:pair:${CHAIN}:${poolId}`;

/** Slot cursor persistent */
export const KEY_CURSOR   = `preflight:indexer:cursor:${CHAIN}`;

/** Health heartbeat (JSON) */
export const KEY_HEALTH   = `preflight:indexer:health:${CHAIN}`;

/** Token metadata cache per mint: preflight:solana:token:{mint} */
export const KEY_TOKEN_META = (mint: string) => `preflight:solana:token:${mint}`;

// ── Discovery params ──────────────────────────────────────────────────────────

/** Câte slot-uri procesăm per batch */
export const BATCH_SLOTS      = 10;

/** Interval polling când nu folosim WebSocket (ms) */
export const POLL_INTERVAL_MS = 5_000;

/** TTL pentru perechile indexate (72h) */
export const PAIR_TTL_SEC     = 72 * 60 * 60;

/** TTL pentru health key (5min — reînnoit la fiecare heartbeat) */
export const HEALTH_TTL_SEC   = 5 * 60;

/** TTL pentru token metadata cache (24h) */
export const TOKEN_META_TTL_SEC = 24 * 60 * 60;

// ── Health thresholds ─────────────────────────────────────────────────────────

/** Slot-uri în urmă până la care considerăm OK */
export const BEHIND_OK_SLOTS      = 50;

/** Slot-uri în urmă până la care considerăm DEGRADED */
export const BEHIND_DEGRADED_SLOTS = 200;

// ── pump.fun launch namespace ─────────────────────────────────────────────────

/** ZSET cu toate launch-urile indexate (score = slot descoperire) */
export const KEY_LAUNCHES    = `preflight:indexed:launches:${CHAIN}`;

/** ZSET sortat după timestamp descoperire (score = Unix ms) */
export const KEY_LAUNCHES_TS = `preflight:indexed:launches:ts:${CHAIN}`;

/** JSON per launch: preflight:indexed:launch:solana:{mint} */
export const KEY_LAUNCH      = (mint: string) => `preflight:indexed:launch:${CHAIN}:${mint}`;

// ── Swap activity namespace ───────────────────────────────────────────────────

/** Activity state per pool (swap counts, volumes, 5m window): preflight:solana:activity:{pool} */
export const KEY_POOL_ACTIVITY = (pool: string) => `preflight:solana:activity:${pool}`;

/** Price snapshot per pool (priceInQuote, priceUsd): preflight:solana:price:{pool} */
export const KEY_PRICE_SNAPSHOT = (pool: string) => `preflight:solana:price:${pool}`;

/** Ring buffer de price history per pool (max 60 intrări, TTL 2h): preflight:solana:price:history:{pool} */
export const KEY_PRICE_HISTORY = (pool: string) => `preflight:solana:price:history:${pool}`;

/** ZSET index cu poolurile care au price snapshot (score = lastUpdatedAt ms) — evita KEYS scan */
export const KEY_PRICE_POOLS = `preflight:solana:price:pools`;

// ── Trending namespace (comun cu EVM) ─────────────────────────────────────────

/** Top movers pre-calculați per chain: preflight:trending:movers:solana */
export const KEY_TRENDING_MOVERS = `preflight:trending:movers:${CHAIN}`;

// ── Worker version ────────────────────────────────────────────────────────────

export const INDEXER_VERSION = "v8.0h-b5";
