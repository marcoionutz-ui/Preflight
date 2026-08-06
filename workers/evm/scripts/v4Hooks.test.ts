/**
 * scripts/v4Hooks.test.ts — NF1 (U4): hook-uri V4, model tri-stare + coverage + detecție V4 chain-agnostică.
 * Biții de permisiune sunt în octetul JOS al adresei: 0x8 = beforeSwapReturnDelta, 0x4 = afterSwapReturnDelta.
 *
 * Rulează: `npm run test:u4` (workers/evm). Exercită atât helperele PURE (v4Hooks) cât și normalizatoarele
 * REALE Gecko (normalizePool) + DexScreener (normalizeDsPair) și decizia REALĂ de evidence din brief
 * (hooksEvidenceField din @preflight/schema) — pe fiecare chain, ca să dovedească că NU mai există gating pe Base.
 */
import {
  normalizeHooks, hookReturnsDelta, flowCoverageForPool, isV4PoolAddress,
} from "../src/ws/v4Hooks";
import { normalizePool } from "../src/sources/normalize";
import { normalizeDsPair } from "../src/sources/dexscreener";
import { hooksEvidenceField } from "@preflight/schema";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}
const A = (last: string) => "0x" + "0".repeat(40 - last.length) + last; // adresă 40-hex terminată în `last`
const ZERO = "0x0000000000000000000000000000000000000000";
const CUSTOM_DELTA    = A("8");   // hook cu beforeSwapReturnDelta
const CUSTOM_NO_DELTA = A("40");  // hook (afterSwap) fără return-delta

// Minimal ChainConfig — normalizatoarele reale folosesc DOAR `chain.id` din el.
const chainCfg = (id: string) => ({ id } as any);

// Gecko raw (forma reală citită de normalizePool): attributes.address + name + relationships.
function geckoRaw(address: string, dexId: string, symbol = "PEPE") {
  return {
    attributes: {
      address,
      name: `${symbol} / WETH`,
      base_token_price_usd: "1.5",
      price_change_percentage: { m5: "1", h1: "2", h24: "3" },
      reserve_in_usd: "50000",
      volume_usd: { h24: "12345" },
      transactions: { m5: { buys: 3, sells: 1 }, h1: { buys: 9, sells: 4 } },
    },
    relationships: {
      base_token: { data: { id: `${dexId.includes("v3") ? "eth" : "base"}_0x${"1".repeat(40)}` } },
      dex:        { data: { id: dexId } },
    },
  };
}

// DexScreener raw (forma reală citită de normalizeDsPair).
function dsRaw(pairAddress: string, dexId: string, symbol = "PEPE") {
  return {
    pairAddress,
    priceUsd: "1.5",
    baseToken: { symbol, address: "0x" + "2".repeat(40) },
    dexId,
    priceChange: { m5: 1, h1: 2, h24: 3 },
    liquidity: { usd: 50000 },
    volume: { h24: 12345 },
    txns: { m5: { buys: 3, sells: 1 }, h1: { buys: 9, sells: 4 } },
  };
}

