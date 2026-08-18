/**
 * infra/redis.ts
 * Redis client singleton pentru worker.
 */

import Redis from "ioredis";

let _redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      // false cauza "Stream isn't writeable and enableOfflineQueue options
      // is false" — o comandă emisă în timpul unei reconectări (conexiune
      // căzută din inactivitate) era respinsă instant. true lasă comanda în
      // coadă până se stabilește conexiunea (vezi și mcp/lib/db/redis.ts).
      enableOfflineQueue: true,
    });
    _redis.on("error", (err) => {
      // Nu nulificăm singleton-ul pe error — conexiunea se reface automat prin ioredis retry.
      // Dacă setăm _redis = null, fiecare eroare tranzitorie creează un client nou (leak).
      console.log("[REDIS] Error:", err.message);
    });
  }
  return _redis;
}

/**
 * PH-13 (graceful shutdown): închide conexiunea Redis DUPĂ persistarea finală a memoriei. `quit()` golește elegant
 * (așteaptă comenzile în coadă), cu `disconnect()` ca fallback dur dacă `quit` aruncă. Idempotent — dacă nu există
 * client, e no-op. Nulificăm singleton-ul ca un eventual `getRedis()` ulterior să nu întoarcă un client închis.
 */
export async function closeRedis(): Promise<void> {
  if (!_redis) return;
  const r = _redis;
  _redis = null;
  try { await r.quit(); }
  catch { try { r.disconnect(); } catch { /* best-effort */ } }
}
