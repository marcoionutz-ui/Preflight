/**
 * lib/mcp/freshness.test.ts — E11 + E12 + E13 (freshness honesty).
 *
 * E13 safeAgeSec/safeAgeMs: skew MIC (≤5s) → 0; timestamp SERIOS în viitor → null (necunoscut → LOW/OFFLINE),
 *   NU 0 (care primea VIP pass la HIGH/online/READY); ts invalid → null.
 * E11 quotePriceCurrentAgeSec: checkedAt absolut (îmbătrânește) preferat; LEGACY fără checkedAt → frozen + timpul
 *   scurs de la pricedAt (tot îmbătrânește, nu rămâne la age-at-write).
 * E12 pricePoolsWindowStart + PROBĂ Redis reală (ZCOUNT/ZREMRANGEBYSCORE boundary la cutoff).
 */
import {
  safeAgeSec, safeAgeMs, quotePriceCurrentAgeSec,
  pricePoolsWindowStart, PRICE_POOLS_WINDOW_MS,
} from "./freshness";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const NOW = 1_000_000_000_000;

async function main(): Promise<void> {
console.log("E13 — safeAgeSec (viitor serios → null, NU 0/HIGH; skew mic → 0)");
check("1. acum-30s → 30", safeAgeSec(NOW, NOW - 30_000) === 30);
check("2. ⭐ viitor +30s → null (necunoscut, NU 0 → NU HIGH)", safeAgeSec(NOW, NOW + 30_000) === null);
check("3. ⭐ skew mic +3s (≤5s tol) → 0 (proaspăt)", safeAgeSec(NOW, NOW + 3_000) === 0);
check("4. exact la prag +5s → 0 (tol inclusiv)", safeAgeSec(NOW, NOW + 5_000) === 0);
check("5. +5001ms → null (peste tol)", safeAgeSec(NOW, NOW + 5_001) === null);
check("6. exact now → 0", safeAgeSec(NOW, NOW) === 0);
check("7. null → null", safeAgeSec(NOW, null) === null);
check("8. undefined → null", safeAgeSec(NOW, undefined) === null);
check("9. NaN → null", safeAgeSec(NOW, Number.NaN) === null);
check("10. Infinity → null", safeAgeSec(NOW, Number.POSITIVE_INFINITY) === null);
check("11. rotunjire (1499ms → 1s)", safeAgeSec(NOW, NOW - 1_499) === 1);
check("12. tolerance custom 0 → orice viitor → null", safeAgeSec(NOW, NOW + 1, 0) === null);

console.log("\nE13 — safeAgeMs (aceeași semantică, ms)");
check("13. acum-5000ms → 5000", safeAgeMs(NOW, NOW - 5_000) === 5_000);
check("14. ⭐ viitor +30s → null (nu 0)", safeAgeMs(NOW, NOW + 30_000) === null);
check("15. skew mic +2s → 0", safeAgeMs(NOW, NOW + 2_000) === 0);
check("16. null → null", safeAgeMs(NOW, null) === null);

console.log("\nE11 — quotePriceCurrentAgeSec (checkedAt absolut; LEGACY frozen+pricedAt îmbătrânește)");
check("17. ⭐ checkedAt acum-600s → 600 (curent)", quotePriceCurrentAgeSec({ quotePriceCheckedAt: NOW - 600_000, quotePriceAgeSec: 5 }, NOW) === 600);
check("18. ⭐ același checkedAt, 1h mai târziu → 4200 (îmbătrânește)", quotePriceCurrentAgeSec({ quotePriceCheckedAt: NOW - 600_000 }, NOW + 3_600_000) === 4200);
// ⭐ LEGACY (fără checkedAt): frozen 5s + pricedAt acum 1h → ~3605s, NU 5s (bugul E11 nu supraviețuiește).
check("19. ⭐ LEGACY frozen=5 + pricedAt acum-1h → ~3605 (nu 5)", quotePriceCurrentAgeSec({ quotePriceAgeSec: 5, pricedAt: NOW - 3_600_000 }, NOW) === 3605);
check("20. LEGACY frozen fără pricedAt → frozen (best-effort)", quotePriceCurrentAgeSec({ quotePriceAgeSec: 42 }, NOW) === 42);
// ⭐ checkedAt PREZENT dar serios în viitor → null, NU fallback legacy (nu mai reintră „0s proaspăt" pe ușa din spate).
check("21. ⭐ checkedAt serios în viitor → null (NU fallback legacy)", quotePriceCurrentAgeSec({ quotePriceCheckedAt: NOW + 60_000, quotePriceAgeSec: 7, pricedAt: NOW - 10_000 }, NOW) === null);
check("22. ⭐ checkedAt PREZENT dar corupt (NaN) → null (NU fallback)", quotePriceCurrentAgeSec({ quotePriceCheckedAt: Number.NaN, quotePriceAgeSec: 7, pricedAt: NOW - 10_000 }, NOW) === null);
check("23. checkedAt skew mic (+3s) → 0 (nu fallback)", quotePriceCurrentAgeSec({ quotePriceCheckedAt: NOW + 3_000, quotePriceAgeSec: 99 }, NOW) === 0);
check("24. nimic utilizabil → null", quotePriceCurrentAgeSec({}, NOW) === null);
check("25. LEGACY frozen negativ → 0 (clamp) + pricedAt acum-100s → 100", quotePriceCurrentAgeSec({ quotePriceAgeSec: -3, pricedAt: NOW - 100_000 }, NOW) === 100);
check("26. LEGACY frozen ne-numeric → null", quotePriceCurrentAgeSec({ quotePriceAgeSec: "x" as unknown as number }, NOW) === null);
check("27. ⭐ LEGACY pricedAt corupt (NaN) → null (nu frozen orb)", quotePriceCurrentAgeSec({ quotePriceAgeSec: 5, pricedAt: Number.NaN }, NOW) === null);

console.log("\nE12 — pricePoolsWindowStart (now - 2h)");
check("28. window start = now - 2h", pricePoolsWindowStart(NOW) === NOW - 2 * 60 * 60 * 1000);
check("29. const = 2h în ms", PRICE_POOLS_WINDOW_MS === 7_200_000);

// ── Partea B: PROBĂ Redis reală pt. E12 (ZCOUNT/ZREMRANGEBYSCORE boundary) ────────────────
console.log("\nE12 — boundary ZCOUNT/prune (Redis real; skip curat dacă indisponibil)");
let redis: import("ioredis").default | null = null;
try {
  const { default: Redis } = await import("ioredis");
  // REDIS_URL (CI: serviciul redis:7) → REDIS_PUBLIC_URL (rularea locală a lui Marco) → localhost.
  const url = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL || "redis://127.0.0.1:6379";
  redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 3_000,
    // FĂRĂ reconnect infinit: când Redis e jos, connect() respinge o dată și procesul IESE CURAT după
    // „29 passed" — altfel clientul orfan reîncerca la nesfârșit („[ioredis] Unhandled error event") și
    // ținea event loop-ul viu → `npm test` atârna și trebuia ^C.
    retryStrategy: () => null,
  });
  redis.on("error", () => { /* înghite event-ul `error`: fără listener ioredis logează + poate arunca */ });
  await redis.connect();
  await redis.ping();
} catch {
  console.log("  ⚠️  Redis indisponibil — SKIP partea B.");
  try { redis?.disconnect(); } catch { /* noop */ } // eliberează handle-ul → proces curat
  redis = null;
}

