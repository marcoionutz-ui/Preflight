/**
 * scripts/registryWrite.test.ts — C1.
 *
 * Teste pe ioredis REAL (skip curat exit 0 dacă nu-i Redis). Verifică:
 *   - insertRecordAndIndex: SET NX blob + 2×ZADD ATOMIC (record + ambele index-uri sau nimic).
 *   - casUpdateJson: read-modify-write atomic prin CAS (happy / noop / absent / corrupt / merge concurent).
 *   - primitiva CAS Lua: compară exact, scrie doar la potrivire (respinge write-ul stale → retry în wrapper).
 *
 * NB: Solana și EVM folosesc aceeași primitivă de producție `insertRecordAndIndex` din modulele lor
 * `registryWrite.ts` (byte-identice) — testul de aici acoperă logica Lua pentru ambii workeri.
 */

import Redis from "ioredis";
import { insertRecordAndIndex, casUpdateJson } from "../src/discovery/registryWrite";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const K   = "preflight:test:c1:blob";
const ZA  = "preflight:test:c1:zsetA";
const ZB  = "preflight:test:c1:zsetB";
const KC  = "preflight:test:c1:cas";
const KX  = "preflight:test:c1:corrupt";
const KM  = "preflight:test:c1:merge";
const KP  = "preflight:test:c1:cas_primitive";
const ALL = [K, ZA, ZB, KC, KX, KM, KP];

interface Rec { a?: number; b?: number; sym?: string; grad?: boolean; }

async function main(): Promise<void> {
  console.log("C1 — registryWrite (insert atomic + CAS)");

  const url = process.env.INDEXER_TEST_REDIS_URL || "redis://127.0.0.1:6379";
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  r.on("error", () => { /* mut */ });
  try {
    await r.connect();
  } catch {
    console.log("\n⚠️  Redis indisponibil (" + url + ") — SKIP; testul C1 Solana necesită Redis real.");
    console.log("\n0 passed, 0 failed (skip)");
    await r.quit().catch(() => {});
    process.exit(0);
    return;
  }

  await r.del(...ALL);

  // ── insertRecordAndIndex: atomic SET NX + 2 ZADD ──────────────────────────
  const ok1 = await insertRecordAndIndex(r, {
    jsonKey: K, blob: '{"v":1}', member: "m1",
    zsetA: ZA, scoreA: 100, zsetB: ZB, scoreB: 5000,
  });
  check("1a. insert nou → true", ok1 === true);
  check("1b. blob scris", (await r.get(K)) === '{"v":1}');
  check("1c. zsetA are member cu scor corect", (await r.zscore(ZA, "m1")) === "100");
  check("1d. zsetB are member cu scor corect", (await r.zscore(ZB, "m1")) === "5000");

  const ok2 = await insertRecordAndIndex(r, {
    jsonKey: K, blob: '{"v":999}', member: "m1",
    zsetA: ZA, scoreA: 111, zsetB: ZB, scoreB: 9999,
  });
  check("2a. insert dup → false (EXISTS)", ok2 === false);
  check("2b. blob NU e suprascris", (await r.get(K)) === '{"v":1}');
  check("2c. zsetA scor NEschimbat (fără re-ZADD)", (await r.zscore(ZA, "m1")) === "100");
  check("2d. zsetB scor NEschimbat", (await r.zscore(ZB, "m1")) === "5000");

  // ── fault-path: validate-before-write (review varu — dovada „totul sau nimic") ──
  await r.del(...ALL);
  await r.set(ZA, "wrong-type"); // ZA e STRING, nu ZSET
  let threwType = false;
  try {
    await insertRecordAndIndex(r, { jsonKey: K, blob: '{"v":1}', member: "m1", zsetA: ZA, scoreA: 100, zsetB: ZB, scoreB: 5000 });
  } catch { threwType = true; }
  check("2e. fault: WRONGTYPE respins (aruncă)", threwType);
  check("2f. fault: blob NU a fost scris (fără stare parțială)", (await r.get(K)) === null);
  check("2g. fault: zsetB NU a fost atins", (await r.zscore(ZB, "m1")) === null);
  await r.del(...ALL);
  let threwScore = false;
  try {
    await insertRecordAndIndex(r, { jsonKey: K, blob: '{"v":1}', member: "m1", zsetA: ZA, scoreA: Infinity, zsetB: ZB, scoreB: 5000 });
  } catch { threwScore = true; }
  check("2h. fault: scor Infinity respins (aruncă)", threwScore);
  check("2i. fault: blob NU a fost scris", (await r.get(K)) === null);

  // ── casUpdateJson: happy / noop / absent / corrupt ────────────────────────
  await r.set(KC, JSON.stringify({ a: 1, b: 2 }));
  const c1 = await casUpdateJson<Rec>(r, KC, (o) => ({ ...o, a: 10 }));
  check("3a. cas update → ok", c1 === "ok");
  const after = JSON.parse((await r.get(KC))!) as Rec;
  check("3b. câmp modificat (a=10)", after.a === 10);
  check("3c. câmp neatins păstrat (b=2)", after.b === 2);

  const c2 = await casUpdateJson<Rec>(r, KC, () => null);
  check("4a. mutate null → noop", c2 === "noop");
  check("4b. valoare neschimbată la noop", JSON.parse((await r.get(KC))!).a === 10);

  const c3 = await casUpdateJson<Rec>(r, "preflight:test:c1:absent", (o) => o);
  check("5. cheie absentă → absent", c3 === "absent");

  await r.set(KX, "nu-i json valid {");
  const c4 = await casUpdateJson<Rec>(r, KX, (o) => o);
  check("6. JSON corupt → corrupt", c4 === "corrupt");

  // ── primitiva CAS Lua (replicat): compară exact, scrie doar la potrivire ───
  const LUA_CAS = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0`;
  await r.set(KP, "v1");
  const p1 = await r.eval(LUA_CAS, 1, KP, "v1", "v2");
  check("7a. CAS cu expected corect → 1", Number(p1) === 1);
  check("7b. valoarea a devenit v2", (await r.get(KP)) === "v2");
  const p2 = await r.eval(LUA_CAS, 1, KP, "v1", "v3"); // expected stale (acum e v2)
  check("7c. CAS cu expected stale → 0 (respins)", Number(p2) === 0);
  check("7d. valoarea NEschimbată (tot v2)", (await r.get(KP)) === "v2");

  // ── merge concurent: două update-uri pe câmpuri disjuncte nu se pierd ──────
  // Simulează exact race-ul linkLaunchToPool (grad) vs enrichLaunchRecord (sym).
  await r.set(KM, JSON.stringify({ a: 0 }));
  const [m1, m2] = await Promise.all([
    casUpdateJson<Rec>(r, KM, (o) => ({ ...o, sym: "TOK" })),   // enrich
    casUpdateJson<Rec>(r, KM, (o) => ({ ...o, grad: true })),   // graduation
  ]);
  check("8a. ambele update-uri concurente → ok", m1 === "ok" && m2 === "ok");
  const merged = JSON.parse((await r.get(KM))!) as Rec;
  check("8b. câmpul enrich prezent (sym)", merged.sym === "TOK");
  check("8c. câmpul graduation prezent (grad)", merged.grad === true);
  check("8d. câmpul original păstrat (a=0)", merged.a === 0);

  await r.del(...ALL);
  await r.quit().catch(() => {});
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
