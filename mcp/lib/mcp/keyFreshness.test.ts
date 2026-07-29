/**
 * lib/mcp/keyFreshness.test.ts — E14 (tp_health_check minte „stale" în steady state).
 *
 * Dovedeste ca `keyFreshness` raporteaza prospetimea CHEII (proxy = keyAgeMs, ex. snapshotAge) drept `quality`,
 * iar varsta celei mai noi intrari e raportata SEPARAT ca `newestEntryAgeSec` — nu mai confunda „nicio adaugare
 * noua" cu „cheie stale". Plus contrastul cu logica veche + praguri `freshnessLabel` + `safeMinAge`.
 */
import { keyFreshness, freshnessLabel, safeMinAge, aggregateKnownFreshness, completeOnKnownChains } from "./health-freshness";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

console.log("E14 — keyFreshness (prospețimea cheii ≠ vârsta celei mai noi intrări)");

// 1. ⭐ E14 — steady state: worker VIU (snapshotAge 10s) dar cea mai nouă intrare veche (600s).
{
  const k = keyFreshness(true, 10_000, 600_000);
  check("1a. quality = fresh (worker viu, NU «stale»)", k.quality === "fresh");
  check("1b. ageSec = 10 (prospețimea cheii, nu 600)", k.ageSec === 10);
  check("1c. newestEntryAgeSec = 600 (raportat SEPARAT)", k.newestEntryAgeSec === 600);
  // contrast: logica veche folosea freshnessLabel(newestEntryAge) → „stale" pe worker perfect viu
  check("1d. (contrast) logica veche ar fi zis stale", freshnessLabel(600_000) === "stale");
}

// 2. worker aging (60s) → quality aging.
{
  const k = keyFreshness(true, 60_000, 600_000);
  check("2. quality = aging (snapshotAge 60s)", k.quality === "aging");
}

// 3. worker chiar stale (200s) → quality stale (cheia chiar nu-i menținută).
{
  const k = keyFreshness(true, 200_000, 5_000);
  check("3. quality = stale (snapshotAge 200s, cheie chiar nementinută)", k.quality === "stale");
}

// 4. snapshotAge null (worker snapshot absent) → quality unknown, ageSec null.
{
  const k = keyFreshness(true, null, 600_000);
  check("4a. keyAgeMs null → quality unknown", k.quality === "unknown");
  check("4b. ageSec null", k.ageSec === null);
  check("4c. newestEntryAgeSec tot raportat (600)", k.newestEntryAgeSec === 600);
}

// 5. pair_states style: FĂRĂ newestEntry → fără câmp newestEntryAgeSec.
{
  const k = keyFreshness(true, 5_000);
  check("5a. quality = fresh", k.quality === "fresh");
  check("5b. newestEntryAgeSec absent (undefined)", k.newestEntryAgeSec === undefined);
  check("5c. cheia lipsește din obiect", !("newestEntryAgeSec" in k));
}

// 6. set gol (newestEntry null) → newestEntryAgeSec null DAR prezent.
{
  const k = keyFreshness(true, 5_000, null);
  check("6a. newestEntryAgeSec = null (set gol)", k.newestEntryAgeSec === null);
  check("6b. câmpul e prezent (null, nu undefined)", "newestEntryAgeSec" in k);
}

// 7. exists propagat.
check("7. exists=false propagat", keyFreshness(false, null).exists === false);

// 8. ⭐ varu R2 — cheie ABSENTĂ dar keyAgeMs pasat (snapshotAge) → quality unknown, NU „fresh".
{
  const k = keyFreshness(false, 10_000, null);
  check("8a. absent → quality unknown (nu «fresh»)", k.quality === "unknown");
  check("8b. absent → ageSec null (nu 10)", k.ageSec === null);
  check("8c. absent → newestEntryAgeSec null", k.newestEntryAgeSec === null);
}

// 9. ⭐ varu R2 — keyAgeMs din VIITOR (negativ) + exists → invalidat → unknown (nu «fresh»).
{
  const k = keyFreshness(true, -5_000);
  check("9a. age negativ (viitor) → quality unknown", k.quality === "unknown");
  check("9b. age negativ → ageSec null", k.ageSec === null);
}

// 10. newestEntryAgeMs negativ/non-finit → newestEntryAgeSec null.
{
  const k = keyFreshness(true, 5_000, -1);
  check("10a. newestEntry negativ → null", k.newestEntryAgeSec === null);
  const k2 = keyFreshness(true, 5_000, Number.NaN);
  check("10b. newestEntry NaN → null", k2.newestEntryAgeSec === null);
}

