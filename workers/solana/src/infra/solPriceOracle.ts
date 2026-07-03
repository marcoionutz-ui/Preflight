/**
 * infra/solPriceOracle.ts
 * 8.0j: SOL/USD price oracle via Jupiter Price API v2.
 *
 * Fetch la fiecare 30s → Redis cu TTL 5min.
 * Citit de priceTracker.ts pentru WSOL-quoted pools.
 *
 * Failure silentios: dacă fetch esuează, returneaza null → priceUsd rămâne null
 * până la urmatorul fetch reușit (max 5min window cu prețul vechi din Redis).
 */

import { getRedis }           from "./redis";
import { KEY_SOL_USD_PRICE }  from "../config/constants";
import { WSOL_MINT }          from "../config/programs";

// ── Constante ─────────────────────────────────────────────────────────────────

const ORACLE_TTL_SEC    = 5 * 60;   // TTL Redis — prețul vechi e acceptabil 5min
const ORACLE_INTERVAL_MS = 30_000;  // refresh la 30s
const FETCH_TIMEOUT_MS  = 8_000;
const JUPITER_URL       = `https://api.jup.ag/price/v2?ids=${WSOL_MINT}`;

// ── Tipuri ────────────────────────────────────────────────────────────────────

export interface SolPriceEntry {
  priceUsd:  number;
  fetchedAt: number;
  source:    "JUPITER_V2";
}

// ── Fetch + cache ─────────────────────────────────────────────────────────────

export async function fetchAndCacheSolPrice(): Promise<SolPriceEntry | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(JUPITER_URL, {
      signal:  controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) return null;

    const json = await res.json() as any;
    const priceStr = json?.data?.[WSOL_MINT]?.price;
    if (!priceStr) return null;

    const priceUsd = Number(priceStr);
    if (!isFinite(priceUsd) || priceUsd <= 0) return null;

    const entry: SolPriceEntry = {
      priceUsd,
      fetchedAt: Date.now(),
      source:    "JUPITER_V2",
    };

    const redis = getRedis();
    await redis.set(KEY_SOL_USD_PRICE, JSON.stringify(entry), "EX", ORACLE_TTL_SEC);

    return entry;
  } catch (err: any) {
    console.warn("[SOLANA][ORACLE] fetch error:", err?.message ?? String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Read (folosit de priceTracker per swap) ───────────────────────────────────

export async function readSolPrice(): Promise<number | null> {
  try {
    const redis = getRedis();
    const raw   = await redis.get(KEY_SOL_USD_PRICE);
    if (!raw) return null;
    const entry = JSON.parse(raw) as SolPriceEntry;
    return typeof entry.priceUsd === "number" && entry.priceUsd > 0
      ? entry.priceUsd
      : null;
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
