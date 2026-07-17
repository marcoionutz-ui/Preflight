/**
 * discovery/pairWriter.ts
 * 8.0f:   Scrie un pool Solana în Redis. Include quote normalization + metadata enrichment.
 * 8.0h-a: Dupa insert nou, leaga pool-ul de launch record (daca exista) via linkLaunchToPool.
 * 8.0k-a1: Dupa insert nou, patch price snapshot existent cu knownPool=true (stale sync fix).
 *
 * Redis keys (consistente cu EVM):
 *   preflight:indexed:pair:solana:{poolAddress}  -> JSON (persistent — fara TTL)
 *   preflight:indexed:pairs:solana               -> ZSET (score = slot)
 *   preflight:indexed:pairs:ts:solana            -> ZSET (score = Unix ms)
 */

import { getRedis } from "../infra/redis";
import {
  CHAIN, KEY_PAIR, KEY_PAIRS, KEY_PAIRS_TS, KEY_PRICE_SNAPSHOT, INDEXER_VERSION,
} from "../config/constants";
import { normalizeQuote, WSOL_MINT, USDC_MINT, USDT_MINT } from "./quoteNormalizer";
import { TokenMeta } from "../infra/tokenMetadata";
import { linkLaunchToPool } from "./launchWriter";
import type { PreflightIndexedSolanaPool, PreflightSolanaProgram } from "@preflight/schema";

// Mints care sunt quote assets — nu sunt niciodata launch-uri pump.fun
const KNOWN_QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

// ── 8.0k-a1: knownPool stale sync ────────────────────────────────────────────

/**
 * Dacă există un price snapshot cu knownPool=false pentru poolul tocmai indexat,
 * îl corectează la true fără să îi modifice TTL-ul.
 * Fire-and-forget — nu blochează pipeline-ul de insert.
 */
async function markPriceSnapshotKnown(poolAddress: string): Promise<void> {
  const redis = getRedis();
  const key   = KEY_PRICE_SNAPSHOT(poolAddress);

  const raw = await redis.get(key);
  if (!raw) return; // snapshot inexistent — nimic de corectat

  const snap = JSON.parse(raw);
  if (snap.knownPool === true) return; // deja corect

  snap.knownPool = true;
  // KEEPTTL păstrează TTL-ul original — nu reset la 10m
  await (redis as any).set(key, JSON.stringify(snap), "KEEPTTL");
  console.log("[SOLANA][WRITER] knownPool patched pool=" + poolAddress.slice(0, 8) + "...");
}

// PreflightSolanaPool (schema) is now a discriminated union of this file's
// write path (PreflightIndexedSolanaPool) and observedPool.ts's inline
// promotion write (PreflightObservedSolanaPool) — see schema comment. This
// file only ever produces the indexed variant.
export type SolanaPool = PreflightIndexedSolanaPool;

export type WriteResult = "inserted" | "exists" | "error";

export async function writeSolanaPool(pool: SolanaPool): Promise<WriteResult> {
  const redis = getRedis();
  const key   = KEY_PAIR(pool.poolAddress);

  try {
    // SET NX — atomic: scrie doar daca cheia nu exista; registry persistent
    const inserted = await redis.set(key, JSON.stringify(pool), "NX"); // permanent — fara TTL (registry)
    if (!inserted) return "exists";

    // Actualizeaza ZSET-urile doar daca am inserat cu succes
    const pipeline = redis.pipeline();
    pipeline.zadd(KEY_PAIRS,    pool.slot,  pool.poolAddress);
    pipeline.zadd(KEY_PAIRS_TS, Date.now(), pool.poolAddress);
    await pipeline.exec();

    // 8.0k-a1 — sync price snapshot knownPool (fire-and-forget)
    // Daca exista un snapshot cu knownPool=false (sampled inainte de indexare), il corectam
    markPriceSnapshotKnown(pool.poolAddress).catch((err: Error) => {
      console.warn("[SOLANA][WRITER] knownPool patch error:", err.message);
    });

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
  program:     PreflightSolanaProgram,
  source:      "BACKFILL" | "LIVE",
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
    source,
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
    await redis.set(key, JSON.stringify(enriched)); // permanent — fara TTL
  } catch (err) {
    console.error("[SOLANA][WRITER] enrich error pool=" + pool.poolAddress.slice(0, 8) + ":", (err as Error).message);
  }
}
