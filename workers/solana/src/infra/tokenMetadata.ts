/**
 * infra/tokenMetadata.ts
 * 8.0f: Rezolvă symbol + decimals pentru un Solana mint.
 *
 * Surse (în ordine):
 *   1. KNOWN   — mints hardcodate (wSOL, USDC, USDT) — instant, fără RPC
 *   2. CACHE   — Redis cu TTL 24h
 *   3. JUPITER — https://tokens.jup.ag/token/{mint} — acoperire largă mainnet
 *   4. FALLBACK — mint[:6]+"..." dacă Jupiter nu cunoaște tokenul
 *
 * Nu aruncă erori — returnează FALLBACK în caz de orice problemă.
 */

import { getRedis } from "./redis";
import { TOKEN_META_TTL_SEC, KEY_TOKEN_META } from "../config/constants";

// ── Tipuri ────────────────────────────────────────────────────────────────────

export type TokenMetaSource = "KNOWN" | "CACHE" | "JUPITER" | "FALLBACK";

export interface TokenMeta {
  mint:      string;
  symbol:    string;
  decimals:  number | null;
  name?:     string;
  source:    TokenMetaSource;
  cachedAt:  string;
}

// ── Mints cunoscute (fără niciun apel) ───────────────────────────────────────

const KNOWN_MINTS: Record<string, { symbol: string; decimals: number; name: string }> = {
  "So11111111111111111111111111111111111111112":   { symbol: "WSOL",  decimals: 9,  name: "Wrapped SOL"  },
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC",  decimals: 6,  name: "USD Coin"     },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT",  decimals: 6,  name: "Tether USD"   },
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": { symbol: "mSOL",  decimals: 9,  name: "Marinade SOL" },
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": { symbol: "ETH",   decimals: 8,  name: "Ethereum (Wormhole)" },
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": { symbol: "WBTC",  decimals: 8,  name: "Wrapped BTC"  },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol: "BONK",  decimals: 5,  name: "Bonk"         },
};

// ── Jupiter API ───────────────────────────────────────────────────────────────

// Jupiter Tokens API V2
// Default: Pro URL (api.jup.ag) — necesită JUPITER_API_KEY pentru rate limits mai mari
// Override via env: JUPITER_TOKEN_SEARCH_URL=https://lite-api.jup.ag/token/v2/search
const JUPITER_SEARCH_URL =
  process.env.JUPITER_TOKEN_SEARCH_URL ?? "https://api.jup.ag/tokens/v2/search";
const FETCH_TIMEOUT_MS   = 5_000;

interface JupiterTokenV2 {
  id:       string;   // mint address
  symbol:   string;
  name:     string;
  decimals: number;
}

function buildJupiterHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (process.env.JUPITER_API_KEY) {
    headers["x-api-key"] = process.env.JUPITER_API_KEY;
  }
  return headers;
}

async function fetchFromJupiter(mint: string): Promise<TokenMeta | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(
      `${JUPITER_SEARCH_URL}?query=${encodeURIComponent(mint)}`,
      { signal: controller.signal, headers: buildJupiterHeaders() },
    );

    if (!res.ok) {
      console.warn("[SOLANA][META] jupiter status=" + res.status + " mint=" + mint.slice(0, 8));
      return null;
    }

    const rows = (await res.json()) as JupiterTokenV2[];
    // Caută match exact pe mint address — search poate returna mai mulți tokens
    const token = rows.find(t => t.id === mint) ?? rows[0];
    if (!token) return null;

    return {
      mint,
      symbol:   token.symbol   ?? mint.slice(0, 6) + "...",
      decimals: token.decimals ?? null,
      name:     token.name,
      source:   "JUPITER",
      cachedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (!msg.includes("abort")) {
      console.warn("[SOLANA][META] jupiter fetch error mint=" + mint.slice(0, 8) + ":", msg);
    }
    return null;
  } finally {
    clearTimeout(timer); // rulează mereu — abort sau succes
  }
}

// ── Fallback ──────────────────────────────────────────────────────────────────

function makeFallback(mint: string): TokenMeta {
  return {
    mint,
    symbol:   mint.slice(0, 6) + "...",
    decimals: null,
    source:   "FALLBACK",
    cachedAt: new Date().toISOString(),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Rezolvă metadata pentru un mint.
 * Nu aruncă erori — returnează FALLBACK în cel mai rău caz.
 */
export async function resolveTokenMeta(mint: string): Promise<TokenMeta> {
  // 1. KNOWN — instant
  const known = KNOWN_MINTS[mint];
  if (known) {
    return { mint, ...known, source: "KNOWN", cachedAt: new Date().toISOString() };
  }

  const redis    = getRedis();
  const cacheKey = KEY_TOKEN_META(mint);

  // 2. CACHE — Redis
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as TokenMeta;
      return { ...parsed, source: "CACHE" };
    }
  } catch (_err) {
    // Redis error — continuăm
  }

  // 3. JUPITER — HTTP fetch
  const jupiterMeta = await fetchFromJupiter(mint);
  if (jupiterMeta) {
    try {
      await redis.set(cacheKey, JSON.stringify(jupiterMeta), "EX", TOKEN_META_TTL_SEC);
    } catch (_err) { /* Redis write failure — non-critical */ }
    return jupiterMeta;
  }

  // 4. FALLBACK
  const fallback = makeFallback(mint);
  // Nu cache-uim FALLBACK — poate fi rezolvat mai târziu
  return fallback;
}

/**
 * Rezolvă metadata pentru mai multe mints în paralel.
 */
export async function resolveTokenMetaBatch(mints: string[]): Promise<Record<string, TokenMeta>> {
  const unique = [...new Set(mints)];
  const results = await Promise.all(unique.map(m => resolveTokenMeta(m)));
  return Object.fromEntries(unique.map((m, i) => [m, results[i]]));
}
