/**
 * scripts/priceHistory.test.ts — E17 (ring buffer 60 taia history sub 1h pe pool-urile hot).
 *
 * Partea A (PURĂ, mereu rulează): `shouldAppendPricePoint` (downsample >=60s) + `parsePricePointTs` (safe) +
 *   o SIMULARE de 1h de swap-uri dese care demonstrează că, cu downsampling, bufferul (60) acoperă ~1h →
 *   anchor-ul de 1h e găsibil și oldest ajunge >=55m.
 * Partea B (Redis REAL, skip curat dacă nu-i): `APPEND_HISTORY_LUA` — gate + LPUSH ATOMIC. Regresie de
 *   CONCURENȚĂ (blocker varu): 100 apeluri simultane, același pool + același ts → EXACT 1 punct (fără Lua,
 *   read-modify-write neatomic lăsa toate cele 100 să scrie). Rulează pe `INDEXER_TEST_REDIS_URL` ||
 *   127.0.0.1:6379; dacă nu se conectează → skip + exit 0 (npm test rămâne verde fără Redis local; CI are redis:7).
 */
import Redis from "ioredis";
import { shouldAppendPricePoint, parsePricePointTs, APPEND_HISTORY_LUA } from "../src/discovery/priceHistory";
import { KEY_PRICE_HISTORY } from "../src/config/constants";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const MIN = 60_000;
const NOW = 1_000_000_000_000;

