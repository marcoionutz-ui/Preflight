/**
 * discovery/pairRegistry.ts
 * Redis registry pentru perechi descoperite prin indexer.
 *
 * Redis structure:
 *   preflight:indexed:pair:{chain}:{pairAddress}  → JSON (permanent, no TTL)
 *   preflight:indexed:pairs:{chain}               → ZSET score=blockNumber, member=pairAddress
 *   preflight:indexed:pairs:ts:{chain}            → ZSET score=discoveredAt (ms), member=pairAddress
 *
 * Write flow (Faza 6.4 + 6.5):
 *   1. SET NX pair minimal (token0/token1, fără metadata)
 *   2. zadd la ambele ZSETs
 *   3. fire-and-forget: enrichPairMetadata →
 *        base/quote detection + eth_call metadata (6.4)
 *        + V2 getReserves + price/liquidity (6.5)
 *        + SET overwrite cu toate câmpurile
 *   4. cursorul NU depinde de enrichment — writePair returnează imediat după ZSETs
 *
 * TODO(6.4+): pairs inserate înainte de 6.4 (fără metadataStatus) rămân minimale.
 *   Adaugă un background enrichment pass pentru perechi vechi dacă e necesar.
 */

import { getRedis } from "../infra/redis";
import { getRpcUrl } from "../infra/rpc";
import type { ChainId } from "../config/factories";
import { getV4Config } from "../config/factories";
import type { DecodedPair } from "./eventDecoder";
import { chooseBaseQuote } from "../config/quotes";
import type { QuoteStatus } from "../config/quotes";
import { fetchAndCacheTokenMetadata } from "../infra/tokenMetadata";
import { getQuotePriceResult } from "../infra/quotePrices";
import type { QuotePriceSource } from "../infra/quotePrices";
import { fetchV2Price } from "../infra/v2Pricing";
import type { PriceStatus, AmmVersion, PricingSource, ReserveSource } from "../infra/v2Pricing";
import { intEnv } from "../config/env";
import type Redis from "ioredis";
import {
  enqueueEnrich, claimDueEnrich, reclaimExpiredEnrich,
  markEnrichDone, markEnrichFailed, ENRICH_LEASE_MS,
} from "./enrichQueue";

// ── Enrichment concurrency guard ──────────────────────────────────────────────

// ── Re-pricing (C3) ───────────────────────────────────────────────────────────
const REPRICE_TOP_K    = intEnv("INDEXER_REPRICE_TOP_K", 50);        // top-K perechi recente scanate/pasaj
const REPRICE_STALE_MS = intEnv("INDEXER_REPRICE_STALE_MS", 45_000); // re-preț dacă pricedAt e mai vechi
const REPRICE_BATCH    = intEnv("INDEXER_REPRICE_BATCH", 20);        // max re-prețuite pe pasaj (bound RPC)
const REPRICE_CONCURRENCY = intEnv("INDEXER_REPRICE_CONCURRENCY", 4);   // câte re-prețuiri simultan (worker-pool)

// ── Enrichment queue drain (C2) ─────────────────────────────────────────────────
const ENRICH_DRAIN_BATCH       = intEnv("INDEXER_ENRICH_DRAIN_BATCH", 20);        // max drenate pe pasaj
const ENRICH_DRAIN_CONCURRENCY = intEnv("INDEXER_ENRICH_DRAIN_CONCURRENCY", 4);   // worker-pool drain
const ENRICH_REPAIR_SCAN_K     = intEnv("INDEXER_ENRICH_REPAIR_SCAN_K", 200);     // fereastra de scan reparație (paginat)
const repairOffset = new Map<ChainId, number>();                                   // cursor paginare reparație per chain

export interface IndexedPair {
  // ── Core (scris întotdeauna) ──────────────────────────────────────────────
  chain:        string;
  dexId:        string;
  pairAddress:  string;   // V2/V3: pool contract address; V4: poolId bytes32 (66 chars)
  token0:       string;   // V4: currency0 (poate fi address(0) pentru native ETH/BNB)
  token1:       string;   // V4: currency1
  fee?:         number;   // V3/V4
  stable?:      boolean;  // Aerodrome only
  hooks?:       string;   // V4 only — hooks contract (address(0) = vanilla pool)
  tickSpacing?: number;   // V4 only
  blockNumber:  number;
  txHash:       string;
  discoveredAt: number;   // Unix ms

