/**
 * scripts/enrichQueue.test.ts — test:u8-p5 (P1-5): coadă de re-enrichment (Solana) + end-to-end writers.
 *
 * Partea A (PURĂ, mereu): encode/decode membru kind-tagged, backoff, case-preservation base58, ȘI
 *   `enrichAgeVerdict` — boundary-ul EXACT de 24h (23:59:59.999 → within/retry; 24:00:00.000 → terminal/FAILED).
 * Partea B (Redis REAL, skip curat): tranzițiile Lua (enqueue NX + skip processing, claim+lease, reclaim,
 *   done, reschedule cu backoff — FĂRĂ dead-set), + invariantul Solana: membrul NU e lowercased.
 * Partea C (Redis REAL, end-to-end): writer → enrich → status. Validează finding-urile centrale cgpt:
 *   enqueue confirmat la insert, RE-enqueue pe exists (redelivery), și writer→drain→metadataStatus.
 *
 * Rulează pe `INDEXER_TEST_REDIS_URL` || 127.0.0.1:6379. Fără Redis → skip B+C, DAR partea A tot
 * influențează exit-code (fix cgpt R1: nu mai returnăm înainte de `process.exit(1)` pe eșecuri pure).
 */

import Redis from "ioredis";
import {
  encodeEnrichMember, decodeEnrichMember, nextBackoffMs, enrichAgeVerdict,
  enqueueEnrich, claimDueEnrich, reclaimExpiredEnrich,
  markEnrichDone, markEnrichReschedule,
  pendingEnrichCount, processingEnrichCount, enrichQueueStats,
  ENRICH_BACKOFF_BASE_MS, ENRICH_BACKOFF_MAX_MS, ENRICH_MAX_AGE_MS,
} from "../src/discovery/enrichQueue";
import { backfillMarkerDecision } from "../src/discovery/backfillMarker";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const C = "testp5";
const K = {
  pending:    `preflight:indexer:enrich:pending:${C}`,
  processing: `preflight:indexer:enrich:processing:${C}`,
  attempts:   `preflight:indexer:enrich:attempts:${C}`,
};

const MIXED_MINT = "So11111111111111111111111111111111111111112";
const MIXED_POOL = "Ck9uGaMbLeRXyZAbc123DEF456ghiJKLmnoPQRstuVWx";

// Mints KNOWN (fără rețea) — pt. Part C enriched path.
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WSOL = "So11111111111111111111111111111111111111112";
const FAKE1 = "Fake1nqr8ScannerTokenNeverOnJupiterAAAAAAAAA";
const FAKE2 = "Fake2nqr8ScannerTokenNeverOnJupiterBBBBBBBBB";