async function main(): Promise<void> {
  console.log("E17 — shouldAppendPricePoint (downsample >=60s)");

  // 1. buffer gol → append (primul punct).
  check("1. newestTs null → append", shouldAppendPricePoint(null, NOW, MIN) === true);

  // 2. ⭐ E17 — cel mai recent are exact 60s → append (>=).
  check("2. age == 60s (prag) → append", shouldAppendPricePoint(NOW - 60_000, NOW, MIN) === true);

  // 3. ⭐ E17 — cel mai recent are 59s → skip (prea devreme, ar comprima history-ul).
  check("3. age == 59s → skip", shouldAppendPricePoint(NOW - 59_000, NOW, MIN) === false);

  // 4. cel mai recent e foarte proaspăt (1s) → skip (pool hot).
  check("4. age == 1s → skip", shouldAppendPricePoint(NOW - 1_000, NOW, MIN) === false);

  // 5. cel mai recent e vechi (5min) → append.
  check("5. age == 5min → append", shouldAppendPricePoint(NOW - 300_000, NOW, MIN) === true);

  // 6. ts din VIITOR (skew / corupt) → append (nu ne blocăm pe o valoare în care nu avem încredere).
  check("6. newestTs în viitor (age<0) → append", shouldAppendPricePoint(NOW + 30_000, NOW, MIN) === true);

  console.log("\nE17 — parsePricePointTs (safe)");

  // 7. raw valid → ts extras.
  check("7. {p,ts} valid → ts", parsePricePointTs(JSON.stringify({ p: 1.5, ts: NOW })) === NOW);

  // 8. null → null.
  check("8. null → null", parsePricePointTs(null) === null);

  // 9. JSON invalid → null.
  check("9. '{bad json' → null", parsePricePointTs("{bad json") === null);

  // 10. lipsă ts → null.
  check("10. {p} fără ts → null", parsePricePointTs(JSON.stringify({ p: 1.5 })) === null);

  // 11. ts ne-numeric (string) → null.
  check("11. ts string → null", parsePricePointTs(JSON.stringify({ p: 1, ts: "123" })) === null);

  // 12. non-obiect ('123') → null.
  check("12. '123' (non-obiect) → null", parsePricePointTs("123") === null);

  // 13. ts = 0 e valid (epoch) → 0, NU null.
  check("13. ts == 0 → 0 (valid, nu null)", parsePricePointTs(JSON.stringify({ p: 1, ts: 0 })) === 0);

  console.log("\nE17 — simulare 1h (pool hot, 1 swap/s) → buffer acoperă ~1h");

  // Simulare secvențială: pool hot, 1 swap/secundă timp de 1h. Aplicăm EXACT logica de write (append gated
  // pe shouldAppendPricePoint, apoi ltrim la 60). index 0 = cel mai recent (LPUSH).
  {
    const CAP = 60;
    let buf: number[] = [];
    const start = NOW;
    for (let s = 0; s <= 3600; s++) {
      const now = start + s * 1000;
      const newest = buf.length > 0 ? buf[0] : null;
      if (shouldAppendPricePoint(newest, now, MIN)) {
        buf.unshift(now);
        if (buf.length > CAP) buf = buf.slice(0, CAP);
      }
    }
    const end     = start + 3600 * 1000;
    const oldest  = buf[buf.length - 1];
    const spanMin = (end - oldest) / 60_000;

    check("sim-a. buffer plin (60 sloturi)", buf.length === 60);
    check("sim-b. span oldest >= 55min (historyStatus READY reachable)", spanMin >= 55);

    const target1h = end - 3600_000;
    let closest = buf[0];
    for (const ts of buf) if (Math.abs(ts - target1h) < Math.abs(closest - target1h)) closest = ts;
    check("sim-c. sample lângă now-1h (±15m) → priceChange1hPct calculabil", Math.abs(closest - target1h) <= 15 * 60_000);

    let minGap = Infinity;
    for (let i = 0; i < buf.length - 1; i++) minGap = Math.min(minGap, buf[i] - buf[i + 1]);
    check("sim-d. spacing minim între puncte >= 60s", minGap >= 60_000);

    const naiveOldest = start + (3600 - 59) * 1000;
    check("sim-e. (contrast) fără fix: span ar fi fost < 2min", (end - naiveOldest) / 60_000 < 2);
  }

  // ── Partea B: Redis real — atomicitate sub concurență (skip dacă nu-i) ─────────────────────────
  const url = process.env.INDEXER_TEST_REDIS_URL || "redis://127.0.0.1:6379";
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  r.on("error", () => { /* mut — gestionăm la connect */ });

  try {
    await r.connect();
  } catch {
    console.log("\n⚠️  Redis indisponibil (" + url + ") — SKIP partea B (Lua). Partea A a rulat.");
    console.log("\n" + passed + " passed, " + failed + " failed (A only)");
    await r.quit().catch(() => {});
    process.exit(failed === 0 ? 0 : 1);
    return;
  }

  console.log("\nE17 — APPEND_HISTORY_LUA (gate + LPUSH atomic, Redis real)");

  const POOL = "teste17pool";
  const HKEY = KEY_PRICE_HISTORY(POOL);
  const PKEY = "preflight:test:e17:pools";   // ZSET de test — NU atingem indexul real de producție
  const arg = (ts: number, p: number) => JSON.stringify({ p, ts });
  const evalAppend = (ts: number, p: number) =>
    r.eval(APPEND_HISTORY_LUA, 2, HKEY, PKEY, String(ts), String(MIN), arg(ts, p), "59", String(2 * 60 * 60), POOL);

  await r.del(HKEY, PKEY);

  // ⭐ B1 (blocker varu) — 100 apeluri SIMULTANE, același pool + același ts → EXACT 1 punct.
  const now = NOW;
  await Promise.all(Array.from({ length: 100 }, () => evalAppend(now, 1.23)));
  const len1 = await r.llen(HKEY);
  check("B1. 100 apeluri concurente, același ts → exact 1 punct (atomic)", len1 === 1);
  const score = await r.zscore(PKEY, POOL);
  check("B2. ZADD aplicat necondiționat (pool în index)", score === String(now));

  // B3 — un ts nou la >=60s → append (2 puncte).
  const now2 = now + 60_000;
  await evalAppend(now2, 2);
  check("B3. ts la +60s → append (2 puncte)", (await r.llen(HKEY)) === 2);

  // B4 — un ts la +30s (sub prag) → skip (rămâne 2), chiar și 50 concurente.
  const now3 = now2 + 30_000;
  await Promise.all(Array.from({ length: 50 }, () => evalAppend(now3, 3)));
  check("B4. 50 concurente la +30s (sub 60s) → skip (rămâne 2)", (await r.llen(HKEY)) === 2);

  // B5 — ltrim ține bufferul la 60 chiar dacă vin 200 de puncte spațiate corect.
  await r.del(HKEY, PKEY);
  for (let i = 0; i < 200; i++) await evalAppend(now + i * 60_000, i);
  check("B5. 200 append-uri spațiate → ltrim la 60", (await r.llen(HKEY)) === 60);

  // B6 — newest corupt în buffer → append (fail-open, ca parsePricePointTs).
  await r.del(HKEY, PKEY);
  await r.lpush(HKEY, "{corrupt json");
  await evalAppend(now, 9);
  check("B6. newest corupt → append (fail-open)", (await r.llen(HKEY)) === 2);

  await r.del(HKEY, PKEY);
  await r.quit().catch(() => {});

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
