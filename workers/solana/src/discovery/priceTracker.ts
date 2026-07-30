/**
 * discovery/priceTracker.ts
 * 8.0h-b4: Price snapshots — preț aproximativ per pool din vault deltas.
 * 8.0h-b5: Ring buffer history + ZSET index per pool (fara KEYS scan in movers job).
 * 8.0j:    WSOL-quoted pools get priceUsd via cached SOL/USD oracle (Jupiter Price API v2).
 * A3:      decimale AUTORITATIVE (mint account), fără fallback la 9 — vezi mai jos.
 *
 * Formula: priceInQuote = quoteAmount_normalized / baseAmount_normalized
 *   QUOTE_IN:  quoteAmt = inputAmount,  baseAmt = outputAmount
 *   QUOTE_OUT: quoteAmt = outputAmount, baseAmt = inputAmount
 *
 * Redis keys (b5):
 *   preflight:solana:price:{pool}           — current snapshot (TTL 10m)
 *   preflight:solana:price:history:{pool}   — ring buffer 60 intrări, DOWNSAMPLED >=60s (TTL 2h) — E17
 *   preflight:solana:price:pools            — ZSET index (score = lastUpdatedAt ms)
 *
 * E17: history-ul e downsampled la scriere — un punct nou doar dacă cel mai recent are >=60s (vezi
 * priceHistory.ts). Fără asta, un pool hot umplea toate 60 sloturile în câteva minute → priceChange1hPct
 * structural imposibil. Snapshot-ul live rămâne pe fiecare swap; doar bufferul e rărit.
 */

import { getRedis }             from "../infra/redis";
import {
  KEY_PRICE_SNAPSHOT,
  KEY_PRICE_HISTORY,
  KEY_PRICE_POOLS,
}                               from "../config/constants";
import { resolveTokenMeta }     from "../infra/tokenMetadata";
import { resolveMintDecimals }  from "../infra/mintDecimals";
import { SwapParseResult }      from "./swapParser";
import { USDC_MINT, USDT_MINT, WSOL_MINT } from "../config/programs";
import { maybeCalculateMovers }         from "./moversTracker";
import { APPEND_HISTORY_LUA } from "./priceHistory";
import { readSolPrice }                 from "../infra/solPriceOracle";
import { maybeRecordObservedCandidate } from "./observedPool";
import type {
  PreflightSolanaPriceSnapshot, PreflightSolanaPricePoint, PreflightSolanaProgram,
} from "@preflight/schema";

// ── Tipuri ────────────────────────────────────────────────────────────────────

export type PriceSnapshot = PreflightSolanaPriceSnapshot;

// ── Constante ─────────────────────────────────────────────────────────────────

const TTL_SEC = 10 * 60;

// E17 — ring buffer history downsampled: 60 sloturi, spacing minim 60s → 60 puncte ≈ 1h (READY reachable).
const HISTORY_TTL_SEC         = 2 * 60 * 60; // 2h
const HISTORY_MAX_INDEX       = 59;          // ltrim 0..59 → 60 intrări
const HISTORY_MIN_INTERVAL_MS = 60_000;      // scrie un punct nou doar dacă cel mai recent are >=60s

// E12 — fereastra de activitate pt. ZSET-ul `price:pools`. Fără prune, ZADD-ul (necondiționat, la fiecare swap)
// lasă membri vechi pe veci → `trackedPricePools` (zcard→zcount în reader) crește monoton. Trebuie să coincidă
// cu `PRICE_POOLS_WINDOW_MS` din reader (mcp/lib/mcp/freshness.ts).
const PRICE_POOLS_WINDOW_MS   = 2 * 60 * 60 * 1000; // 2h

// ── Helpers ───────────────────────────────────────────────────────────────────

