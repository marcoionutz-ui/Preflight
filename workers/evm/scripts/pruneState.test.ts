/**
 * scripts/pruneState.test.ts — E20 (leak RSS: watchedPoolCache + tokenPools nemărginite).
 *
 * Dovedeste ca `prunePairFromAuxState` (apelat din pruneMemory pentru fiecare pair stale) curăță AMBELE
 * store-uri auxiliare care înainte creșteau nemărginit: `watchedPoolCache` (per pair) + `tokenPools`
 * (Set<pair> per token, cu ștergerea cheii când set-ul rămâne gol). Maps injectate → zero module-state.
 */
import { PairMap } from "../src/state/PairMap";
import { prunePairFromAuxState, tokenPoolKey } from "../src/infra/poolTracker";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const CHAIN = "base";
const TOKEN = "0xtoken00000000000000000000000000000000de";
const P1 = "0xpair1111111111111111111111111111111111";
const P2 = "0xpair2222222222222222222222222222222222";
const KEY = tokenPoolKey(CHAIN, TOKEN);

function makeTokenPools(pairs: string[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  m.set(KEY, new Set(pairs.map(p => p.toLowerCase())));
  return m;
}

console.log("E20 — prunePairFromAuxState (watchedPoolCache + tokenPools bounded)");

// 1. watchedPoolCache: pair-ul pruned e șters; celălalt rămâne.
{
  const wc = new PairMap<number>();
  wc.set(CHAIN, P1, 1); wc.set(CHAIN, P2, 2);
  const tp = makeTokenPools([P1, P2]);
  prunePairFromAuxState(CHAIN, TOKEN, P1, wc, tp);
  check("1a. watchedCache: P1 șters", wc.has(CHAIN, P1) === false);
  check("1b. watchedCache: P2 intact", wc.has(CHAIN, P2) === true);
}

// 2. tokenPools: token cu 2 pool-uri → prune 1 → set are 1, cheia rămâne.
{
  const wc = new PairMap<number>();
  const tp = makeTokenPools([P1, P2]);
  prunePairFromAuxState(CHAIN, TOKEN, P1, wc, tp);
  check("2a. tokenPools: set-ul are 1 pool", tp.get(KEY)?.size === 1);
  check("2b. tokenPools: P1 scos", tp.get(KEY)?.has(P1.toLowerCase()) === false);
  check("2c. tokenPools: P2 rămâne", tp.get(KEY)?.has(P2.toLowerCase()) === true);
  check("2d. tokenPools: cheia token-ului rămâne", tp.has(KEY) === true);
}

// 3. ⭐ E20 — prune ULTIMUL pool → set gol → cheia token-ului ȘTEARSĂ (nu persistă orfan).
{
  const wc = new PairMap<number>();
  const tp = makeTokenPools([P1]);
  prunePairFromAuxState(CHAIN, TOKEN, P1, wc, tp);
  check("3a. set gol → cheia token-ului ștearsă", tp.has(KEY) === false);
  check("3b. tokenPools complet gol", tp.size === 0);
}

// 4. prune un pair care NU e în set → no-op (set neschimbat, cheia rămâne).
{
  const wc = new PairMap<number>();
  const tp = makeTokenPools([P1]);
  prunePairFromAuxState(CHAIN, TOKEN, P2, wc, tp);
  check("4a. set neschimbat (P1 tot acolo)", tp.get(KEY)?.has(P1.toLowerCase()) === true);
  check("4b. cheia rămâne (set nu-i gol)", tp.has(KEY) === true);
}

// 5. prune dintr-un token FĂRĂ set (cheie absentă) → no-op, fără throw.
{
  const wc = new PairMap<number>();
  const tp = new Map<string, Set<string>>(); // gol
  let threw = false;
  try { prunePairFromAuxState(CHAIN, TOKEN, P1, wc, tp); } catch { threw = true; }
  check("5a. token fără set → nu aruncă", threw === false);
  check("5b. tokenPools rămâne gol", tp.size === 0);
}

// 6. case-insensitive: set stochează lowercase, prune cu UPPERCASE → tot îl scoate.
{
  const wc = new PairMap<number>();
  const tp = makeTokenPools([P1]);
  prunePairFromAuxState(CHAIN, TOKEN, P1.toUpperCase(), wc, tp);
  check("6. prune cu adresă uppercase → scos (lowercase match)", tp.has(KEY) === false);
}

// 7. watchedCache curățat chiar dacă tokenPools n-are entry (independent).
{
  const wc = new PairMap<number>();
  wc.set(CHAIN, P1, 1);
  const tp = new Map<string, Set<string>>();
  prunePairFromAuxState(CHAIN, TOKEN, P1, wc, tp);
  check("7. watchedCache curățat independent de tokenPools", wc.has(CHAIN, P1) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
