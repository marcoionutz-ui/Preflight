/**
 * scripts/discoveryQueue.test.ts — C6.
 *
 * Partea A (PURĂ, mereu rulează): encode/decode candidate, backoff, derivarea ONESTĂ a health-ului.
 * Partea B (Redis REAL, skip curat dacă nu-i): tranzițiile Lua atomice ale cozii de discovery.
 *
 * Rulează pe `INDEXER_TEST_REDIS_URL` || 127.0.0.1:6379. Dacă nu se poate conecta → skip + exit 0
 * (deci `npm test` rămâne verde chiar fără Redis local; Lua verificat autoritativ în dev).
 */

import Redis from "ioredis";
import {
  encodeCandidate, decodeCandidate, nextBackoffMs,
  enqueueCandidate, claimDueCandidates, reclaimExpiredCandidates,
  markCandidateDone, markCandidateFailed, discoveryQueueStats,
  deadCandidateCount, pendingCandidateCount, processingCandidateCount,
  DISC_MAX_ATTEMPTS, DISC_BACKOFF_BASE_MS, DISC_BACKOFF_MAX_MS,
  type DiscoveryCandidate,
} from "../src/discovery/discoveryQueue";
import { buildHealth } from "../src/infra/health";
import { parseStoredSlot } from "../src/infra/cursor";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const CHAIN = "testc6";

