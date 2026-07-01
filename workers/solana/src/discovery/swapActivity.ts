/**
 * discovery/swapActivity.ts
 * 8.0h-b3: Pool activity state — Redis per pool, knownPool=true only.
 *
 * Guard strict: zero Redis writes pentru knownPool=false.
 * Window: 5-minute rolling (reset pe boundary, nu strict sliding).
 * Amounts: BigInt stocate ca string (JSON.stringify nu suporta BigInt nativ).
 * Coverage: "SAMPLED" — datele reflecta sample TX, nu toate swap-urile.
 *
 * Redis key: preflight:solana:activity:{pool}   (TTL 10min, refresh per write)
 */

import { getRedis }          from "../infra/redis";
import { KEY_POOL_ACTIVITY } from "../config/constants";
import { SwapParseResult }   from "./swapParser";

// ── Tipuri ────────────────────────────────────────────────────────────────────

export interface PoolActivity {
  poolAddress:       string;
  program:           "raydium_cpmm" | "raydium_clmm";
  sampledSwaps5m:    number;
  sampledQuoteIn5m:  string;   // BigInt ca string — quote intrat din TX-uri samplate
  sampledQuoteOut5m: string;   // BigInt ca string — quote iesit din TX-uri samplate
  coverage:          "SAMPLED"; // nu e total real — reflecta 2 sample TX/instruction/60s
  windowStart:       number;   // ms timestamp — start fereastra curenta
  lastSwapAt:        number;   // ms timestamp — ultimul swap observat
  lastFlow:          "QUOTE_IN" | "QUOTE_OUT" | "UNKNOWN";
  lastSignature:     string;
}

// ── Constante ─────────────────────────────────────────────────────────────────

const WINDOW_MS = 5 * 60 * 1_000;   // fereastra 5 minute
const TTL_SEC   = 10 * 60;           // TTL 10 minute (refresh la fiecare write)

// ── Helpers ───────────────────────────────────────────────────────────────────

function programLabel(prog: SwapParseResult["program"]): "raydium_cpmm" | "raydium_clmm" {
  return prog === "cpmm" ? "raydium_cpmm" : "raydium_clmm";
}

/** Extrage quote amount relevant din result (QUOTE_IN → inputAmount, QUOTE_OUT → outputAmount). */
function quoteAmount(result: SwapParseResult): bigint {
  if (result.flow === "QUOTE_IN")  return result.inputAmount  ?? 0n;
  if (result.flow === "QUOTE_OUT") return result.outputAmount ?? 0n;
  return 0n; // UNKNOWN — nu acumulam (stable-stable sau ambiguous)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scrie / actualizeaza activity state pentru un pool dupa un swap parsed.
 * Apelat doar cand result.knownPool === true (guard in caller).
 *
 * Logic fereastra:
 *   - Daca windowStart e mai vechi de 5 minute: reset contori, noua fereastra.
 *   - Altfel: incrementeaza in fereastra curenta.
 * TTL refreshed la fiecare write (10 minute) — pooluri inactive expira automat.
 */
export async function recordSwapActivity(
  result:    SwapParseResult,
  signature: string,
): Promise<void> {
  // Guard strict — caller ar trebui sa verifice, dar double-check pentru siguranta
  if (!result.knownPool) return;

  const key   = KEY_POOL_ACTIVITY(result.pool);
  const now   = Date.now();
  const redis = getRedis();
  const qAmt  = quoteAmount(result);

  let activity: PoolActivity;

  const raw = await redis.get(key);

  if (raw) {
    activity = JSON.parse(raw) as PoolActivity;

    if (now - activity.windowStart > WINDOW_MS) {
      // Fereastra expirata — reset si porneste noua fereastra
      activity.sampledSwaps5m    = 1;
      activity.sampledQuoteIn5m  = result.flow === "QUOTE_IN"  ? qAmt.toString() : "0";
      activity.sampledQuoteOut5m = result.flow === "QUOTE_OUT" ? qAmt.toString() : "0";
      activity.windowStart       = now;
    } else {
      // Aceeasi fereastra — acumuleaza
      activity.sampledSwaps5m++;
      if (result.flow === "QUOTE_IN") {
        activity.sampledQuoteIn5m  = (BigInt(activity.sampledQuoteIn5m) + qAmt).toString();
      } else if (result.flow === "QUOTE_OUT") {
        activity.sampledQuoteOut5m = (BigInt(activity.sampledQuoteOut5m) + qAmt).toString();
      }
      // UNKNOWN flow: sampledSwaps5m creste dar quoteIn/Out raman neschimbate
    }
  } else {
    // Entry nou — prima data cand vedem acest pool activ
    activity = {
      poolAddress:       result.pool,
      program:           programLabel(result.program),
      sampledSwaps5m:    1,
      sampledQuoteIn5m:  result.flow === "QUOTE_IN"  ? qAmt.toString() : "0",
      sampledQuoteOut5m: result.flow === "QUOTE_OUT" ? qAmt.toString() : "0",
      coverage:          "SAMPLED",
      windowStart:       now,
      lastSwapAt:        now,
      lastFlow:          result.flow,
      lastSignature:     signature,
    };
  }

  // Update last swap info (mereu, independent de fereastra)
  activity.lastSwapAt    = now;
  activity.lastFlow      = result.flow;
  activity.lastSignature = signature;

  // ioredis: sintaxa pozitionala pentru EX (nu obiect { EX: n })
  await redis.set(key, JSON.stringify(activity), "EX", TTL_SEC);
}