  // ── Faza 6.4: token metadata (opțional — prezent după enrichment) ─────────
  baseToken?:      string;
  quoteToken?:     string | null;
  quoteStatus?:    QuoteStatus;
  baseSymbol?:     string | null;
  quoteSymbol?:    string | null;
  baseDecimals?:   number | null;
  quoteDecimals?:  number | null;
  metadataStatus?: "OK" | "PARTIAL" | "FAILED";

  // ── Faza 6.5: price + liquidity (opțional — prezent după enrichment) ──────
  priceUsd?:    number;
  reserveUsd?:  number;
  priceStatus?: PriceStatus;
  pricedAt?:    number;   // C3: Unix ms al ultimei prețuiri (freshness pt. re-pricing + staleness la reader)

  // ── Faza 6.9b: pricing metadata (opțional — prezent după enrichment) ──────
  ammVersion?:       AmmVersion;
  pricingSource?:    PricingSource;
  reserveSource?:    ReserveSource;

  // ── Faza 6.11: quote price source tracking ───────────────────────────────
  quotePriceSource?: QuotePriceSource;
  quotePriceAgeSec?: number;
}

// ── Key helpers ───────────────────────────────────────────────────────────────

function pairKey(chain: string, pairAddress: string): string {
  return `preflight:indexed:pair:${chain}:${pairAddress.toLowerCase()}`;
}

function blockSetKey(chain: string): string {
  return `preflight:indexed:pairs:${chain}`;
}

function tsSetKey(chain: string): string {
  return `preflight:indexed:pairs:ts:${chain}`;
}

// ── Enrichment ────────────────────────────────────────────────────────────────

/**
 * Best-effort enrichment: fetch token metadata + base/quote detection + overwrite pair JSON.
 * Called fire-and-forget — cursor advancement never waits for this.
 */
/** Rezultat explicit al enrichment-ului (C2): ok DOAR dacă recordul e scris ȘI servabil (priceStatus OK). */
type EnrichOutcome = { ok: true } | { ok: false; reason: string };

async function enrichPairMetadata(
  chain:   ChainId,
  rpcUrl:  string,
  pair:    IndexedPair,
  jsonKey: string,
): Promise<EnrichOutcome> {
  const { baseToken, quoteToken, quoteStatus } = chooseBaseQuote(chain, pair.token0, pair.token1);

  // Redis disponibil devreme — necesar pentru Chainlink cache (6.11)
  const r = getRedis();

  // Fetch metadata for both tokens in parallel (cache-aware)
  const [baseMeta, quoteMeta] = await Promise.all([
    fetchAndCacheTokenMetadata(rpcUrl, chain, baseToken),
    quoteToken
      ? fetchAndCacheTokenMetadata(rpcUrl, chain, quoteToken)
      : Promise.resolve(null),
  ]);

  const metadataStatus: "OK" | "PARTIAL" | "FAILED" =
    baseMeta.status === "OK" && (quoteMeta === null || quoteMeta.status === "OK")         ? "OK"      :
    baseMeta.status === "FAILED" && (quoteMeta === null || quoteMeta?.status === "FAILED") ? "FAILED" :
    "PARTIAL";

  // ── Pricing (C3: partajat cu re-pricing — vezi computePricing) ──────────────
  const pricing = await computePricing(
    chain, rpcUrl, r, pair,
    baseToken, quoteToken, quoteStatus,
    baseMeta.decimals, quoteMeta?.decimals ?? null,
  );

  // ── Write enriched pair ───────────────────────────────────────────────────
  const enriched: IndexedPair = {
    ...pair,
    // 6.4: metadata
    baseToken,
    quoteToken:    quoteToken   ?? undefined,
    quoteStatus,
    baseSymbol:    baseMeta.symbol    ?? undefined,
    quoteSymbol:   quoteMeta?.symbol  ?? undefined,
    baseDecimals:  baseMeta.decimals  ?? undefined,
    quoteDecimals: quoteMeta?.decimals ?? undefined,
    metadataStatus,
    // 6.5/6.9b/6.11 + C3: price + reserve + pricing sources + quote source/age + pricedAt
    ...pricing,
  };

  if (!r) return { ok: false, reason: "no_redis" };

  try {
    await r.set(jsonKey, JSON.stringify(enriched));
  } catch (err) {
    console.error(`[REGISTRY] enrich SET(${pair.pairAddress}) error:`, (err as Error).message);
    return { ok: false, reason: "set_failed" };
  }

  console.log(
    `[INDEXED] enriched ${pair.pairAddress} ` +
    `base:${baseMeta.symbol ?? "?"} quote:${quoteMeta?.symbol ?? "?"} ` +
    `price:$${pricing.priceUsd.toFixed(6)} reserve:$${pricing.reserveUsd.toFixed(0)} ` +
    `meta:${metadataStatus} price_status:${pricing.priceStatus} ` +
    `amm:${pricing.ammVersion ?? "?"} price_src:${pricing.pricingSource ?? "?"} reserve_src:${pricing.reserveSource ?? "?"} ` +
    `quote_price_src:${pricing.quotePriceSource} quote_price_age:${pricing.quotePriceAgeSec ?? "n/a"}s`,
  );

  // C2: succes DOAR dacă prețul e servabil (priceStatus OK). Altfel drain-ul reîncearcă / dead-letter,
  // NU marchează DONE un pair încă neservabil (bugul principal din review).
  return pricing.priceStatus === "OK"
    ? { ok: true }
    : { ok: false, reason: `price_status:${pricing.priceStatus}` };
}

