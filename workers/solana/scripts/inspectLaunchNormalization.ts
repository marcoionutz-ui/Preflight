/**
 * scripts/inspectLaunchNormalization.ts — NF2/U9: inspecție READ-ONLY a normalizării launch-urilor.
 *
 * Rulează normalizatorul REAL (`classifySolanaLaunchNormalization` din @preflight/schema — exact codul
 * din reader + worker) peste TOATE launch records Solana din Redis-ul de producție și raportează
 * distribuția: current / normalized_pumpfun / normalized_graduated / rejected (+ histogramă de cauze).
 *
 * SCOP (varu): confirmă OFFLINE, ÎNAINTE de orice mutație în producție, că cele ~13.980 de records se
 * normalizează DETERMINIST — dacă `rejected === 0`, adapterul le acoperă pe toate fără invenție și fără
 * pierdere. Dacă apar respingeri, histograma de cauze arată exact ce trebuie tratat.
 *
 * ⚠️ STRICT READ-ONLY: doar SCAN + MGET + ZCARD. NU scrie NIMIC în Redis (nici măcar markere). Migrarea
 * efectivă (rescrierea recordurilor) e o operațiune de cleanup ULTERIOARĂ, separată — nu face parte din U9.
 *
 * Rulare:  REDIS_URL=redis://... npx tsx scripts/inspectLaunchNormalization.ts
 *          (opțional: LAUNCH_SCAN_COUNT, LAUNCH_MGET_BATCH, SAMPLE_REJECTED)
 */

import Redis from "ioredis";
import {
  classifySolanaLaunchNormalization,
  type SolanaLaunchNormalizeOutcome,
} from "@preflight/schema";

const LAUNCH_KEY_PREFIX = "preflight:indexed:launch:solana:";
const LAUNCH_KEY_MATCH  = LAUNCH_KEY_PREFIX + "*";
const TS_ZSET           = "preflight:indexed:launches:ts:solana";
const SLOT_ZSET         = "preflight:indexed:launches:solana";

const SCAN_COUNT   = Number(process.env.LAUNCH_SCAN_COUNT ?? "1000");
const MGET_BATCH   = Number(process.env.LAUNCH_MGET_BATCH ?? "500");
const SAMPLE_LIMIT = Number(process.env.SAMPLE_REJECTED ?? "25");

/**
 * Rezolvă URL-ul Redis. ⚠️ Diagnostic rulat din AFARA Railway (laptop/WSL) → preferă ENDPOINT-ul
 * PUBLIC: `REDIS_PUBLIC_URL` întâi (reachable extern), apoi override explicit `REDIS_URL`, apoi
 * `REDIS_PRIVATE_URL` (host intern `*.railway.internal` — reachable DOAR din rețeaua Railway, dă
 * ECONNRESET/timeout de pe laptop). Escape hatch: `INSPECT_REDIS_URL` bate tot.
 * NU logăm URL-ul (conține parola) — doar ce VARIABILĂ am ales + host:port.
 */
function resolveRedisUrl(): string {
  const candidates: [string, string | undefined][] = [
    ["INSPECT_REDIS_URL", process.env.INSPECT_REDIS_URL],
    ["REDIS_PUBLIC_URL",  process.env.REDIS_PUBLIC_URL],
    ["REDIS_URL",         process.env.REDIS_URL],
    ["REDIS_PRIVATE_URL", process.env.REDIS_PRIVATE_URL],
  ];
  const picked = candidates.find(([, v]) => typeof v === "string" && v.length > 0);
  if (!picked || !picked[1]) {
    console.error("Missing Redis env: set REDIS_PUBLIC_URL (recomandat pt. rulare externă), INSPECT_REDIS_URL, REDIS_URL sau REDIS_PRIVATE_URL");
    process.exit(2);
  }
  const [name, url] = picked;
  let hostPort = "(neparseabil)";
  try { const u = new URL(url); hostPort = u.host; } catch { /* ignore */ }
  console.log("[U9][INSPECT] folosesc " + name + " → " + hostPort + (url.startsWith("rediss://") ? " (TLS)" : ""));
  return url;
}

/** SCAN read-only al tuturor cheilor de launch (NU KEYS — non-blocking, cursor-based). */
async function scanLaunchKeys(redis: Redis): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", LAUNCH_KEY_MATCH, "COUNT", SCAN_COUNT);
    cursor = next;
    for (const k of batch) keys.push(k);
  } while (cursor !== "0");
  // Dedup (SCAN poate întoarce duplicate în timpul rehash-ului).
  return Array.from(new Set(keys));
}