if (redis) {
  const KEY = "test:e12:price:pools";
  const now = NOW;
  const cutoff = pricePoolsWindowStart(now); // now - 2h
  await redis.del(KEY);
  // pool-old = sub cutoff (inactiv); pool-edge = EXACT cutoff; pool-new = peste cutoff (activ).
  await redis.zadd(KEY, String(cutoff - 1), "pool-old", String(cutoff), "pool-edge", String(cutoff + 1), "pool-new");

  // Reader: ZCOUNT windowStart +inf → include edge (>=cutoff) + new = 2 (NU pool-old).
  const zc = await redis.zcount(KEY, cutoff, "+inf");
  check("B1. ZCOUNT cutoff +inf → 2 (edge + new, NU old)", Number(zc) === 2);

  // Worker: ZREMRANGEBYSCORE -inf (cutoff → șterge DOAR < cutoff (exclusiv) = pool-old.
  const removed = await redis.zremrangebyscore(KEY, "-inf", "(" + cutoff);
  check("B2. prune -inf (cutoff → șterge exact 1 (pool-old)", Number(removed) === 1);

  const remaining = await redis.zrange(KEY, 0, -1);
  check("B3. după prune → rămân edge + new (2)", remaining.length === 2 && remaining.includes("pool-edge") && remaining.includes("pool-new"));
  check("B4. pool-old chiar șters", !remaining.includes("pool-old"));
  check("B5. edge (== cutoff) NU e șters de prune (boundary consistent cu ZCOUNT)", remaining.includes("pool-edge"));

  await redis.del(KEY);
  redis.disconnect();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
