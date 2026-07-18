/**
 * scripts/redisInspect.ts — A6, READ-ONLY.
 * Inventar al cheilor `preflight:*` din Redis: grupate pe namespace (colapsând
 * partea variabilă), cu câte sunt PERMANENTE (fără TTL) vs cu TTL, plus câteva
 * mostre de pool records Solana ca să confirmăm coruperea A2.
 *
 * NU șterge nimic. Rulare (din workers/solana):
 *   npx tsx --env-file=../../.env.local scripts/redisInspect.ts
 */

import Redis from "ioredis";

const url =
  process.env.REDIS_URL ??
  process.env.REDIS_PRIVATE_URL ??
  process.env.REDIS_PUBLIC_URL;

if (!url) {
  console.error("Missing Redis env: set REDIS_URL / REDIS_PRIVATE_URL / REDIS_PUBLIC_URL");
  process.exit(1);
}

const r = new Redis(url, { maxRetriesPerRequest: 3, enableReadyCheck: true });

/** Colapsează partea variabilă a cheii ca să grupăm pe namespace. */
function bucket(key: string): string {
  return key
    .replace(/0x[0-9a-fA-F]{40,64}/g, "{evm}")            // EVM address / bytes32 poolId
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "{b58}");    // base58 (Solana mint/pool/sig)
}

async function scanAll(pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await r.scan(cursor, "MATCH", pattern, "COUNT", 1000);
    cursor = next;
    out.push(...keys);
  } while (cursor !== "0");
  return out;
}

async function main() {
  console.log("Scanning preflight:* ...");
  const keys = await scanAll("preflight:*");
  console.log(`Total chei preflight:* = ${keys.length}\n`);

  // TTL pentru fiecare cheie (pipeline în batch-uri)
  const ttl = new Map<string, number>();
  const BATCH = 500;
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    const pipe = r.pipeline();
    slice.forEach(k => pipe.ttl(k));
    const res = await pipe.exec();
    res?.forEach(([, v], j) => ttl.set(slice[j], Number(v)));
  }

  // Agregare pe bucket
  type Agg = { count: number; permanent: number; withTtl: number; type?: string };
  const agg = new Map<string, Agg>();
  for (const k of keys) {
    const b = bucket(k);
    const a = agg.get(b) ?? { count: 0, permanent: 0, withTtl: 0 };
    a.count++;
    if ((ttl.get(k) ?? -1) === -1) a.permanent++; else a.withTtl++;
    agg.set(b, a);
  }

  // Tip pentru un reprezentant din fiecare bucket
  for (const b of agg.keys()) {
    const sample = keys.find(k => bucket(k) === b);
    if (sample) {
      try { agg.get(b)!.type = await r.type(sample); } catch { /* ignore */ }
    }
  }

  const rows = [...agg.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log("NAMESPACE (colapsat)".padEnd(52), "COUNT".padStart(7), "PERM".padStart(6), "TTL".padStart(6), " TYPE");
  console.log("-".repeat(80));
  for (const [b, a] of rows) {
    console.log(
      b.slice(0, 52).padEnd(52),
      String(a.count).padStart(7),
      String(a.permanent).padStart(6),
      String(a.withTtl).padStart(6),
      " " + (a.type ?? "?"),
    );
  }

  // Mostre de pool records Solana (A2 corruption check)
  console.log("\n=== Mostre preflight:indexed:pair:solana:* (max 5) ===");
  const solPools = keys.filter(k => k.startsWith("preflight:indexed:pair:solana:")).slice(0, 5);
  for (const k of solPools) {
    try {
      const raw = await r.get(k);
      const j = raw ? JSON.parse(raw) : null;
      console.log(
        "  " + k.replace("preflight:indexed:pair:solana:", "").slice(0, 10) + "…",
        "base=" + String(j?.baseMint ?? j?.mint0 ?? "?").slice(0, 10),
        "quote=" + String(j?.quoteMint ?? j?.mint1 ?? "?").slice(0, 10),
        "quoteType=" + (j?.quoteType ?? "?"),
        "source=" + (j?.source ?? "?"),
      );
    } catch (e) {
      console.log("  " + k + " — parse error: " + (e as Error).message);
    }
  }

  // ZSET-uri cheie (dimensiuni)
  console.log("\n=== ZSET-uri index (ZCARD) ===");
  for (const z of ["preflight:indexed:pairs:solana", "preflight:indexed:pairs:ts:solana",
                   "preflight:indexed:launches:solana", "preflight:solana:price:pools"]) {
    try {
      const t = await r.type(z);
      if (t === "zset") console.log("  " + z + " = " + (await r.zcard(z)));
      else if (t !== "none") console.log("  " + z + " (type=" + t + ")");
    } catch { /* ignore */ }
  }

  await r.quit();
}

main().catch(e => { console.error("inspect error:", e); process.exit(1); });
