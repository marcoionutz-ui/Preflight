/**
 * scripts/enrichQueue.test.ts — C2 (coadă persistentă de enrichment), tranziții Lua ATOMICE.
 *
 * Rulează pe un Redis REAL (Lua rulează doar pe server, nu se poate mock-ui fidel). Testează:
 * backoff pur, enqueue NX + skip dead/processing (dead TERMINAL), claim atomic pending→processing+lease,
 * reclaim lease expirat, markDone, markFailed retry→dead.
 *
 * Fără Redis (nici INDEXER_TEST_REDIS_URL, nici localhost) → SKIP curat (exit 0), ca `npm test` să rămână
 * verde. Verificarea autoritativă a Lua-ului s-a făcut pe Redis real în dev.
 *
 * Rulează: npm run test:c2   (tsx scripts/enrichQueue.test.ts)
 */
import Redis from "ioredis";
import {
  nextBackoffMs, enqueueEnrich, claimDueEnrich, reclaimExpiredEnrich,
  markEnrichDone, markEnrichFailed, pendingEnrichCount, processingEnrichCount,
  ENRICH_MAX_ATTEMPTS, ENRICH_BACKOFF_BASE_MS,
} from "../src/discovery/enrichQueue";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else       { failed++; console.log("  ❌ " + name); }
}

const URL = process.env.INDEXER_TEST_REDIS_URL || "redis://127.0.0.1:6379";
const C = "testc2";
const K = {
  pending:    `preflight:indexer:enrich:pending:${C}`,
  processing: `preflight:indexer:enrich:processing:${C}`,
  attempts:   `preflight:indexer:enrich:attempts:${C}`,
  dead:       `preflight:indexer:enrich:dead:${C}`,
};

async function main() {
  console.log("C2 — enrichQueue (Lua atomic, Redis real)\n");

  // backoff pur — nu are nevoie de Redis
  check("1a. backoff attempts=1 -> base", nextBackoffMs(1, 5000, 300000) === 5000);
  check("1b. attempts=3 -> 4x", nextBackoffMs(3, 5000, 300000) === 20000);
  check("1c. cap la max", nextBackoffMs(20, 5000, 300000) === 300000);

  const r = new Redis(URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500, retryStrategy: () => null });
  r.on("error", () => { /* skip curat dacă Redis lipsește */ });
  try {
    await r.connect();
  } catch {
    console.log("\n  ⚠️  Redis indisponibil — testele Lua SKIP (verificate pe Redis real în dev).");
    console.log(`\n${passed} passed, ${failed} failed (Lua skipped)`);
    r.disconnect();
    return;
  }

  try {
    await r.del(K.pending, K.processing, K.attempts, K.dead);

    // 2. enqueue NX + skip dead/processing
    check("2a. enqueue nou -> true", (await enqueueEnrich(r, C, "0xAAA", 100)) === true);
    check("2b. enqueue dup -> false (NX)", (await enqueueEnrich(r, C, "0xAAA", 999)) === false);
    check("2c. scor original pastrat", (await r.zscore(K.pending, "0xaaa")) === "100");
    check("2d. 1 in pending", (await pendingEnrichCount(r, C)) === 1);

    await r.zadd(K.dead, 123, "0xdead");
    check("3a. enqueue pair dead -> false (TERMINAL)", (await enqueueEnrich(r, C, "0xDEAD", 0)) === false);
    check("3b. NU intra in pending", (await r.zscore(K.pending, "0xdead")) === null);

    // 4. claim atomic pending -> processing + lease
    const claimed = await claimDueEnrich(r, C, 200, 60000, 10);
    check("4a. claim 0xaaa (due)", claimed.length === 1 && claimed[0] === "0xaaa");
    check("4b. scos din pending", (await r.zscore(K.pending, "0xaaa")) === null);
    check("4c. in processing cu lease", (await r.zscore(K.processing, "0xaaa")) === String(200 + 60000));
    check("4d. enqueue pair in processing -> false", (await enqueueEnrich(r, C, "0xAAA", 0)) === false);

    // 5. claim nu ia ce nu-i due
    await r.del(K.pending, K.processing);
    await enqueueEnrich(r, C, "0xFUT", 10000);
    check("5. claim nu ia itemul din viitor", (await claimDueEnrich(r, C, 500, 60000, 10)).length === 0);

    // 6. reclaim lease expirat -> pending
    await r.del(K.pending, K.processing);
    await r.zadd(K.processing, 1000, "0xexp", 9999, "0xlive");
    const rec = await reclaimExpiredEnrich(r, C, 5000);
    check("6a. 1 reclaimat", rec === 1);
    check("6b. 0xexp inapoi in pending", (await r.zscore(K.pending, "0xexp")) !== null);
    check("6c. 0xexp scos din processing", (await r.zscore(K.processing, "0xexp")) === null);
    check("6d. 0xlive ramane in processing", (await r.zscore(K.processing, "0xlive")) !== null);

    // 7. markDone
    await r.del(K.pending, K.processing, K.attempts);
    await r.zadd(K.processing, 1, "0xok");
    await r.hincrby(K.attempts, "0xok", 2);
    await markEnrichDone(r, C, "0xOK");
    check("7a. scos din processing", (await r.zscore(K.processing, "0xok")) === null);
    check("7b. attempts resetate", (await r.hget(K.attempts, "0xok")) === null);

    // 8. markFailed retry -> dead terminal
    await r.del(K.pending, K.processing, K.attempts, K.dead);
    const outs: string[] = [];
    for (let i = 0; i < ENRICH_MAX_ATTEMPTS; i++) {
      await r.zadd(K.processing, 1, "0xc");
      outs.push(await markEnrichFailed(r, C, "0xC", 1_000_000));
    }
    check("8a. primele MAX-1 = retry", outs.filter(o => o === "retry").length === ENRICH_MAX_ATTEMPTS - 1);
    check("8b. ultima = dead", outs[outs.length - 1] === "dead");
    check("8c. dead: scos din pending", (await r.zscore(K.pending, "0xc")) === null);
    check("8d. dead: scos din processing", (await r.zscore(K.processing, "0xc")) === null);
    check("8e. dead: in DEAD", (await r.zscore(K.dead, "0xc")) !== null);
    check("8f. dead TERMINAL: enqueue refuza", (await enqueueEnrich(r, C, "0xC", 0)) === false);

    // 9. retry reprogramat in viitor
    await r.del(K.pending, K.processing, K.attempts);
    await r.zadd(K.processing, 1, "0xd");
    await markEnrichFailed(r, C, "0xD", 1_000_000);
    check("9a. reprogramat la now+backoff", (await r.zscore(K.pending, "0xd")) === String(1_000_000 + ENRICH_BACKOFF_BASE_MS));
    check("9b. nu e claim-abil la now", (await claimDueEnrich(r, C, 1_000_000, 60000, 10)).length === 0);

    // 10. processing count
    await r.del(K.pending, K.processing);
    await enqueueEnrich(r, C, "0xe", 0);
    await claimDueEnrich(r, C, 100, 60000, 10);
    check("10. processingEnrichCount = 1", (await processingEnrichCount(r, C)) === 1);

    await r.del(K.pending, K.processing, K.attempts, K.dead);
  } finally {
    r.disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("harness error:", e); process.exit(1); });
