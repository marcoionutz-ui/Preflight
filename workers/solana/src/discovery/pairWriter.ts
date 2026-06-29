/**
 * discovery/pairWriter.ts
 * 8.0d: Scrie un pool Raydium CPMM in Redis.
 *
 * Redis keys (consistente cu EVM):
 *   preflight:indexed:pair:solana:{poolAddress}  -> JSON (EX: PAIR_TTL_SEC)
 *   preflight:indexed:pairs:solana               -> ZSET (score = slot)
 *   preflight:indexed:pairs:ts:solana            -> ZSET (score = Unix ms)
 */

import { getRedis } from "../infra/redis";
import {
  CHAIN, KEY_PAIR, KEY_PAIRS, KEY_PAIRS_TS, PAIR_TTL_SEC, INDEXER_VERSION,
} from "../config/constants";

export interface SolanaPool {
  chain:          typeof CHAIN;
  poolAddress:    string;
  mint0:          string;
  mint1:          string;
  program:        string;
  slot:           number;
  signature:      string;
  discoveredAt:   string;
  indexerVersion: string;
}

export type WriteResult = "inserted" | "exists" | "error";

export async function writeSolanaPool(pool: SolanaPool): Promise<WriteResult> {
  const redis = getRedis();
  const key   = KEY_PAIR(pool.poolAddress);

  try {
    // SET NX EX — atomic: scrie doar daca cheia nu exista
    const inserted = await redis.set(key, JSON.stringify(pool), "EX", PAIR_TTL_SEC, "NX");
    if (!inserted) return "exists";

    // Actualizeaza ZSET-urile doar daca am inserat cu succes
    const pipeline = redis.pipeline();
    pipeline.zadd(KEY_PAIRS,    pool.slot,  pool.poolAddress);
    pipeline.zadd(KEY_PAIRS_TS, Date.now(), pool.poolAddress);
    await pipeline.exec();

    return "inserted";
  } catch (err) {
    console.error("[SOLANA][WRITER] error:", (err as Error).message);
    return "error";
  }
}

export function buildSolanaPool(
  poolAddress: string,
  mint0:       string,
  mint1:       string,
  slot:        number,
  signature:   string,
  program:     string,
): SolanaPool {
  return {
    chain:          CHAIN,
    poolAddress,
    mint0,
    mint1,
    program,
    slot,
    signature,
    discoveredAt:   new Date().toISOString(),
    indexerVersion: INDEXER_VERSION,
  };
}