function programLabel(prog: SwapParseResult["program"]): PreflightSolanaProgram {
  return prog === "cpmm" ? "raydium_cpmm" : "raydium_clmm";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Calculeaza si salveaza un price snapshot pentru un pool dupa un swap parsed.
 * Apelat pentru orice pool cu flow !== "UNKNOWN" (b4b: nu mai e gated pe knownPool).
 *
 * Nu arunca erori — toate path-urile de esec returneaza silentios.
 */
export async function recordPriceSnapshot(
  result:    SwapParseResult,
  signature: string,
): Promise<void> {
  // knownPool nu mai e required — price e util și pentru pooluri nedescoperite încă
  if (result.flow === "UNKNOWN") return;

  // Extrage quote si base amounts in functie de directia fluxului
  let quoteAmt: bigint;
  let baseAmt:  bigint;

  if (result.flow === "QUOTE_IN") {
    quoteAmt = result.inputAmount  ?? 0n;
    baseAmt  = result.outputAmount ?? 0n;
  } else {
    // QUOTE_OUT
    baseAmt  = result.inputAmount  ?? 0n;
    quoteAmt = result.outputAmount ?? 0n;
  }

  if (baseAmt === 0n || quoteAmt === 0n) return;

  // A3: metadata (symbol/name) și decimalele autoritative, rezolvate în paralel.
  // resolveTokenMeta e DOAR pentru symbol/name — Jupiter poate avea decimals greșite,
  // deci nu-l folosim la math. resolveMintDecimals (mint account on-chain, imutabil)
  // e singura sursă pentru normalizarea sumelor. NU mai asumăm 9 — pump.fun folosește
  // 6, iar un fallback la 9 producea preț 1000× umflat + movers fabricați.
  const [quoteMeta, baseMeta, quoteDecimals, baseDecimals] = await Promise.all([
    resolveTokenMeta(result.quoteMint),
    resolveTokenMeta(result.baseMint),
    resolveMintDecimals(result.quoteMint),
    resolveMintDecimals(result.baseMint),
  ]);

  // Fără decimale sigure nu putem calcula un preț corect — SĂRIM (mai bine lipsă decât 1000× greșit).
  if (quoteDecimals === null || baseDecimals === null) {
    console.warn(
      "[SOLANA][PRICE] skip — decimale nerezolvate"
      + " pool=" + result.pool.slice(0, 8)
      + " base=" + result.baseMint.slice(0, 8) + "(" + baseDecimals + ")"
      + " quote=" + result.quoteMint.slice(0, 8) + "(" + quoteDecimals + ")",
    );
    return;
  }

  // Normalizare la unitati reale — Number() suficient pentru aproximare b4
  const quoteNorm = Number(quoteAmt) / Math.pow(10, quoteDecimals);
  const baseNorm  = Number(baseAmt)  / Math.pow(10, baseDecimals);

  if (baseNorm === 0 || !isFinite(quoteNorm) || !isFinite(baseNorm)) return;

  const priceInQuote = quoteNorm / baseNorm;
  if (!isFinite(priceInQuote) || priceInQuote <= 0) return;

  // 8.0j: priceUsd — USD/STABLE direct, WSOL via oracle
  const isUsdQuote  = result.quoteMint === USDC_MINT || result.quoteMint === USDT_MINT;
  const isWsolQuote = result.quoteMint === WSOL_MINT;
  let priceUsd:    number | null = null;
  let usdSource:   PriceSnapshot["usdSource"] = null;
  let solUsdPrice: number | undefined;

  if (isUsdQuote) {
    priceUsd  = priceInQuote;
    usdSource = "STABLE_QUOTE";
  } else if (isWsolQuote) {
    const solUsd = await readSolPrice();
    if (solUsd !== null) {
      solUsdPrice = solUsd;
      priceUsd    = priceInQuote * solUsd;
      usdSource   = "SOL_USD_ORACLE";
    }
  }

  const progLabel = result.program === "cpmm" ? "CPMM" : "CLMM";

  const snapshot: PriceSnapshot = {
    poolAddress:   result.pool,
    program:       programLabel(result.program),
    baseMint:      result.baseMint,
    quoteMint:     result.quoteMint,
    baseSymbol:    baseMeta.symbol  ?? result.baseMint.slice(0, 8),
    quoteSymbol:   quoteMeta.symbol ?? result.quoteMint.slice(0, 8),
    priceInQuote,
    priceUsd,
    usdSource,
    solUsdPrice,
    lastUpdatedAt: Date.now(),
    lastSignature: signature,
    source:        "SWAP_VAULT_DELTA",
    coverage:      "SAMPLED",
    knownPool:     result.knownPool,
  };

  const redis = getRedis();

  // b4: current snapshot
  await redis.set(
    KEY_PRICE_SNAPSHOT(result.pool),
    JSON.stringify(snapshot),
    "EX",
    TTL_SEC,
  );

  // b5 + E17: ring buffer history (60 intrări, DOWNSAMPLED) + ZSET index — gate + scriere ATOMICE în Lua.
  // Gate-ul (citește newest → decide) și LPUSH trebuie în ACEEAȘI unitate atomică: altfel două swap-uri
  // concurente citesc același newest vechi, ambele trec gate-ul și scriu → un pool hot ar re-comprima
  // history-ul sub burst. Lua rulează totul atomic în Redis (single-threaded): primul swap face append,
  // următoarele văd deja ts-ul nou și sar. ZADD (index de activitate) e necondiționat. Fără fix, un pool hot
  // umplea toate 60 sloturile în câteva minute → priceChange1hPct structural imposibil.
  const historyPoint: PreflightSolanaPricePoint = { p: priceInQuote, ts: snapshot.lastUpdatedAt };
  const appended = await redis.eval(
    APPEND_HISTORY_LUA,
    2,
    KEY_PRICE_HISTORY(result.pool),
    KEY_PRICE_POOLS,
    String(snapshot.lastUpdatedAt),
    String(HISTORY_MIN_INTERVAL_MS),
    JSON.stringify(historyPoint),
    String(HISTORY_MAX_INDEX),
    String(HISTORY_TTL_SEC),
    result.pool,
  );

  // E12: prune pool-urile inactive (>2h) din ZSET-ul de index — altfel `trackedPricePools` crește monoton.
  // Gated pe `appended` (Lua întoarce 1 doar la ≥60s/pool) → ZREMRANGEBYSCORE rulează cel mult o dată/60s/pool,
  // nu la fiecare swap. `(` = scor exclusiv: păstrează exact pool-urile actualizate în ultimele 2h.
  if (appended === 1) {
    await redis.zremrangebyscore(
      KEY_PRICE_POOLS, "-inf", "(" + (snapshot.lastUpdatedAt - PRICE_POOLS_WINDOW_MS),
    );
  }

  console.log(
    "[SOLANA][SWAP][" + progLabel + "][PRICE]"
    + " pool=" + result.pool.slice(0, 8) + "..."
    + " base=" + snapshot.baseSymbol
    + " price=" + priceInQuote.toExponential(4)
    + " " + snapshot.quoteSymbol
    + (priceUsd !== null ? " priceUsd=" + priceUsd.toExponential(4) + " (" + usdSource + ")" : "")
    + " sig=" + signature.slice(0, 12) + "...",
  );

  // b5: trigger movers calculation (throttled la 60s in moversTracker)
  maybeCalculateMovers().catch((err: Error) => {
    console.warn("[SOLANA][MOVERS] trigger error:", err.message);
  });

  // 8.0k-b: observed pool candidate — tracking pentru pooluri neindexate
  if (!result.knownPool) {
    maybeRecordObservedCandidate(snapshot, signature).catch((err: Error) => {
      console.warn("[SOLANA][OBSERVED] candidate error:", err.message);
    });
  }
}
