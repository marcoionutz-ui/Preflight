/**
 * lib/mcp/schemas/reader.ts — E8c (scheme Zod la granițele de parse Redis rămase din redis-reader.ts).
 *
 * E8a/E8b au acoperit `safeJson`. E8c acoperă citirile care foloseau `JSON.parse` BRUT + cast, ratate
 * fiindcă nu treceau prin `safeJson`. Rigoare E8b (review varu R2): CONTRACT CANONIC COMPLET, nu guard
 * superficial — un `{}` NU e context/health valid; câmpurile de branching sunt `z.enum`; `price` pozitiv.
 * Contracte oglindite:
 *   - MoverEntry (readTrendingMovers — EVM-only; movers Solana merg prin readSolanaMovers/E8a);
 *   - IndexedPair (readQuotePriceHealth) — ancore core obligatorii + quotePriceSource/priceStatus enum;
 *   - QuotePrice (readQuotePrices) — price POZITIV + updatedAt number (producătorul scrie exact asta);
 *   - PreflightPairContext (readPairContext) — contract COMPLET (`workers/evm/src/lib/preflight-redis.ts`).
 *
 * PUR (doar `zod` + `parseWithSchema`) → testabil izolat în tsx.
 */
import { z } from "zod";
import { parseWithSchema } from "../safeParse";

// ── Enum-uri canonice (oglindesc uniunile din @preflight/schema + worker) ──
const EVM_CHAINS          = ["base", "arbitrum", "ethereum", "bsc"] as const;                                     // PreflightEvmChain
const DEX_TYPES           = ["V2", "V3", "V4", "UNKNOWN"] as const;                                               // DexType
const PIPELINE_STATES     = ["NONE", "OBSERVED", "WATCHING", "HOT", "ARMED", "QUALIFIED", "DROPPED", "REJECTED"] as const; // PipelineState
const FLOW_STATUSES       = ["NO_DATA", "WEAK", "BUYING", "STRONG", "ONE_SIDED"] as const;                        // FlowStatus
const LIQ_STATUSES        = ["THIN", "OK", "CONFIRMED", "DEEP"] as const;                                         // LiquidityStatus
const ENTRY_RISKS         = ["LOW", "MEDIUM", "HIGH", "EXTREME"] as const;                                        // EntryRisk
const QUOTE_PRICE_SOURCES = ["STATIC_STABLE", "CHAINLINK", "ENV_FALLBACK", "UNKNOWN"] as const;                   // QuotePriceSource
const PRICE_STATUSES      = [
  "OK", "V3_SKIP", "V3_NO_SLOT0", "V3_PRICE_ONLY", "V4_NO_SLOT0", "V4_PRICE_ONLY", "AMBIGUOUS_QUOTE",
  "NO_QUOTE", "QUOTE_PRICE_UNKNOWN", "MISSING_DECIMALS", "PAIR_TOKEN_MISMATCH", "NO_RESERVES",
] as const;                                                                                                       // PriceStatus

// ── MoverEntry[] (readTrendingMovers) ──
// chain/dexType/direction/historyStatus = enum (reader-ul e EVM-only → uniuni închise, un typo → fallback).
const MoverEntrySchema = z.object({
  chain:          z.enum(EVM_CHAINS),
  pairAddress:    z.string(),
  tokenAddress:   z.string().nullable(),
  symbol:         z.string(),
  dexType:        z.enum(DEX_TYPES),
  priceUsd:       z.number(),
  reserveUsd:     z.number(),
  priceChange5m:  z.number().nullable(),
  priceChange1h:  z.number().nullable(),
  priceChange24h: z.number().nullable(),
  direction:      z.enum(["UP", "DOWN", "FLAT"]),
  historyStatus:  z.enum(["WARMING_UP", "PARTIAL", "READY"]),
  snapshotCount:  z.number(),
  ts:             z.number(),
}).passthrough();

/** Payload-ul `preflight:trending:movers:{chain}` = ARRAY de MoverEntry (whole-array fail-closed → []). */
export const MoversArraySchema = z.array(MoverEntrySchema);

// ── QuotePrice (readQuotePrices — preflight:indexer:quoteprice:{chain}:{symbol}) ──
// Producătorul scrie { price: number POZITIV, updatedAt: number }. Un `price:0`/negativ sau updatedAt
// lipsă/string = payload garbage → fallback (nu preț „CHAINLINK" cu valoare invalidă).
export const QuotePriceSchema = z.object({
  price:     z.number().positive(),
  updatedAt: z.number(),
}).passthrough();