function main(): void {
  console.log("U4 / NF1 — v4Hooks (tri-stare hooks + coverage + detecție V4)");

  // ── normalizeHooks: tri-stare ──────────────────────────────────────────────
  check("1. normalizeHooks: custom non-zero → adresă lowercase", normalizeHooks("0xABcdef0000000000000000000000000000000008") === "0xabcdef0000000000000000000000000000000008");
  check("2. normalizeHooks: zero-address → null (vanilla)",       normalizeHooks(ZERO) === null);
  check("3. normalizeHooks: absent (undefined) → undefined",      normalizeHooks(undefined) === undefined);
  check("4. normalizeHooks: non-string → undefined",             normalizeHooks(123) === undefined);
  check("5. normalizeHooks: malformat (scurt) → undefined",       normalizeHooks("0x1234") === undefined);
  check("6. normalizeHooks: malformat (non-hex) → undefined",     normalizeHooks("0xZZZ...") === undefined);

  // ── hookReturnsDelta ───────────────────────────────────────────────────────
  check("7. return-delta: 0x8 → true",           hookReturnsDelta(A("8")) === true);
  check("8. return-delta: 0x4 → true",           hookReturnsDelta(A("4")) === true);
  check("9. return-delta: 0xc (ambii) → true",   hookReturnsDelta(A("c")) === true);
  check("10. return-delta: 0x40 (fără) → false", hookReturnsDelta(A("40")) === false);
  check("11. return-delta: 0x3 (liquidity delta, nu swap) → false", hookReturnsDelta(A("3")) === false);
  check("12. return-delta: null/zero/invalid → false", !hookReturnsDelta(null) && !hookReturnsDelta(ZERO) && !hookReturnsDelta("0xzz"));

  // ── flowCoverageForPool: matricea completă ─────────────────────────────────
  check("13. V2 → FULL",                         flowCoverageForPool("V2", undefined) === "FULL");
  check("14. V3 → FULL",                         flowCoverageForPool("V3", undefined) === "FULL");
  check("15. V4 + hooks undefined → UNKNOWN",    flowCoverageForPool("V4", undefined) === "UNKNOWN");
  check("16. V4 + hooks null (vanilla) → FULL",  flowCoverageForPool("V4", null) === "FULL");
  check("17. V4 + custom return-delta → EVENT_ONLY", flowCoverageForPool("V4", CUSTOM_DELTA) === "EVENT_ONLY");
  check("18. V4 + custom fără return-delta → FULL",  flowCoverageForPool("V4", CUSTOM_NO_DELTA) === "FULL");

  // ── pipeline: normalize → coverage (end-to-end pe câmpul brut) ──────────────
  const cov = (dexType: string, rawHooks: unknown) => flowCoverageForPool(dexType, normalizeHooks(rawHooks));
  check("19. e2e: V4 + raw custom return-delta → EVENT_ONLY", cov("V4", CUSTOM_DELTA) === "EVENT_ONLY");
  check("20. e2e: V4 + raw zero-address → FULL (vanilla)",    cov("V4", ZERO) === "FULL");
  check("21. e2e: V4 + raw malformat → UNKNOWN",             cov("V4", "0xdead") === "UNKNOWN");
  check("22. e2e: V4 + raw absent → UNKNOWN",                cov("V4", undefined) === "UNKNOWN");
  check("23. e2e: V2 + raw orice → FULL (neschimbat)",       cov("V2", CUSTOM_DELTA) === "FULL");

  // ── isV4PoolAddress: bytes32 pe ORICE chain (nu doar Base) ──────────────────
  const POOLID = "0x" + "a".repeat(64);            // 66 chars = bytes32 poolId V4
  const EVMADDR = "0x" + "b".repeat(40);           // 42 chars = adresă EVM (V2/V3)
  check("24. isV4PoolAddress: bytes32 (66) → true",  isV4PoolAddress(POOLID) === true);
  check("25. isV4PoolAddress: adresă EVM (42) → false", isV4PoolAddress(EVMADDR) === false);
  check("26. isV4PoolAddress: gol/undefined → false", !isV4PoolAddress("") && !isV4PoolAddress(undefined));
  check("27. isV4PoolAddress: garbage → false",       isV4PoolAddress("0xnothex") === false);

  // ── hooksEvidenceField (brief/evidence REAL): model tri-stare, conditional spread ──────────
  // custom → { hooks: adresă }; vanilla → { hooks: null }; V4 fără info / non-V4 → PROPRIETATE ABSENTĂ.
  const evCustom  = hooksEvidenceField("V4", CUSTOM_DELTA);
  const evVanilla = hooksEvidenceField("V4", null);
  const evUnknown = hooksEvidenceField("V4", undefined);
  const evNonV4   = hooksEvidenceField("V2", undefined);
  check("28. evidence: V4 custom → { hooks: adresă }", evCustom.hooks === CUSTOM_DELTA && "hooks" in evCustom);
  check("29. evidence: V4 vanilla → { hooks: null }",  evVanilla.hooks === null && "hooks" in evVanilla);
  check("30. evidence: V4 fără info → proprietate ABSENTĂ", !("hooks" in evUnknown));
  check("31. evidence: non-V4 → proprietate ABSENTĂ",       !("hooks" in evNonV4));

  // ── REAL normalizatoare Gecko + DexScreener + evidence, pe FIECARE chain ────────────────────
  // Dovedește end-to-end că un poolId V4 (bytes32) e detectat V4 pe base/arbitrum/ethereum/bsc
  // (fără gating pe Base), că `chain.id` se propagă corect, iar Gecko/DexScreener — care NU
  // furnizează hooks — dau coverage UNKNOWN onest (nu FULL fals). O adresă EVM rămâne V2/V3.
  const CHAINS = ["base", "arbitrum", "ethereum", "bsc"];
  let geckoV4Ok = 0, geckoV2Ok = 0, geckoV3Ok = 0, dsV4Ok = 0, dsV2Ok = 0, evOk = 0;
  CHAINS.forEach((chain, i) => {
    const cfg      = chainCfg(chain);
    const v4PoolId = "0x" + (10 + i).toString(16).repeat(64); // bytes32 (64 hex) distinct per chain (a…/b…/c…/d…)
    const evmAddr  = "0x" + (i + 1).toString(16).repeat(40);  // adresă EVM 20 bytes distinctă per chain

    // Gecko REAL — V4 poolId (dex uniswap-v4), Gecko nu dă hooks → undefined → coverage UNKNOWN.
    const gV4 = normalizePool(geckoRaw(v4PoolId, "uniswap-v4"), cfg)!;
    const gV4ok = gV4 && gV4.dexType === "V4" && gV4.chain === chain
      && gV4.hooks === undefined
      && flowCoverageForPool(gV4.dexType, gV4.hooks) === "UNKNOWN";
    check(`32.${chain}: Gecko V4 poolId → dexType V4 + coverage UNKNOWN (chain propagat, fără gating)`, !!gV4ok);
    if (gV4ok) geckoV4Ok++;

    // Gecko REAL — adresă EVM + dex non-V3 → V2.
    const gV2 = normalizePool(geckoRaw(evmAddr, "uniswap-v2"), cfg)!;
    const gV2ok = gV2 && gV2.dexType === "V2" && gV2.chain === chain;
    check(`33.${chain}: Gecko adresă EVM (dex v2) → dexType V2`, !!gV2ok);
    if (gV2ok) geckoV2Ok++;

    // Gecko REAL — adresă EVM + dex V3 cunoscut → V3 (V4 are prioritate DOAR pt. bytes32).
    const gV3 = normalizePool(geckoRaw(evmAddr, "uniswap-v3"), cfg)!;
    const gV3ok = gV3 && gV3.dexType === "V3" && gV3.chain === chain;
    check(`34.${chain}: Gecko adresă EVM (dex v3) → dexType V3`, !!gV3ok);
    if (gV3ok) geckoV3Ok++;

    // DexScreener REAL — V4 poolId → V4 + coverage UNKNOWN (DexScreener nu dă hooks).
    const dV4 = normalizeDsPair(dsRaw(v4PoolId, "uniswap"), cfg)!;
    const dV4ok = dV4 && dV4.dexType === "V4" && dV4.chain === chain
      && dV4.hooks === undefined
      && flowCoverageForPool(dV4.dexType, dV4.hooks) === "UNKNOWN";
    check(`35.${chain}: DexScreener V4 poolId → dexType V4 + coverage UNKNOWN (fără gating)`, !!dV4ok);
    if (dV4ok) dsV4Ok++;

    // DexScreener REAL — adresă EVM → V2.
    const dV2 = normalizeDsPair(dsRaw(evmAddr, "uniswap"), cfg)!;
    const dV2ok = dV2 && dV2.dexType === "V2" && dV2.chain === chain;
    check(`36.${chain}: DexScreener adresă EVM → dexType V2`, !!dV2ok);
    if (dV2ok) dsV2Ok++;

    // Brief/evidence REAL — custom/vanilla/unknown pe acest chain, model tri-stare.
    const evC = hooksEvidenceField("V4", CUSTOM_DELTA);
    const evV = hooksEvidenceField("V4", null);
    const evU = hooksEvidenceField("V4", undefined);
    const evChainOk =
      evC.hooks === CUSTOM_DELTA && "hooks" in evC &&   // custom → adresă
      evV.hooks === null && "hooks" in evV &&           // vanilla → null
      !("hooks" in evU);                                // indisponibil → absent
    check(`37.${chain}: evidence hooks tri-stare corect (custom/vanilla/absent)`, evChainOk);
    if (evChainOk) evOk++;
  });
  check("38. Gecko: toate cele 4 chain-uri detectează V4/V2/V3 identic (Base nu mai e special)",
    geckoV4Ok === 4 && geckoV2Ok === 4 && geckoV3Ok === 4);
  check("39. DexScreener: toate cele 4 chain-uri detectează V4/V2 identic (fără gating pe Base)",
    dsV4Ok === 4 && dsV2Ok === 4);
  check("40. evidence: model tri-stare consistent pe toate cele 4 chain-uri", evOk === 4);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
