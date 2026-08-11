/**
 * discovery/launchWriter.ts
 * 8.0g-b5: Scrie pump.fun launch records in Redis.
 * 8.0h-a:  lifecycleStage + graduated + raydiumPools[] + linkLaunchToPool().
 * P1-5:    Enrichment-ul nu mai e o buclă în memorie (30s/2m/10m apoi FAILED permanent). `writeLaunchRecord`
 *          ENQUEUE-uiește launch-ul în coada durabilă (enrichQueue) AWAITED, pe „inserted" ȘI pe „exists"
 *          (idempotent NX) → durabil DUPĂ ACK. `enrichLaunchOnce` e încercarea chemată de scanner (CAS-merge
 *          peste graduation fields). Terminal FAILED după 24h (din discoveredAt).
 *
 * Namespace separat de pool registry — launch-urile nu sunt pool-uri:
 *   preflight:indexed:launch:solana:{mint}   → JSON
 *   preflight:indexed:launches:solana        → ZSET (score = slot)
 *   preflight:indexed:launches:ts:solana     → ZSET (score = Unix ms)
 *
 * Nu foloseste buildSolanaPool / writeSolanaPool — semantica diferita.
 */

import { getRedis }         from "../infra/redis";
import { insertRecordAndIndex, casUpdateJson } from "./registryWrite";
import { resolveTokenMeta } from "../infra/tokenMetadata";
import {
  CHAIN, INDEXER_VERSION,
  KEY_LAUNCH, KEY_LAUNCHES, KEY_LAUNCHES_TS,
} from "../config/constants";
import { enqueueEnrich, enrichAgeVerdict, ENRICH_INITIAL_DELAY_MS, type EnrichOutcome } from "./enrichQueue";
import type { PumpfunCreateResult } from "./pumpfunFetcher";
// NF2/U9: boundary de normalizare — normalizează un record (legacy sau curent) în union-ul curent
// ÎNAINTE de orice mutație CAS, ca să nu scriem înapoi un hibrid (record legacy spread-uit fără lifecycle).
import { parseAndNormalizeSolanaLaunch } from "@preflight/schema";
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
 * Scrie launch record in Redis + ENQUEUE enrichment durabil (AWAITED, pe inserted ȘI exists).
 * Returneaza "inserted" | "exists" | "error". Dacă enqueue-ul aruncă → "error" (caller-ul reîncearcă;
 * insert idempotent → "exists" → re-enqueue). Deduplicare via SET NX pe key-ul mint.
 */