// ── Pricing core (C3) ──────────────────────────────────────────────────────────

interface PricingFields {
  priceUsd:          number;
  reserveUsd:        number;
  priceStatus:       PriceStatus;
  ammVersion?:       AmmVersion;
  pricingSource?:    PricingSource;
  reserveSource?:    ReserveSource;
  quotePriceSource:  QuotePriceSource;
  quotePriceAgeSec?: number;
  pricedAt:          number;
}

/**
 * Calculează prețul + rezerva unei perechi (quote price Chainlink + reserves/price on-chain).
 * Partajat între enrichment (metadata proaspăt fetch-uită) și re-pricing (metadata din registry).
 * Stampează `pricedAt = now` la fiecare apel.
 */
async function computePricing(
  chain:         ChainId,
  rpcUrl:        string,
  r:             Redis | null,
  pair:          IndexedPair,
  baseToken:     string,
  quoteToken:    string | null,
  quoteStatus:   QuoteStatus,
  baseDecimals:  number | null,
  quoteDecimals: number | null,
): Promise<PricingFields> {
  const quotePriceResult = quoteToken
    ? await getQuotePriceResult(quoteToken, chain, rpcUrl, r)
    : null;
  const quotePriceUsd = quotePriceResult?.price ?? null;
  const v4Config = getV4Config(chain);

  const { priceUsd, reserveUsd, priceStatus, ammVersion, pricingSource, reserveSource } =
    await fetchV2Price({
      rpcUrl,
      pairAddress:      pair.pairAddress,
      dexId:            pair.dexId,
      token0:           pair.token0,
      token1:           pair.token1,
      baseToken,
      baseDecimals,
      quoteToken,
      quoteDecimals,
      quoteStatus,
      quotePriceUsd,
      stateViewAddress: v4Config?.stateViewAddress,
    });

  return {
    priceUsd, reserveUsd, priceStatus, ammVersion, pricingSource, reserveSource,
    quotePriceSource: quotePriceResult?.source ?? "UNKNOWN",
    quotePriceAgeSec: quotePriceResult
      ? Math.max(0, Math.floor((Date.now() - quotePriceResult.updatedAt) / 1000))
      : undefined,
    pricedAt: Date.now(),
  };
}

/**
 * Selecție PURĂ (testabilă): care perechi deja enrichuite sunt destul de vechi ca să merite re-preț.
 * Exclude neenrichuitele (fără metadataStatus) și cele proaspete; sortează cele mai vechi întâi; cap la `batch`.
 */
export function selectPairsToReprice<T extends { metadataStatus?: string; pricedAt?: number }>(
  pairs:   T[],
  now:     number,
  staleMs: number,
  batch:   number,
): T[] {
  return pairs
    .filter(p => p.metadataStatus !== undefined)
    .filter(p => now - (p.pricedAt ?? 0) >= staleMs)
    .sort((a, b) => (a.pricedAt ?? 0) - (b.pricedAt ?? 0))
    .slice(0, batch);
}

