/**
 * scripts/priceStatus-audit.ts
 * Read-only audit: distribuție priceStatus + metadataStatus + quoteStatus în Redis.
 *
 * Usage:
 *   tsx scripts/priceStatus-audit.ts [--chain base] [--hours 24]
 *
 * Env: REDIS_URL
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

const REDIS_URL   = process.env.REDIS_URL ?? "redis://localhost:6379";
const TS_SET_KEY  = `preflight:indexed:pairs:ts:${chain}`;
const PAIR_PREFIX = `preflight:indexed:pair:${chain}:`;

// ── Redis ────────────────────────────────────────────────────────────────────

const r = new Redis(REDIS_URL);

// ── Helpers ──────────────────────────────────────────────────────────────────

function inc(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function printMap(label: string, map: Map<string, number>, total: number) {
  console.log(`\n${label}:`);
  const sorted = [...map.entries()].sort(([, a], [, b]) => b - a);
  for (const [k, v] of sorted) {
    const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${k.padEnd(30)} ${v.toString().padStart(4)}  (${pct}%)`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== priceStatus-audit: chain=${chain} hours=${hours} ===\n`);

  const since = Date.now() - hours * 60 * 60 * 1000;

  // Fetch addresses from ts ZSET, filtered by time window
  const addrs: string[] = await r.zrangebyscore(TS_SET_KEY, since, "+inf");
  console.log(`Indexed pairs in last ${hours}h: ${addrs.length}`);

  if (addrs.length === 0) {
    console.log("No pairs found — indexer may not have run yet or REDIS_URL is wrong.");
    await r.quit();
    process.exit(0);
  }

  // MGET all pair JSONs
  const keys  = addrs.map(a => `${PAIR_PREFIX}${a}`);
  const raws: (string | null)[] = await r.mget(...keys);

  const pairs = raws
    .map(raw => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
    .filter(Boolean);

  console.log(`Pairs fetched: ${pairs.length} / ${addrs.length}\n`);

  // ── Counters ───────────────────────────────────────────────────────────────

  const byPriceStatus       = new Map<string, number>();
  const byDexId             = new Map<string, number>();
  const byQuoteStatus       = new Map<string, number>();
  const byMetadataStatus    = new Map<string, number>();
  const byNoKnownQuoteToken = new Map<string, number>();

  const sampleBad: any[] = [];

  for (const p of pairs) {
    const ps = p.priceStatus    ?? "MISSING";
    const ms = p.metadataStatus ?? "MISSING";
    const qs = p.quoteStatus    ?? "MISSING";

    inc(byPriceStatus,    ps);
    inc(byDexId,          p.dexId ?? "unknown");
    inc(byQuoteStatus,    qs);
    inc(byMetadataStatus, ms);

    // ── NO_KNOWN_QUOTE breakdown ──────────────────────────────────────────────
    // Pentru fiecare pereche unde quote detection a picat, numărăm ambele
    // token-uri (base + "celălalt") ca să identificăm ce tokens lipsesc din quotes.ts.
    // baseSymbol e disponibil (fetched); "celălalt" îl identificăm prin adresă.
    if (qs === "NO_KNOWN_QUOTE") {
      const base  = (p.baseToken ?? "").toLowerCase();
      const t0    = (p.token0    ?? "").toLowerCase();
      const t1    = (p.token1    ?? "").toLowerCase();
      const other = t0 === base ? t1 : t0;

      // Base token — avem simbol
      if (base) {
        const sym   = p.baseSymbol;
        const label = sym ? `${sym} (${base.slice(0, 10)})` : base.slice(0, 10);
        inc(byNoKnownQuoteToken, label);
      }

      // "Celălalt" token — fără simbol (nu a fost fetched), doar adresă
      if (other && other !== base) {
        inc(byNoKnownQuoteToken, `? ${other.slice(0, 10)}`);
      }
    }

    if (ps !== "OK" && ps !== "V3_SKIP" && sampleBad.length < 5) {
      sampleBad.push({
        pairAddress:    p.pairAddress,
        dexId:          p.dexId,
        priceStatus:    ps,
        quoteStatus:    qs,
        metadataStatus: ms,
        baseSymbol:     p.baseSymbol ?? null,
        quoteSymbol:    p.quoteSymbol ?? null,
        priceUsd:       p.priceUsd ?? 0,
        reserveUsd:     p.reserveUsd ?? 0,
      });
    }
  }

  const total = pairs.length;

  printMap("priceStatus distribution",    byPriceStatus,    total);
  printMap("dexId distribution",          byDexId,          total);
  printMap("quoteStatus distribution",    byQuoteStatus,    total);
  printMap("metadataStatus distribution", byMetadataStatus, total);

  if (sampleBad.length > 0) {
    console.log("\nSample problematic pairs (priceStatus != OK/V3_SKIP):");
    for (const p of sampleBad) {
      console.log(`  ${p.pairAddress}  dex:${p.dexId}  priceStatus:${p.priceStatus}  quote:${p.quoteStatus}  meta:${p.metadataStatus}  base:${p.baseSymbol ?? "?"}  quote:${p.quoteSymbol ?? "?"}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const okCount    = byPriceStatus.get("OK")      ?? 0;
  const v3Count    = byPriceStatus.get("V3_SKIP")  ?? 0;
  const noQuote    = byPriceStatus.get("NO_QUOTE") ?? 0;
  const noPrice    = byPriceStatus.get("QUOTE_PRICE_UNKNOWN") ?? 0;
  const noReserve  = byPriceStatus.get("NO_RESERVES") ?? 0;

  console.log("\n=== Summary ===");
  console.log(`  Total pairs:       ${total}`);
  console.log(`  Priced (OK):       ${okCount}  (${total > 0 ? ((okCount / total) * 100).toFixed(1) : 0}%)`);
  console.log(`  V3 (skip):         ${v3Count}`);
  console.log(`  No quote token:    ${noQuote}`);
  console.log(`  Quote price missing:${noPrice}`);
  console.log(`  No reserves:       ${noReserve}`);

  if (noQuote / total > 0.3) {
    console.log("\n  ⚠️  WARNING: NO_QUOTE > 30% — quote token detection may need tuning");
  }
  if (noPrice / total > 0.2) {
    console.log("\n  ⚠️  WARNING: QUOTE_PRICE_UNKNOWN > 20% — set INDEXER_WETH_USD env var");
  }

  // ── Top token candidates în NO_KNOWN_QUOTE pairs ───────────────────────────
  if (byNoKnownQuoteToken.size > 0) {
    const noKnownQuote = byQuoteStatus.get("NO_KNOWN_QUOTE") ?? 0;
    const topN = [...byNoKnownQuoteToken.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20);
    console.log(`\nTop token candidates în NO_KNOWN_QUOTE pairs (top ${topN.length}):`);
    console.log("  (tokens cu simbol = base token cunoscut; '? 0x...' = celălalt token fără simbol)");
    console.log("  (procentele pot însuma peste 100%, fiindcă numărăm ambele tokenuri din fiecare pereche)");
    for (const [k, v] of topN) {
      const pct = noKnownQuote > 0 ? ((v / noKnownQuote) * 100).toFixed(1) : "0.0";
      console.log(`  ${k.padEnd(40)} ${v.toString().padStart(4)}  (${pct}% din NO_KNOWN_QUOTE)`);
    }
    console.log("  → Tokens cu simbol care apar des = candidați pentru quotes.ts");
    console.log("  → '?' cu adrese repetate = tokens necunoscuți care ar putea fi quote common");
  }

  await r.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
