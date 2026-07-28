/**
 * scripts/swapActivity.test.ts — E21 (recordSwapActivity: JSON.parse/BigInt neguardat).
 *
 * Dovedeste ca logica pura `nextActivityState` (+ `parseActivity`) tolereaza blob-uri Redis CORUPTE:
 * in loc sa arunce (bug-ul E21 — valoarea corupta bloca pool-ul pana la TTL), REBUILD-uieste fereastra
 * din swap-ul curent, care suprascrie corupt-ul. Plus caile normale: absent / acumulare / fereastra
 * expirata / flow-uri QUOTE_IN/OUT/UNKNOWN. Zero Redis (logica extrasa e pura).
 */
import { nextActivityState, parseActivity, type PoolActivity } from "../src/discovery/swapActivity";
import type { SwapParseResult } from "../src/discovery/swapParser";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const NOW = 1_000_000;
const WINDOW_MS = 5 * 60 * 1_000;

function makeResult(over: Partial<SwapParseResult> = {}): SwapParseResult {
  return {
    program: "cpmm", instruction: "swap", pool: "POOL1",
    inputMint: "IN", outputMint: "OUT", quoteMint: "Q", baseMint: "B",
    flow: "QUOTE_IN", inputAmount: 100n, outputAmount: 50n, knownPool: true, ...over,
  };
}
function storedBlob(over: Partial<PoolActivity> = {}): string {
  const base: PoolActivity = {
    poolAddress: "POOL1", program: "raydium_cpmm",
    sampledSwaps5m: 3, sampledQuoteIn5m: "1000", sampledQuoteOut5m: "2000",
    coverage: "SAMPLED", windowStart: NOW - 1_000, lastSwapAt: NOW - 1_000,
    lastFlow: "QUOTE_IN", lastSignature: "old",
  };
  return JSON.stringify({ ...base, ...over });
}

console.log("E21 — nextActivityState / parseActivity (swap activity, corrupt-tolerant)");

// 1. Absent (raw=null) → fereastra noua din swap-ul curent.
{
  const a = nextActivityState(null, makeResult({ flow: "QUOTE_IN", inputAmount: 100n }), NOW, "sig1");
  check("1a. absent → sampledSwaps5m 1", a.sampledSwaps5m === 1);
  check("1b. QUOTE_IN → quoteIn = 100", a.sampledQuoteIn5m === "100");
  check("1c. quoteOut = 0", a.sampledQuoteOut5m === "0");
  check("1d. windowStart = now", a.windowStart === NOW);
  check("1e. program label = raydium_cpmm", a.program === "raydium_cpmm");
  check("1f. lastSignature = sig1", a.lastSignature === "sig1");
}

// 2. Acumulare in fereastra (QUOTE_IN) — swaps++ + BigInt sum, windowStart pastrat.
{
  const raw = storedBlob({ windowStart: NOW - 1_000, sampledSwaps5m: 3, sampledQuoteIn5m: "1000" });
  const a = nextActivityState(raw, makeResult({ flow: "QUOTE_IN", inputAmount: 100n }), NOW, "sig2");
  check("2a. swaps 3 → 4", a.sampledSwaps5m === 4);
  check("2b. quoteIn 1000 + 100 = 1100", a.sampledQuoteIn5m === "1100");
  check("2c. windowStart pastrat (aceeasi fereastra)", a.windowStart === NOW - 1_000);
  check("2d. lastSignature actualizat", a.lastSignature === "sig2");
}

// 3. Acumulare QUOTE_OUT → quoteOut += outputAmount.
{
  const raw = storedBlob({ windowStart: NOW - 1_000, sampledQuoteOut5m: "2000" });
  const a = nextActivityState(raw, makeResult({ flow: "QUOTE_OUT", outputAmount: 500n }), NOW, "s");
  check("3a. quoteOut 2000 + 500 = 2500", a.sampledQuoteOut5m === "2500");
  check("3b. quoteIn neschimbat", a.sampledQuoteIn5m === "1000");
}

// 4. Acumulare UNKNOWN → swaps++ dar quote neschimbate.
{
  const raw = storedBlob({ windowStart: NOW - 1_000, sampledSwaps5m: 5 });
  const a = nextActivityState(raw, makeResult({ flow: "UNKNOWN" }), NOW, "s");
  check("4a. swaps 5 → 6", a.sampledSwaps5m === 6);
  check("4b. quoteIn neschimbat", a.sampledQuoteIn5m === "1000");
  check("4c. quoteOut neschimbat", a.sampledQuoteOut5m === "2000");
}

// 5. Fereastra expirata → reset fereastra noua (count 1).
{
  const raw = storedBlob({ windowStart: NOW - (WINDOW_MS + 1), sampledSwaps5m: 9 });
  const a = nextActivityState(raw, makeResult({ flow: "QUOTE_IN", inputAmount: 7n }), NOW, "s");
  check("5a. expirat → swaps reset la 1", a.sampledSwaps5m === 1);
  check("5b. quoteIn = 7 (doar swap-ul curent)", a.sampledQuoteIn5m === "7");
  check("5c. windowStart = now (fereastra noua)", a.windowStart === NOW);
}