/** Re-prețuiește o pereche deja enrichuită folosind metadata din registry (fără RPC de metadata). */
async function repricePair(
  chain:   ChainId,
  rpcUrl:  string,
  r:       Redis,
  pair:    IndexedPair,
  jsonKey: string,
): Promise<boolean> {
  const baseToken = pair.baseToken;
  if (!baseToken || pair.metadataStatus === undefined) return false; // încă neenrichuită
  const pricing = await computePricing(
    chain, rpcUrl, r, pair,
    baseToken,
    pair.quoteToken   ?? null,
    pair.quoteStatus  ?? "NO_KNOWN_QUOTE",
    pair.baseDecimals ?? null,
    pair.quoteDecimals ?? null,
  );
  const updated: IndexedPair = { ...pair, ...pricing };
  try {
    await r.set(jsonKey, JSON.stringify(updated));
    return true;
  } catch (err) {
    console.error(`[REPRICE] SET(${pair.pairAddress}) error:`, (err as Error).message);
    return false;
  }
}

/**
 * Pasaj periodic de re-pricing (C3): re-prețuiește cele mai vechi perechi dintre top-K cele mai
 * recent descoperite, ca INDEXER_PRIMARY să nu mai servească prețuri înghețate la discovery
 * (rezolvă NO_MOMENTUM permanent / movers 0%). Mărginit pe apel de REPRICE_BATCH.
 */
export async function repriceRecentPairs(chain: ChainId): Promise<{ repriced: number; scanned: number }> {
  const r = getRedis();
  if (!r) return { repriced: 0, scanned: 0 };
  const rpcUrl = getRpcUrl(chain);
  if (!rpcUrl) return { repriced: 0, scanned: 0 };

  try {
    const addrs = await r.zrevrange(tsSetKey(chain), 0, REPRICE_TOP_K - 1);
    if (addrs.length === 0) return { repriced: 0, scanned: 0 };

    const pipe = r.pipeline();
    for (const a of addrs) pipe.get(pairKey(chain, a));
    const results = await pipe.exec();
    if (!results) return { repriced: 0, scanned: 0 };

    const pairs: IndexedPair[] = [];
    for (const [err, raw] of results) {
      if (err || !raw) continue;
      try { pairs.push(JSON.parse(raw as string) as IndexedPair); } catch { /* skip malformed */ }
    }

    const toReprice = selectPairsToReprice(pairs, Date.now(), REPRICE_STALE_MS, REPRICE_BATCH);

    // Worker-pool cu concurență mărginită (NU 20 secvențial, NU 20 simultan) — o pereche V3/V4
    // poate face mai multe RPC calls; ținem RPC-ul sub control fără să serializăm tot pasajul.
    let repriced = 0;
    let idx = 0;
    async function worker(): Promise<void> {
      while (idx < toReprice.length) {
        const p = toReprice[idx++];
        const ok = await repricePair(chain, rpcUrl, r!, p, pairKey(chain, p.pairAddress)).catch(() => false);
        if (ok) repriced++;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(REPRICE_CONCURRENCY, toReprice.length) }, () => worker()),
    );
    if (toReprice.length > 0) {
      console.log(`[REPRICE][${chain.toUpperCase()}] repriced ${repriced}/${toReprice.length} (scanned top-${addrs.length})`);
    }
    return { repriced, scanned: addrs.length };
  } catch (err) {
    console.error(`[REPRICE][${chain.toUpperCase()}] error:`, (err as Error).message);
    return { repriced: 0, scanned: 0 };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Result of a writePair call — three distinct outcomes:
 *   "inserted" — pair is new, written to registry + ZSETs + enrichment triggered
 *   "exists"   — pair already in registry (SET NX returned null), safe to continue
 *   "error"    — Redis unavailable or threw; pair NOT written, caller must NOT advance cursor
 */
export type WritePairResult = "inserted" | "exists" | "error";

/**
 * Writes a discovered pair to the registry.
 * Uses SET NX → idempotent on block replay.
 * Triggers metadata enrichment fire-and-forget on new inserts.
 *
 * Callers must treat "error" as a signal to abort and not advance cursor.
 */
export async function writePair(
  chain:   ChainId,
  dexId:   string,
  decoded: DecodedPair,
): Promise<WritePairResult> {
  const r = getRedis();
  if (!r) return "error";

  const now      = Date.now();
  const pairAddr = decoded.pairAddress.toLowerCase();
  const jsonKey  = pairKey(chain, pairAddr);

  const pair: IndexedPair = {
    chain,
    dexId,
    pairAddress:  pairAddr,
    token0:       decoded.token0,
    token1:       decoded.token1,
    fee:          decoded.fee,
    stable:       decoded.stable,
    hooks:        decoded.hooks,
    tickSpacing:  decoded.tickSpacing,
    blockNumber:  decoded.blockNumber,
    txHash:       decoded.txHash,
    discoveredAt: now,
  };

  try {
    // SET NX — only write if not already present
    const wrote = await r.set(jsonKey, JSON.stringify(pair), "NX");
    if (!wrote) return "exists";

    // New pair — add to ZSETs
    await r.zadd(blockSetKey(chain), decoded.blockNumber, pairAddr);
    await r.zadd(tsSetKey(chain), now, pairAddr);

    // C2: TOATE perechile noi intră DOAR prin coada persistentă de enrichment — un SINGUR execution
    // path (fără enrichment inline), o singură limită de concurență (drain), nimic pierdut la crash.
    // Dacă enqueue eșuează, pair-ul e deja în registry (SET NX de mai sus) → repair-ul îl prinde ulterior;
    // NU întoarcem "error" (ar reprocesa blocul → SET NX "exists" → tot n-ar ajunge în coadă).
    if (getRpcUrl(chain)) {
      try {
        await enqueueEnrich(r, chain, pairAddr);
      } catch (err) {
        console.error(`[REGISTRY] enqueue(${pairAddr}) failed (repair va reîncerca):`, (err as Error).message);
      }
    }

    return "inserted";
  } catch (err) {
    console.error(`[REGISTRY] write(${pairAddr}) error:`, (err as Error).message);
    return "error";
  }
}

/** Total perechi descoperite pe un chain (ZCARD pe block ZSET). */
export async function getTotalPairsCount(chain: ChainId): Promise<number> {
  const r = getRedis();
  if (!r) return 0;
  try {
    return await r.zcard(blockSetKey(chain));
  } catch {
    return 0;
  }
}

/** Perechi descoperite în ultimele 24h (ZCOUNT pe ts ZSET). */
export async function getFreshPairs24h(chain: ChainId): Promise<number> {
  const r = getRedis();
  if (!r) return 0;
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return await r.zcount(tsSetKey(chain), since, "+inf");
  } catch {
    return 0;
  }
}

