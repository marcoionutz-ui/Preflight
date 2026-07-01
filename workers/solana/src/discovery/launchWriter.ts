/**
 * discovery/launchWriter.ts
 * 8.0g-b3: Scrie pump.fun launch records in Redis.
 *
 * Namespace separat de pool registry — launch-urile nu sunt pool-uri:
 *   preflight:indexed:launch:solana:{mint}   → JSON
 *   preflight:indexed:launches:solana        → ZSET (score = slot)
 *   preflight:indexed:launches:ts:solana     → ZSET (score = Unix ms)
 *
 * Nu foloseste buildSolanaPool / writeSolanaPool — semantica diferita.
 */

import { getRedis }      from "../infra/redis";
import { resolveTokenMeta } from "../infra/tokenMetadata";
import {
  CHAIN, INDEXER_VERSION,
  KEY_LAUNCH, KEY_LAUNCHES, KEY_LAUNCHES_TS,
} from "../config/constants";
import type { PumpfunCreateResult } from "./pumpfunFetcher";

// ── Tipuri ────────────────────────────────────────────────────────────────────

export interface SolanaLaunch {
  chain:                    typeof CHAIN;
  recordType:               "TOKEN_LAUNCH";
  launchSource:             "PUMPFUN";
  mint:                     string;
  bondingCurveAddress:      string;
  associatedBondingCurve:   string;
  creatorAddress:           string;
  slot:                     number;
  signature:                string;
  discoveredAt:             string;
  indexerVersion:           string;
  // metadata (opțional — populat async după insert)
  symbol?:                  string;
  name?:                    string;
  decimals?:                number | null;
  metaSource?:              string;
}

// ── Build ─────────────────────────────────────────────────────────────────────

export function buildLaunchRecord(
  result:    PumpfunCreateResult,
  slot:      number,
  signature: string,
): SolanaLaunch {
  return {
    chain:                  CHAIN,
    recordType:             "TOKEN_LAUNCH",
    launchSource:           "PUMPFUN",
    mint:                   result.mint,
    bondingCurveAddress:    result.bondingCurveAddress,
    associatedBondingCurve: result.associatedBondingCurve,
    creatorAddress:         result.creatorAddress,
    slot,
    signature,
    discoveredAt:           new Date().toISOString(),
    indexerVersion:         INDEXER_VERSION,
  };
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Scrie launch record in Redis.
 * Returneaza "inserted" | "exists" | "error".
 * Deduplicare via SET NX pe key-ul mint — acelasi pattern ca writeSolanaPool.
 */
export async function writeLaunchRecord(
  launch: SolanaLaunch,
): Promise<"inserted" | "exists" | "error"> {
  try {
    const redis     = getRedis();
    const key       = KEY_LAUNCH(launch.mint);
    const nowMs     = Date.now();
    const json      = JSON.stringify(launch);

    // SET NX — insert doar daca nu exista (fara TTL: launch-urile sunt permanente)
    const set = await redis.set(key, json, "NX");
    if (!set) return "exists";

    // ZADD in ambele ZSET (doar dupa insert nou)
    await redis.zadd(KEY_LAUNCHES,    launch.slot, launch.mint);
    await redis.zadd(KEY_LAUNCHES_TS, nowMs,        launch.mint);

    return "inserted";
  } catch (err) {
    console.error("[SOLANA][LAUNCH] redis write error:", (err as Error).message);
    return "error";
  }
}

// ── Enrichment ────────────────────────────────────────────────────────────────

/**
 * Enricheaza launch record cu metadata din Jupiter.
 * Non-blocking — apelat async dupa writeLaunchRecord.
 * Actualizeaza JSON-ul din Redis cu symbol/name/decimals.
 */
export async function enrichLaunchRecord(launch: SolanaLaunch): Promise<void> {
  const meta = await resolveTokenMeta(launch.mint);

  const enriched: SolanaLaunch = {
    ...launch,
    symbol:     meta.symbol,
    name:       meta.name,
    decimals:   meta.decimals,
    metaSource: meta.source,
  };

  try {
    const redis = getRedis();
    const key   = KEY_LAUNCH(launch.mint);
    // Suprascrie cu datele enriched (SET fara NX — vrem sa actualizam)
    await redis.set(key, JSON.stringify(enriched));
  } catch (err) {
    console.error("[SOLANA][LAUNCH] enrichment redis write error:", (err as Error).message);
  }
}