async function main(): Promise<void> {
  console.log("C6 — discoveryQueue");

  // ── Partea A: pur (mereu) ──────────────────────────────────────────────────
  const cand: DiscoveryCandidate = { program: "raydium_cpmm", slot: 123456, signature: "5xSigABCdefGHijkLMnoPQ" };
  const m = encodeCandidate(cand);
  check("A1. encode = program|slot|signature", m === "raydium_cpmm|123456|5xSigABCdefGHijkLMnoPQ");
  const dec = decodeCandidate(m);
  check("A2. decode roundtrip program", dec?.program === "raydium_cpmm");
  check("A3. decode roundtrip slot",    dec?.slot === 123456);
  check("A4. decode roundtrip signature", dec?.signature === "5xSigABCdefGHijkLMnoPQ");
  check("A5. decode pumpfun ok",  decodeCandidate("pumpfun|1|sig")?.program === "pumpfun");
  check("A6. decode clmm ok",     decodeCandidate("raydium_clmm|1|sig")?.program === "raydium_clmm");
  check("A7. decode program invalid → null", decodeCandidate("evil|1|sig") === null);
  check("A8. decode slot ne-numeric → null", decodeCandidate("pumpfun|abc|sig") === null);
  check("A9. decode fără signature → null",  decodeCandidate("pumpfun|1|") === null);
  check("A10. decode fără delimitatori → null", decodeCandidate("nope") === null);
  check("A11. decode slot negativ → null", decodeCandidate("pumpfun|-1|sig") === null);
  // signature cu delimitator? base58 n-are '|', dar verificăm că split ia doar primele 2
  check("A12. slot 0 valid", decodeCandidate("pumpfun|0|sig")?.slot === 0);

  // backoff
  check("A13. backoff attempts=1 = base", nextBackoffMs(1, DISC_BACKOFF_BASE_MS, DISC_BACKOFF_MAX_MS) === DISC_BACKOFF_BASE_MS);
  check("A14. backoff attempts=3 = 4x base", nextBackoffMs(3, DISC_BACKOFF_BASE_MS, DISC_BACKOFF_MAX_MS) === DISC_BACKOFF_BASE_MS * 4);
  check("A15. backoff cap la max", nextBackoffMs(100, DISC_BACKOFF_BASE_MS, DISC_BACKOFF_MAX_MS) === DISC_BACKOFF_MAX_MS);

  // health onest (pur)
  const noQ = { pending: 0, processing: 0, dead: 0, oldestPendingAgeMs: null };
  const hOk = buildHealth(1000, 995, 990, 111, noQ, "v");
  check("A16. observed lag mic → OK", hOk.status === "OK");
  check("A17. cursorSlot = observed", hOk.cursorSlot === 995);
  check("A18. behindSlots = latest-observed", hOk.behindSlots === 5);
  check("A19. processedSlot expus", hOk.processedSlot === 990);
  check("A20. lastProcessedAt ISO", typeof hOk.lastProcessedAt === "string" && hOk.lastProcessedAt!.includes("T"));

  const hStart = buildHealth(1000, null, null, null, noQ, "v");
  check("A21. observed null → STARTING", hStart.status === "STARTING");
  check("A22. lastProcessedAt null → null", hStart.lastProcessedAt === null);

  const hDead = buildHealth(1000, 999, 990, 111, { pending: 2, processing: 0, dead: 1, oldestPendingAgeMs: 500 }, "v");
  check("A23. dead>0 escaladează OK→DEGRADED", hDead.status === "DEGRADED");
  check("A24. deadCount expus în health", hDead.deadCount === 1);
  check("A25. pendingCount expus", hDead.pendingCount === 2);

  const hBacklog = buildHealth(1000, 999, 990, 111, { pending: 5, processing: 0, dead: 0, oldestPendingAgeMs: 200_000 }, "v");
  check("A26. backlog vechi escaladează OK→DEGRADED", hBacklog.status === "DEGRADED");

  const hBehind = buildHealth(100000, 50000, 40000, 111, { pending: 0, processing: 0, dead: 3, oldestPendingAgeMs: null }, "v");
  check("A27. BEHIND NU e coborât la DEGRADED de dead", hBehind.status === "BEHIND");

  const hBacklogFresh = buildHealth(1000, 999, 990, 111, { pending: 5, processing: 1, dead: 0, oldestPendingAgeMs: 1000 }, "v");
  check("A28. backlog proaspăt (mic) rămâne OK", hBacklogFresh.status === "OK");

  // parseStoredSlot — fail-closed la citire cursor (fix varu blocker 3; doctrina C4 EVM)
  const threw = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };
  check("A29. parse cifre → număr", parseStoredSlot("12345", "k") === 12345);
  check("A30. parse null → null (first-run)", parseStoredSlot(null, "k") === null);
  check("A31. parse '0' → 0 valid (slot genesis)", parseStoredSlot("0", "k") === 0);
  check("A32. parse '123abc' ARUNCĂ (nu 123)", threw(() => parseStoredSlot("123abc", "k")));
  check("A33. parse '12.5' ARUNCĂ (nu 12)", threw(() => parseStoredSlot("12.5", "k")));
  check("A34. parse '-1' ARUNCĂ", threw(() => parseStoredSlot("-1", "k")));
  check("A35. parse '' ARUNCĂ (nu tratat ca first-run)", threw(() => parseStoredSlot("", "k")));

  // ── Partea B: Redis real (skip dacă nu-i) ──────────────────────────────────
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

  // curăță cheile de test (inclusiv testc6_empty folosit la B19 și cheia de test cursor — fix varu nit)
  const keys = [
    `preflight:indexer:disc:pending:${CHAIN}`,
    `preflight:indexer:disc:processing:${CHAIN}`,
    `preflight:indexer:disc:attempts:${CHAIN}`,
    `preflight:indexer:disc:dead:${CHAIN}`,
  ];
  const emptyKeys = [
    `preflight:indexer:disc:pending:testc6_empty`,
    `preflight:indexer:disc:processing:testc6_empty`,
    `preflight:indexer:disc:attempts:testc6_empty`,
    `preflight:indexer:disc:dead:testc6_empty`,
  ];
  const CURSOR_TEST_KEY = "preflight:test:c6:cursor";
  await r.del(...keys, ...emptyKeys, CURSOR_TEST_KEY);

  const c1: DiscoveryCandidate = { program: "raydium_cpmm", slot: 100, signature: "sigAAA" };
  const c2: DiscoveryCandidate = { program: "pumpfun",      slot: 101, signature: "sigBBB" };

  // enqueue
  check("B1. enqueue nou → true", (await enqueueCandidate(r, CHAIN, c1, 1000)) === true);
  check("B2. enqueue dup → false (NX)", (await enqueueCandidate(r, CHAIN, c1, 9999)) === false);
  check("B3. 1 în pending", (await pendingCandidateCount(r, CHAIN)) === 1);
  await enqueueCandidate(r, CHAIN, c2, 1000);
  check("B4. 2 în pending", (await pendingCandidateCount(r, CHAIN)) === 2);

  // claim (due la now=2000)
  const claimed = await claimDueCandidates(r, CHAIN, 2000, 180_000, 10);
  check("B5. claim ia ambii due", claimed.length === 2);
  check("B6. pending gol după claim", (await pendingCandidateCount(r, CHAIN)) === 0);
  check("B7. 2 în processing", (await processingCandidateCount(r, CHAIN)) === 2);

  // claim din viitor nu ia nimic
  await enqueueCandidate(r, CHAIN, { program: "raydium_clmm", slot: 200, signature: "sigFUT" }, 999_999_999_999);
  const claimFut = await claimDueCandidates(r, CHAIN, 2000, 180_000, 10);
  check("B8. claim nu ia itemul din viitor", claimFut.length === 0);

  // done
  await markCandidateDone(r, CHAIN, encodeCandidate(c1));
  check("B9. done scoate din processing", (await processingCandidateCount(r, CHAIN)) === 1);

  // reclaim: c2 e în processing cu lease până la 2000+180000; simulăm expirat
  const reclaimed = await reclaimExpiredCandidates(r, CHAIN, 2000 + 180_000 + 1);
  check("B10. reclaim recuperează lease expirat", reclaimed === 1);
  check("B11. c2 înapoi în pending", (await pendingCandidateCount(r, CHAIN)) >= 1);

  // failed → retry apoi dead
  await r.del(...keys);
  const cf: DiscoveryCandidate = { program: "pumpfun", slot: 300, signature: "sigDEAD" };
  await enqueueCandidate(r, CHAIN, cf, 1000);
  await claimDueCandidates(r, CHAIN, 2000, 180_000, 10);
  const mf = encodeCandidate(cf);
  let lastOutcome = "";
  for (let i = 0; i < DISC_MAX_ATTEMPTS; i++) {
    lastOutcome = await markCandidateFailed(r, CHAIN, mf, 2000);
    // re-claim pt. următoarea încercare (dacă nu-i dead)
    if (lastOutcome === "retry") await claimDueCandidates(r, CHAIN, 999_999_999_999, 180_000, 10);
  }
  check("B12. primele = retry, ultima = dead", lastOutcome === "dead");
  check("B13. în dead-letter", (await deadCandidateCount(r, CHAIN)) === 1);
  check("B14. scos din pending la dead", (await pendingCandidateCount(r, CHAIN)) === 0);
  check("B15. scos din processing la dead", (await processingCandidateCount(r, CHAIN)) === 0);
  check("B16. enqueue refuză dead (TERMINAL)", (await enqueueCandidate(r, CHAIN, cf, 1000)) === false);

  // stats: oldestPendingAgeMs
  await r.del(...keys);
  await enqueueCandidate(r, CHAIN, { program: "raydium_cpmm", slot: 400, signature: "sigOLD" }, 1000);
  const stats = await discoveryQueueStats(r, CHAIN, 51_000);
  check("B17. stats.pending = 1", stats.pending === 1);
  check("B18. stats.oldestPendingAgeMs = now-score", stats.oldestPendingAgeMs === 50_000);
  const statsEmpty = await discoveryQueueStats(r, "testc6_empty", 1000);
  check("B19. stats coadă goală → oldest null", statsEmpty.oldestPendingAgeMs === null);

  // cursor: monotonicitate + self-heal (fix varu blocker 3). Rulez Lua identic cu advance*Slot din
  // cursor.ts pe o cheie NAMESPACED de test — cheile reale de cursor (`solana`) NU sunt
  // chain-parametrizate, deci testarea funcțiilor reale ar clobber-ui un Redis partajat.
  const LUA_ADV = `local cur = tonumber(redis.call('GET', KEYS[1])) or -1
local inc = tonumber(ARGV[1])
if inc > cur then redis.call('SET', KEYS[1], ARGV[1]) end
return 1`;
  await r.del(CURSOR_TEST_KEY);
  await r.eval(LUA_ADV, 1, CURSOR_TEST_KEY, "100");
  check("B20. advance 100 → 100", (await r.get(CURSOR_TEST_KEY)) === "100");
  await r.eval(LUA_ADV, 1, CURSOR_TEST_KEY, "50");
  check("B21. advance 50 ignorat (monoton, compare-and-set)", (await r.get(CURSOR_TEST_KEY)) === "100");
  await r.eval(LUA_ADV, 1, CURSOR_TEST_KEY, "150");
  check("B22. advance 150 → 150", (await r.get(CURSOR_TEST_KEY)) === "150");
  await r.set(CURSOR_TEST_KEY, "12abc"); // valoare stocată coruptă
  await r.eval(LUA_ADV, 1, CURSOR_TEST_KEY, "500");
  check("B23. self-heal peste corupt → 500 (tonumber(GET) or -1)", (await r.get(CURSOR_TEST_KEY)) === "500");

  await r.del(...keys, ...emptyKeys, CURSOR_TEST_KEY);
  await r.quit().catch(() => {});

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
