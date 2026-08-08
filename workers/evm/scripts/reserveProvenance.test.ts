/**
 * scripts/reserveProvenance.test.ts — NF/U5: proveniența reserveUsd (V4 estimat) + gating conservator.
 *
 * V4 `reserveUsd` vine din virtual reserves (StateView.getLiquidity × sqrtPrice × 2) — ESTIMAT care
 * SUPRAESTIMEAZĂ pozițiile concentrate. Testăm: (A) isEstimatedReserve (doar V4_STATE_LIQUIDITY);
 * (B) liquidityBars (praguri mai mari pt. estimat); (C) classifyLiquidity — un estimat V4 NU mai citește
 * CONFIRMED la același prag ca o rezervă reală (contrastul-cheie); (D) proveniența e PROPAGATĂ prin
 * normalizatoarele REALE Gecko/DexScreener + toSourcePool (indexer) — înainte se pierdea la SourcePool.
 *
 * Rulează: `npm run test:u5` (workers/evm).
 */
import { isEstimatedReserve, reserveEstimatedFlag, type ReserveSource } from "@preflight/schema";
import { classifyLiquidity, liquidityBars, deriveLiquidityTier, reserveSourceForRestore } from "../src/risk/liquidityClassify";
import { normalizePool } from "../src/sources/normalize";
import { normalizeDsPair } from "../src/sources/dexscreener";
import { toSourcePool } from "../src/sources/indexed";
// Funcția de PRODUCȚIE (nu leaf-ul) — dovedește că preflight-redis (momentum/signal/qualified/pair_context) plafonează.
import { deriveLiquidityStatus as prodDeriveLiquidityStatus } from "../src/lib/preflight-redis";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const MIN = 60_000;
const chainCfg = (id: string) => ({ id } as any);

function geckoRaw(address: string, dexId: string, reserveUsd: number, symbol = "PEPE") {
  return {
    attributes: {
      address, name: `${symbol} / WETH`, base_token_price_usd: "1.5",
      price_change_percentage: { m5: "1", h1: "2", h24: "3" },
      reserve_in_usd: String(reserveUsd), volume_usd: { h24: "1" },
      transactions: { m5: { buys: 1, sells: 1 } },
    },
    relationships: { base_token: { data: { id: "base_0x" + "1".repeat(40) } }, dex: { data: { id: dexId } } },
  };
}
function dsRaw(pairAddress: string, dexId: string, reserveUsd: number, symbol = "PEPE") {
  return {
    pairAddress, priceUsd: "1.5", baseToken: { symbol, address: "0x" + "2".repeat(40) },
    dexId, priceChange: { m5: 1, h1: 2, h24: 3 }, liquidity: { usd: reserveUsd },
    volume: { h24: 1 }, txns: { m5: { buys: 1, sells: 1 } },
  };
}
// IndexedPair minimal (indexer record) — toSourcePool citește chain/pairAddress/dexId/reserveUsd/reserveSource.
const idxPair = (dexId: string, reserveUsd: number, reserveSource?: ReserveSource) => ({
  chain: "base", dexId, pairAddress: "0x" + "a".repeat(dexId === "uniswap-v4" ? 64 : 40),
  token0: "0x" + "1".repeat(40), token1: "0x" + "2".repeat(40), blockNumber: 1, txHash: "0x", discoveredAt: 0,
  priceUsd: 1, reserveUsd, priceStatus: "OK", pricedAt: 0, reserveSource,
} as any);

