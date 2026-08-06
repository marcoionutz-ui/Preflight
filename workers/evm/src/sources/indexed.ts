/**
 * sources/indexed.ts
 * Reads discovered pools from the Preflight Indexer EVM registry in Redis.
 *
 * Redis keys (written by workers/indexer-evm):
 *   preflight:indexer:health:{chain}       — IndexerHealth JSON (TTL 60s)
 *   preflight:indexed:pairs:{chain}        — ZSET by blockNumber (permanent)
 *   preflight:indexed:pair:{chain}:{addr}  — IndexedPair JSON (permanent)
 *
 * Defensive: returns [] / MISSING status if Redis unavailable or keys missing.
 * Never throws — all errors are caught and logged.
 *
 * Faza 6.3: pools have priceUsd=0 (token metadata + price not available yet).
 *   INDEXER_PRIMARY is gated on indexed.some(p => p.priceUsd > 0) so the
 *   fallback to Gecko remains in effect until Faza 6.5 adds price data.
 * Faza 6.5+: once price data exists, indexed pools pass processPool's price check.
 */

import { getRedis } from "../infra/redis";
import { CHAINS } from "../config/chains";
import type { ChainConfig } from "../config/chains";
import type { SourcePool, DexType, QuotePriceSource } from "./normalize";
import { normalizeHooks } from "../ws/v4Hooks";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Health of the indexer-evm source for a given chain.
 * "MISSING" = Redis key absent or Redis unavailable (not an indexer-written status).
 */
export interface IndexedSourceHealth {
  status:          "OK" | "CATCHING_UP" | "DEGRADED" | "MISSING";
  blocksBehind:    number | null;
  lastSuccessAt:   number | null;
  pairsDiscovered: number;
  freshPairs24h:   number;
  reason?:         string;
}

/** Shape written by workers/indexer-evm/src/discovery/pairRegistry.ts */
interface IndexedPair {
  // Core (always present)
  chain:        string;
  dexId:        string;
  pairAddress:  string;
  token0:       string;
  token1:       string;
  fee?:         number;
  stable?:      boolean;
  hooks?:       string;   // NF1: V4 hooks contract (indexer scrie address(0) pt. vanilla; absent pt. non-V4)
  blockNumber:  number;
  txHash:       string;
  discoveredAt: number;

  // Faza 6.4: token metadata (optional — present after enrichment by indexer-evm)
  baseToken?:      string;
  quoteToken?:     string | null;
  quoteStatus?:    "OK" | "NO_KNOWN_QUOTE" | "AMBIGUOUS_QUOTE";
  baseSymbol?:     string | null;
  quoteSymbol?:    string | null;
  baseDecimals?:   number | null;
  quoteDecimals?:  number | null;
  metadataStatus?: "OK" | "PARTIAL" | "FAILED";

  // Faza 6.5: price + liquidity (optional — present after enrichment by indexer-evm)
  priceUsd?:    number;
  reserveUsd?:  number;
  priceStatus?: string;
  pricedAt?:    number;   // C3: Unix ms al ultimei prețuiri (staleness)

