/**
 * scripts/indexedFreshness.test.ts — C3 (staleness la reader-ul indexer)
 *
 * Verifică `isIndexedPriceServable`: servim doar priceStatus OK ȘI preț proaspăt (pricedAt recent).
 * Prețul înghețat la discovery (vechi / fără pricedAt) NU e servit → fallback Gecko.
 *
 * Rulează: npm run test:c3   (tsx scripts/indexedFreshness.test.ts)
 */
import { isIndexedPriceServable } from "../src/sources/indexed";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else       { failed++; console.log("  ❌ " + name); }
}

function run() {
  console.log("C3 — isIndexedPriceServable\n");
  const now = 1_000_000;
  const MAX = 120_000;

  check("1. OK + proaspăt (10s) → servabil",
    isIndexedPriceServable({ priceStatus: "OK", pricedAt: now - 10_000 }, now, MAX) === true);
  check("2. OK + vechi (200s) → NEservabil",
    isIndexedPriceServable({ priceStatus: "OK", pricedAt: now - 200_000 }, now, MAX) === false);
  check("3. OK + fără pricedAt (legacy) → NEservabil",
    isIndexedPriceServable({ priceStatus: "OK" }, now, MAX) === false);
  check("4. non-OK (DEGRADED) + proaspăt → NEservabil",
    isIndexedPriceServable({ priceStatus: "DEGRADED", pricedAt: now }, now, MAX) === false);
  check("5. priceStatus lipsă → NEservabil",
    isIndexedPriceServable({ pricedAt: now }, now, MAX) === false);
  check("6. prag exact: age == MAX → servabil (<=)",
    isIndexedPriceServable({ priceStatus: "OK", pricedAt: now - MAX }, now, MAX) === true);
  check("7. age == MAX+1 → NEservabil",
    isIndexedPriceServable({ priceStatus: "OK", pricedAt: now - MAX - 1 }, now, MAX) === false);
  check("8. pricedAt în viitor → NEservabil (age<0)",
    isIndexedPriceServable({ priceStatus: "OK", pricedAt: now + 1_000 }, now, MAX) === false);
  check("9. pricedAt NaN → NEservabil",
    isIndexedPriceServable({ priceStatus: "OK", pricedAt: NaN }, now, MAX) === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
