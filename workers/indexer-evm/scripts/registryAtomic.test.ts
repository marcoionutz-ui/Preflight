/**
 * scripts/registryAtomic.test.ts — C1 (indexer-evm).
 *
 * Testează pe Redis REAL (skip curat) `insertRecordAndIndex` din `registryWrite.ts` — funcția REALĂ
 * IMPORTATĂ din producție (nu un Lua replicat → fără drift, fix hardening varu). Acoperă: insert atomic
 * (SET NX + ambele ZADD sau nimic), duplicat, și **fault-path** (validate-before-write: WRONGTYPE /
 * scor invalid → respins ÎNAINTE de orice write, deci fără stare parțială).
 */

import Redis from "ioredis";
import { insertRecordAndIndex } from "../src/discovery/registryWrite";
import { pricingInputsMatch, shouldApplyComputedPricing, type PricingInputsSnapshot } from "../src/discovery/pricingInputs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const K  = "preflight:test:c1evm:pair:0xabc";
const ZA = "preflight:test:c1evm:pairs";
const ZB = "preflight:test:c1evm:pairs:ts";
const ALL = [K, ZA, ZB];

async function main(): Promise<void> {
  console.log("C1 — pairRegistry insert+index atomic (EVM, funcția reală)");

  // ── pricingInputsMatch — race stale-pricing-input (review varu r3), PUR (mereu rulează) ──
  const snap: PricingInputsSnapshot = { baseToken: "0xb", quoteToken: "0xq", quoteStatus: "OK", baseDecimals: 18, quoteDecimals: 6 };
  check("P1. inputuri identice → true", pricingInputsMatch(snap, { ...snap }) === true);
  check("P2. baseDecimals schimbat → false", pricingInputsMatch(snap, { ...snap, baseDecimals: 9 }) === false);
  check("P3. quoteDecimals schimbat → false", pricingInputsMatch(snap, { ...snap, quoteDecimals: 18 }) === false);
  check("P4. quoteToken schimbat → false", pricingInputsMatch(snap, { ...snap, quoteToken: "0xother" }) === false);
  check("P5. quoteStatus schimbat → false", pricingInputsMatch(snap, { ...snap, quoteStatus: "NO_KNOWN_QUOTE" }) === false);
  check("P6. baseToken schimbat → false", pricingInputsMatch(snap, { ...snap, baseToken: "0xother" }) === false);
  check("P7. decimals lipsă ambele → true", pricingInputsMatch({ baseToken: "0xb" }, { baseToken: "0xb" }) === true);
  check("P8. null vs valoare (baseDecimals) → false", pricingInputsMatch({ baseToken: "0xb" }, { baseToken: "0xb", baseDecimals: 18 }) === false);
  check("P9. quoteStatus lipsă == NO_KNOWN_QUOTE → true", pricingInputsMatch({ baseToken: "0xb" }, { baseToken: "0xb", quoteStatus: "NO_KNOWN_QUOTE" }) === true);
  // decizia reprice = inputuri identice ȘI candidate STRICT mai nou (mirror al guard-ului din repricePair)
  const shouldApply = (cur: PricingInputsSnapshot & { pricedAt?: number }, candPricedAt: number) =>
    pricingInputsMatch(snap, cur) && (cur.pricedAt ?? 0) < candPricedAt;
  check("P10. inputuri egale + candidate strict mai nou → aplică", shouldApply({ ...snap, pricedAt: 100 }, 200) === true);
  check("P11. inputuri egale + pricedAt EGAL → NU aplica", shouldApply({ ...snap, pricedAt: 200 }, 200) === false);
  check("P12. inputuri egale + current mai nou → NU aplica", shouldApply({ ...snap, pricedAt: 300 }, 200) === false);
  check("P13. inputuri schimbate + candidate mai nou → NU aplica", shouldApply({ ...snap, baseDecimals: 9, pricedAt: 100 }, 200) === false);

  // ── shouldApplyComputedPricing — decizia ENRICH (asimetrică: invalidare pe schimbare de inputuri, review varu r4) ──
  const decide = (cur: PricingInputsSnapshot & { pricedAt?: number }, cand: number) => shouldApplyComputedPricing(snap, cur, cand);
  check("E1. inputuri identice + candidate mai nou → true", decide({ ...snap, pricedAt: 100 }, 200) === true);
  check("E2. inputuri identice + timestamp EGAL → false", decide({ ...snap, pricedAt: 200 }, 200) === false);
  check("E3. inputuri identice + current mai nou → false", decide({ ...snap, pricedAt: 300 }, 200) === false);
  check("E4. inputuri SCHIMBATE + current timestamp NOU → true (invalidare pricing stale)", decide({ ...snap, baseDecimals: 9, pricedAt: 999 }, 100) === true);
  check("E5. inputuri schimbate + candidate mai nou → true", decide({ ...snap, quoteToken: "0xz", pricedAt: 100 }, 200) === true);

  const url = process.env.INDEXER_TEST_REDIS_URL || "redis://127.0.0.1:6379";
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  r.on("error", () => { /* mut */ });
  try {
    await r.connect();
  } catch {
    console.log("\n⚠️  Redis indisponibil (" + url + ") — partea pe Redis skip-uită; checks-urile pure au rulat.");
    console.log(`\n${passed} passed, ${failed} failed (doar pure; Redis skip)`);
    await r.quit().catch(() => {});
    process.exit(failed === 0 ? 0 : 1);
    return;
  }

  await r.del(...ALL);
  const insert = (blob: string, member: string, sa: number, sb: number) =>
    insertRecordAndIndex(r, { jsonKey: K, blob, member, zsetA: ZA, scoreA: sa, zsetB: ZB, scoreB: sb });

  const ok1 = await insert('{"pairAddress":"0xabc","v":1}', "0xabc", 1500, 1710000000000);
  check("1a. insert nou → true", ok1 === true);
  check("1b. blob scris", (await r.get(K)) === '{"pairAddress":"0xabc","v":1}');
  check("1c. blockSet are member (scor=blockNumber)", (await r.zscore(ZA, "0xabc")) === "1500");
  check("1d. tsSet are member (scor=discoveredAt)", (await r.zscore(ZB, "0xabc")) === "1710000000000");

  const ok2 = await insert('{"pairAddress":"0xabc","v":999}', "0xabc", 2000, 1720000000000);
  check("2a. insert dup → false (EXISTS)", ok2 === false);
  check("2b. blob NU e suprascris", (await r.get(K)) === '{"pairAddress":"0xabc","v":1}');
  check("2c. blockSet scor NEschimbat", (await r.zscore(ZA, "0xabc")) === "1500");
  check("2d. tsSet scor NEschimbat", (await r.zscore(ZB, "0xabc")) === "1710000000000");

  // ── fault-path: WRONGTYPE respins ÎNAINTE de write (validate-before-write) ──
  await r.del(...ALL);
  await r.set(ZA, "wrong-type"); // ZA e acum STRING, nu ZSET
  let threwType = false;
  try {
    await insert('{"v":1}', "m1", 100, 5000);
  } catch { threwType = true; }
  check("3a. fault: script respinge WRONGTYPE (aruncă)", threwType);
  check("3b. fault: blob NU a fost scris (fără stare parțială)", (await r.get(K)) === null);
  check("3c. fault: zsetB NU a fost atins", (await r.zscore(ZB, "m1")) === null);

  // ── fault-path: scor invalid respins ÎNAINTE de write ─────────────────────
  await r.del(...ALL);
  let threwScore = false;
  try {
    await insert('{"v":1}', "m1", Infinity, 5000);
  } catch { threwScore = true; }
  check("4a. fault: scor Infinity respins (aruncă)", threwScore);
  check("4b. fault: blob NU a fost scris", (await r.get(K)) === null);

  await r.del(...ALL);
  await r.quit().catch(() => {});
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