export async function writeLaunchRecord(
  launch: SolanaLaunch,
): Promise<"inserted" | "exists" | "error"> {
  try {
    const redis  = getRedis();
    const key    = KEY_LAUNCH(launch.mint);
    const nowMs  = Date.now();
    const json   = JSON.stringify(launch);

    // C1: SET NX blob + ambele ZADD ATOMIC — launch-ul e ori complet indexat, ori deloc.
    const inserted = await insertRecordAndIndex(redis, {
      jsonKey: key, blob: json, member: launch.mint,
      zsetA: KEY_LAUNCHES,    scoreA: launch.slot,
      zsetB: KEY_LAUNCHES_TS, scoreB: nowMs,
    });

    // P1-5 (fix cgpt R1): enqueue enrichment DURABIL — AWAITED, pe „inserted" ȘI pe „exists" (idempotent
    // NX). Throw (Redis jos) → outer catch → "error" → caller-ul NU face ACK, reîncearcă.
    await enqueueEnrich(redis, CHAIN, "launch", launch.mint, Date.now() + ENRICH_INITIAL_DELAY_MS);

    if (!inserted) return "exists";

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
  const redis     = getRedis();
  const key       = KEY_LAUNCH(mint);
  const linkedAt  = new Date().toISOString();

  // C1: read-modify-write ATOMIC prin CAS — înainte GET→modify→SET neatomic se putea suprascrie
  // cu enrichment (ambele scriau blob-ul launch-ului). Acum CAS + retry → merge, nu clobber.
  // NF2/U9: normalizează `raw` (poate fi legacy fără lifecycle) ÎNAINTE de mutație — altfel un
  // spread al unui record legacy scria înapoi un hibrid graduated. Nenormalizabil → skip + log (nu scriem).
  let normFailed = false;
  const res = await casUpdateJson<SolanaLaunch>(redis, key, (raw) => {
    const launch = parseAndNormalizeSolanaLaunch(raw);
    if (!launch) { normFailed = true; return null; }
    // Idempotent — nu adaugam acelasi pool de doua ori
    const existing = launch.raydiumPools ?? [];
    if (existing.some(p => p.poolAddress === pool.poolAddress)) return null; // deja legat → no-op

    const link: RaydiumPoolLink = {
      poolAddress: pool.poolAddress,
      program:     pool.program,
      slot:        pool.slot,
      signature:   pool.signature,
      linkedAt,
    };
    return {
      ...launch,
      lifecycleStage: "RAYDIUM_POOL_FOUND",
      graduated:      true,
      // graduatedAt = prima data cand a absolvit (nu suprascrie la pool-uri ulterioare)
      graduatedAt:    launch.graduatedAt ?? linkedAt,
      raydiumPools:   [...existing, link],
    };
  });

  if (normFailed) {
    console.error("[SOLANA][LAUNCH] linkLaunchToPool skip (record nenormalizabil) mint=" + mint.slice(0, 8));
    return;
  }

  // "absent" (fara launch pentru acest mint) / "noop" (deja legat) / "corrupt" / "conflict" → silent
  if (res === "ok") {
    console.log(
      "[SOLANA][LAUNCH] graduated"
      + " mint=" + mint.slice(0, 8) + "..."
      + " pool=" + pool.poolAddress.slice(0, 8) + "..."
      + " program=" + pool.program,
    );
  } else if (res === "conflict" || res === "corrupt") {
    console.error("[SOLANA][LAUNCH] linkLaunchToPool " + res + " mint=" + mint.slice(0, 8));
  }
}

// ── Enrichment (P1-5: durabil prin coadă — o încercare per invocare) ────────────────────────────────

/**
 * O SINGURĂ încercare de enrichment pentru un launch. Chemată de scanner-ul cozii durabile (enrichQueue).
 * CAS-merge peste graduation fields scrise între timp de linkLaunchToPool (nu clobber).
 *   "enriched" — metadata reală (non-FALLBACK) scrisă CU SUCCES (CAS "ok") → scoate din coadă.
 *   "failed"   — launch prea vechi (enrichAgeVerdict=terminal) și FAILED scris CU SUCCES → scoate din coadă.
 *   "retry"    — Jupiter încă nu știe tokenul (nu-i prea vechi) SAU CAS "conflict" (n-am confirmat scrierea).
 *   "gone"     — launch dispărut/corupt (CAS "absent"/"corrupt") → scoate din coadă.
 * ⚠️ (fix cgpt R1): CAS "conflict"/"corrupt" NU mai sunt tratate ca „enriched"; jobul iese doar pe scriere
 *    terminală CONFIRMATĂ ("ok").
 */
export async function enrichLaunchOnce(
  mint:     string,
  nowMs:    number,
  maxAgeMs: number,
): Promise<EnrichOutcome> {
  const redis = getRedis();
  const key   = KEY_LAUNCH(mint);
  const m8    = mint.slice(0, 8) + "...";

  // Existență + short-circuit pe record deja terminal (redelivery) — fără re-resolve inutil.
  // NF2/U9: normalizează recordul (legacy sau curent) în loc de `JSON.parse ... as SolanaLaunch`.
  // Nenormalizabil/corupt → "gone" (scoate din coadă). Restul logicii merge pe union-ul curent.
  const raw = await redis.get(key);
  if (raw === null) return "gone";
  const current = parseAndNormalizeSolanaLaunch(raw);
  if (!current) return "gone";
  if (current.metadataStatus === "ENRICHED") return "enriched";
  if (current.metadataStatus === "FAILED")   return "failed";

  const meta = await resolveTokenMeta(mint);

  if (meta.source !== "FALLBACK") {
    // Metadata reala gasita — CAS merge peste graduation fields scrise între timp de linkLaunchToPool.
    // NF2/U9: normalizează `raw` ÎNAINTE de spread — un legacy enrichat fără normalizare ar rămâne
    // hibrid (ENRICHED dar fără lifecycle). Nenormalizabil → skip + retry (scanner-ul reîncearcă; outer-ul
    // îl va prinde ca "gone" dacă e persistent corupt).
    let normFailed = false;
    const res = await casUpdateJson<SolanaLaunch>(redis, key, (rawCur) => {
      const norm = parseAndNormalizeSolanaLaunch(rawCur);
      if (!norm) { normFailed = true; return null; }
      return {
        ...norm,
        symbol:         meta.symbol,
        name:           meta.name,
        decimals:       meta.decimals,
        metaSource:     meta.source,
        metadataStatus: "ENRICHED",
      };
    });
    if (normFailed) { console.error("[SOLANA][LAUNCH][META] skip enrich (record nenormalizabil) mint=" + m8); return "retry"; }
    switch (res) {
      case "ok":       console.log("[SOLANA][LAUNCH][META] mint=" + m8 + " source=" + meta.source + " symbol=" + meta.symbol + " status=ENRICHED"); return "enriched";
      case "absent":   return "gone";
      case "corrupt":  return "gone";
      case "conflict": return "retry"; // prea multe conflicte → n-am confirmat scrierea; reîncearcă
      case "noop":     return "enriched"; // mutate întoarce obiect când norm reușește → nu apare; safe
    }
  }

  // FALLBACK → terminal (FAILED) DACĂ prea vechi, altfel retry. enrichAgeVerdict = pur, boundary exact 24h.
  // NF2/U9: normalizează `raw` ÎNAINTE — enrichAgeVerdict primește un discoveredAt validat + write-back e union curent.
  let normFailedFb = false;
  const res = await casUpdateJson<SolanaLaunch>(redis, key, (rawCur) => {
    const norm = parseAndNormalizeSolanaLaunch(rawCur);
    if (!norm) { normFailedFb = true; return null; }
    if (enrichAgeVerdict(norm.discoveredAt, nowMs, maxAgeMs) === "terminal") {
      return {
        ...norm,
        symbol:         norm.symbol ?? mint.slice(0, 6) + "...",
        decimals:       norm.decimals ?? null,
        metaSource:     norm.metaSource ?? "FALLBACK",
        metadataStatus: "FAILED",
      };
    }
    return null; // încă în fereastra de 24h → noop, rămâne în coadă (backoff)
  });
  if (normFailedFb) { console.error("[SOLANA][LAUNCH][META] skip FALLBACK-terminal (record nenormalizabil) mint=" + m8); return "retry"; }
  switch (res) {
    case "ok":       console.log("[SOLANA][LAUNCH][META] mint=" + m8 + " source=FALLBACK status=FAILED (terminal, age>max)"); return "failed";
    case "noop":     return "retry"; // în fereastră (sau norm-fail) → reîncearcă mai târziu
    case "absent":   return "gone";
    case "corrupt":  return "gone";
    case "conflict": return "retry";
  }
  return "retry"; // unreachable (switch e exhaustiv) — satisface TS
}
