/**
 * lib/mcp/schemas/solana.ts — E8a (scheme Zod la granițele Redis Solana).
 *
 * Politică: **validează câmpurile CONSUMATE de reader** (redis-reader.ts) strict-când-prezente;
 * `.optional()/.nullish()` fiindcă reader-ul le citește ca `Partial<>` cu default-uri; `.passthrough()`
 * pe restul (writer-ele pot adăuga câmpuri fără să rupă parse-ul). Root = OBIECT: un JSON non-obiect
 * (array/primitiv/null) → schema pică → `fallback` în `parseWithSchema` (fail-closed).
 *
 * CÂMPURI-ANCORĂ (review varu): payload-urile care, prin simpla EXISTENȚĂ (obiect truthy), setează
 * `found=true` / `dataSource` în `readSolanaPoolContext` NU trebuie să accepte `{}`. De aceea Pool,
 * PriceSnapshot și ObservedCandidate au câmpuri OBLIGATORII (ancore) — câmpuri `required` în tipul-sursă
 * `@preflight/schema`, mereu scrise de worker (pairWriter/priceTracker/observedPool), deci ancorarea NU
 * produce fallback-uri false pe date valide, dar `{}` → schema pică → `fallback` (nu mai e „truthy fals").
 * Movers: fiecare element trece prin `SolanaMoverSchema` (strict-când-prezent pe câmpurile consumate de
 * `readSolanaMovers`), nu doar „orice obiect" — un mover cu câmp consumat greșit tipat → snapshot fallback.
 *
 * Sursă tipuri: `@preflight/schema` (doar tipuri TS, fără Zod) — schemele oglindesc câmpurile folosite;
 * `test:e8` acoperă valid/`{}`/formă-greșită. `zod` NU e declarat în mcp/package.json — se rezolvă
 * tranzitiv la copia hoisted din root node_modules (4.4.3, adusă de `porto`) și e deja importat direct
 * de tool-urile mcp dinainte de E8a (ex. E37, tools/pairAddressSchema.ts). Un `zod` explicit în deps ar
 * fi hygiene bună, dar cere regen de lockfile → pas separat, nu în E8a.
 */
import { z } from "zod";

/** „orice obiect" — pt. elementele de array unde reader-ul coerçează fiecare câmp defensiv. */
const objectLike = z.object({}).passthrough();

// preflight:indexer:health:solana — reader citește updatedAt(number|string), status, slot-uri, indexerVersion.
export const SolanaHealthSchema = z.object({
  updatedAt:      z.union([z.number(), z.string()]).optional(),
  status:         z.string().optional(),
  latestSlot:     z.number().nullish(),
  cursorSlot:     z.number().nullish(),
  behindSlots:    z.number().nullish(),
  indexerVersion: z.string().nullish(),
}).passthrough();

// Element mover — câmpurile CONSUMATE de readSolanaMovers.map() (poolAddress/program/base/quote/
// priceInQuote/priceUsd/priceChange*/sampleCount/currentAgeSec/historyStatus/knownPool). Strict-când-
// prezent (un tip greșit → element pică → array pică → snapshot fallback). `.passthrough()` păstrează
// restul. `historyStatus` pe wire e mereu una din cele 4 stări (UNKNOWN e doar default-ul reader-ului).
export const SolanaMoverSchema = z.object({
  poolAddress:      z.string().optional(),
  program:          z.string().optional(),
  baseSymbol:       z.string().optional(),
  quoteSymbol:      z.string().optional(),
  priceInQuote:     z.number().optional(),
  priceUsd:         z.number().nullish(),
  priceChange5mPct: z.number().nullish(),
  priceChange1hPct: z.number().nullish(),
  sampleCount:      z.number().optional(),
  currentAgeSec:    z.number().optional(),
  historyStatus:    z.enum(["READY", "PARTIAL", "INSUFFICIENT", "STALE"]).optional(),
  knownPool:        z.boolean().optional(),
}).passthrough();

// preflight:trending:movers:solana — reader citește computedAt(number) + movers(array de SolanaMover).
export const SolanaMoversSnapshotSchema = z.object({
  computedAt:   z.number().optional(),
  totalTracked: z.number().optional(),
  movers:       z.array(SolanaMoverSchema).optional(),
}).passthrough();

// preflight:indexed:pair:solana:{addr} — reader citește program/baseSymbol/quoteSymbol/quoteType (+ downstream).
// ANCORE: poolAddress + program (required în PreflightSolanaPoolBase, mereu scrise) → `{}` nu mai e „found".
export const SolanaPoolSchema = z.object({
  poolAddress: z.string(),
  program:     z.string(),
  baseSymbol:  z.string().nullish(),
  quoteSymbol: z.string().nullish(),
  quoteType:   z.string().nullish(),
}).passthrough();

// preflight:indexed:launch:solana:{mint} — reader citește symbol + bondingCurveAddress.
export const SolanaLaunchSchema = z.object({
  symbol:              z.string().optional(),
  bondingCurveAddress: z.string().optional(),
}).passthrough();

// preflight:solana:price:{pool} — reader citește lastUpdatedAt(number) + (downstream) price/knownPool.
// ANCORE: poolAddress + priceInQuote + lastUpdatedAt (required în PreflightSolanaPriceSnapshot, mereu
// scrise de priceTracker; lastUpdatedAt e chiar câmpul folosit de reader pt. dataAgeSec) → `{}` → fallback.
export const SolanaPriceSnapshotSchema = z.object({
  poolAddress:   z.string(),
  priceInQuote:  z.number(),
  priceUsd:      z.number().nullish(),
  lastUpdatedAt: z.number(),
  knownPool:     z.boolean().optional(),
}).passthrough();

// preflight:solana:activity:{pool} — quote-urile sunt BigInt serializat ca STRING.
export const SolanaPoolActivitySchema = z.object({
  poolAddress:       z.string().optional(),
  sampledSwaps5m:    z.number().optional(),
  sampledQuoteIn5m:  z.string().optional(),
  sampledQuoteOut5m: z.string().optional(),
  windowStart:       z.number().optional(),
  lastSwapAt:        z.number().optional(),
  lastFlow:          z.string().optional(),
  lastSignature:     z.string().optional(),
}).passthrough();

// preflight:solana:price:history:{pool} — ring buffer {p, ts}. AMBELE consumate → STRICT
// (un punct fără p/ts numeric e inutil pt. price-change → mai bine îl filtrăm).
export const SolanaPricePointSchema = z.object({
  p:  z.number(),
  ts: z.number(),
}).passthrough();

// preflight:solana:observed_candidate:{pool} — reader întoarce candidatul (consumat downstream).
// ANCORE: poolAddress + sampleCount (required în PreflightObservedCandidate — TOATE câmpurile lui sunt
// required — mereu scrise de observedPool) → `{}` nu mai trece ca observed candidate „valid".
export const SolanaObservedCandidateSchema = z.object({
  poolAddress:      z.string(),
  program:          z.string().optional(),
  baseSymbol:       z.string().nullish(),
  quoteSymbol:      z.string().nullish(),
  sampleCount:      z.number(),
  lastPriceInQuote: z.number().optional(),
  lastPriceUsd:     z.number().nullish(),
  promoted:         z.boolean().optional(),
}).passthrough();
