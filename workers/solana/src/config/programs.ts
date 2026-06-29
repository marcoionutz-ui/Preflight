/**
 * config/programs.ts
 * Solana program IDs pentru discovery.
 * Toate adresele verificate din documentație oficială.
 */

// ── Raydium ───────────────────────────────────────────────────────────────────

/** Raydium AMM V4 — pool-uri cu constant product (x*y=k) */
export const RAYDIUM_AMM_V4    = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

/** Raydium CLMM — concentrated liquidity (echivalent Uniswap V3) */
export const RAYDIUM_CLMM      = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

/** Raydium CPMM — constant product cu fee flex (mai nou decât AMM V4) */
export const RAYDIUM_CPMM      = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

// ── pump.fun ──────────────────────────────────────────────────────────────────

/** pump.fun bonding curve program */
export const PUMPFUN_PROGRAM   = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

/** pump.fun migration authority (graduate → Raydium AMM V4) */
export const PUMPFUN_MIGRATION = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";

// ── SPL Token ─────────────────────────────────────────────────────────────────

/** Token Program standard */
export const TOKEN_PROGRAM     = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Token-2022 (Token Extensions) */
export const TOKEN_2022        = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Associated Token Account program */
export const ATA_PROGRAM       = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS";

// ── Native ────────────────────────────────────────────────────────────────────

/** Wrapped SOL mint */
export const WSOL_MINT         = "So11111111111111111111111111111111111111112";

/** USDC mint pe Solana mainnet */
export const USDC_MINT         = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** USDT mint pe Solana mainnet */
export const USDT_MINT         = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** Adrese considerate quote stabile — case-sensitive, nu lowercase */
export const STABLE_MINTS = new Set([
  USDC_MINT,
  USDT_MINT,
]);

/** Quote-uri native cunoscute */
export const NATIVE_QUOTE_MINTS = new Set([
  WSOL_MINT,
  USDC_MINT,
  USDT_MINT,
]);
