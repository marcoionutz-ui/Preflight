/**
 * scripts/registryAtomic.test.ts — C1 (indexer-evm).
 *
 * Testează pe Redis REAL (skip curat) `insertRecordAndIndex` din `registryWrite.ts` — funcția REALĂ
 * IMPORTATĂ din producție (nu un Lua replicat → fără drift, fix hardening varu). Acoperă: insert atomic
 * (SET NX + ambele ZADD sau nimic), duplicat, și **fault-path** (validate-before-write: WRONGTYPE /
 * scor invalid → respins ÎNAINTE de orice write, deci fără stare parțială).
 */

import Redis from "ioredis";
import { insertRecordAndIndex, casUpdateJson } from "../src/discovery/registryWrite";
import { pricingInputsMatch, shouldApplyComputedPricing, type PricingInputsSnapshot } from "../src/discovery/pricingInputs";
// P1-2/P1-3: mutațiile CAS reale din producție (leaf — import type strip-uit de tsx, fără deps grele).
import { buildEnrichMutation, buildRepriceMutation, isEnrichServable } from "../src/discovery/registryMerge";
import type { IndexedPair, PricingFields, MetadataFields } from "../src/discovery/pairRegistry";

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

  // ── buildRepriceMutation / buildEnrichMutation — mutațiile CAS reale (P1-2/P1-3), PURE ──────────────
  // Fixtures minimale: IndexedPair core + pricing. `over` suprascrie câmpuri per-caz.
  const mkPair = (over: Partial<IndexedPair> = {}): IndexedPair => ({
    chain: "base", dexId: "uniswap-v3", pairAddress: "0xabc", token0: "0x0", token1: "0x1",
    blockNumber: 100, txHash: "0xtx", discoveredAt: 1_000,
    baseToken: "0xb", quoteToken: "0xq", quoteStatus: "OK", baseDecimals: 18, quoteDecimals: 6,
    metadataStatus: "OK", priceUsd: 1, reserveUsd: 1000, priceStatus: "OK",
    quotePriceSource: "CHAINLINK", pricedAt: 100, ...over,
  });
  const mkPricing = (over: Partial<PricingFields> = {}): PricingFields => ({
    priceUsd: 2, reserveUsd: 2000, priceStatus: "OK", quotePriceSource: "CHAINLINK", pricedAt: 200, ...over,
  });
  const inputs: PricingInputsSnapshot = { baseToken: "0xb", quoteToken: "0xq", quoteStatus: "OK", baseDecimals: 18, quoteDecimals: 6 };

  // buildRepriceMutation: aplică pricing pe CURRENT doar dacă inputurile-s identice ȘI candidatul-i strict mai nou.
  const rp1 = buildRepriceMutation(mkPair({ pricedAt: 100 }), inputs, mkPricing({ pricedAt: 200, priceUsd: 2 }));
  check("R1. reprice: inputuri egale + candidate mai nou → aplică pricing (priceUsd 2, pricedAt 200)",
    rp1 !== null && rp1.priceUsd === 2 && rp1.pricedAt === 200);
  check("R2. reprice: pricedAt EGAL → null (idempotent)",
    buildRepriceMutation(mkPair({ pricedAt: 200 }), inputs, mkPricing({ pricedAt: 200 })) === null);
  check("R3. reprice: current mai nou → null (nu retrograda)",
    buildRepriceMutation(mkPair({ pricedAt: 300 }), inputs, mkPricing({ pricedAt: 200 })) === null);
  check("R4. reprice: enrich a schimbat baseDecimals (18→9) → null (pricing stale, NU aplica deși mai nou)",
    buildRepriceMutation(mkPair({ baseDecimals: 9, pricedAt: 100 }), inputs, mkPricing({ pricedAt: 999 })) === null);
  // merge pe CURRENT, nu pe snapshotul stale: metadata nouă din current e păstrată, doar pricing-ul se schimbă.
  const rp5 = buildRepriceMutation(mkPair({ baseSymbol: "NEW", pricedAt: 100 }), inputs, mkPricing({ pricedAt: 200 }));
  check("R5. reprice: merge pe CURRENT → păstrează baseSymbol nou din registry + aplică pricing",
    rp5 !== null && rp5.baseSymbol === "NEW" && rp5.priceUsd === 2);

  // buildEnrichMutation: metadata SE APLICĂ MEREU; pricing doar dacă inputuri schimbate SAU strict mai nou.
  const meta: MetadataFields = { baseToken: "0xb", quoteToken: "0xq", quoteStatus: "OK", baseSymbol: "SYM", quoteSymbol: "USDC", baseDecimals: 18, quoteDecimals: 6, metadataStatus: "OK" };
  const en1 = buildEnrichMutation(mkPair({ baseSymbol: undefined, pricedAt: 100 }), meta, mkPricing({ pricedAt: 50, priceUsd: 2 }), inputs);
  check("E1'. enrich: inputuri identice + pricing MAI VECHI → metadata aplicată, pricing NEschimbat (priceUsd 1, pricedAt 100)",
    en1.baseSymbol === "SYM" && en1.priceUsd === 1 && en1.pricedAt === 100);
  const en2 = buildEnrichMutation(mkPair({ pricedAt: 100 }), meta, mkPricing({ pricedAt: 200, priceUsd: 2 }), inputs);
  check("E2'. enrich: inputuri identice + pricing mai nou → metadata + pricing (priceUsd 2, pricedAt 200)",
    en2.baseSymbol === "SYM" && en2.priceUsd === 2 && en2.pricedAt === 200);
  // enrich SCHIMBĂ inputurile (current avea baseDecimals=9 vechi) → invalidează pricing stale chiar dacă current e „mai nou".
  const en3 = buildEnrichMutation(mkPair({ baseDecimals: 9, pricedAt: 999 }), meta, mkPricing({ pricedAt: 100, priceUsd: 2 }), inputs);
  check("E3'. enrich: inputuri SCHIMBATE (decimals 9→18) → aplică pricing nou deși current pricedAt mai mare (invalidare)",
    en3.baseDecimals === 18 && en3.priceUsd === 2 && en3.pricedAt === 100);
  check("E4'. enrich: metadata aplicată MEREU chiar când pricing e skip-uit (baseSymbol actualizat)",
    en1.baseSymbol === "SYM" && en1.metadataStatus === "OK");

  // ── P1-3 lifecycle: outcome + log DIN recordul persistat (mutația câștigătoare), NU din candidat (blocker varu) ──
  // Q1: candidat OK mai VECHI + current NEservabil mai NOU (inputuri egale) → CAS păstrează current → persistă
  //     NEservabil → outcome false → coada NU marchează DONE (bugul: înainte returna ok:true pe candidatul OK).
  const q1 = buildEnrichMutation(mkPair({ priceStatus: "NO_RESERVES", pricedAt: 200, priceUsd: 5 }), meta, mkPricing({ priceStatus: "OK", pricedAt: 100, priceUsd: 9 }), inputs);
  check("Q1. lifecycle: candidat OK mai vechi + current NEservabil mai nou → persistă NEservabil, outcome false (NU DONE)",
    q1.priceStatus === "NO_RESERVES" && q1.priceUsd === 5 && isEnrichServable(q1) === false);
  // Q2: candidat NEservabil mai VECHI + current OK mai NOU → CAS păstrează OK → outcome true → coada DONE
  //     (bugul invers: înainte returna retry pe candidatul NEservabil, deși recordul persistat era OK).
  const q2 = buildEnrichMutation(mkPair({ priceStatus: "OK", pricedAt: 200, priceUsd: 5 }), meta, mkPricing({ priceStatus: "NO_RESERVES", pricedAt: 100, priceUsd: 9 }), inputs);
  check("Q2. lifecycle: candidat NEservabil mai vechi + current OK mai nou → persistă OK, outcome true (DONE)",
    q2.priceStatus === "OK" && q2.priceUsd === 5 && isEnrichServable(q2) === true);
  // Q3: mutația câștigătoare = candidatul aplicat (inputuri schimbate) → log/outcome folosesc persistatul (9/OK), nu vreun candidat pierdut.
  const q3 = buildEnrichMutation(mkPair({ baseDecimals: 9, priceStatus: "NO_RESERVES", pricedAt: 999, priceUsd: 5 }), meta, mkPricing({ priceStatus: "OK", pricedAt: 100, priceUsd: 9 }), inputs);
  check("Q3. lifecycle: candidat aplicat (inputuri schimbate) → log/outcome din persistat (priceUsd 9, OK)",
    q3.priceUsd === 9 && q3.priceStatus === "OK" && isEnrichServable(q3) === true);
  check("Q4. isEnrichServable: priceStatus lipsă → false (fail-closed)", isEnrichServable({ priceStatus: undefined }) === false);

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

  // ── casUpdateJson pe Redis REAL (primitivul CAS pe care se bazează P1-3) ──────────────────────────
  await r.del(K);
  await r.set(K, JSON.stringify({ pricedAt: 100, priceUsd: 1 }));
  const cOk = await casUpdateJson<{ pricedAt: number; priceUsd: number }>(r, K, (cur) => ({ ...cur, priceUsd: 2, pricedAt: 200 }));
  check("5a. casUpdateJson: mutație → 'ok'", cOk === "ok");
  check("5b. casUpdateJson: valoarea a fost scrisă", (await r.get(K)) === JSON.stringify({ pricedAt: 200, priceUsd: 2 }));
  const cNoop = await casUpdateJson<{ pricedAt: number }>(r, K, () => null);
  check("5c. casUpdateJson: mutate → null ⇒ 'noop', valoare NEschimbată",
    cNoop === "noop" && (await r.get(K)) === JSON.stringify({ pricedAt: 200, priceUsd: 2 }));
  await r.del(K);
  const cAbsent = await casUpdateJson<{ x: number }>(r, K, (cur) => cur);
  check("5d. casUpdateJson: cheie absentă → 'absent'", cAbsent === "absent");
  await r.set(K, "not-json{");
  const cCorrupt = await casUpdateJson<{ x: number }>(r, K, (cur) => cur);
  check("5e. casUpdateJson: JSON invalid → 'corrupt'", cCorrupt === "corrupt");

  await r.del(...ALL);
  await r.del(K);
  await r.quit().catch(() => {});
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
