/**
 * discovery/observedPool.ts
 * 8.0k-b: Observed pool candidate promotion.
 *
 * Pooluri neindexate (knownPool=false) care apar în swap samples de N ori
 * cu distribuție temporală suficientă sunt promovate în registry cu:
 *   discoveryReason:    "OBSERVED_SWAP"
 *   registrySource:     "SWAP_SAMPLED"
 *   registryConfidence: "OBSERVED"
 *
 * Guards:
 *   ✅ quoteMint trebuie să fie WSOL / USDC / USDT
 *   ✅ baseMint + quoteMint + program consistente între samples
 *   ✅ price finite > 0
 *   ✅ nu overwrite dacă pool-ul există deja în registry (SET NX)
 *   ✅ promoted=true după prima promovare → nu re-încearcă
 *
 * Thresholds:
 *   PROMOTE_MIN_SAMPLES = 3     sample-uri distincte
 *   PROMOTE_MIN_SPAN_MS = 120s  distribuție temporală minimă
 *   PROMOTE_MAX_IDLE_MS = 10m   ultimul sample în ultimele 10min
 *
 * Keys:
 *   preflight:solana:observed_candidate:{pool}  TTL 2h
 *   preflight:indexed:pair:solana:{pool}        SET NX persistent la promovare
 */

import { getRedis } from "../infra/redis";
import {
  CHAIN,
  KEY_PAIR, KEY_PAIRS, KEY_PAIRS_TS,
  KEY_OBSERVED_CANDIDATE, KEY_PRICE_SNAPSHOT,
  INDEXER_VERSION,
} from "../config/constants";
import { USDC_MINT, USDT_MINT, WSOL_MINT } from "../config/programs";
import type { PriceSnapshot } from "./priceTracker";
import type { PreflightSolanaQuoteType, PreflightObservedSolanaPool, PreflightObservedCandidate } from "@preflight/schema";
import { linkLaunchToPool } from "./launchWriter";

// ── Constante ─────────────────────────────────────────────────────────────────

const CANDIDATE_TTL_SEC   = 2 * 60 * 60; // 2h — fereastra de observare
const PROMOTE_MIN_SAMPLES = 3;            // min sample-uri distincte
const PROMOTE_MIN_SPAN_MS = 120_000;      // min 2min între primul și ultimul sample
const PROMOTE_MAX_IDLE_MS = 10 * 60_000; // pool trebuie activ în ultimele 10min
const MAX_SIGNATURES      = 10;           // cap pe signatures[] — evită RAM bloat

const VALID_QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

// ── Tipuri ────────────────────────────────────────────────────────────────────

// ObservedCandidate moved to @preflight/schema (item 6a) — was already a
// clean interface here, just not shared with mcp.
export type ObservedCandidate = PreflightObservedCandidate;

// ── Quote type helper ─────────────────────────────────────────────────────────
// Was a local `"WSOL"|"STABLE"|"UNKNOWN"` (3 members) — real drift found
// against quoteNormalizer.ts's SolanaQuoteType (4 members, has "AMBIGUOUS"
// too). inferQuoteType() itself never returns "AMBIGUOUS" (no behavior
// change), but the type it was declared to return was already wrong/narrower
// than the canonical one — widened to the real type.

