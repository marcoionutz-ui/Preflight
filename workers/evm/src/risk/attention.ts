/**
 * risk/attention.ts
 * attentionScore + monitoringTier + patternTags
 * 
 * Nu decide dacă e trade bun. Decide cât de important e evenimentul de piață.
 * Workerul raportează. Agentul decide.
 */

export type MonitoringTier =
  | "EVENT_WATCH"        // major market event: liq mare + move extrem
  | "FRESH_WATCH"        // mișcare activă recentă, prima apariție
  | "CONTINUATION_WATCH" // mișcare susținută, repeated sightings
  | "SHORT_WATCH"        // mișcare violentă low-liq, TTL scurt
  | "MARKET_ONLY";       // facts only, fără WS

export function computeAttentionScore(
  m5: number,
  h1: number,
  h24: number,
  reserveUsd: number,
  seenCount: number,
): number {
  const absM5  = Math.abs(m5);
  const absH1  = Math.abs(h1);
  const absH24 = Math.abs(h24);

  // Move magnitude — m5 și h1 contează mai mult decât h24 vechi
  const moveScore =
    Math.min(absM5  * 2.0,   30) +   // m5:+8  → 16, m5:+15 → 30
    Math.min(absH1  * 0.45,  30) +   // h1:+40 → 18, h1:+67 → 30
    Math.min(absH24 * 0.015, 15);    // h24 contribuie dar e capuit

  // Liquidity — amplificator de relevanță
  const liqScore =
    reserveUsd >= 500_000 ? 20 :
    reserveUsd >= 100_000 ? 15 :
    reserveUsd >= 50_000  ? 12 :
    reserveUsd >= 25_000  ?  8 :
    reserveUsd >= 10_000  ?  4 : 0;

  // Continuation — m5 și h1 ambele pozitive = mișcare susținută
  const continuationBonus = m5 > 0 && h1 > 0 ? 10 : 0;

  // Repeated sightings — apare în mai multe scanuri
  const repeatedBonus = Math.min(seenCount * 1.0, 8);

  // Major event bonus — SpaceX-style: liq mare + move absurd
  const majorEventBonus =
    reserveUsd >= 250_000 && (absH1 >= 500 || absH24 >= 1000) ? 15 : 0;

  // Noise penalty — mișcare violentă + liq mică = probabil manipulation
  const lowLiqNoisePenalty =
    reserveUsd < 20_000 && (absM5 > 100 || absH1 > 300) ? 20 : 0;

  // Flat m5 penalty — h1 enorm dar m5 mort + liq medie = already over
  const flatM5Penalty =
    absM5 < 2 && absH1 > 500 && reserveUsd < 100_000 ? 10 : 0;

  return Math.max(0, Math.round(Math.min(
    moveScore + liqScore + continuationBonus + repeatedBonus +
    majorEventBonus - lowLiqNoisePenalty - flatM5Penalty,
    100,
  )));
}

/**
 * Returnează monitoring tier-ul pentru un pair.
 * 
 * EVENT_WATCH / SHORT_WATCH: active în scan.ts pentru hard rejects cu attention mare.
 * FRESH_WATCH / CONTINUATION_WATCH: calculate și expuse în pair_states, dar watch
 * selection pentru ele rămâne momentan pe logica existentă (vertical/late/normal).
 * Migrarea completă a watch selection vine în pasul următor.
 */
export function getMonitoringTier(
  score: number,
  m5: number,
  h1: number,
  h24: number,
  reserveUsd: number,
  seenCount: number,
): MonitoringTier {
  const absH1  = Math.abs(h1);
  const absH24 = Math.abs(h24);
  const absM5  = Math.abs(m5);

  // EVENT_WATCH: major market event — liq mare + move extrem
  if (score >= 75 && reserveUsd >= 250_000 && (absH1 >= 500 || absH24 >= 1000)) {
    return "EVENT_WATCH";
  }

  // CONTINUATION_WATCH: mișcare susținută, repeated sightings
  if (score >= 60 && m5 > 0 && h1 > 0 && reserveUsd >= 25_000 && seenCount >= 3) {
    return "CONTINUATION_WATCH";
  }

  // FRESH_WATCH: mișcare activă, prima sau a doua apariție
  if (score >= 60 && m5 > 0 && h1 > 0 && reserveUsd >= 25_000) {
    return "FRESH_WATCH";
  }

  // SHORT_WATCH: mișcare violentă low-liq
  if (score >= 55 && reserveUsd >= 10_000 && absM5 >= 100) {
    return "SHORT_WATCH";
  }

  return "MARKET_ONLY";
}

export function getPatternTags(
  m5: number,
  h1: number,
  h24: number,
  reserveUsd: number,
): string[] {
  const tags: string[] = [];
  const absM5  = Math.abs(m5);
  const absH1  = Math.abs(h1);
  const absH24 = Math.abs(h24);

  if (absH1 >= 1000 || absH24 >= 1000)  tags.push("EXTREME_EXPANSION");
  if (absH1 >= 500  && absH1 < 1000)    tags.push("MAJOR_H1_MOVE");
  if (absM5 >= 100)                      tags.push("VIOLENT_M5");
  if (absM5 >= 30   && absM5 < 100)     tags.push("STRONG_M5");
  if (absM5 >= 5    && absM5 < 30)      tags.push("ACTIVE_M5");
  if (m5 > 0 && h1 > 0)                 tags.push("CONTINUED_EXPANSION");
  if (m5 < 0 && h1 > 100)               tags.push("DISTRIBUTION_SIGNAL");
  if (m5 < 0 && h1 > 0)                 tags.push("PULLBACK");
  if (reserveUsd >= 500_000)             tags.push("HIGH_LIQUIDITY_MOVER");
  if (reserveUsd >= 100_000 && reserveUsd < 500_000) tags.push("MED_LIQUIDITY_MOVER");
  if (reserveUsd < 20_000)               tags.push("LOW_LIQUIDITY");
  if (reserveUsd < 20_000 && absM5 > 100) tags.push("NOISE_RISK");
  if (absM5 < 2 && absH1 > 500)         tags.push("FLAT_M5_LATE");

  return tags;
}