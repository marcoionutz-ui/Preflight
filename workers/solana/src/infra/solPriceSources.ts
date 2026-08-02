/**
 * infra/solPriceSources.ts — E28 (surse SOL/USD în cascadă, parseri puri).
 *
 * Logică PURĂ (zero runtime imports) → testabilă izolat în tsx. Fiecare sursă are URL-ul ei public
 * (fără auth) + un parser dedicat care extrage prețul din forma proprie a răspunsului și îl validează.
 *
 * BUG E28: oracle-ul era etichetat „JUPITER_V2" dar chema Binance, iar Binance dă HTTP 451 pe IP US
 * (deploy Railway) → SOL price NULL permanent. Fix: cascadă US-friendly (Coinbase → Kraken → Binance
 * last), iar `source` reflectă sursa REALĂ care a dat prețul.
 */

export type SolPriceSourceName = "COINBASE" | "KRAKEN" | "BINANCE";

/** Acceptă number sau string-number; întoarce prețul doar dacă e finit și > 0, altfel null. */
export function validateSolPrice(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Coinbase: GET /v2/prices/SOL-USD/spot → { "data": { "amount": "178.42", "base": "SOL", "currency": "USD" } }
export function parseCoinbaseSol(json: any): number | null {
  return validateSolPrice(json?.data?.amount);
}

// Kraken: GET /0/public/Ticker?pair=SOLUSD → { "error": [], "result": { "SOLUSD": { ..., "c": ["178.45","0.001"] } } }
// Cheia pair-ului o citim GENERIC (primul key din result) — Kraken poate întoarce nume canonice diferite.
export function parseKrakenSol(json: any): number | null {
  const result = json?.result;
  if (!result || typeof result !== "object") return null;
  const firstKey = Object.keys(result)[0];
  if (!firstKey) return null;
  const c = result[firstKey]?.c;
  return validateSolPrice(Array.isArray(c) ? c[0] : undefined);
}

// Binance: GET /api/v3/ticker/price?symbol=SOLUSDT → { "symbol": "SOLUSDT", "price": "178.42" }
export function parseBinanceSol(json: any): number | null {
  return validateSolPrice(json?.price);
}

export interface SolPriceSource {
  name:  SolPriceSourceName;
  url:   string;
  parse: (json: any) => number | null;
}

// Ordinea = preferință. Coinbase + Kraken merg pe IP US; Binance e last (util doar pe deploy non-US).
export const SOL_PRICE_SOURCES: SolPriceSource[] = [
  { name: "COINBASE", url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",              parse: parseCoinbaseSol },
  { name: "KRAKEN",   url: "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",           parse: parseKrakenSol   },
  { name: "BINANCE",  url: "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",   parse: parseBinanceSol  },
];

// ── Cascadă (fetch INJECTAT → testabilă izolat, fără redis) ────────────────────────────────────────

/** Un singur source: fetch (timeout via AbortController) + parse dedicat. `fetchImpl` injectabil. */
async function fetchOneSource(src: SolPriceSource, fetchImpl: typeof fetch, timeoutMs: number): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(src.url, { signal: controller.signal, headers: { "Accept": "application/json" } });
    if (!res.ok) {
      // Binance → 451 pe IP US e AȘTEPTAT; cascada trece la următoarea sursă.
      console.warn(`[SOLANA][ORACLE] ${src.name} HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    const json  = await res.json() as any;
    const price = src.parse(json);
    if (price === null) {
      console.warn(`[SOLANA][ORACLE] ${src.name} formă/valoare neașteptată:`, JSON.stringify(json)?.slice(0, 200));
      return null;
    }
    return price;
  } catch (err: any) {
    console.warn(`[SOLANA][ORACLE] ${src.name} fetch error:`, err?.message ?? String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cascadă: încearcă sursele în ordine, PRIMA validă câștigă (se oprește imediat). O sursă e „eșuată"
 * dacă HTTP !ok (ex. Binance 451), throw (network/timeout) SAU valoarea nu trece de parse/validare.
 * Întoarce `{ price, source }` cu sursa REALĂ, sau `null` dacă TOATE eșuează.
 */
export async function resolveSolPriceFromSources(
  sources:   SolPriceSource[],
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ price: number; source: SolPriceSourceName } | null> {
  for (const src of sources) {
    const price = await fetchOneSource(src, fetchImpl, timeoutMs);
    if (price !== null) return { price, source: src.name };
  }
  return null;
}