/**
 * Ultimele N perechi descoperite, ordonate by blockNumber descendent.
 * Folosit pentru debugging/logging — nu e pe hot path.
 */
export async function getRecentPairs(
  chain: ChainId,
  limit: number = 20,
): Promise<IndexedPair[]> {
  const r = getRedis();
  if (!r) return [];

  try {
    const addrs = await r.zrevrange(blockSetKey(chain), 0, limit - 1);
    if (addrs.length === 0) return [];

    const pipe = r.pipeline();
    for (const addr of addrs) {
      pipe.get(pairKey(chain, addr));
    }

    const results = await pipe.exec();
    if (!results) return [];

    return results
      .map(([err, raw]) => (err || !raw ? null : JSON.parse(raw as string) as IndexedPair))
      .filter((p): p is IndexedPair => p !== null);
  } catch {
    return [];
  }
}


// ── Enrichment queue drain (C2) ─────────────────────────────────────────────────

/**
 * Drenează coada de enrichment (C2): ia perechile eligibile, le enrichuiește (metadata+price),
 * marchează OK/retry/dead. reclaim (lease expirat) → claim ATOMIC (pending→processing) → enrich → DONE/FAIL.
 * Mărginit pe apel de ENRICH_DRAIN_BATCH + concurență ENRICH_DRAIN_CONCURRENCY. Repair-ul e SEPARAT (repairEnrichQueue).
 */
