/**
 * infra/redis.ts
 * Redis singleton pentru indexer-solana.
 */

import Redis from "ioredis";

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;

  const url =
    process.env.REDIS_URL ??
    process.env.REDIS_PRIVATE_URL ??
    process.env.REDIS_PUBLIC_URL;

  if (!url) {
    throw new Error(
      "Missing Redis env: set REDIS_URL, REDIS_PRIVATE_URL, or REDIS_PUBLIC_URL",
    );
  }

  _redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck:     true,
    lazyConnect:          false,
  });

  _redis.on("error", (err: Error) => {
    console.error("[SOLANA][REDIS] error:", err.message);
  });

  _redis.on("connect", () => {
    console.log("[SOLANA][REDIS] connected");
  });

  return _redis;
}
