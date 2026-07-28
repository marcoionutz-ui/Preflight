/**
 * scripts/moversTracker.test.ts — E16 (JSON.parse neguardat în loop-ul de movers).
 *
 * Dovedeste ca `computePoolMover` (logica pura per-pool, extrasa din calculateAndWriteMovers) NU arunca
 * pe input corupt: snapshot neparsabil → skip pool (`{ok:false, reason:"corrupt"}`), intrari de history
 * corupte → filtrate individual (pool-ul supravietuieste cu sample-urile valide). Astfel un singur pool
 * corupt nu mai anuleaza tot batch-ul de movers (recurent pana la 2h). Plus caile normale + write-back.
 * Zero Redis (logica extrasa e pura).
 */
import { computePoolMover, type PoolMoverOutcome } from "../src/discovery/moversTracker";
import type { PriceSnapshot } from "../src/discovery/priceTracker";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const NOW = 10_000_000;

function makeSnap(over: Partial<PriceSnapshot> = {}): PriceSnapshot {
  return {
    poolAddress: "POOL1", program: "raydium_cpmm",
    baseMint: "BASE", quoteMint: "QUOTE", baseSymbol: "BSY", quoteSymbol: "QSY",
    priceInQuote: 110, priceUsd: 1.1, usdSource: "STABLE_QUOTE",
    lastUpdatedAt: NOW - 1_000, lastSignature: "sig",
    source: "SWAP_VAULT_DELTA", coverage: "SAMPLED", knownPool: true, ...over,
  };
}
const snapRaw = (over: Partial<PriceSnapshot> = {}): string => JSON.stringify(makeSnap(over));
const pt = (p: number, ageMs: number): string => JSON.stringify({ p, ts: NOW - ageMs });

console.log("E16 — computePoolMover (movers, corrupt-tolerant per-pool)");

// 1. ⭐ E16 — snapshot corupt (JSON invalid) → skip, NU throw.
{
  let threw = false; let o: PoolMoverOutcome | null = null;
  try { o = computePoolMover("{bad json", [], false, NOW); } catch { threw = true; }
  check("1a. snapshot corupt NU arunca", threw === false);
  check("1b. → ok:false reason:corrupt", o?.ok === false && o.reason === "corrupt");
}

// 2. Snapshot absent (null) → skip (reason:absent, nu corrupt).
{
  const o = computePoolMover(null, [], false, NOW);
  check("2a. null → ok:false reason:absent", o.ok === false && o.reason === "absent");
}

// 3. Snapshot gol "" → absent.
{
  const o = computePoolMover("", [], false, NOW);
  check("3. '' → ok:false reason:absent", o.ok === false && o.reason === "absent");
}

// 4. Snapshot valid + history valid → mover corect + priceChange calculat.
{
  const o = computePoolMover(snapRaw({ priceInQuote: 110 }), [pt(100, 300_000), pt(50, 3_600_000)], false, NOW);
  check("4a. ok:true", o.ok === true);
  if (o.ok) {
    check("4b. priceChange5m = 10% ((110-100)/100)", o.mover.priceChange5mPct === 10);
    check("4c. priceChange1h = 120% ((110-50)/50)", o.mover.priceChange1hPct === 120);
    check("4d. sampleCount 2", o.mover.sampleCount === 2);
    check("4e. historyStatus READY (2 sample, oldest 60m, current 1s)", o.mover.historyStatus === "READY");
    check("4f. poolAddress din snap", o.mover.poolAddress === "POOL1");
    check("4g. computedAt = now", o.mover.computedAt === NOW);
  }
}

// 5. ⭐ E16 — snapshot valid + UNELE intrari de history corupte → filtrate individual, pool supravietuieste.
{
  let threw = false; let o: PoolMoverOutcome | null = null;
  try { o = computePoolMover(snapRaw({ priceInQuote: 110 }), [pt(100, 300_000), "{corrupt", pt(50, 3_600_000), "also bad"], false, NOW); }
  catch { threw = true; }
  check("5a. history corupt NU arunca", threw === false);
  check("5b. ok:true (pool pastrat)", o?.ok === true);
  if (o?.ok) {
    check("5c. sampleCount 2 (doar cele valide, 2 corupte sarite)", o.mover.sampleCount === 2);
    check("5d. priceChange5m tot calculat din sample valid", o.mover.priceChange5mPct === 10);
  }
}

// 6. Snapshot valid + TOATE history corupte → history goala, sampleCount 0, priceChange null.
{
  const o = computePoolMover(snapRaw(), ["{bad", "nope"], false, NOW);
  check("6a. ok:true", o.ok === true);
  if (o.ok) {
    check("6b. sampleCount 0", o.mover.sampleCount === 0);
    check("6c. priceChange5m null (fara sample)", o.mover.priceChange5mPct === null);
    check("6d. historyStatus INSUFFICIENT", o.mover.historyStatus === "INSUFFICIENT");
  }
}

// 7. Write-back: isRegistered && !knownPool → writeback re-serializat cu knownPool:true.
{
  const o = computePoolMover(snapRaw({ knownPool: false }), [], true, NOW);
  check("7a. ok:true", o.ok === true);
  if (o.ok) {
    check("7b. writeback non-null (corectare knownPool)", o.writeback !== null);
    check("7c. writeback contine knownPool:true", o.writeback !== null && JSON.parse(o.writeback).knownPool === true);
    check("7d. mover.knownPool corectat la true", o.mover.knownPool === true);
  }
}

// 8. Fara write-back cand nu-i cazul.
{
  const registeredKnown = computePoolMover(snapRaw({ knownPool: true }), [], true, NOW);
  check("8a. deja knownPool → writeback null", registeredKnown.ok === true && registeredKnown.writeback === null);
  const unregistered = computePoolMover(snapRaw({ knownPool: false }), [], false, NOW);
  check("8b. neinregistrat → writeback null (nu inventam)", unregistered.ok === true && unregistered.writeback === null);
}

// 9. priceChange null cand nu exista sample in toleranta (±2m pt 5m).
{
  const o = computePoolMover(snapRaw({ priceInQuote: 110 }), [pt(100, 1_000_000)], false, NOW); // sample la ~16m, in afara ±2m de 5m si ±15m de 1h
  check("9a. ok:true", o.ok === true);
  if (o.ok) {
    check("9b. priceChange5m null (sample prea departe)", o.mover.priceChange5mPct === null);
    check("9c. priceChange1h null (sample prea departe)", o.mover.priceChange1hPct === null);
  }
}

// 10. Sample cu p=0 → priceChange null (evita impartire la 0).
{
  const o = computePoolMover(snapRaw({ priceInQuote: 110 }), [pt(0, 300_000)], false, NOW);
  check("10. sample p=0 → priceChange5m null", o.ok === true && o.mover.priceChange5mPct === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