function finish(): never {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

async function main(): Promise<void> {
  console.log("P1-5 — enrichQueue + writers end-to-end\n");

  // ── Partea A: pur (mereu) ──────────────────────────────────────────────────
  console.log("A. pur — membru, backoff, age-boundary");
  check("A1. encode pool = pool|<addr>", encodeEnrichMember("pool", MIXED_POOL) === "pool|" + MIXED_POOL);
  check("A2. encode launch = launch|<mint>", encodeEnrichMember("launch", MIXED_MINT) === "launch|" + MIXED_MINT);
  check("A3. decode pool kind + id (case PĂSTRAT)", decodeEnrichMember("pool|" + MIXED_POOL)?.id === MIXED_POOL);
  check("A4. ⭐ roundtrip NU lowercase", decodeEnrichMember(encodeEnrichMember("launch", MIXED_MINT))?.id === MIXED_MINT);
  check("A5. decode kind invalid → null", decodeEnrichMember("evil|" + MIXED_MINT) === null);
  check("A6. decode fără id → null", decodeEnrichMember("pool|") === null);
  check("A7. decode fără delimitator → null", decodeEnrichMember("nope") === null);
  check("A8. decode delimitator la început → null", decodeEnrichMember("|abc") === null);
  check("A9. backoff attempts=1 = base", nextBackoffMs(1, ENRICH_BACKOFF_BASE_MS, ENRICH_BACKOFF_MAX_MS) === ENRICH_BACKOFF_BASE_MS);
  check("A10. backoff attempts=3 = 4x (cap)", nextBackoffMs(3, ENRICH_BACKOFF_BASE_MS, ENRICH_BACKOFF_MAX_MS) === Math.min(ENRICH_BACKOFF_BASE_MS * 4, ENRICH_BACKOFF_MAX_MS));
  check("A11. backoff cap la max", nextBackoffMs(100, ENRICH_BACKOFF_BASE_MS, ENRICH_BACKOFF_MAX_MS) === ENRICH_BACKOFF_MAX_MS);

  // enrichAgeVerdict — boundary EXACT de 24h (finding central cgpt)
  const DAY = 24 * 60 * 60_000; // 86_400_000
  const T0 = 1_000_000_000_000;                       // now de referință
  const iso = (ms: number) => new Date(ms).toISOString();
  check("A12. ⭐ age = 23:59:59.999 → within (retry)", enrichAgeVerdict(iso(T0 - (DAY - 1)), T0, DAY) === "within_window");
  check("A13. ⭐ age = 24:00:00.000 EXACT → terminal (FAILED)", enrichAgeVerdict(iso(T0 - DAY), T0, DAY) === "terminal");
  check("A14. ⭐ age = 24:00:00.001 → terminal", enrichAgeVerdict(iso(T0 - (DAY + 1)), T0, DAY) === "terminal");
  check("A15. age = 0 (proaspăt) → within", enrichAgeVerdict(iso(T0), T0, DAY) === "within_window");
  check("A16. discoveredAt în viitor → within (se rezolvă cu timpul)", enrichAgeVerdict(iso(T0 + 60_000), T0, DAY) === "within_window");
  check("A17. ⭐ discoveredAt corupt (neparseabil) → terminal (nu ținem veșnic PENDING)", enrichAgeVerdict("not-a-date", T0, DAY) === "terminal");
  check("A18. discoveredAt gol → terminal", enrichAgeVerdict("", T0, DAY) === "terminal");
  check("A19. ENRICH_MAX_AGE_MS default = 24h", ENRICH_MAX_AGE_MS === DAY);

  // backfillMarkerDecision (fix cgpt R2) — pur
  check("A20. ⭐ writeErrors=0 → write (marker scris, backfill complet)", backfillMarkerDecision(0) === "write");
  check("A21. ⭐ writeErrors=1 → skip (marker NEscris → backfill re-rulează pt. reconciliere durabilă)", backfillMarkerDecision(1) === "skip");
  check("A22. writeErrors=5 → skip", backfillMarkerDecision(5) === "skip");

  // ── Partea B + C: Redis real ───────────────────────────────────────────────
  const URL = process.env.INDEXER_TEST_REDIS_URL || "redis://127.0.0.1:6379";
  const r = new Redis(URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null });
  r.on("error", () => { /* skip curat dacă Redis lipsește */ });
  try {
    await r.connect();
  } catch {
    console.log("\n  ⚠️  Redis indisponibil — testele Lua + end-to-end SKIP (verificate pe Redis real în dev).");
    r.disconnect();
    finish(); // ⭐ fix cgpt R1: tot trecem prin exit-code (partea A poate fi picat)
  }

  console.log("\nB. Redis real — tranziții Lua (fără dead-set)");
  try {
    await r.del(K.pending, K.processing, K.attempts);

    const LM = encodeEnrichMember("launch", MIXED_MINT);
    check("B1. enqueue launch nou → true", (await enqueueEnrich(r, C, "launch", MIXED_MINT, 100)) === true);
    check("B2. enqueue dup → false (NX)", (await enqueueEnrich(r, C, "launch", MIXED_MINT, 999)) === false);
    check("B3. ⭐ membru = 'launch|<mint>' EXACT (base58 NElowercased)", (await r.zscore(K.pending, LM)) === "100");
    check("B4. ⭐ varianta lowercased NU există", (await r.zscore(K.pending, LM.toLowerCase())) === null);

    // claim → processing + lease
    const claimed = await claimDueEnrich(r, C, 200, 60000, 10);
    check("B5. claim (due)", claimed.length === 1 && claimed[0] === LM);
    check("B6. scos din pending", (await r.zscore(K.pending, LM)) === null);
    check("B7. în processing cu lease", (await r.zscore(K.processing, LM)) === String(200 + 60000));
    check("B8. enqueue membru în processing → false (skip)", (await enqueueEnrich(r, C, "launch", MIXED_MINT, 0)) === false);

    // claim nu ia din viitor
    await r.del(K.pending, K.processing);
    await enqueueEnrich(r, C, "pool", MIXED_POOL, 10000);
    check("B9. claim nu ia itemul din viitor", (await claimDueEnrich(r, C, 500, 60000, 10)).length === 0);

    // reclaim lease expirat
    await r.del(K.pending, K.processing);
    await r.zadd(K.processing, 1000, "launch|EXP", 9999, "launch|LIVE");
    check("B10. reclaim 1 (lease expirat)", (await reclaimExpiredEnrich(r, C, 5000)) === 1);
    check("B11. EXP înapoi în pending", (await r.zscore(K.pending, "launch|EXP")) !== null);
    check("B12. LIVE rămâne în processing", (await r.zscore(K.processing, "launch|LIVE")) !== null);

    // markEnrichDone
    await r.del(K.pending, K.processing, K.attempts);
    await r.zadd(K.processing, 1, "pool|X");
    await r.hincrby(K.attempts, "pool|X", 3);
    await markEnrichDone(r, C, "pool|X");
    check("B13. done: scos din processing", (await r.zscore(K.processing, "pool|X")) === null);
    check("B14. done: attempts resetate", (await r.hget(K.attempts, "pool|X")) === null);

    // ⭐ markEnrichReschedule: backoff, attempts++, RĂMÂNE în coadă (fără dead-set)
    await r.del(K.pending, K.processing, K.attempts);
    await r.zadd(K.processing, 1, "pool|R");
    const n1 = await markEnrichReschedule(r, C, "pool|R", 1_000_000);
    check("B15. reschedule#1 → attempts=1", n1 === 1);
    check("B16. reprogramat la now+base", (await r.zscore(K.pending, "pool|R")) === String(1_000_000 + ENRICH_BACKOFF_BASE_MS));
    check("B17. scos din processing", (await r.zscore(K.processing, "pool|R")) === null);
    // a doua oară (după re-claim): attempts=2, backoff dublu
    await r.zadd(K.processing, 1, "pool|R"); await r.zrem(K.pending, "pool|R");
    const n2 = await markEnrichReschedule(r, C, "pool|R", 2_000_000);
    check("B18. reschedule#2 → attempts=2", n2 === 2);
    check("B19. backoff dublat (2x base, cap)", (await r.zscore(K.pending, "pool|R")) === String(2_000_000 + Math.min(ENRICH_BACKOFF_BASE_MS * 2, ENRICH_BACKOFF_MAX_MS)));
    check("B20. ⭐ NICIODATĂ dead-letter — jobul e MEREU în pending (nu se pierde)", (await pendingEnrichCount(r, C)) === 1);

    // stats
    await r.del(K.pending, K.processing);
    await enqueueEnrich(r, C, "pool", MIXED_POOL, 0);
    await claimDueEnrich(r, C, 100, 60000, 10);
    const st = await enrichQueueStats(r, C);
    check("B21. enrichQueueStats processing=1", st.processing === 1 && (await processingEnrichCount(r, C)) === 1);

    await r.del(K.pending, K.processing, K.attempts);
  } catch (e) {
    check("B. Redis Lua a rulat fără excepție", false);
    console.error("  (B error:", (e as Error).message + ")");
  }

  // ── Partea C: end-to-end writer → enrich → status ─────────────────────────────
  console.log("\nC. end-to-end writer → enrich (finding-uri centrale cgpt)");
  // getRedis() (writer-ele) citește REDIS_URL. Jupiter dezactivat → orice mint non-KNOWN → FALLBACK rapid/determinist.
  process.env.REDIS_URL = URL;
  process.env.JUPITER_TOKEN_SEARCH_URL = "http://127.0.0.1:1/disabled";
  const { getRedis } = await import("../src/infra/redis");
  const { buildSolanaPool, writeSolanaPool, enrichPoolOnce } = await import("../src/discovery/pairWriter");
  const { buildLaunchRecord, writeLaunchRecord, enrichLaunchOnce } = await import("../src/discovery/launchWriter");
  const { KEY_PAIR, KEY_LAUNCH } = await import("../src/config/constants");

  const PEND_SOL = "preflight:indexer:enrich:pending:solana";
  const now = Date.now();
  const readStatus = async (key: string): Promise<string | null> => {
    const raw = await r.get(key); if (!raw) return null;
    try { return (JSON.parse(raw).metadataStatus ?? null); } catch { return null; }
  };

  try {
    // curăță spațiul „solana" folosit de writer-e
    await r.del(PEND_SOL, "preflight:indexer:enrich:processing:solana", "preflight:indexer:enrich:attempts:solana");
    await r.del(KEY_PAIR("PoolA"), KEY_PAIR("PoolB"), KEY_PAIR("PoolC"), KEY_LAUNCH(BONK));

    // C1: pool cu BASE KNOWN → inserted + ENQUEUED + enrichPoolOnce ENRICHED
    const poolA = buildSolanaPool("PoolA", BONK, WSOL, 100, "sigA", "raydium_cpmm", "LIVE");
    check("C1a. writeSolanaPool → inserted", (await writeSolanaPool(poolA)) === "inserted");
    check("C1b. ⭐ enqueue CONFIRMAT la insert (job în pending)", (await r.zscore(PEND_SOL, "pool|PoolA")) !== null);
    check("C1c. record PENDING la insert", (await readStatus(KEY_PAIR("PoolA"))) === "PENDING");
    // ⭐ redelivery: golim coada (simulăm job consumat) apoi re-scriem → exists TREBUIE să RE-enqueue-uiască
    await r.del(PEND_SOL);
    check("C1d. re-write → exists", (await writeSolanaPool(poolA)) === "exists");
    check("C1e. ⭐⭐ RE-enqueue pe exists (finding #1: nu se pierde enrichment-ul la redelivery)", (await r.zscore(PEND_SOL, "pool|PoolA")) !== null);
    // enrich (BONK KNOWN → non-FALLBACK → ENRICHED)
    check("C1f. enrichPoolOnce → enriched", (await enrichPoolOnce("PoolA", now, ENRICH_MAX_AGE_MS)) === "enriched");
    check("C1g. ⭐ record → ENRICHED", (await readStatus(KEY_PAIR("PoolA"))) === "ENRICHED");

    // C2: pool FAKE + discoveredAt VECHI (25h) → enrichPoolOnce FAILED terminal
    const poolB = buildSolanaPool("PoolB", FAKE1, WSOL, 100, "sigB", "raydium_cpmm", "LIVE");
    poolB.discoveredAt = new Date(now - 25 * 60 * 60_000).toISOString();
    check("C2a. writeSolanaPool(fake, vechi) → inserted", (await writeSolanaPool(poolB)) === "inserted");
    check("C2b. enrichPoolOnce → failed (FALLBACK + age>24h)", (await enrichPoolOnce("PoolB", now, ENRICH_MAX_AGE_MS)) === "failed");
    check("C2c. ⭐ record → FAILED (terminal)", (await readStatus(KEY_PAIR("PoolB"))) === "FAILED");

    // C3: pool FAKE + discoveredAt RECENT → enrichPoolOnce retry, record rămâne PENDING
    const poolC = buildSolanaPool("PoolC", FAKE2, WSOL, 100, "sigC", "raydium_cpmm", "LIVE");
    check("C3a. writeSolanaPool(fake, proaspăt) → inserted", (await writeSolanaPool(poolC)) === "inserted");
    check("C3b. ⭐ enrichPoolOnce → retry (FALLBACK dar în fereastră)", (await enrichPoolOnce("PoolC", now, ENRICH_MAX_AGE_MS)) === "retry");
    check("C3c. ⭐ record rămâne PENDING (NU FAILED — nu scoatem jobul pe retry)", (await readStatus(KEY_PAIR("PoolC"))) === "PENDING");

    // C4: launch cu mint KNOWN → inserted + enqueue + re-enqueue pe exists + enrichLaunchOnce ENRICHED
    const launch = buildLaunchRecord({ mint: BONK, bondingCurveAddress: "bc", associatedBondingCurve: "abc", creatorAddress: "cr" } as any, 100, "sigL");
    check("C4a. writeLaunchRecord → inserted", (await writeLaunchRecord(launch)) === "inserted");
    check("C4b. ⭐ enqueue CONFIRMAT (launch|BONK în pending)", (await r.zscore(PEND_SOL, "launch|" + BONK)) !== null);
    await r.del(PEND_SOL);
    check("C4c. re-write → exists", (await writeLaunchRecord(launch)) === "exists");
    check("C4d. ⭐⭐ RE-enqueue pe exists", (await r.zscore(PEND_SOL, "launch|" + BONK)) !== null);
    check("C4e. enrichLaunchOnce → enriched", (await enrichLaunchOnce(BONK, now, ENRICH_MAX_AGE_MS)) === "enriched");
    check("C4f. ⭐ launch → ENRICHED", (await readStatus(KEY_LAUNCH(BONK))) === "ENRICHED");

    // C5: ⭐⭐ finding cgpt R2 — insert reușit + enqueue EȘUAT → writeSolanaPool "error" (NU succes fals).
    // Simulăm eșecul de enqueue făcând cheia pending a cozii un STRING (tip greșit) → LUA_ENQUEUE (ZADD) aruncă.
    // (Insertul pool-ului scrie în alte chei — pairs zsets — deci reușește; doar enqueue-ul pică.)
    await r.set(PEND_SOL, "not-a-zset");
    const poolE = buildSolanaPool("PoolE", FAKE1, WSOL, 0, "sigE", "raydium_cpmm", "BACKFILL");
    check("C5a. ⭐ writeSolanaPool → error când enqueue aruncă (insert ok, enqueue WRONGTYPE)", (await writeSolanaPool(poolE)) === "error");
    check("C5b. ⭐ pool E TOTUȘI inserted = PENDING (insertul a reușit; enqueue-ul a picat)", (await readStatus(KEY_PAIR("PoolE"))) === "PENDING");
    check("C5c. ⭐ backfillMarkerDecision(writeErrors≥1) = skip → backfill NU scrie marker → re-rulează", backfillMarkerDecision(1) === "skip");
    await r.del(PEND_SOL, KEY_PAIR("PoolE"));

    // cleanup
    await r.del(KEY_PAIR("PoolA"), KEY_PAIR("PoolB"), KEY_PAIR("PoolC"), KEY_LAUNCH(BONK),
      PEND_SOL, "preflight:indexer:enrich:processing:solana", "preflight:indexer:enrich:attempts:solana");
  } catch (e) {
    check("C. end-to-end a rulat fără excepție", false);
    console.error("  (C error:", (e as Error).message + ")");
  } finally {
    try { getRedis().disconnect(); } catch { /* noop */ }
    r.disconnect();
  }

  finish();
}

main().catch(e => { console.error("harness error:", e); process.exit(1); });