// ── QuotePriceHealthEntry = IndexedPair (readQuotePriceHealth — preflight:indexed:pair:{chain}:{addr}) ──
// Ancorele CORE ale IndexedPair (scrise ÎNTOTDEAUNA) sunt obligatorii → un `{}` sau blob non-IndexedPair
// pică. quotePriceSource/priceStatus = enum canonic → fără categorii garbage în distribuția de health.
export const QuotePriceHealthEntrySchema = z.object({
  chain:        z.string(),
  dexId:        z.string(),
  pairAddress:  z.string(),
  token0:       z.string(),
  token1:       z.string(),
  blockNumber:  z.number(),
  txHash:       z.string(),
  discoveredAt: z.number(),
  // câmpurile citite de readQuotePriceHealth (opționale în IndexedPair — prezente după enrichment):
  quotePriceSource:    z.enum(QUOTE_PRICE_SOURCES).optional(),
  priceStatus:         z.enum(PRICE_STATUSES).optional(),
  quotePriceAgeSec:    z.number().optional(),
  quotePriceCheckedAt: z.number().optional(),
  pricedAt:            z.number().optional(),
}).passthrough();

// ── PreflightPairContext (readPairContext) — contract COMPLET ──
const PairContextFlowSchema = z.object({
  status:   z.enum(FLOW_STATUSES),
  buyVol5m: z.number(),
  netVol5m: z.number(),
  buys5m:   z.number(),
  sells5m:  z.number(),
  hasData:  z.boolean(),
}).passthrough();
const PairContextLifecycleSchema = z.object({
  lastOutcome:   z.string(),
  lastOutcomeAt: z.number(),
  ageSec:        z.number(),
  fromState:     z.string(),
  reason:        z.string(),
}).passthrough();
export const PairContextSchema = z.object({
  schemaVersion:      z.string(),
  workerVersion:      z.string(),
  symbol:             z.string(),
  chain:              z.enum(EVM_CHAINS),      // EVM-only (worker-evm îngustează tipul)
  pairAddress:        z.string(),
  pipelineState:      z.enum(PIPELINE_STATES),
  phase:              z.enum(["NEW", "TRENDING", "PUMPING", "DUMPING", "RECOVERING", "UNKNOWN"]),  // U6/NF-E33: doar cele 5 faze valide + UNKNOWN (fallback din snapshots) — fazele legacy respinse
  liquidityStatus:    z.enum(LIQ_STATUSES),
  reserveUsd:         z.number(),
  // NF/U5 (R4): proveniența rezervei — `V4_STATE_LIQUIDITY` = estimat. Optional (absent pe pair_context vechi).
  reserveSource:      z.enum(["V2_RESERVES", "BALANCE_OF", "V4_STATE_LIQUIDITY", "UNKNOWN_V4", "GECKO_REPORTED", "DEXSCREENER_REPORTED", "UNKNOWN"]).nullable().optional(),
  flow:               PairContextFlowSchema,
  entryRisk:          z.enum(ENTRY_RISKS),
  riskFlags:          z.array(z.string()),
  opportunitySignals: z.array(z.string()),
  workerObservation:  z.string(),
  updatedAt:          z.number(),
  lifecycle:          PairContextLifecycleSchema.nullable().optional(),
}).passthrough();

// ── Leaf: lookup pair_context fără chain — VALIDEAZĂ întâi, apoi decide ambiguitatea (varu R2) ──
// Vechiul cod număra orice raw nenul ÎNAINTE de validare → un JSON corupt pe alt chain producea fals
// AMBIGUOUS_PAIR. Corect: filtrează hit-urile VALIDE, apoi 0 → not-found, 1 → acel context, >1 → ambiguous.
// PUR (doar parseWithSchema) → testabil izolat.
export interface PairContextResolution {
  context:         Record<string, unknown> | null;
  matchedChain:    string | null;
  ambiguousChains: string[];
}
export function resolveValidatedPairContext(
  hits: readonly { raw: string; chain: string }[],
): PairContextResolution {
  const valid = hits
    .map(h => ({
      chain: h.chain,
      ctx:   parseWithSchema<Record<string, unknown> | null>(h.raw, PairContextSchema, null, `pair_context:${h.chain}`),
    }))
    .filter((v): v is { chain: string; ctx: Record<string, unknown> } => v.ctx !== null);
  if (valid.length === 0) return { context: null, matchedChain: null, ambiguousChains: [] };
  if (valid.length > 1)   return { context: null, matchedChain: null, ambiguousChains: valid.map(v => v.chain) };
  return { context: valid[0].ctx, matchedChain: valid[0].chain, ambiguousChains: [] };
}