function inferQuoteType(quoteMint: string): PreflightSolanaQuoteType {
  if (quoteMint === WSOL_MINT) return "WSOL";
  if (quoteMint === USDC_MINT || quoteMint === USDT_MINT) return "STABLE";
  return "UNKNOWN";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCandidate(
  snapshot:  PriceSnapshot,
  signature: string,
  now:       number,
): ObservedCandidate {
  return {
    poolAddress:      snapshot.poolAddress,
    program:          snapshot.program,
    baseMint:         snapshot.baseMint,
    quoteMint:        snapshot.quoteMint,
    baseSymbol:       snapshot.baseSymbol,
    quoteSymbol:      snapshot.quoteSymbol,
    firstSeenAt:      now,
    lastSeenAt:       now,
    sampleCount:      1,
    signatures:       [signature],
    lastPriceInQuote: snapshot.priceInQuote,
    lastPriceUsd:     snapshot.priceUsd,
    promoted:         false,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Actualizează candidate record pentru un pool neindexat.
 * Dacă thresholds sunt îndeplinite, promovează în registry.
 * Fire-and-forget — apelantul face .catch().
 */
export async function maybeRecordObservedCandidate(
  snapshot:  PriceSnapshot,
  signature: string,
): Promise<void> {
  // Guard: nu procesăm pooluri deja indexate
  if (snapshot.knownPool) return;

  // Guard: quoteMint trebuie să fie un quote asset cunoscut
  if (!VALID_QUOTE_MINTS.has(snapshot.quoteMint)) return;

  // Guard: price trebuie să fie finit și pozitiv
  if (!isFinite(snapshot.priceInQuote) || snapshot.priceInQuote <= 0) return;

  const redis   = getRedis();
  const key     = KEY_OBSERVED_CANDIDATE(snapshot.poolAddress);
  const pairKey = KEY_PAIR(snapshot.poolAddress);
  const now     = Date.now();

  // Citim candidatul existent (dacă există)
  const raw = await redis.get(key);
  let candidate: ObservedCandidate;

  if (raw) {
    try {
      candidate = JSON.parse(raw) as ObservedCandidate;
    } catch {
      // JSON corupt / editat manual — resetam candidatul
      candidate = buildCandidate(snapshot, signature, now);
    }

    // Dacă deja promovat — skip
    if (candidate.promoted) return;

    // Verificăm consistența datelor (program + mints)
    const consistent =
      candidate.baseMint  === snapshot.baseMint  &&
      candidate.quoteMint === snapshot.quoteMint &&
      candidate.program   === snapshot.program;

    if (!consistent) {
      // Date inconsistente (ex: pool refolosit cu mints diferite) — resetăm
      candidate = buildCandidate(snapshot, signature, now);
    } else {
      // Update normal
      candidate.lastSeenAt       = now;
      candidate.lastPriceInQuote = snapshot.priceInQuote;
      candidate.lastPriceUsd     = snapshot.priceUsd;

      // sampleCount crește doar pe signatures distincte — safe by itself,
      // independent de dedup-ul din swapShadow
      const alreadySeen = candidate.signatures.includes(signature);
      if (!alreadySeen) {
        candidate.sampleCount += 1;
        if (candidate.signatures.length < MAX_SIGNATURES) {
          candidate.signatures.push(signature);
        }
      }

      // Actualizăm symbol dacă am primit unul mai bun (din metadata enrichment)
      if (snapshot.baseSymbol !== snapshot.baseMint.slice(0, 7) + "...") {
        candidate.baseSymbol = snapshot.baseSymbol;
      }
    }
  } else {
    candidate = buildCandidate(snapshot, signature, now);
  }

  // Verificăm thresholds de promovare
  const span      = candidate.lastSeenAt - candidate.firstSeenAt;
  const idle      = now - candidate.lastSeenAt;
  const canPromote =
    candidate.sampleCount >= PROMOTE_MIN_SAMPLES &&
    span >= PROMOTE_MIN_SPAN_MS                  &&
    idle <  PROMOTE_MAX_IDLE_MS;

  if (canPromote) {
    // Was an untyped inline JSON.stringify({...}) — typed against the real
    // canonical shape (PreflightObservedSolanaPool, the discriminated-union
    // member for this write path) so a future field rename/typo here would
    // surface as a compile error instead of silently drifting.
    const registryEntry: PreflightObservedSolanaPool = {
      chain:              CHAIN,
      poolAddress:        candidate.poolAddress,
      mint0:              candidate.baseMint,
      mint1:              candidate.quoteMint,
      baseMint:           candidate.baseMint,
      quoteMint:          candidate.quoteMint,
      quoteType:          inferQuoteType(candidate.quoteMint),
      program:            candidate.program,
      slot:               0,
      signature:          candidate.signatures[0] ?? signature,
      discoveredAt:       new Date().toISOString(),
      indexerVersion:     INDEXER_VERSION,
      baseSymbol:         candidate.baseSymbol,
      quoteSymbol:        candidate.quoteSymbol,
      discoveryReason:    "OBSERVED_SWAP",
      registrySource:     "SWAP_SAMPLED",
      registryConfidence: "OBSERVED",
      sampleCount:        candidate.sampleCount,
    };
    const registryRecord = JSON.stringify(registryEntry);

    // SET NX — nu overwrite dacă pool-ul a fost indexat între timp
    const inserted = await redis.set(pairKey, registryRecord, "NX"); // permanent — fara TTL (registry)

    if (inserted) {
      // Actualizăm ZSET-urile (slot=0 pentru observed, score=now pentru TS)
      const pipeline = redis.pipeline();
      pipeline.zadd(KEY_PAIRS,    0,   candidate.poolAddress);
      pipeline.zadd(KEY_PAIRS_TS, now, candidate.poolAddress);
      await pipeline.exec();

      // 8.0k-b + item 6b — al doilea write path pe pool registry (alături de
      // pairWriter.ts's writeSolanaPool()) trebuia să cheme și el
      // linkLaunchToPool(), altfel un launch pump.fun al cărui pool e
      // promovat doar prin OBSERVED_SWAP rămânea veșnic PUMPFUN_LAUNCHED
      // chiar dacă pool-ul lui era deja indexat. baseMint e mint-ul corect
      // aici — quoteMint a trecut deja guard-ul WSOL/USDC/USDT mai sus, deci
      // nu poate fi el mint-ul unui launch pump.fun. Fire-and-forget, ca la
      // pairWriter.ts.
      linkLaunchToPool(candidate.baseMint, {
        poolAddress: candidate.poolAddress,
        program:     candidate.program,
        slot:        0,
        signature:   registryEntry.signature,
      }).catch((err: Error) => {
        console.error(
          "[SOLANA][OBSERVED] linkLaunchToPool error mint=" + candidate.baseMint.slice(0, 8) + ":",
          err.message,
        );
      });

      // Patch price snapshot imediat — nu așteptăm moversTracker (60s lag)
      const snapKey = KEY_PRICE_SNAPSHOT(candidate.poolAddress);
      const snapRaw = await redis.get(snapKey);
      if (snapRaw) {
        try {
          const snap = JSON.parse(snapRaw);
          if (snap.knownPool !== true) {
            snap.knownPool = true;
            await (redis as any).set(snapKey, JSON.stringify(snap), "KEEPTTL");
          }
        } catch (_e) {
          // snapshot malformat - ignoram, moversTracker va corecta la urmatorul compute
        }
      }

      console.log(
        "[SOLANA][OBSERVED] promoted pool=" + candidate.poolAddress.slice(0, 8) + "..."
        + " base=" + candidate.baseSymbol
        + " quote=" + candidate.quoteSymbol
        + " samples=" + candidate.sampleCount
        + " spanSec=" + Math.round(span / 1000),
      );
    }

    // Marcam promoted indiferent - daca NX a esuat, pool-ul exista deja
    if (!inserted) {
      // Pool exista deja in registry - patch snapshot oricum (poate knownPool=false din cache vechi)
      const snapKey2 = KEY_PRICE_SNAPSHOT(candidate.poolAddress);
      const snapRaw2 = await redis.get(snapKey2);
      if (snapRaw2) {
        try {
          const snap2 = JSON.parse(snapRaw2);
          if (snap2.knownPool !== true) {
            snap2.knownPool = true;
            await (redis as any).set(snapKey2, JSON.stringify(snap2), "KEEPTTL");
          }
        } catch (_e2) { /* ignore */ }
      }
    }
    candidate.promoted = true;
  }

  // Salvam candidatul actualizat
  if (raw) {
    await (redis as any).set(key, JSON.stringify(candidate), "KEEPTTL");
  } else {
    await redis.set(key, JSON.stringify(candidate), "EX", CANDIDATE_TTL_SEC);
  }
}