// 6. ⭐ E21 — JSON corupt → rebuild, NU throw.
{
  let threw = false; let a: PoolActivity | null = null;
  try { a = nextActivityState("{not valid json", makeResult({ flow: "QUOTE_IN", inputAmount: 42n }), NOW, "sigX"); }
  catch { threw = true; }
  check("6a. JSON corupt NU arunca", threw === false);
  check("6b. → fereastra noua (swaps 1)", a?.sampledSwaps5m === 1);
  check("6c. quoteIn = 42 (rebuild din swap curent)", a?.sampledQuoteIn5m === "42");
  check("6d. windowStart = now (suprascrie corupt-ul)", a?.windowStart === NOW);
}

// 7. ⭐ E21 — contor BigInt corupt (JSON valid, dar sampledQuoteIn5m ne-numeric) → rebuild.
{
  const raw = storedBlob({ windowStart: NOW - 1_000, sampledQuoteIn5m: "abc" });
  let threw = false; let a: PoolActivity | null = null;
  try { a = nextActivityState(raw, makeResult({ flow: "QUOTE_IN", inputAmount: 5n }), NOW, "s"); }
  catch { threw = true; }
  check("7a. contor BigInt corupt NU arunca", threw === false);
  check("7b. → rebuild (swaps 1, nu acumulare peste corupt)", a?.sampledSwaps5m === 1);
  check("7c. quoteIn = 5 (fereastra noua)", a?.sampledQuoteIn5m === "5");
}

// 8. Structura invalida (windowStart lipsa) → rebuild.
{
  const raw = JSON.stringify({ sampledSwaps5m: 2, sampledQuoteIn5m: "1", sampledQuoteOut5m: "1" });
  const a = nextActivityState(raw, makeResult({ flow: "QUOTE_OUT", outputAmount: 9n }), NOW, "s");
  check("8a. windowStart lipsa → rebuild (swaps 1)", a.sampledSwaps5m === 1);
  check("8b. quoteOut = 9", a.sampledQuoteOut5m === "9");
}

// 9. last swap info actualizat mereu (chiar pe acumulare).
{
  const raw = storedBlob({ windowStart: NOW - 1_000, lastFlow: "QUOTE_IN", lastSignature: "old" });
  const a = nextActivityState(raw, makeResult({ flow: "QUOTE_OUT", outputAmount: 1n }), NOW, "sigNew");
  check("9a. lastSwapAt = now", a.lastSwapAt === NOW);
  check("9b. lastFlow = QUOTE_OUT", a.lastFlow === "QUOTE_OUT");
  check("9c. lastSignature = sigNew", a.lastSignature === "sigNew");
}

// 10. parseActivity: valid → non-null; corupt → null (variante).
{
  check("10a. valid → non-null", parseActivity(storedBlob()) !== null);
  check("10b. JSON invalid → null", parseActivity("{bad") === null);
  check("10c. non-obiect ('123') → null", parseActivity("123") === null);
  check("10d. null literal → null", parseActivity("null") === null);
  check("10e. BigInt contor invalid → null", parseActivity(storedBlob({ sampledQuoteOut5m: "1.5" })) === null);
  check("10f. windowStart ne-numeric → null", parseActivity(JSON.stringify({ ...JSON.parse(storedBlob()), windowStart: "x" })) === null);
  check("10g. contor negativ '-1' → null (varu)", parseActivity(storedBlob({ sampledQuoteIn5m: "-1" })) === null);
  check("10h. contor gol '' → null (varu)", parseActivity(storedBlob({ sampledQuoteIn5m: "" })) === null);
  check("10i. contor hex '0x10' → null (varu)", parseActivity(storedBlob({ sampledQuoteIn5m: "0x10" })) === null);
  check("10j. contor leading-zero '007' → null", parseActivity(storedBlob({ sampledQuoteOut5m: "007" })) === null);
  check("10k. sampledSwaps5m float 2.5 → null (varu)", parseActivity(storedBlob({ sampledSwaps5m: 2.5 })) === null);
  check("10l. sampledSwaps5m negativ -4 → null (varu)", parseActivity(storedBlob({ sampledSwaps5m: -4 })) === null);
}

// 11. program clmm_swapv2 → label raydium_clmm.
{
  const a = nextActivityState(null, makeResult({ program: "clmm_swapv2" }), NOW, "s");
  check("11. clmm_swapv2 → raydium_clmm", a.program === "raydium_clmm");
}

// 12. ⭐ E21 (varu) — windowStart din VIITOR → varsta negativa → rebuild, nu fereastra activa.
{
  const raw = storedBlob({ windowStart: NOW + 1, sampledSwaps5m: 99 });
  const a = nextActivityState(raw, makeResult({ flow: "QUOTE_IN", inputAmount: 8n }), NOW, "future");
  check("12a. future windowStart → rebuild (swaps 1)", a.sampledSwaps5m === 1);
  check("12b. quoteIn = 8 (swap curent, nu 99)", a.sampledQuoteIn5m === "8");
  check("12c. windowStart = now (suprascrie viitorul corupt)", a.windowStart === NOW);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
