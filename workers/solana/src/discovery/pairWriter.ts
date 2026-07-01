/**
 * discovery/pairWriter.ts
 * 8.0f:   Scrie un pool Solana în Redis. Include quote normalization + metadata enrichment.
 * 8.0h-a: Dupa insert nou, leaga pool-ul de launch record (daca exista) via linkLaunchToPool.
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
import { normalizeQuote, SolanaQuoteType, WSOL_MINT, USDC_MINT, USDT_MINT } from "./quoteNormalizer";
import { TokenMeta } from "../infra/tokenMetadata";
import { linkLaunchToPool } from "./launchWriter";

// Mints care sunt quote assets — nu sunt niciodata launch-uri pump.fun
const KNOWN_QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

export interface SolanaPool {
  chain:          typeof CHAIN;
  poolAddress:    string;
  mint0:          string;
  mint1:          string;
  baseMint:       string;
  quoteMint:      string;
  quoteType:      SolanaQuoteType;
  program:        string;
  slot:           number;
  signature:      string;
  discoveredAt:   string;
  indexerVersion: string;
  // 8.0f — token metadata (opțional; populat async după insert)
  baseSymbol?:    string;
  quoteSymbol?:   string;
  baseDecimals?:  number | null;
  quoteDecimals?: number | null;
  metaSource?:    string;
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

    // 8.0h-a — migration linking: leaga launch-ul pump.fun de pool-ul Raydium (daca exista)
    // Filtram quote mints cunoscute — WSOL/USDC/USDT nu sunt niciodata launch-uri pump.fun
    const poolInfo = {
      poolAddress: pool.poolAddress,
      program:     pool.program,
      slot:        pool.slot,
      signature:   pool.signature,
    };
    for (const mint of [pool.mint0, pool.mint1]) {
      if (KNOWN_QUOTE_MINTS.has(mint)) continue;
      linkLaunchToPool(mint, poolInfo).catch((err: Error) => {
        console.error(
          "[SOLANA][WRITER] linkLaunchToPool error mint=" + mint.slice(0, 8) + ":",
          err.message,
        );
      });
    }

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
  const { baseMint, quoteMint, quoteType } = normalizeQuote(mint0, mint1);

  return {
    chain:          CHAIN,
    poolAddress,
    mint0,
    mint1,
    baseMint,
    quoteMint,
    quoteType,
    program,
    slot,
    signature,
    discoveredAt:   new Date().toISOString(),
    indexerVersion: INDEXER_VERSION,
  };
}

/**
 * Rescrie pool-ul în Redis cu metadata token (base + quote).
 * Nu folosește NX — este un update al unui record existent.
 * Non-blocking: nu aruncă erori.
 */
export async function enrichSolanaPool(
  pool:       SolanaPool,
  baseMeta:   TokenMeta,
  quoteMeta:  TokenMeta,
): Promise<void> {
  const redis = getRedis();
  const key   = KEY_PAIR(pool.poolAddress);

  const enriched: SolanaPool = {
    ...pool,
    baseSymbol:    baseMeta.symbol,
    quoteSymbol:   quoteMeta.symbol,
    baseDecimals:  baseMeta.decimals,
    quoteDecimals: quoteMeta.decimals,
    metaSource:    baseMeta.source + "/" + quoteMeta.source,
  };

  try {
    await redis.set(key, JSON.stringify(enriched), "EX", PAIR_TTL_SEC);
  } catch (err) {
    console.error("[SOLANA][WRITER] enrich error pool=" + pool.poolAddress.slice(0, 8) + ":", (err as Error).message);
  }
}
