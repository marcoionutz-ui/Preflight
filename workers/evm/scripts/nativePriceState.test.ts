/**
 * scripts/nativePriceState.test.ts — E25 (leaf pur `resolveNativePrice`).
 *
 * `now` este INJECTAT → determinist, fără Date.now(). Acoperă: fresh, boundary exact (==TTL inclusiv),
 * stale, never-fetched (null), valori invalide (≤0 / NaN / Infinity), timestamp VIITOR (updatedAt>now,
 * ceas sărit înapoi), now/updatedAt ne-finit, maxAgeMs negativ/NaN.
 */
import { resolveNativePrice, isOracleFresh } from "../src/infra/nativePriceState";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const NOW = 1_000_000_000;
const TTL = 15 * 60_000; // 900_000

function main(): void {
  console.log("E25 leaf — resolveNativePrice(value, updatedAt, now, maxAgeMs)");

  // fresh
  check("1. fresh (age 0) → value", resolveNativePrice(2500, NOW, NOW, TTL) === 2500);
  check("2. fresh (age < TTL) → value", resolveNativePrice(600, NOW - 60_000, NOW, TTL) === 600);
  // boundary
  check("3. age == TTL (exact) → value (inclusiv)", resolveNativePrice(2500, NOW - TTL, NOW, TTL) === 2500);
  check("4. age == TTL+1 → null (stale)", resolveNativePrice(2500, NOW - TTL - 1, NOW, TTL) === null);
  // stale
  check("5. age >> TTL → null", resolveNativePrice(2500, NOW - 10 * TTL, NOW, TTL) === null);
  // never-fetched
  check("6. value null → null", resolveNativePrice(null, NOW, NOW, TTL) === null);
  check("7. updatedAt null → null", resolveNativePrice(2500, null, NOW, TTL) === null);
  check("8. ambele null → null", resolveNativePrice(null, null, NOW, TTL) === null);
  // value invalid
  check("9. value 0 → null", resolveNativePrice(0, NOW, NOW, TTL) === null);
  check("10. value negativ → null", resolveNativePrice(-5, NOW, NOW, TTL) === null);
  check("11. value NaN → null", resolveNativePrice(NaN, NOW, NOW, TTL) === null);
  check("12. value Infinity → null", resolveNativePrice(Infinity, NOW, NOW, TTL) === null);
  // timestamp viitor / corupt (varu R3)
  check("13. updatedAt > now (viitor) → null", resolveNativePrice(2500, NOW + 1000, NOW, TTL) === null);
  check("14. now NaN → null", resolveNativePrice(2500, NOW, NaN, TTL) === null);
  check("15. updatedAt NaN → null", resolveNativePrice(2500, NaN, NOW, TTL) === null);
  // maxAgeMs invalid
  check("16. maxAgeMs negativ → null", resolveNativePrice(2500, NOW, NOW, -1) === null);
  check("17. maxAgeMs NaN → null", resolveNativePrice(2500, NOW, NOW, NaN) === null);
  check("18. maxAgeMs 0 + age 0 → value (fresh chiar la 0)", resolveNativePrice(2500, NOW, NOW, 0) === 2500);

  console.log("\nE25 leaf — isOracleFresh(sourceUpdatedAtMs, now, maxSourceAgeMs, futureSkewMs)");
  const MAX = 60 * 60_000;     // prag per-feed 1h
  const SKEW = 2 * 60_000;     // 2 min
  const fresh = (src: number) => isOracleFresh(src, NOW, MAX, SKEW);

  check("19. source recent (age 5min) → fresh", fresh(NOW - 5 * 60_000) === true);
  check("20. source age == maxSourceAge (exact) → fresh", fresh(NOW - MAX) === true);
  check("21. source age == maxSourceAge+1 → stale", fresh(NOW - MAX - 1) === false);
  check("22. source mult prea vechi (10h) → stale", fresh(NOW - 10 * 60 * 60_000) === false);
  check("23. updatedAt 0 (round gol) → false", fresh(0) === false);
  check("24. updatedAt negativ → false", fresh(-1) === false);
  check("25. viitor în limita skew (now+1min) → fresh", fresh(NOW + 60_000) === true);
  check("26. viitor peste skew (now+3min) → false", fresh(NOW + 3 * 60_000) === false);
  check("27. sourceUpdatedAt NaN → false", isOracleFresh(NaN, NOW, MAX, SKEW) === false);
  check("28. now NaN → false", isOracleFresh(NOW, NaN, MAX, SKEW) === false);
  check("29. maxSourceAge negativ → false", isOracleFresh(NOW, NOW, -1, SKEW) === false);
  check("30. skew negativ → false", isOracleFresh(NOW, NOW, MAX, -1) === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
