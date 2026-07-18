/**
 * scripts/redisCleanup.ts — A6.
 * Curăță datele corupte/orfane înainte de repornirea worker-ului cu codul fixat.
 * DRY-RUN implicit — nu șterge nimic fără `--yes`.
 *
 * ── GRUP 1: Solana corupt/orfan (A2 + index-uri) ──
 *   preflight:indexed:pair:solana:*        pool records (unele corupte A2, blochează SET NX)
 *   preflight:indexed:pairs:solana         ZSET index (orfani)
 *   preflight:indexed:pairs:ts:solana      ZSET index (orfani)
 *   preflight:solana:price:pools           ZSET orfan (snapshots expirate — M15)
 *   preflight:solana:price:*               snapshots + history (majoritatea expirate)
 *   preflight:solana:activity:*            activity per pool
 *   preflight:solana:observed_candidate:*  candidați observați
 *   preflight:solana:decimals:*            cache decimals (se re-rezolvă)
 *   preflight:indexer:backfill:cpmm:*      MARKERELE de backfill — ȘTERSE ca backfill-ul
 *                                          (corect, citește PoolState on-chain, NEatins de A2)
 *                                          să reconstruiască registry-ul cu SOLANA_BACKFILL_ENABLED=1
 *
 * ── GRUP 2: EVM derived state (V4 flow inversat de bug-ul H1) ──
 *   pair_states, active_watch, hot_candidates, armed_entries, signal_pipeline,
 *   pipeline_events, qualified_signals, market_context, market_regime,
 *   worker_snapshot:latest, recent_drops, momentum_events, pipeline_coverage,
 *   scanner_stats, agent_watch_requests, lifecycle, pair_context:*
 *   (au TTL scurt → după zile de off sunt 0; incluse pt completitudine/robustețe —
 *    dacă worker-ul e recent oprit, curăță starea V4 construită cu direcția inversată)
 *
 * NU atinge: registry-urile EVM `indexed:pair:{base,arbitrum,bsc,ethereum}:*` (71k+,
 * NEcorupte), token metadata cache, risk cache, cursoare EVM, launches (decât cu --full).
 *
 * --full  → ȘI launches solana + launches ZSETs + cursor solana + token cache solana
 *           (Solana COMPLET fresh)
 * --yes   → execută efectiv (altfel dry-run)
 *
 * Rulare (din workers/solana):
 *   npm run cleanup:redis               # dry-run
 *   npm run cleanup:redis -- --yes      # execută
 *   npm run cleanup:redis -- --full --yes
 */

import Redis from "ioredis";

const args    = process.argv.slice(2);
const EXECUTE = args.includes("--yes");
const FULL    = args.includes("--full");

const url =
  process.env.REDIS_URL ??
  process.env.REDIS_PRIVATE_URL ??
  process.env.REDIS_PUBLIC_URL;

if (!url) {
  console.error("Missing Redis env: set REDIS_URL / REDIS_PRIVATE_URL / REDIS_PUBLIC_URL");
  process.exit(1);
}

const r = new Redis(url, { maxRetriesPerRequest: 3, enableReadyCheck: true });

async function scanKeys(pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 1000);
    cursor = next;
    out.push(...keys);
  } while (cursor !== "0");
  return out;
}

async function unlinkAll(keys: string[]): Promise<number> {
  let removed = 0;
  const BATCH = 500;
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    const pipe = r.pipeline();
    slice.forEach(k => pipe.unlink(k));
    const res = await pipe.exec();
    res?.forEach(([, v]) => { removed += Number(v) || 0; });
  }
  return removed;
}

// ── GRUP 1: Solana corupt/orfan ───────────────────────────────────────────────
const solanaPatterns = [
  "preflight:indexed:pair:solana:*",
  "preflight:solana:price:*",
  "preflight:solana:activity:*",
  "preflight:solana:observed_candidate:*",
  "preflight:solana:decimals:*",
  "preflight:indexer:backfill:cpmm:*",     // markere backfill → șterse ca să ruleze din nou
];
const solanaExact = [
  "preflight:indexed:pairs:solana",
  "preflight:indexed:pairs:ts:solana",
  "preflight:solana:price:pools",
];

// ── GRUP 2: EVM derived state (V4 flow inversat — TTL scurt, ~0 după zile off) ─
const evmDerivedPatterns = [
  "preflight:pair_context:*",
];
const evmDerivedExact = [
  "preflight:pair_states", "preflight:active_watch", "preflight:hot_candidates",
  "preflight:armed_entries", "preflight:signal_pipeline", "preflight:pipeline_events",
  "preflight:qualified_signals", "preflight:market_context", "preflight:market_regime",
  "preflight:worker_snapshot:latest", "preflight:recent_drops", "preflight:momentum_events",
  "preflight:pipeline_coverage", "preflight:scanner_stats", "preflight:agent_watch_requests",
  "preflight:lifecycle",
];

async function main() {
  console.log(`Mod: ${EXECUTE ? "EXECUTE (--yes)" : "DRY-RUN"}${FULL ? " + FULL" : ""}\n`);

  const patterns  = [...solanaPatterns, ...evmDerivedPatterns];
  const exactKeys = [...solanaExact, ...evmDerivedExact];

  if (FULL) {
    patterns.push("preflight:indexed:launch:solana:*", "preflight:solana:token:*");
    exactKeys.push(
      "preflight:indexed:launches:solana",
      "preflight:indexed:launches:ts:solana",
      "preflight:indexer:cursor:solana",
    );
  }

  const groups: { label: string; keys: string[] }[] = [];
  for (const p of patterns) {
    groups.push({ label: p, keys: await scanKeys(p) });
  }
  const existingExact: string[] = [];
  {
    const pipe = r.pipeline();
    exactKeys.forEach(k => pipe.exists(k));
    const res = await pipe.exec();
    res?.forEach(([, v], i) => { if (Number(v) === 1) existingExact.push(exactKeys[i]); });
  }
  groups.push({ label: "(chei exacte existente)", keys: existingExact });

  // Dedup global (price:pools e prins și de pattern price:* și de exact)
  const uniq = new Set<string>();
  for (const g of groups) g.keys.forEach(k => uniq.add(k));

  console.log("DE ȘTERS (per grup):");
  for (const g of groups) {
    if (g.keys.length > 0) console.log("  " + String(g.keys.length).padStart(6) + "  " + g.label);
  }
  console.log("  " + "-".repeat(44));
  console.log("  " + String(uniq.size).padStart(6) + "  TOTAL unic\n");

  if (!EXECUTE) {
    console.log("DRY-RUN — nimic șters. Rulează cu `-- --yes` ca să execuți.");
    await r.quit();
    return;
  }

  const removed = await unlinkAll([...uniq]);
  console.log(`✅ Șters ${removed} chei (din ${uniq.size} unice candidate).`);
  await r.quit();
}

main().catch(e => { console.error("cleanup error:", e); process.exit(1); });
