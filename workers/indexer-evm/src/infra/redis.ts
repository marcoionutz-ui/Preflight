/**
 * infra/redis.ts
 * Redis client singleton pentru indexer-evm.
 * Același pattern ca workers/evm/src/infra/redis.ts.
 */

import Redis from "ioredis";

let _redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (!_redis) {
    _redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect:          true,
      // false cauza "Stream isn't writeable and enableOfflineQueue options
      // is false" — o comandă emisă în timpul unei reconectări (conexiune
      // căzută din inactivitate) era respinsă instant. true lasă comanda în
      // coadă până se stabilește conexiunea (vezi și mcp/lib/db/redis.ts).
      enableOfflineQueue:   true,
    });
    _redis.on("error", (err: Error) => {
      // Log once — nu reseta _redis la null, ioredis gestionează reconnect intern
      console.error("[INDEXER][REDIS] Error:", err.message);
    });
  }
  return _redis;
}
