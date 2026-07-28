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
 *
 * E21 (Confirmed · Intern L15): `JSON.parse(raw)` + `BigInt(contor)` erau NEGUARDATE. O singura valoare
 * Redis corupta (JSON invalid sau contor BigInt neparsabil) facea `recordSwapActivity` sa arunce ÎNAINTE
 * de `redis.set` → valoarea corupta NU se suprascria → fiecare swap urmator o recitea si arunca din nou →
 * activitatea pool-ului ramanea BLOCATA pana la expirarea TTL (10 min). Fix: parse + validare (`parseActivity`
 * → null pe corupt) si logica pura extrasa (`nextActivityState`); corupt / absent / fereastra expirata →
 * REBUILD fereastra din swap-ul curent, care SUPRASCRIE blob-ul corupt la scrierea urmatoare.
 */

import { getRedis }          from "../infra/redis";
import { KEY_POOL_ACTIVITY } from "../config/constants";
import { SwapParseResult }   from "./swapParser";
import type { PreflightSolanaPoolActivity, PreflightSolanaProgram } from "@preflight/schema";

// ── Tipuri ────────────────────────────────────────────────────────────────────

export type PoolActivity = PreflightSolanaPoolActivity;

// ── Constante ─────────────────────────────────────────────────────────────────

const WINDOW_MS = 5 * 60 * 1_000;   // fereastra 5 minute
const TTL_SEC   = 10 * 60;           // TTL 10 minute (refresh la fiecare write)

// ── Helpers ───────────────────────────────────────────────────────────────────

function programLabel(prog: SwapParseResult["program"]): PreflightSolanaProgram {
  return prog === "cpmm" ? "raydium_cpmm" : "raydium_clmm";
}

/** Extrage quote amount relevant din result (QUOTE_IN → inputAmount, QUOTE_OUT → outputAmount). */
function quoteAmount(result: SwapParseResult): bigint {
  if (result.flow === "QUOTE_IN")  return result.inputAmount  ?? 0n;
  if (result.flow === "QUOTE_OUT") return result.outputAmount ?? 0n;
  return 0n; // UNKNOWN — nu acumulam (stable-stable sau ambiguous)
}

/**
 * E21: un contor canonic NON-NEGATIV stocat ca string (forma produsa de `.toString()` pe un bigint >= 0).
 * `BigInt()` singur ar accepta ""/"  "/"-1"/"0x10" ca valide → prea permisiv pentru un contor; cerem
 * exact `0` sau o secventa de cifre zecimale fara zero-uri de inceput (fix varu).
 */
function isUintString(v: unknown): v is string {
  return typeof v === "string" && /^(0|[1-9]\d*)$/.test(v);
}

/**
 * E21: parseaza + VALIDEAZA un blob de activity din Redis. Intoarce `null` daca e corupt — JSON invalid,
 * structura gresita, contorii ne-canonici (non-uint / negativ / float), sau `windowStart` ne-numeric. Apelantul trateaza `null` ca „reconstruieste
 * fereastra", deci o valoare corupta NU mai blocheaza pool-ul pana la TTL. Campurile validate sunt EXACT
 * cele citite in ramura de acumulare (`windowStart` pt. decizia de fereastra; `sampledSwaps5m` +
 * `sampledQuoteIn5m`/`sampledQuoteOut5m` pt. `BigInt`) → daca `parseActivity` intoarce non-null, ramura
 * de acumulare NU poate arunca.
 */
export function parseActivity(raw: string): PoolActivity | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (typeof obj !== "object" || obj === null) return null;
  const a = obj as Record<string, unknown>;
  if (typeof a.windowStart !== "number" || !Number.isFinite(a.windowStart)) return null;
  if (typeof a.sampledSwaps5m !== "number" || !Number.isSafeInteger(a.sampledSwaps5m) || a.sampledSwaps5m < 0) return null;
  if (!isUintString(a.sampledQuoteIn5m) || !isUintString(a.sampledQuoteOut5m)) return null;
  return obj as PoolActivity;
}

/**
 * E21: decide starea de activity de scris — PUR (fara Redis) → testabil izolat.
 * `raw` = blob-ul Redis existent, sau `null` daca lipseste. Corupt (parseActivity → null) / absent /
 * fereastra expirata → fereastra NOUA (rebuild din swap-ul curent). Altfel → acumuleaza in fereastra
 * curenta. Info-ul „last swap" (lastSwapAt/lastFlow/lastSignature) se actualizeaza mereu.
 */
export function nextActivityState(
  raw:       string | null,
  result:    SwapParseResult,
  now:       number,
  signature: string,
): PoolActivity {
  const qAmt     = quoteAmount(result);
  const existing = raw !== null ? parseActivity(raw) : null;
  // E21 (fix varu): varsta ferestrei EXPLICITA. Un `windowStart` din viitor (blob corupt) da varsta
  // NEGATIVA; o tratam ca fereastra INVALIDA (rebuild), nu ca activa — altfel `now - windowStart <=
  // WINDOW_MS` ar fi trecut cu o diferenta negativa. Acumulam DOAR intr-o fereastra cu varsta in [0, WINDOW_MS].
  const windowAgeMs = existing !== null ? now - existing.windowStart : null;

  let activity: PoolActivity;

  if (existing !== null && windowAgeMs !== null && windowAgeMs >= 0 && windowAgeMs <= WINDOW_MS) {
    // Aceeasi fereastra — acumuleaza. Contorii BigInt sunt validati in parseActivity → fara throw.
    activity = existing;
    activity.sampledSwaps5m++;
    if (result.flow === "QUOTE_IN") {
      activity.sampledQuoteIn5m  = (BigInt(activity.sampledQuoteIn5m)  + qAmt).toString();
    } else if (result.flow === "QUOTE_OUT") {
      activity.sampledQuoteOut5m = (BigInt(activity.sampledQuoteOut5m) + qAmt).toString();
    }
    // UNKNOWN flow: sampledSwaps5m creste, quoteIn/Out raman neschimbate.
  } else {
    // Absent / CORUPT (E21) / fereastra expirata → fereastra noua. Un blob corupt e astfel SUPRASCRIS la
    // scrierea urmatoare (mai jos, in recordSwapActivity), nu blocheaza pool-ul pana la TTL.
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

  // Update last swap info (mereu, independent de fereastra).
  activity.lastSwapAt    = now;
  activity.lastFlow      = result.flow;
  activity.lastSignature = signature;
  return activity;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scrie / actualizeaza activity state pentru un pool dupa un swap parsed.
 * Apelat doar cand result.knownPool === true (guard in caller). Decizia pura e in `nextActivityState`;
 * aici doar I/O Redis (GET blob curent → scrie noua stare cu TTL refresh).
 */
export async function recordSwapActivity(
  result:    SwapParseResult,
  signature: string,
): Promise<void> {
  // Guard strict — caller ar trebui sa verifice, dar double-check pentru siguranta
  if (!result.knownPool) return;

  const key      = KEY_POOL_ACTIVITY(result.pool);
  const now      = Date.now();
  const redis    = getRedis();
  const raw      = await redis.get(key);
  const activity = nextActivityState(raw, result, now, signature);

  // ioredis: sintaxa pozitionala pentru EX (nu obiect { EX: n })
  await redis.set(key, JSON.stringify(activity), "EX", TTL_SEC);
}
