/**
 * discovery/pairWriter.ts
 * 8.0f:   Scrie un pool Solana în Redis. Include quote normalization + metadata enrichment.
 * 8.0h-a: Dupa insert nou, leaga pool-ul de launch record (daca exista) via linkLaunchToPool.
 * 8.0k-a1: Dupa insert nou, patch price snapshot existent cu knownPool=true (stale sync fix).
 * P1-5:   Enrichment-ul nu mai e fire-and-forget. `writeSolanaPool` ENQUEUE-uiește pool-ul în coada
 *         durabilă (enrichQueue) AWAITED, pe „inserted" ȘI pe „exists" (idempotent NX) → durabil DUPĂ ACK
 *         (acoperă live + backfill). `enrichPoolOnce` / `enrichSolanaPool` sunt încercarea chemată de scanner.
 *
 * Redis keys (consistente cu EVM):
 *   preflight:indexed:pair:solana:{poolAddress}  -> JSON (persistent — fara TTL)
 *   preflight:indexed:pairs:solana               -> ZSET (score = slot)
 *   preflight:indexed:pairs:ts:solana            -> ZSET (score = Unix ms)
 */

import { getRedis } from "../infra/redis";
import { insertRecordAndIndex } from "./registryWrite";
import {
  CHAIN, KEY_PAIR, KEY_PAIRS, KEY_PAIRS_TS, KEY_PRICE_SNAPSHOT, INDEXER_VERSION,
} from "../config/constants";
import { normalizeQuote, WSOL_MINT, USDC_MINT, USDT_MINT } from "./quoteNormalizer";
import { TokenMeta, resolveTokenMeta } from "../infra/tokenMetadata";
import { linkLaunchToPool } from "./launchWriter";
import { enqueueEnrich, enrichAgeVerdict, ENRICH_INITIAL_DELAY_MS, type EnrichOutcome } from "./enrichQueue";
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
    // C1: SET NX blob + ambele ZADD ATOMIC (un singur EVAL) — pool-ul e ori complet indexat,
    // ori deloc; nu mai poate exista în registry dar invizibil în ZSET. Idempotent pe replay.
    const inserted = await insertRecordAndIndex(redis, {
      jsonKey: key, blob: JSON.stringify(pool), member: pool.poolAddress,
      zsetA: KEY_PAIRS,    scoreA: pool.slot,
      zsetB: KEY_PAIRS_TS, scoreB: Date.now(),
    });

    // P1-5 (fix cgpt R1): enqueue enrichment DURABIL — AWAITED, pe „inserted" ȘI pe „exists" (idempotent
    // NX). Dacă enqueue-ul aruncă (Redis jos), throw → outer catch → "error" → caller-ul NU face ACK,
    // reîncearcă (insert idempotent → "exists" → re-enqueue). Astfel enrichment-ul nu se mai pierde între
    // insert și ACK, iar o redelivery pe „exists" tot enqueue-uiește. Același write path prinde ȘI backfill-ul.
    await enqueueEnrich(redis, CHAIN, "pool", pool.poolAddress, Date.now() + ENRICH_INITIAL_DELAY_MS);

    if (!inserted) return "exists";

    // 8.0k-a1 — sync price snapshot knownPool (fire-and-forget)
    markPriceSnapshotKnown(pool.poolAddress).catch((err: Error) => {
      console.warn("[SOLANA][WRITER] knownPool patch error:", err.message);
    });

    // 8.0h-a — migration linking: leaga launch-ul pump.fun de pool-ul Raydium (daca exista)
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
    // P1-5: stare inițială explicită — enrichment-ul se face durabil prin coadă (enrichQueue).
    metadataStatus: "PENDING",
  };
}

/**
 * Rescrie pool-ul în Redis cu metadata token (base + quote) + metadataStatus="ENRICHED".
 * Nu folosește NX — update al unui record existent.
 * ⚠️ (fix cgpt R1): întoarce "ok"|"error" — o scriere eșuată NU mai e înghițită tăcut, ca apelantul să
 *    NU raporteze „enriched" (și să nu scoată jobul din coadă) când metadata n-a fost de fapt persistată.
 */
