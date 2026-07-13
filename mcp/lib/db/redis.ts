import Redis from "ioredis";

let _redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
      // false cauza exact "Stream isn't writeable and enableOfflineQueue
      // options is false" — o comandă emisă în timp ce clientul e în
      // reconectare (conexiune căzută din inactivitate) era respinsă instant
      // în loc să aștepte reconectarea. true lasă comanda în coadă până se
      // stabilește conexiunea, cu maxRetriesPerRequest ca plasă de siguranță.
      enableOfflineQueue: true,
    });
    _redis.on("error", (err) => {
      console.log("[REDIS] Error:", err.message);
      _redis = null;
    });
  }
  return _redis;
}