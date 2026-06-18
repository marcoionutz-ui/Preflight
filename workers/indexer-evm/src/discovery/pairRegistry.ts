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
import type { DecodedPair } from "./eventDecoder";
import { chooseBaseQuote } from "../config/quotes";
import type { QuoteStatus } from "../config/quotes";
import { fetchAndCacheTokenMetadata } from "../infra/tokenMetadata";
import { getQuotePrice } from "../infra/quotePrices";
import { fetchV2Price } from "../infra/v2Pricing";
import type { PriceStatus } from "../infra/v2Pricing";

// ── Enrichment concurrency guard ──────────────────────────────────────────────

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const MAX_ENRICHMENTS = intEnv("INDEXER_METADATA_CONCURRENCY", 4);
let activeEnrichments = 0;

export interface IndexedPair {
  // ── Core (scris întotdeauna) ──────────────────────────────────────────────
  chain:        string;
  dexId:        string;
  pairAddress:  string;
  token0:       string;
  token1:       string;
  fee?:         number;   // V3 only
  stable?:      boolean;  // Aerodrome only
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
async function enrichPairMetadata(
  chain:   ChainId,
  rpcUrl:  string,
  pair:    IndexedPair,
  jsonKey: string,
): Promise<void> {
  const { baseToken, quoteToken, quoteStatus } = chooseBaseQuote(chain, pair.token0, pair.token1);

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

  // ── Faza 6.5: V2 price + liquidity ──────────────────────────────────────────
  const quotePriceUsd = quoteToken ? getQuotePrice(quoteToken) : null;

  const { priceUsd, reserveUsd, priceStatus } = await fetchV2Price({
    rpcUrl,
    pairAddress:   pair.pairAddress,
    dexId:         pair.dexId,
    token0:        pair.token0,
    baseToken,
    baseDecimals:  baseMeta.decimals,
    quoteToken,
    quoteDecimals: quoteMeta?.decimals ?? null,
    quoteStatus,
    quotePriceUsd,
  });

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
    // 6.5: price
    priceUsd,
    reserveUsd,
    priceStatus,
  };

  const r = getRedis();
  if (!r) return;

  try {
    await r.set(jsonKey, JSON.stringify(enriched));
    console.log(
      `[INDEXED] enriched ${pair.pairAddress} ` +
      `base:${baseMeta.symbol ?? "?"} quote:${quoteMeta?.symbol ?? "?"} ` +
      `price:$${priceUsd.toFixed(6)} reserve:$${reserveUsd.toFixed(0)} ` +
      `meta:${metadataStatus} price_status:${priceStatus}`,
    );
  } catch (err) {
    console.error(`[REGISTRY] enrich SET(${pair.pairAddress}) error:`, (err as Error).message);
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

    // Best-effort metadata enrichment — fire-and-forget, never blocks cursor
    const rpcUrl = getRpcUrl(chain);
    if (rpcUrl) {
      if (activeEnrichments >= MAX_ENRICHMENTS) {
        console.log(`[METADATA] enrichment skipped for ${pairAddr} reason:concurrency_limit`);
      } else {
        activeEnrichments++;
        enrichPairMetadata(chain, rpcUrl, pair, jsonKey)
          .catch(err => {
            console.error(`[REGISTRY] enrichPairMetadata(${pairAddr}) unhandled:`, (err as Error).message);
          })
          .finally(() => { activeEnrichments--; });
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
