/**
 * discovery/launchWriter.ts
 * 8.0g-b5: Scrie pump.fun launch records in Redis.
 * 8.0h-a:  lifecycleStage + graduated + raydiumPools[] + linkLaunchToPool().
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
import type {
  PreflightRaydiumPoolLink, PreflightSolanaLaunch, PreflightSolanaProgram,
} from "@preflight/schema";

// ── Tipuri ────────────────────────────────────────────────────────────────────

/** Un pool Raydium legat de acest mint (pump.fun → Raydium graduation). */
export type RaydiumPoolLink = PreflightRaydiumPoolLink;

/**
 * Subset minim din SolanaPool — evita import circular pairWriter ↔ launchWriter.
 * pairWriter importa launchWriter; launchWriter nu importa pairWriter.
 */
export interface PoolLinkInfo {
  poolAddress: string;
  program:     PreflightSolanaProgram;
  slot:        number;
  signature:   string;
}

export type SolanaLaunch = PreflightSolanaLaunch;

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
    // Stare inițială explicită — înainte, aceste câmpuri lipseau complet
    // pana la graduation (schema le declara opționale, dar niciun write
    // path nu scria vreodata PUMPFUN_LAUNCHED/false/[] la creare).
    lifecycleStage:         "PUMPFUN_LAUNCHED",
    graduated:              false,
    raydiumPools:           [],
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

// ── Migration linking ──────────────────────────────────────────────────────────────────────────────

/**
 * Leaga un launch record de un pool Raydium descoperit ulterior.
 * Apelat din pairWriter dupa insert nou (non-blocking).
 * Idempotent — daca pool-ul e deja in raydiumPools[], skip.
 * Nu arunca erori — caller foloseste .catch().
 */
export async function linkLaunchToPool(
  mint: string,
  pool: PoolLinkInfo,
): Promise<void> {
  const redis = getRedis();
  const key   = KEY_LAUNCH(mint);

  const launchJson = await redis.get(key);
  if (!launchJson) return; // nu exista launch pentru acest mint — skip

  let launch: SolanaLaunch;
  try {
    launch = JSON.parse(launchJson) as SolanaLaunch;
  } catch (_err) {
    return; // JSON corupt — skip, nu crasam
  }

  const link: RaydiumPoolLink = {
    poolAddress: pool.poolAddress,
    program:     pool.program,
    slot:        pool.slot,
    signature:   pool.signature,
    linkedAt:    new Date().toISOString(),
  };

  // Idempotent — nu adaugam acelasi pool de doua ori
  const existing = launch.raydiumPools ?? [];
  if (existing.some(p => p.poolAddress === pool.poolAddress)) return;

  const updated: SolanaLaunch = {
    ...launch,
    lifecycleStage: "RAYDIUM_POOL_FOUND",
    graduated:      true,
    // graduatedAt = prima data cand a absolvit (nu suprascrie la pool-uri ulterioare)
    graduatedAt:    launch.graduatedAt ?? new Date().toISOString(),
    raydiumPools:   [...existing, link],
  };

  await redis.set(key, JSON.stringify(updated));

  console.log(
    "[SOLANA][LAUNCH] graduated"
    + " mint=" + mint.slice(0, 8) + "..."
    + " pool=" + pool.poolAddress.slice(0, 8) + "..."
    + " program=" + pool.program,
  );
}

// ── Enrichment ─────────────────────────────────────────────────────────────────────────────────

// Delay-uri inainte de fiecare incercare Jupiter:
//   30s  — tokenii noi apar pe Jupiter dupa ~1m, dar incercam devreme
//   2m   — retry daca 429 sau nu e inca indexat
//   10m  — last chance; dupa asta marcam FAILED
const ENRICH_DELAYS_MS = [30_000, 120_000, 600_000];

/**
 * Citeste starea curenta a launch record din Redis.
 * Folosit de enrichLaunchRecord inainte de fiecare write pentru a nu suprascrie
 * graduation fields setate intre timp de linkLaunchToPool.
 * Daca Redis nu are recordul (unlikely) sau JSON corupt, fallback la obiectul initial.
 *
 * NOTĂ (item 6b): asta MICȘOREAZĂ fereastra de race, nu o elimină — GET aici
 * și SET-ul din enrichLaunchRecord/linkLaunchToPool rămân operații separate,
 * neatomice. Un enrich și o graduation care nimeresc exact în același
 * interval GET→SET tot se pot suprascrie reciproc (rar — enrich rulează la
 * 30s/2m/10m fix, graduation doar când vine un pool matching). Fix real =
 * update atomic (Lua EVAL, pattern deja folosit în infra/cursor.ts's
 * advanceCursor) — scos deliberat din scope-ul 6b (schema consolidation) și
 * mutat ca task separat de concurrency hardening, cu teste automate
 * dedicate, nu QA manual pe Redis-ul de producție.
 */
async function readCurrentLaunch(
  mint:     string,
  fallback: SolanaLaunch,
): Promise<SolanaLaunch> {
  try {
    const raw = await getRedis().get(KEY_LAUNCH(mint));
    if (!raw) return fallback;
    return JSON.parse(raw) as SolanaLaunch;
  } catch {
    return fallback;
  }
}

/**
 * Enricheaza launch record cu metadata din Jupiter.
 * Non-blocking — apelat async dupa writeLaunchRecord.
 * Implementeaza retry cu delay si marcheaza metadataStatus ENRICHED/FAILED.
 *
 * IMPORTANT: citeste recordul curent din Redis inainte de fiecare write
 * pentru a pastra graduation fields (raydiumPools[], graduated, lifecycleStage)
 * setate intre timp de linkLaunchToPool — evita race condition stale overwrite.
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
      // Ultima incercare — citim starea curenta si marcam FAILED
      // (pastreaza raydiumPools[] / graduated / lifecycleStage daca linkLaunchToPool a scris intre timp)
      const current = await readCurrentLaunch(launch.mint, launch);
      const failed: SolanaLaunch = {
        ...current,
        symbol:         current.symbol ?? launch.mint.slice(0, 6) + "...",
        decimals:       current.decimals ?? null,
        metaSource:     current.metaSource ?? "FALLBACK",
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

    // Metadata reala gasita — citim starea curenta si facem merge
    const current = await readCurrentLaunch(launch.mint, launch);
    const enriched: SolanaLaunch = {
      ...current,
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
