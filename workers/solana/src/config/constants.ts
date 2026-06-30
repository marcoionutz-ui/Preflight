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

// ── Worker version ────────────────────────────────────────────────────────────

export const INDEXER_VERSION = "v8.0g-a3";
