/**
 * scripts/compare-sources.ts
 * Read-only: compară indexed pairs (Redis) vs Gecko pools (live fetch).
 *
 * Usage:
 *   tsx scripts/compare-sources.ts [--chain base] [--hours 24]
 *
 * Env: REDIS_URL
 *
 * Output:
 *   - indexedTotal, geckoTotal, overlapCount, overlapPct
 *   - indexedOnly (în indexer dar nu în Gecko)
 *   - geckoOnly   (în Gecko dar nu în indexer)
 *   - insufficient_sample dacă prea puțin timp de date
 *
 * NOTE: Primele ore de date sunt early/insufficient_sample.
 *       Concluzioni reale abia după 24–48h de indexer live.
 */

import Redis from "ioredis";

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function readArg(name: string, fallback: string): string {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) return fallback;
  return v;
}

const chain = readArg("--chain", "base");
const hours = Number(readArg("--hours", "24"));

if (!Number.isFinite(hours) || hours <= 0) {
  console.error(`Invalid --hours: ${hours}`);
  process.exit(1);
}

const GECKO_NETWORK: Record<string, string> = {
  base:     "base",
  arbitrum: "arbitrum",
  bsc:      "bsc",
};

const REDIS_URL   = process.env.REDIS_URL ?? "redis://localhost:6379";
const TS_SET_KEY  = `preflight:indexed:pairs:ts:${chain}`;
const PAIR_PREFIX = `preflight:indexed:pair:${chain}:`;
const GECKO_BASE  = "https://api.geckoterminal.com/api/v2";

const geckoNetwork = GECKO_NETWORK[chain];
if (!geckoNetwork) {
  console.error(`Unknown chain: ${chain}. Supported: base, arbitrum, bsc`);
  process.exit(1);
}

// ── Redis ─────────────────────────────────────────────────────────────────────

const r = new Redis(REDIS_URL);

// ── Gecko fetch ───────────────────────────────────────────────────────────────

async function fetchGeckoPools(): Promise<Set<string>> {
  const addrs = new Set<string>();
  const urls  = [
    `${GECKO_BASE}/networks/${geckoNetwork}/trending_pools?page=1`,
    `${GECKO_BASE}/networks/${geckoNetwork}/trending_pools?page=2`,
    `${GECKO_BASE}/networks/${geckoNetwork}/new_pools?page=1`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal:  AbortSignal.timeout(8_000),
      });
      if (res.status === 429) {
        console.warn(`  [GECKO] 429 on ${url} — partial results`);
        continue;
      }
      if (!res.ok) continue;
      const json = await res.json() as any;
      for (const item of json.data ?? []) {
        const addr = item.attributes?.address?.toLowerCase();
        if (addr) addrs.add(addr);
      }
      // Politeness delay
      await new Promise(r => setTimeout(r, 700));
    } catch (e) {
      console.warn(`  [GECKO] fetch error: ${(e as Error).message}`);
    }
  }

  return addrs;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== compare-sources: chain=${chain} hours=${hours} ===\n`);

  const since = Date.now() - hours * 60 * 60 * 1000;

  // ── Read indexed pairs ────────────────────────────────────────────────────
  const addrs: string[] = await r.zrangebyscore(TS_SET_KEY, since, "+inf");
  console.log(`Indexed pairs in last ${hours}h: ${addrs.length}`);

  if (addrs.length === 0) {
    console.log("No indexed pairs found — indexer may not have run yet.");
    await r.quit();
    process.exit(0);
  }

  // MGET to get dexId + symbols for context
  const keys = addrs.map(a => `${PAIR_PREFIX}${a}`);
  const raws: (string | null)[] = await r.mget(...keys);

  const indexedPairs = raws
    .map(raw => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
    .filter(Boolean);

  const indexedAddrs = new Set(indexedPairs.map((p: any) => p.pairAddress.toLowerCase()));

  // ── Fetch Gecko pools ─────────────────────────────────────────────────────
  console.log("Fetching Gecko pools (trending p1+p2 + new)...");
  const geckoAddrs = await fetchGeckoPools();
  console.log(`Gecko pools fetched: ${geckoAddrs.size}`);

  // ── Compute overlap ───────────────────────────────────────────────────────
  const overlap     = [...indexedAddrs].filter(a => geckoAddrs.has(a));
  const indexedOnly = [...indexedAddrs].filter(a => !geckoAddrs.has(a));
  const geckoOnly   = [...geckoAddrs].filter(a => !indexedAddrs.has(a));

  const overlapPct = geckoAddrs.size > 0
    ? ((overlap.length / geckoAddrs.size) * 100).toFixed(1)
    : "N/A";

  const insufficientSample = addrs.length < 10 || hours < 2;

  // ── Latency estimation ────────────────────────────────────────────────────
  // For overlapping pairs, we only know indexer discoveredAt.
  // We can't know exact Gecko firstSeen without historical Gecko data.
  // So latency is not computable here — noted as future work.

  // ── Print results ─────────────────────────────────────────────────────────
  console.log("\n=== Results ===");
  if (insufficientSample) {
    console.log("  ⚠️  INSUFFICIENT SAMPLE — early data, do not draw conclusions yet");
    console.log(`      Need: ≥10 indexed pairs + ≥2h of data. Have: ${addrs.length} pairs, ${hours}h window.`);
  }
  console.log(`\n  indexedTotal: ${indexedAddrs.size}`);
  console.log(`  geckoTotal:   ${geckoAddrs.size}`);
  console.log(`  overlapCount: ${overlap.length}`);
  console.log(`  overlapPct:   ${overlapPct}%  (overlap / geckoTotal)`);
  console.log(`  indexedOnly:  ${indexedOnly.length}  (în indexer, nu în Gecko snapshot)`);
  console.log(`  geckoOnly:    ${geckoOnly.length}  (în Gecko, nu în indexer)`);
  console.log(`  note: latency comparison requires historical Gecko data (future work)`);

  // ── Sample geckoOnly ──────────────────────────────────────────────────────
  if (geckoOnly.length > 0) {
    console.log(`\n  Sample geckoOnly (first 5 — pools Gecko vede dar indexerul nu):`);
    for (const addr of geckoOnly.slice(0, 5)) {
      console.log(`    ${addr}`);
    }
  }

  // ── Sample indexedOnly ────────────────────────────────────────────────────
  if (indexedOnly.length > 0) {
    console.log(`\n  Sample indexedOnly (first 5 — pools indexerul vede dar Gecko nu):`);
    for (const addr of indexedOnly.slice(0, 5)) {
      const p = indexedPairs.find((x: any) => x.pairAddress.toLowerCase() === addr) as any;
      if (p) {
        console.log(`    ${addr}  dex:${p.dexId}  base:${p.baseSymbol ?? "?"}  priceStatus:${p.priceStatus ?? "MISSING"}`);
      }
    }
  }

  // ── Alert ─────────────────────────────────────────────────────────────────
  if (!insufficientSample && geckoAddrs.size > 0) {
    const pct = (overlap.length / geckoAddrs.size) * 100;
    if (pct < 90) {
      console.log(`\n  ⚠️  WARNING: overlap < 90% (${overlapPct}%) — indexer may be missing pools`);
    } else {
      console.log(`\n  ✅ overlap ≥ 90% (${overlapPct}%) — indexer coverage looks good`);
    }
  }

  console.log(`\n  insufficient_sample: ${insufficientSample}`);
  console.log("  (Run again after 24–48h of indexer live for reliable conclusions)\n");

  await r.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