  // Faza 6.11: quote price transparency
  quotePriceSource?: QuotePriceSource;
  quotePriceAgeSec?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const HEALTH_KEY    = (chain: string) => `preflight:indexer:health:${chain}`;
const BLOCK_SET_KEY = (chain: string) => `preflight:indexed:pairs:${chain}`;
const PAIR_KEY      = (chain: string, addr: string) => `preflight:indexed:pair:${chain}:${addr}`;

/** Maximum pairs to load per chain per scan — keeps pipeline bounded */
const MAX_PAIRS = 200;

/**
 * C3: prețurile indexer sunt re-calculate periodic + stampate cu `pricedAt`. Un preț mai vechi de
 * MAX_PRICE_AGE_MS = înghețat (indexer oprit / pereche ieșită din top-K re-pricing) → NU-l servim,
 * ca INDEXER_PRIMARY să nu raporteze momentum fals; cade pe fallback (Gecko). Override: INDEXED_MAX_PRICE_AGE_MS.
 */
const MAX_PRICE_AGE_MS = Number(process.env.INDEXED_MAX_PRICE_AGE_MS ?? 120_000);

/** True dacă prețul indexat e servabil: priceStatus OK ȘI prețuit recent (nu înghețat la discovery). C3. */
export function isIndexedPriceServable(
  pair:     { priceStatus?: string; pricedAt?: number },
  now:      number,
  maxAgeMs: number,
): boolean {
  if (pair.priceStatus !== "OK") return false;
  if (!Number.isFinite(pair.pricedAt)) return false;   // lipsă (legacy) / NaN → nu servi
  const ageMs = now - (pair.pricedAt as number);
  return ageMs >= 0 && ageMs <= maxAgeMs;              // respinge ȘI timestampuri din viitor (age<0)
}

/** dexIds that correspond to V3 pools (fee in topics[3], not data) */
const V3_DEX_IDS = new Set(["uniswap-v3", "pancakeswap-v3"]);

/** dexIds that correspond to V4 PoolManager singleton pools */
const V4_DEX_IDS = new Set(["uniswap-v4"]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function findChainConfig(chainId: string): ChainConfig | undefined {
  return CHAINS.find(c => c.id === chainId.toLowerCase());
}

function dexTypeFromId(dexId: string): DexType {
  if (V4_DEX_IDS.has(dexId)) return "V4";
  if (V3_DEX_IDS.has(dexId)) return "V3";
  return "V2";
}

function toSourcePool(pair: IndexedPair, chainCfg: ChainConfig): SourcePool {
  return {
    chain:             pair.chain,
    pairAddress:       pair.pairAddress,
    tokenAddress:      pair.baseToken  ?? pair.token0,   // 6.4: enriched base, fallback to token0
    symbol:            pair.baseSymbol ?? "UNKNOWN",     // 6.4: enriched symbol, fallback to UNKNOWN
    dexType:           dexTypeFromId(pair.dexId),
    dexId:             pair.dexId,
    hooks:             normalizeHooks(pair.hooks), // NF1: tri-stare (custom addr / null=vanilla / undefined=absent)
    discoverySource:   "INDEXER",
    priceUsd:          pair.priceUsd   ?? 0, // 6.5: enriched price, fallback 0
    priceChange:       { m5: 0, h1: 0, h24: 0 },
    reserveUsd:        pair.reserveUsd ?? 0, // 6.5: enriched TVL, fallback 0
    volumeUsd24h:      0,
    transactions:      { buys5m: 0, sells5m: 0, buys1h: 0, sells1h: 0 },
    _chain:            chainCfg,
    _raw:              pair,
    // 6.11: quote price transparency
    quotePriceSource:  pair.quotePriceSource,
    quotePriceAgeSec:  pair.quotePriceAgeSec,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reads indexer health from Redis for a given chain.
 * Returns { status: "MISSING" } if key absent or Redis unavailable.
 */
export async function getIndexedSourceHealth(
  chainId: string,
): Promise<IndexedSourceHealth> {
  const r = getRedis();
  if (!r) {
    return {
      status: "MISSING", blocksBehind: null, lastSuccessAt: null,
      pairsDiscovered: 0, freshPairs24h: 0, reason: "redis_unavailable",
    };
  }

  try {
    const raw = await r.get(HEALTH_KEY(chainId.toLowerCase()));
    if (!raw) {
      return {
        status: "MISSING", blocksBehind: null, lastSuccessAt: null,
        pairsDiscovered: 0, freshPairs24h: 0, reason: "health_key_missing",
      };
    }

    const h = JSON.parse(raw) as {
      status:          string;
      blocksBehind:    number;
      lastSuccessAt:   number | null;
      pairsDiscovered: number;
      freshPairs24h:   number;
    };

    return {
      status:          (h.status as IndexedSourceHealth["status"]) ?? "DEGRADED",
      blocksBehind:    h.blocksBehind ?? null,
      lastSuccessAt:   h.lastSuccessAt ?? null,
      pairsDiscovered: h.pairsDiscovered ?? 0,
      freshPairs24h:   h.freshPairs24h ?? 0,
    };
  } catch (err) {
    console.error(`[INDEXED] getIndexedSourceHealth(${chainId}) error:`, (err as Error).message);
    return {
      status: "MISSING", blocksBehind: null, lastSuccessAt: null,
      pairsDiscovered: 0, freshPairs24h: 0, reason: "parse_error",
    };
  }
}

/**
 * Fetches up to MAX_PAIRS most recent pairs from indexer registry (by blockNumber desc).
 * Returns [] if Redis unavailable, chain unknown, or registry is empty.
 */
export async function fetchIndexedDiscoveryPools(
  chain: ChainConfig,
): Promise<SourcePool[]> {
  const r = getRedis();
  if (!r) return [];

  const chainId  = chain.id.toLowerCase();
  const chainCfg = findChainConfig(chainId);
  if (!chainCfg) return [];

  try {
    const addrs = await r.zrevrange(BLOCK_SET_KEY(chainId), 0, MAX_PAIRS - 1);
    if (addrs.length === 0) return [];

    const pipe = r.pipeline();
    for (const addr of addrs) pipe.get(PAIR_KEY(chainId, addr));
    const results = await pipe.exec();
    if (!results) return [];

    const pools: SourcePool[] = [];
    const skipped: Record<string, number> = {};
    const now = Date.now();

    for (const [err, raw] of results) {
      if (err || !raw) continue;
      try {
        const pair = JSON.parse(raw as string) as IndexedPair;

        // C3: servim doar prețuri OK ȘI proaspete — un preț înghețat la discovery ar da momentum
        // fals (NO_MOMENTUM permanent). Vechi/lipsă → skip → INDEXER_PRIMARY nu-l servește → Gecko.
        if (!isIndexedPriceServable(pair, now, MAX_PRICE_AGE_MS)) {
          const key = pair.priceStatus !== "OK" ? (pair.priceStatus ?? "MISSING") : "STALE_PRICE";
          skipped[key] = (skipped[key] ?? 0) + 1;
          continue;
        }

        pools.push(toSourcePool(pair, chainCfg));
      } catch {
        // skip malformed entries silently
      }
    }

    const skippedStr = Object.entries(skipped).map(([k, v]) => `${k}:${v}`).join(" ");
    console.log(
      `[INDEXED] ${chain.id}: loaded ${addrs.length} indexed, ` +
      `served ${pools.length} OK` +
      (skippedStr ? `, skipped ${skippedStr}` : ""),
    );

    return pools;
  } catch (err) {
    console.error(`[INDEXED] fetchIndexedDiscoveryPools(${chain.id}) error:`, (err as Error).message);
    return [];
  }
}

/**
 * Fetches a single pool from indexer registry by pair address.
 * Returns null if not found, Redis unavailable, or parse error.
 */
export async function fetchIndexedPoolByAddress(
  chain:       ChainConfig,
  pairAddress: string,
): Promise<SourcePool | null> {
  const r = getRedis();
  if (!r) return null;

  const chainId = chain.id.toLowerCase();
  try {
    const raw = await r.get(PAIR_KEY(chainId, pairAddress.toLowerCase()));
    if (!raw) return null;
    const pair = JSON.parse(raw) as IndexedPair;
    // C3: invarianta „nu servi prețuri vechi" se aplică ȘI lookup-ului single-pair, nu doar bulk-ului.
    // Preț înghețat → null → callerul cade pe fallback (Gecko), nu servește momentum fals.
    if (!isIndexedPriceServable(pair, Date.now(), MAX_PRICE_AGE_MS)) return null;
    return toSourcePool(pair, chain);
  } catch (err) {
    console.error(`[INDEXED] fetchIndexedPoolByAddress(${chain.id}, ${pairAddress}) error:`, (err as Error).message);
    return null;
  }
}