async function main(): Promise<void> {
  const redis = new Redis(resolveRedisUrl(), {
    maxRetriesPerRequest: 5,
    enableReadyCheck: true,
    lazyConnect: false,
    family: 0,              // dual-stack IPv4/IPv6 — proxy-ul public Railway poate fi doar AAAA
    connectTimeout: 15_000, // toleranță la handshake lent prin proxy
    // reîncearcă conexiunea de câteva ori la reset tranzitoriu, apoi renunță (diagnostic, nu daemon)
    retryStrategy: (times) => (times > 6 ? null : Math.min(times * 500, 3_000)),
  });
  redis.on("error", (err) => console.error("[REDIS] error:", err.message));

  console.log("[U9][INSPECT] scanning launch keys (READ-ONLY: SCAN + MGET + ZCARD, no writes)…");

  const [keys, tsCard, slotCard] = await Promise.all([
    scanLaunchKeys(redis),
    redis.zcard(TS_ZSET).catch(() => -1),
    redis.zcard(SLOT_ZSET).catch(() => -1),
  ]);

  console.log(
    "[U9][INSPECT] launch keys (SCAN)=" + keys.length
    + " | ts-zset ZCARD=" + tsCard
    + " | slot-zset ZCARD=" + slotCard,
  );
  if (tsCard >= 0 && tsCard !== keys.length) {
    console.warn(
      "[U9][INSPECT] ⚠️ discrepanță SCAN vs ts-zset (" + keys.length + " vs " + tsCard + ")"
      + " — unele records pot lipsi din indexul de timp; inspecția merge pe SET-ul complet de chei.",
    );
  }

  const tally: Record<SolanaLaunchNormalizeOutcome, number> = {
    current: 0, normalized_pumpfun: 0, normalized_graduated: 0, rejected: 0,
  };
  const rejectReasons: Record<string, number> = {};
  const rejectedSamples: { key: string; reason: string | null }[] = [];
  let emptyRaw = 0;
  let scanned = 0;

  for (let i = 0; i < keys.length; i += MGET_BATCH) {
    const slice = keys.slice(i, i + MGET_BATCH);
    const raws  = await redis.mget(slice);
    for (let j = 0; j < slice.length; j++) {
      scanned++;
      const raw = raws[j];
      if (raw === null || raw === "") { emptyRaw++; continue; } // cheie dispărută între SCAN și MGET
      const res = classifySolanaLaunchNormalization(raw);
      tally[res.outcome]++;
      if (res.outcome === "rejected") {
        const reason = res.reason ?? "(null)";
        rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
        if (rejectedSamples.length < SAMPLE_LIMIT) rejectedSamples.push({ key: slice[j], reason: res.reason });
      }
    }
    if ((i / MGET_BATCH) % 10 === 0) {
      console.log("[U9][INSPECT] progress " + Math.min(i + MGET_BATCH, keys.length) + "/" + keys.length + "…");
    }
  }

  const normalized = tally.normalized_pumpfun + tally.normalized_graduated;
  const classified = scanned - emptyRaw; // efectiv clasificate (records citite non-null)
  console.log("\n" + "=".repeat(64));
  console.log("[U9][INSPECT] RAPORT normalizare launch-uri Solana");
  console.log("=".repeat(64));
  console.log("  scanned (chei)          : " + scanned);
  console.log("  empty/disparute (MGET)  : " + emptyRaw + "   (neclasificate — dispărute între SCAN și MGET)");
  console.log("  classified (efectiv)    : " + classified);
  console.log("  ── outcome (din classified) ──");
  console.log("  current (deja curent)   : " + tally.current);
  console.log("  normalized_pumpfun      : " + tally.normalized_pumpfun);
  console.log("  normalized_graduated    : " + tally.normalized_graduated);
  console.log("  normalized (total)      : " + normalized + "   ← suprafața de migrare (legacy vindecat determinist)");
  console.log("  rejected (fail-closed)  : " + tally.rejected);

  if (tally.rejected > 0) {
    console.log("\n  ── cauze rejected (histogramă) ──");
    for (const [reason, n] of Object.entries(rejectReasons).sort((a, b) => b[1] - a[1])) {
      console.log("    " + n.toString().padStart(6) + "  " + reason);
    }
    console.log("\n  ── mostre rejected (max " + SAMPLE_LIMIT + ") ──");
    for (const s of rejectedSamples) {
      console.log("    " + s.key.replace(LAUNCH_KEY_PREFIX, "mint=") + "  reason=" + s.reason);
    }
  }

  console.log("\n" + "=".repeat(64));
  if (tally.rejected > 0) {
    console.log("  ⚠️ VERDICT: " + tally.rejected + "/" + classified + " records RESPINSE (fail-closed) — vezi histograma de cauze.");
    console.log("     Reader-ul le tratează ca `null` (symbol/bondingCurve → null), worker-ul le sare (skip+log).");
    console.log("     NU se pierde nimic silențios; dar merită investigat înainte de cleanup-ul de migrare.");
  } else if (emptyRaw > 0) {
    // Verdict onest: nu putem afirma „toate" cât timp `emptyRaw` chei n-au fost clasificate (fix cgpt).
    console.log("  🟡 VERDICT: INCONCLUZIV pt. SETUL COMPLET — cele " + classified + " records CLASIFICATE se");
    console.log("     normalizează determinist (0 respinse), DAR " + emptyRaw + " chei au dispărut între SCAN și");
    console.log("     MGET (neclasificate). Re-rulează pt. acoperire completă; verdictul verde acoperă doar clasificatele.");
  } else {
    console.log("  ✅ VERDICT: DETERMINIST OK — toate cele " + classified + " records CLASIFICATE se normalizează");
    console.log("     în union-ul curent fără respingeri (fără invenție, fără pierdere; empty=0 → acoperire completă).");
  }
  console.log("=".repeat(64));

  await redis.quit();
  // Exit 0 chiar dacă există rejected — e un raport diagnostic, nu un gate CI.
  process.exit(0);
}

main().catch((err) => {
  console.error("[U9][INSPECT] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
