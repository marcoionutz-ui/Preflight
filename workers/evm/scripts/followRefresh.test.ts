/**
 * scripts/followRefresh.test.ts — E19 (429/5xx nu evictă perechi vii din follow-list).
 *
 * Dovedeste `resolveFollowMiss`: pe eroare TRANZITORIE (429/5xx/timeout/network) → `skip` (missCount NU e atins,
 * NICIODATĂ evict, indiferent cât de mare e missCount deja). Doar un `not_found` REAL avansează missCount și,
 * la FOLLOW_MAX_MISSES, produce `evict`. Logica e pură (fără fetch, fără Redis).
 */
import { resolveFollowMiss, type FollowMissAction } from "../src/pipeline/followRefresh";
import { classifyPoolFetchHttpStatus } from "../src/sources/normalize";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const MAX = 3;

console.log("E19 — resolveFollowMiss (transient error nu evictă)");

// 1. ⭐ E19 — eroare tranzitorie → skip, missCount neatins (chiar cu missCount 0).
{
  const d = resolveFollowMiss({ missCount: 0 }, true, MAX);
  check("1. transient (missCount 0) → skip", d.action === "skip");
}

// 2. ⭐ E19 — eroare tranzitorie cu missCount MARE (max-1) → tot skip, NU evict.
{
  const d = resolveFollowMiss({ missCount: MAX - 1 }, true, MAX);
  check("2. transient (missCount max-1) → skip, nu evict", d.action === "skip");
}

// 3. ⭐ E19 — eroare tranzitorie cu missCount >= max → tot skip (nu evictăm pe 429).
{
  const d = resolveFollowMiss({ missCount: MAX + 5 }, true, MAX);
  check("3. transient (missCount peste prag) → tot skip", d.action === "skip");
}

// 4. not_found real, missCount 0 → increment la 1.
{
  const d = resolveFollowMiss({ missCount: 0 }, false, MAX);
  check("4a. not_found (0) → increment", d.action === "increment");
  check("4b. missCount nou = 1", d.action === "increment" && d.missCount === 1);
}

// 5. not_found real, missCount undefined → tratat ca 0 → increment la 1.
{
  const d = resolveFollowMiss({}, false, MAX);
  check("5a. not_found (undefined) → increment", d.action === "increment");
  check("5b. missCount nou = 1", d.action === "increment" && d.missCount === 1);
}

// 6. ⭐ E19 — not_found real, missCount = max-1 → atinge pragul → evict.
{
  const d = resolveFollowMiss({ missCount: MAX - 1 }, false, MAX);
  check("6. not_found (max-1) → evict", d.action === "evict");
}

// 7. not_found real, missCount sub prag (max-2) → increment (nu evict încă).
{
  const d = resolveFollowMiss({ missCount: MAX - 2 }, false, MAX);
  check("7a. not_found (max-2) → increment", d.action === "increment");
  check("7b. missCount nou = max-1", d.action === "increment" && d.missCount === MAX - 1);
}

// 8. not_found real, missCount deja peste prag → evict (idempotent la prag).
{
  const d = resolveFollowMiss({ missCount: MAX + 2 }, false, MAX);
  check("8. not_found (peste prag) → evict", d.action === "evict");
}

// ── Clasificare HTTP (fail-closed pe absență) ─────────────────────────────────────────────
console.log("\nE19 — classifyPoolFetchHttpStatus (fail-closed: doar 404/410 = not_found)");

// 2xx → ok (found/not_found se decide APOI din payload: cu pair → found, fără → not_found).
check("200 → ok (found dacă are pool, not_found dacă payload gol)", classifyPoolFetchHttpStatus(200) === "ok");
check("204 → ok", classifyPoolFetchHttpStatus(204) === "ok");

// Absență EXPLICITĂ → not_found.
check("404 → not_found", classifyPoolFetchHttpStatus(404) === "not_found");
check("410 → not_found", classifyPoolFetchHttpStatus(410) === "not_found");

// ⭐ E19 blocker — 4xx NON-404/410 → error (NU dovadă că pool-ul e mort).
check("401 → error (auth, nu pool mort)", classifyPoolFetchHttpStatus(401) === "error");
check("403 → error", classifyPoolFetchHttpStatus(403) === "error");
check("408 → error (request timeout)", classifyPoolFetchHttpStatus(408) === "error");
check("425 → error", classifyPoolFetchHttpStatus(425) === "error");
check("429 → error (rate limit)", classifyPoolFetchHttpStatus(429) === "error");

// 5xx → error.
check("500 → error", classifyPoolFetchHttpStatus(500) === "error");
check("503 → error", classifyPoolFetchHttpStatus(503) === "error");

// Network/timeout (dsGetWithStatus întoarce status 0) → error.
check("0 (network/timeout) → error", classifyPoolFetchHttpStatus(0) === "error");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