export async function drainEnrichQueue(chain: ChainId): Promise<{ enriched: number; retry: number; dead: number }> {
  const r = getRedis();
  if (!r) return { enriched: 0, retry: 0, dead: 0 };
  const rpcUrl = getRpcUrl(chain);
  if (!rpcUrl) return { enriched: 0, retry: 0, dead: 0 };

  try {
    const now = Date.now();
    // Recuperare crash: lease-uri expirate din processing → înapoi în pending (înainte de claim).
    await reclaimExpiredEnrich(r, chain, now);
    // Claim ATOMIC: mută due din pending → processing cu lease (ZREM-ca-lock, sigur multi-replică).
    const claimed = await claimDueEnrich(r, chain, now, ENRICH_LEASE_MS, ENRICH_DRAIN_BATCH);
    if (claimed.length === 0) return { enriched: 0, retry: 0, dead: 0 };

    let enriched = 0, retry = 0, dead = 0;
    let idx = 0;
    async function worker(): Promise<void> {
      while (idx < claimed.length) {
        const addr = claimed[idx++];
        const jsonKey = pairKey(chain, addr);

        // GET eșuat (eroare Redis) ≠ pair dispărut (null): la EROARE NU marcăm DONE (am scoate din coadă
        // exact când Redis are probleme) → retry/dead-letter. La null CHIAR lipsește → DONE.
        let raw: string | null;
        try {
          raw = await r!.get(jsonKey);
        } catch (err) {
          const res = await markEnrichFailed(r!, chain, addr);
          if (res === "dead") dead++; else retry++;
          console.error(`[ENRICH-QUEUE][${chain.toUpperCase()}] GET(${addr}) failed:`, (err as Error).message);
          continue;
        }
        if (raw === null) { await markEnrichDone(r!, chain, addr); continue; } // chiar dispărut

        let pair: IndexedPair;
        try {
          pair = JSON.parse(raw) as IndexedPair;
        } catch {
          const res = await markEnrichFailed(r!, chain, addr);              // corupt ≠ succes → retry/dead
          if (res === "dead") dead++; else retry++;
          continue;
        }

        // Succes EXPLICIT (write confirmat + priceStatus OK) → DONE; altfel retry/dead-letter.
        const outcome = await enrichPairMetadata(chain, rpcUrl!, pair, jsonKey).catch(
          (e): EnrichOutcome => ({ ok: false, reason: `threw:${(e as Error).message}` }),
        );
        if (outcome.ok) {
          await markEnrichDone(r!, chain, addr);
          enriched++;
        } else {
          const res = await markEnrichFailed(r!, chain, addr);
          if (res === "dead") {
            dead++;
            console.warn(`[ENRICH-QUEUE][${chain.toUpperCase()}] dead-letter ${addr} (${outcome.reason})`);
          } else {
            retry++;
          }
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(ENRICH_DRAIN_CONCURRENCY, claimed.length) }, () => worker()),
    );

    if (enriched || retry || dead) {
      console.log(`[ENRICH-QUEUE][${chain.toUpperCase()}] enriched ${enriched} retry ${retry} dead ${dead} (claimed ${claimed.length})`);
    }
    return { enriched, retry, dead };
  } catch (err) {
    console.error(`[ENRICH-QUEUE][${chain.toUpperCase()}] error:`, (err as Error).message);
    return { enriched: 0, retry: 0, dead: 0 };
  }
}

/**
 * Reparație (C2) — mecanism de migrare pt. perechi rămase neenrichuite (skip pre-C2 / enrichment
 * resolved fără metadataStatus / enqueue eșuat la write). Rulează pe CADENȚĂ PROPRIE (nu depinde de
 * coadă goală → nu poate fi starvation-uit), paginat prin ts ZSET (fereastră glisantă de SCAN_K).
 * `enqueueEnrich` refuză oricum dead-letter-ul (terminal) și duplicatele → sigur de rulat repetat.
 */
export async function repairEnrichQueue(chain: ChainId): Promise<number> {
  const r = getRedis();
  if (!r) return 0;
  try {
    const total = await r.zcard(tsSetKey(chain));
    if (total === 0) return 0;

    let off = repairOffset.get(chain) ?? 0;
    if (off >= total) off = 0;                                     // wrap la capăt
    const addrs = await r.zrevrange(tsSetKey(chain), off, off + ENRICH_REPAIR_SCAN_K - 1);
    repairOffset.set(chain, off + addrs.length);                  // avansează fereastra
    if (addrs.length === 0) return 0;

    const pipe = r.pipeline();
    for (const a of addrs) pipe.get(pairKey(chain, a));
    const results = await pipe.exec();
    if (!results) return 0;

    let queued = 0;
    for (const [err, raw] of results) {
      if (err || !raw) continue;
      try {
        const pair = JSON.parse(raw as string) as IndexedPair;
        if (pair.metadataStatus === undefined) {
          const added = await enqueueEnrich(r, chain, pair.pairAddress); // sare dead/processing/dup
          if (added) queued++;
        }
      } catch { /* skip malformed */ }
    }
    if (queued > 0) {
      console.log(`[ENRICH-QUEUE][${chain.toUpperCase()}] repair queued ${queued} unenriched (window ${off}-${off + addrs.length})`);
    }
    return queued;
  } catch {
    return 0;
  }
}