export async function enrichSolanaPool(
  pool:       SolanaPool,
  baseMeta:   TokenMeta,
  quoteMeta:  TokenMeta,
): Promise<"ok" | "error"> {
  const redis = getRedis();
  const key   = KEY_PAIR(pool.poolAddress);

  const enriched: SolanaPool = {
    ...pool,
    baseSymbol:    baseMeta.symbol,
    quoteSymbol:   quoteMeta.symbol,
    baseDecimals:  baseMeta.decimals,
    quoteDecimals: quoteMeta.decimals,
    metaSource:    baseMeta.source + "/" + quoteMeta.source,
    metadataStatus: "ENRICHED",
  };

  try {
    await redis.set(key, JSON.stringify(enriched)); // permanent — fara TTL
    return "ok";
  } catch (err) {
    console.error("[SOLANA][WRITER] enrich error pool=" + pool.poolAddress.slice(0, 8) + ":", (err as Error).message);
    return "error";
  }
}

// ── P1-5: o încercare de enrichment chemată de scanner (enrichQueue drain) ──────────────

/**
 * O SINGURĂ încercare de enrichment pentru un pool.
 *   "enriched" — base a primit metadata reală (non-FALLBACK) și scrierea ENRICHED a REUȘIT → scoate din coadă.
 *   "failed"   — pool prea vechi (enrichAgeVerdict=terminal) și scrierea FAILED a REUȘIT → scoate din coadă.
 *   "retry"    — Jupiter încă nu știe base-ul (dar nu-i prea vechi) SAU o scriere a EȘUAT → reprogramează.
 *   "gone"     — pool dispărut/corupt în Redis → scoate din coadă.
 * Succesul e condus de BASE (tokenul de interes); quote-ul e de regulă WSOL/USDC (KNOWN), deci prezent.
 */
export async function enrichPoolOnce(
  poolAddress: string,
  nowMs:       number,
  maxAgeMs:    number,
): Promise<EnrichOutcome> {
  const redis = getRedis();
  const key   = KEY_PAIR(poolAddress);

  const raw = await redis.get(key);
  if (raw === null) return "gone";
  let pool: SolanaPool;
  try { pool = JSON.parse(raw) as SolanaPool; } catch { return "gone"; } // corupt → nu mai insistăm

  // Redelivery pe un record deja terminal → scoate din coadă fără re-resolve inutil.
  if (pool.metadataStatus === "ENRICHED") return "enriched";
  if (pool.metadataStatus === "FAILED")   return "failed";

  const [baseMeta, quoteMeta] = await Promise.all([
    resolveTokenMeta(pool.baseMint),
    resolveTokenMeta(pool.quoteMint),
  ]);

  if (baseMeta.source !== "FALLBACK") {
    const w = await enrichSolanaPool(pool, baseMeta, quoteMeta);
    if (w === "error") return "retry"; // scriere eșuată → NU scoate jobul, reîncearcă
    console.log(
      "[SOLANA][META] pool enriched"
      + " pool=" + poolAddress.slice(0, 8) + "..."
      + " base=" + baseMeta.symbol + "(" + baseMeta.source + ")"
      + " quote=" + quoteMeta.symbol + "(" + quoteMeta.source + ")",
    );
    return "enriched";
  }

  // FALLBACK pe base → reîncercăm, DACĂ nu-i prea vechi (terminal decis de enrichAgeVerdict, pur).
  if (enrichAgeVerdict(pool.discoveredAt, nowMs, maxAgeMs) === "terminal") {
    pool.metadataStatus = "FAILED";
    try {
      await redis.set(key, JSON.stringify(pool));
    } catch (err) {
      console.error("[SOLANA][WRITER] pool FAILED write error pool=" + poolAddress.slice(0, 8) + ":", (err as Error).message);
      return "retry"; // n-am putut scrie FAILED → NU scoate jobul, reîncearcă
    }
    console.warn("[SOLANA][META] pool enrichment TERMINAL (age > max) pool=" + poolAddress.slice(0, 8) + "... status=FAILED");
    return "failed";
  }
  return "retry";
}