function main(): void {
  console.log("U5 / NF — reserve provenance (V4 estimat) + gating conservator");

  // ── A. isEstimatedReserve: DOAR V4_STATE_LIQUIDITY ─────────────────────────
  check("1. estimat: V4_STATE_LIQUIDITY → true", isEstimatedReserve("V4_STATE_LIQUIDITY") === true);
  check("2. real: V2_RESERVES → false",          isEstimatedReserve("V2_RESERVES") === false);
  check("3. real: BALANCE_OF → false",           isEstimatedReserve("BALANCE_OF") === false);
  check("4. raportat: GECKO_REPORTED → false",    isEstimatedReserve("GECKO_REPORTED") === false);
  check("5. raportat: DEXSCREENER_REPORTED → false", isEstimatedReserve("DEXSCREENER_REPORTED") === false);
  check("6. UNKNOWN_V4 (fără lichiditate) → false", isEstimatedReserve("UNKNOWN_V4") === false);
  check("7. null/undefined → false",             !isEstimatedReserve(null) && !isEstimatedReserve(undefined));

  // ── B. liquidityBars: estimat V4 = praguri MAI MARI ────────────────────────
  const barReal = liquidityBars("V2_RESERVES");
  const barEst  = liquidityBars("V4_STATE_LIQUIDITY");
  check("8. real: bars {25k,5k} estimated=false", barReal.confirmedUsd === 25_000 && barReal.weakUsd === 5_000 && barReal.estimated === false);
  check("9. ★ V4 estimat: confirmedUsd=Infinity (CONFIRMED imposibil), weakUsd=25k", barEst.confirmedUsd === Infinity && barEst.weakUsd === 25_000 && barEst.estimated === true);
  check("10. undefined → bars reale (nu penaliza necunoscut)", liquidityBars(undefined).confirmedUsd === 25_000);

  // ── C. classifyLiquidity: estimat V4 NICIODATĂ CONFIRMED (decizia varu) ─────
  // Aceeași rezervă $30k proaspătă: REALĂ → CONFIRMED, ESTIMAT V4 → doar WEAK.
  check("11. real $30k/1min → CONFIRMED",      classifyLiquidity(30_000, 1 * MIN, "V2_RESERVES") === "CONFIRMED");
  check("12. ★ V4 estimat $30k/1min → WEAK (NU CONFIRMED)", classifyLiquidity(30_000, 1 * MIN, "V4_STATE_LIQUIDITY") === "WEAK");
  check("13. undefined $30k/1min → CONFIRMED (real, nepenalizat)", classifyLiquidity(30_000, 1 * MIN, undefined) === "CONFIRMED");
  check("14. ★ V4 estimat $100k/1min → WEAK (NU CONFIRMED)", classifyLiquidity(100_000, 1 * MIN, "V4_STATE_LIQUIDITY") === "WEAK");
  check("15. ★ V4 estimat $1B/1min → WEAK (niciodată CONFIRMED, oricât de mare)", classifyLiquidity(1_000_000_000, 1 * MIN, "V4_STATE_LIQUIDITY") === "WEAK");
  check("16. V4 estimat $24.9k/1min → MISSING (sub prag WEAK)", classifyLiquidity(24_999, 1 * MIN, "V4_STATE_LIQUIDITY") === "MISSING");
  check("17. real $5k/1min → WEAK",            classifyLiquidity(5_000, 1 * MIN, "BALANCE_OF") === "WEAK");
  check("18. real $4.9k/1min → MISSING",       classifyLiquidity(4_999, 1 * MIN, "V2_RESERVES") === "MISSING");
  // freshness boundaries (strict <)
  check("19. real $30k @ 4:59 → CONFIRMED",    classifyLiquidity(30_000, 5 * MIN - 1, "V2_RESERVES") === "CONFIRMED");
  check("20. real $30k @ 5:00 → WEAK (nu mai e fresh pt. CONFIRMED)", classifyLiquidity(30_000, 5 * MIN, "V2_RESERVES") === "WEAK");
  check("21. real $30k @ 10:00 → MISSING (stale)", classifyLiquidity(30_000, 10 * MIN, "V2_RESERVES") === "MISSING");
  check("22. ★ V4 estimat $1B stale (@10:00) → MISSING", classifyLiquidity(1_000_000_000, 10 * MIN, "V4_STATE_LIQUIDITY") === "MISSING");
  // guards
  check("23. reserveUsd 0 → MISSING",          classifyLiquidity(0, 1 * MIN, "V2_RESERVES") === "MISSING");
  check("24. reserveUsd negativ → MISSING",    classifyLiquidity(-1, 1 * MIN, "V2_RESERVES") === "MISSING");
  check("25. freshness negativ (viitor) → MISSING", classifyLiquidity(30_000, -1, "V2_RESERVES") === "MISSING");
  check("26. reserveUsd NaN → MISSING",        classifyLiquidity(NaN, 1 * MIN, "V2_RESERVES") === "MISSING");
  check("27. freshness NaN → MISSING",         classifyLiquidity(30_000, NaN, "V2_RESERVES") === "MISSING");

  // ── D. PROPAGARE prin funcțiile REALE (provenance nu se mai pierde) ─────────
  // Gecko/DexScreener raportează lichiditate reală → tag-uite ca reported (NU estimat).
  const g = normalizePool(geckoRaw("0x" + "b".repeat(40), "uniswap-v2", 40_000), chainCfg("base"))!;
  check("28. normalizePool (Gecko) → reserveSource GECKO_REPORTED", g.reserveSource === "GECKO_REPORTED");
  check("29. Gecko reserveSource NU e estimat", isEstimatedReserve(g.reserveSource) === false);
  const d = normalizeDsPair(dsRaw("0x" + "c".repeat(40), "uniswap", 40_000), chainCfg("base"))!;
  check("30. normalizeDsPair (DexScreener) → DEXSCREENER_REPORTED", d.reserveSource === "DEXSCREENER_REPORTED");

  // Indexer toSourcePool: proveniența trece prin (înainte se PIERDEA aici).
  const spV4 = toSourcePool(idxPair("uniswap-v4", 80_000, "V4_STATE_LIQUIDITY"), chainCfg("base"));
  check("31. ★ toSourcePool carry V4_STATE_LIQUIDITY (înainte se pierdea)", spV4.reserveSource === "V4_STATE_LIQUIDITY");
  check("32. ★ SourcePool V4 estimat → isEstimatedReserve true (ajunge la consumatori)", isEstimatedReserve(spV4.reserveSource) === true);
  const spV2 = toSourcePool(idxPair("uniswap-v2", 80_000, "V2_RESERVES"), chainCfg("base"));
  check("33. toSourcePool carry V2_RESERVES (reală)", spV2.reserveSource === "V2_RESERVES" && isEstimatedReserve(spV2.reserveSource) === false);
  const spNone = toSourcePool(idxPair("uniswap-v2", 80_000, undefined), chainCfg("base"));
  check("34. toSourcePool fără reserveSource → undefined (nu inventează)", spNone.reserveSource === undefined);

  // ── E. end-to-end: SourcePool V4 estimat → classifyLiquidity conservator ────
  // Un pool V4 cu estimat $30k (proaspăt) NU trece drept CONFIRMED (contrastul cu o rezervă reală $30k).
  check("35. e2e: SourcePool V4 estimat $30k → classify WEAK", classifyLiquidity(30_000, 1 * MIN, spV4.reserveSource ?? null) === "WEAK");
  check("36. e2e: SourcePool V2 reală $30k → classify CONFIRMED", classifyLiquidity(30_000, 1 * MIN, spV2.reserveSource ?? null) === "CONFIRMED");

  // ── F. deriveLiquidityTier (clasificarea derivată din semnale) — NICIODATĂ CONFIRMED/DEEP pt. estimat V4 ──
  // Folosit REAL de preflight-redis.ts (momentum/signal/qualified). Estimatul V4 nu mai poate reconstrui
  // CONFIRMED/DEEP din raw reserveUsd (blocker #2 varu). Rezervele reale păstrează comportamentul standard.
  check("37. derived real $600k → DEEP",        deriveLiquidityTier(600_000, "", "V2_RESERVES") === "DEEP");
  check("38. derived real $150k → CONFIRMED",   deriveLiquidityTier(150_000, "", "V2_RESERVES") === "CONFIRMED");
  check("39. derived real liqStatus=CONFIRMED → CONFIRMED", deriveLiquidityTier(50_000, "CONFIRMED", "V2_RESERVES") === "CONFIRMED");
  check("40. ★ derived V4 estimat $600k → OK (NU DEEP)",      deriveLiquidityTier(600_000, "", "V4_STATE_LIQUIDITY") === "OK");
  check("41. ★ derived V4 estimat $150k → OK (NU CONFIRMED)", deriveLiquidityTier(150_000, "", "V4_STATE_LIQUIDITY") === "OK");
  check("42. ★ derived V4 estimat $1B + liqStatus=CONFIRMED → OK (nu reconstrui)", deriveLiquidityTier(1_000_000_000, "CONFIRMED", "V4_STATE_LIQUIDITY") === "OK");
  check("43. derived V4 estimat <$15k → THIN (ca oricare)", deriveLiquidityTier(10_000, "", "V4_STATE_LIQUIDITY") === "THIN");
  check("44. ★ derived: pt. V4 estimat, NICIODATĂ CONFIRMED/DEEP (baterie)", [50_000, 150_000, 600_000, 1e9].every(r => { const t = deriveLiquidityTier(r, "CONFIRMED", "V4_STATE_LIQUIDITY"); return t !== "CONFIRMED" && t !== "DEEP"; }));

  // ── G. reserveEstimatedFlag: TRI-STARE (R3 varu — necunoscut ≠ false) ──────────────────────
  check("45. flag: V4_STATE_LIQUIDITY → true",       reserveEstimatedFlag("V4_STATE_LIQUIDITY") === true);
  check("46. flag: V2_RESERVES → false (reală cunoscută)", reserveEstimatedFlag("V2_RESERVES") === false);
  check("47. flag: GECKO_REPORTED → false",          reserveEstimatedFlag("GECKO_REPORTED") === false);
  check("48. ★ flag: null → null (necunoscut, NU false)",    reserveEstimatedFlag(null) === null);
  check("49. ★ flag: undefined → null (necunoscut, NU false)", reserveEstimatedFlag(undefined) === null);
  check("50. ★ flag: 'UNKNOWN' → null (proveniență necunoscută)", reserveEstimatedFlag("UNKNOWN") === null);

  // ── H. restart honesty: helperul REAL de producție reserveSourceForRestore (nu o copie a ternarului) ─────
  // memory.ts la restore folosește EXACT reserveSourceForRestore(addr). Un pool V4 restaurat NU redevine CONFIRMED.
  const V4_ADDR = "0x" + "a".repeat(64); // poolId bytes32
  const V2_ADDR = "0x" + "b".repeat(40); // adresă EVM
  check("51. ★ reserveSourceForRestore(V4 poolId) → V4_STATE_LIQUIDITY", reserveSourceForRestore(V4_ADDR) === "V4_STATE_LIQUIDITY");
  check("52. reserveSourceForRestore(adresă EVM) → undefined (real)",     reserveSourceForRestore(V2_ADDR) === undefined);
  check("53. ★ restore V4 → $30k WEAK (nu CONFIRMED)", classifyLiquidity(30_000, 1 * MIN, reserveSourceForRestore(V4_ADDR)) === "WEAK");
  check("54. restore V2 → $30k CONFIRMED (real)",      classifyLiquidity(30_000, 1 * MIN, reserveSourceForRestore(V2_ADDR)) === "CONFIRMED");

  // ── I. FUNCȚIA DE PRODUCȚIE preflight-redis.deriveLiquidityStatus — plafonează REAL (nu doar leaf-ul) ─────
  // Dovedește că momentum/signal/qualified/pair_context (care apelează acest export) NU mai raportează DEEP/CONFIRMED
  // pe un estimat V4, oricât de mare. (Înainte runtime-ul întorcea DEEP — vezi review varu.)
  check("55. ★ PROD deriveLiquidityStatus: V4 estimat $1B → OK (NU DEEP)", prodDeriveLiquidityStatus(1_000_000_000, "CONFIRMED", "V4_STATE_LIQUIDITY") === "OK");
  check("56. ★ PROD deriveLiquidityStatus: V4 estimat $150k → OK (NU CONFIRMED)", prodDeriveLiquidityStatus(150_000, "", "V4_STATE_LIQUIDITY") === "OK");
  check("57. PROD deriveLiquidityStatus: real $600k → DEEP (neschimbat)", prodDeriveLiquidityStatus(600_000, "", "V2_RESERVES") === "DEEP");
  check("58. PROD deriveLiquidityStatus: real $150k → CONFIRMED (neschimbat)", prodDeriveLiquidityStatus(150_000, "", "V2_RESERVES") === "CONFIRMED");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