console.log("\nE14 — freshnessLabel (praguri + guard viitor/non-finit)");
check("11a. <45s → fresh", freshnessLabel(44_000) === "fresh");
check("11b. 45s (prag) → aging", freshnessLabel(45_000) === "aging");
check("11c. <90s → aging", freshnessLabel(89_000) === "aging");
check("11d. 90s (prag) → stale", freshnessLabel(90_000) === "stale");
check("11e. null → unknown", freshnessLabel(null) === "unknown");
check("11f. ⭐ negativ (-1) → unknown (nu «fresh»)", freshnessLabel(-1) === "unknown");
check("11g. ⭐ NaN → unknown", freshnessLabel(Number.NaN) === "unknown");
check("11h. Infinity → unknown", freshnessLabel(Number.POSITIVE_INFINITY) === "unknown");

console.log("\nE14 — safeMinAge (vârsta celei mai NOI intrări)");
{
  const now = Date.now();
  check("9a. gol → null", safeMinAge([]) === null);
  const a = safeMinAge([now - 1_000, now - 5_000, now - 60_000]);
  check("9b. ia cea mai nouă (≈1000ms)", a !== null && Math.abs(a - 1_000) < 200);
}

console.log("\nE14 — aggregateKnownFreshness (weakest KNOWN chain, varu R4)");

const NOW = 1_000_000_000_000;

// A. ⭐ chain mort NU dispare: Base 5s + BSC 8m, ambele CUNOSCUTE → worst 8m, complete.
{
  const agg = aggregateKnownFreshness(NOW, { base: NOW - 5_000, bsc: NOW - 8 * 60_000 }, ["base", "bsc"]);
  check("A1. worst = cel mai vechi cunoscut (8m, nu 5s)", agg.worstAgeMs === 8 * 60_000);
  check("A2. complete (ambele au snapshot)", agg.complete === true);
  check("A3. worst > 60s → nu-i fresh", agg.worstAgeMs !== null && agg.worstAgeMs >= 60_000);
}

// B. ⭐ chain CUNOSCUT fără snapshot → complete=false + missing (NU ignorat → «unknown»).
{
  const agg = aggregateKnownFreshness(NOW, { base: NOW - 5_000 }, ["base", "bsc"]);
  check("B1. complete=false (bsc cunoscut fără snapshot)", agg.complete === false);
  check("B2. missing = [bsc]", agg.missing.length === 1 && agg.missing[0] === "bsc");
}

// C. toate cunoscute + proaspete → complete, worst mic.
{
  const agg = aggregateKnownFreshness(NOW, { base: NOW - 5_000, arbitrum: NOW - 10_000 }, ["base", "arbitrum"]);
  check("C1. complete", agg.complete === true);
  check("C2. worst = 10s", agg.worstAgeMs === 10_000);
}

// D. knownChains gol → complete=false, worst null.
{
  const agg = aggregateKnownFreshness(NOW, { base: NOW - 5_000 }, []);
  check("D1. gol → complete=false", agg.complete === false);
  check("D2. gol → worst null", agg.worstAgeMs === null);
}

// E. savedAt din VIITOR (skew) pe un chain cunoscut → tratat ca lipsă (complete=false).
{
  const agg = aggregateKnownFreshness(NOW, { base: NOW + 30_000 }, ["base"]);
  check("E1. viitor → missing (complete=false)", agg.complete === false && agg.missing[0] === "base");
  check("E2. viitor → worst null", agg.worstAgeMs === null);
}

console.log("\nE14 — keyFreshness completitudine multichain (varu R4: cheie lipsă pe un chain cunoscut)");

// F. ⭐ complete=false (cheie active_watch lipsă pe BSC cunoscut) → quality unknown, chiar cu age valid + exists.
{
  const k = keyFreshness(true, 10_000, 30_000, false);
  check("F1. complete=false → quality unknown (nu «fresh»)", k.quality === "unknown");
  check("F2. exists rămâne true (există pe alt chain)", k.exists === true);
  check("F3. câmpul complete=false expus", k.complete === false);
  check("F4. ageSec tot raportat (10)", k.ageSec === 10);
}
// G. complete=true → quality normală + câmp complete=true.
{
  const k = keyFreshness(true, 10_000, 30_000, true);
  check("G1. complete=true → quality fresh", k.quality === "fresh");
  check("G2. câmpul complete=true expus", k.complete === true);
}
// H. complete undefined (retro-compat) → fără câmp complete, quality normală.
{
  const k = keyFreshness(true, 10_000);
  check("H1. complete absent din obiect", !("complete" in k));
  check("H2. quality fresh (neafectat)", k.quality === "fresh");
}

console.log("\nE14 — completeOnKnownChains (prezența cheii pe TOATE chain-urile cunoscute)");
check("I1. toate prezente → true", completeOnKnownChains({ base: true, bsc: true }, ["base", "bsc"]) === true);
check("I2. ⭐ una lipsă (bsc) → false", completeOnKnownChains({ base: true, bsc: false }, ["base", "bsc"]) === false);
check("I3. ⭐ chain cunoscut absent din map → false", completeOnKnownChains({ base: true }, ["base", "bsc"]) === false);
check("I4. knownChains gol → false", completeOnKnownChains({ base: true }, []) === false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
