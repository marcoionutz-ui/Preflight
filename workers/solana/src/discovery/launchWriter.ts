/**
 * discovery/launchWriter.ts
 * 8.0g-b5: Scrie pump.fun launch records in Redis.
 *
 * Namespace separat de pool registry — launch-urile nu sunt pool-uri:
 *   preflight:indexed:launch:solana:{mint}   → JSON
 *   preflight:indexed:launches:solana        → ZSET (score = slot)
 *   preflight:indexed:launches:ts:solana     → ZSET (score = Unix ms)
 *
 * Enrichment Jupiter — delayed (30s / 2m / 10m), exact match only.
 * Nu foloseste buildSolanaPool / writeSolanaPool — semantica diferita.
 */

import { getRedis }         from "../infra/redis";
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
  metadataStatus:           "PENDING" | "ENRICHED" | "FAILED";
  // metadata — populat async dupa insert
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
    metadataStatus:         "PENDING",
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
    const redis  = getRedis();
    const key    = KEY_LAUNCH(launch.mint);
    const nowMs  = Date.now();
    const json   = JSON.stringify(launch);

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

// Delay-uri inainte de fiecare incercare Jupiter:
//   30s  — tokenii noi apar pe Jupiter dupa ~1m, dar incercam devreme
//   2m   — retry daca 429 sau nu e inca indexat
//   10m  — last chance; dupa asta marcam FAILED
const ENRICH_DELAYS_MS = [30_000, 120_000, 600_000];

/**
 * Enricheaza launch record cu metadata din Jupiter.
 * Non-blocking — apelat async dupa writeLaunchRecord.
 * Implementeaza retry cu delay si marcheaza metadataStatus ENRICHED/FAILED.
 */
export async function enrichLaunchRecord(launch: SolanaLaunch): Promise<void> {
  const redis = getRedis();
  const key   = KEY_LAUNCH(launch.mint);
  const m8    = launch.mint.slice(0, 8) + "...";

  console.log("[SOLANA][LAUNCH][META] mint=" + m8 + " status=PENDING");

  for (let attempt = 0; attempt < ENRICH_DELAYS_MS.length; attempt++) {
    // Asteapta inainte de a intreba Jupiter — tokenii tocmai s-au lansat
    await new Promise(r => setTimeout(r, ENRICH_DELAYS_MS[attempt]));

    const meta = await resolveTokenMeta(launch.mint);

    if (meta.source === "FALLBACK") {
      if (attempt < ENRICH_DELAYS_MS.length - 1) {
        // Retry — mai avem incercari
        continue;
      }
      // Ultima incercare — marcam FAILED, adaugam fallback symbol ca recordul sa ramana afisabil
      const failed: SolanaLaunch = {
        ...launch,
        symbol:         launch.mint.slice(0, 6) + "...",
        decimals:       null,
        metaSource:     "FALLBACK",
        metadataStatus: "FAILED",
      };
      try {
        await redis.set(key, JSON.stringify(failed));
        console.log(
          "[SOLANA][LAUNCH][META] mint=" + m8
          + " source=FALLBACK status=FAILED",
        );
      } catch (err) {
        console.error("[SOLANA][LAUNCH][META] redis write error:", (err as Error).message);
      }
      return;
    }

    // Metadata reala gasita
    const enriched: SolanaLaunch = {
      ...launch,
      symbol:         meta.symbol,
      name:           meta.name,
      decimals:       meta.decimals,
      metaSource:     meta.source,
      metadataStatus: "ENRICHED",
    };

    try {
      await redis.set(key, JSON.stringify(enriched));
      console.log(
        "[SOLANA][LAUNCH][META] mint=" + m8
        + " source=" + meta.source
        + " symbol=" + meta.symbol,
      );
    } catch (err) {
      console.error("[SOLANA][LAUNCH][META] redis write error:", (err as Error).message);
    }
    return;
  }
}
