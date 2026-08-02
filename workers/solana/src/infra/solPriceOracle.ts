/**
 * infra/solPriceOracle.ts
 * SOL/USD price oracle — cascadă de surse publice: Coinbase → Kraken → Binance.
 *
 * Fetch la fiecare 30s → Redis cu TTL 5min. Citit de priceTracker.ts pentru WSOL-quoted pools.
 *
 * E28: înainte era etichetat „Jupiter v2" dar chema DOAR Binance, care dă HTTP 451 pe IP US
 * (deploy Railway) → SOL price NULL permanent. Acum încercăm sursele în ordine (Coinbase/Kraken
 * merg pe IP US), prima validă câștigă, iar `source` reflectă sursa REALĂ care a dat prețul.
 *
 * Failure silentios: dacă TOATE sursele eșuează, returnează null → priceUsd rămâne null până la
 * următorul fetch reușit (max 5min window cu prețul vechi din Redis).
 */

import { getRedis }           from "./redis";
import { KEY_SOL_USD_PRICE }  from "../config/constants";
import {
  SOL_PRICE_SOURCES,
  resolveSolPriceFromSources,
  validateSolPrice,
  type SolPriceSourceName,
} from "./solPriceSources";

// ── Constante ─────────────────────────────────────────────────────────────────

const ORACLE_TTL_SEC     = 5 * 60;   // TTL Redis — prețul vechi e acceptabil 5min
const ORACLE_INTERVAL_MS = 30_000;  // refresh la 30s
const FETCH_TIMEOUT_MS   = 8_000;

// ── Tipuri ────────────────────────────────────────────────────────────────────

export interface SolPriceEntry {
  priceUsd:  number;
  fetchedAt: number;
  source:    SolPriceSourceName;   // E28: sursa REALĂ (COINBASE/KRAKEN/BINANCE), nu eticheta falsă „JUPITER_V2"
}

// ── Fetch + cache (cascadă din leaf; deps injectabile pentru teste) ───────────

interface RedisLike {
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
}

export interface FetchAndCacheOpts {
  fetchImpl?: typeof fetch;   // default: global fetch
  redis?:     RedisLike;      // default: getRedis()
  now?:       () => number;   // default: Date.now
}

export async function fetchAndCacheSolPrice(opts: FetchAndCacheOpts = {}): Promise<SolPriceEntry | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now       = opts.now ?? Date.now;

  const resolved = await resolveSolPriceFromSources(SOL_PRICE_SOURCES, fetchImpl, FETCH_TIMEOUT_MS);
  if (!resolved) {
    console.warn("[SOLANA][ORACLE] toate sursele au eșuat (Coinbase/Kraken/Binance)");
    return null;
  }

  const entry: SolPriceEntry = { priceUsd: resolved.price, fetchedAt: now(), source: resolved.source };
  try {
    const redis: RedisLike = opts.redis ?? getRedis();
    await redis.set(KEY_SOL_USD_PRICE, JSON.stringify(entry), "EX", ORACLE_TTL_SEC);
  } catch (err: any) {
    // Prețul e valid; doar cache-ul a eșuat → tot îl întoarcem (loggerul din loop îl folosește).
    console.warn("[SOLANA][ORACLE] Redis set eșuat:", err?.message ?? String(err));
  }
  return entry;
}

// ── Read (folosit de priceTracker per swap) ───────────────────────────────────

export async function readSolPrice(): Promise<number | null> {
  try {
    const redis = getRedis();
    const raw   = await redis.get(KEY_SOL_USD_PRICE);
    if (!raw) return null;
    const entry = JSON.parse(raw) as SolPriceEntry;
    // E28: validare comună — respinge Infinity/NaN/≤0 (un JSON `{"priceUsd":1e309}` devine Infinity
    // și trecea de vechiul `typeof number && >0`).
    return validateSolPrice(entry?.priceUsd);
  } catch {
    return null;
  }
}

// ── Oracle loop (pornit din index.ts) ────────────────────────────────────────

export function startSolPriceOracle(): void {
  // Fetch imediat la startup
  fetchAndCacheSolPrice()
    .then(entry => {
      if (entry) {
        console.log("[SOLANA][ORACLE] SOL/USD initial: $" + entry.priceUsd.toFixed(2));
      } else {
        console.warn("[SOLANA][ORACLE] SOL/USD initial fetch failed — waiting for retry");
      }
    })
    .catch(() => {});

  // Refresh periodic
  setInterval(() => {
    fetchAndCacheSolPrice()
      .then(entry => {
        if (entry) {
          console.log("[SOLANA][ORACLE] SOL/USD refresh: $" + entry.priceUsd.toFixed(2));
        } else {
          console.warn("[SOLANA][ORACLE] SOL/USD fetch failed — using cached price");
        }
      })
      .catch(() => {});
  }, ORACLE_INTERVAL_MS);
}
