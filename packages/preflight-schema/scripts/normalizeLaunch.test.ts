/**
 * scripts/normalizeLaunch.test.ts — NF2/U9: test PUR pentru parseAndNormalizeSolanaLaunch +
 * classifySolanaLaunchNormalization (boundary-ul de normalizare a launch-urilor legacy Solana).
 *
 * Rulează cu tsx (import-urile type-only din index.ts sunt eliminate). Fără Redis, fără rețea.
 * Verifică EXACT regulile Marco/varu: fail-closed pe câmp factual lipsă/greșit; fără graduation →
 * PUMPFUN_LAUNCHED; dovezi coerente → RAYDIUM_POOL_FOUND; contradicție → fail-closed; niciodată inventat.
 */

import {
  classifySolanaLaunchNormalization,
  parseAndNormalizeSolanaLaunch,
  type SolanaLaunchNormalizeOutcome,
} from "../src/index";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; }
  else { failed++; console.error("  ✗ FAIL: " + name); }
}
function eq<T>(name: string, got: T, want: T): void {
  check(name + " (got=" + JSON.stringify(got) + " want=" + JSON.stringify(want) + ")", got === want);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// base58 case-sensitive (NU lowercase). Adrese plauzibile Solana.
const MINT   = "So11111111111111111111111111111111111111112";
const BCURVE = "BondingCurveAddr1111111111111111111111111111";
const ABCURVE = "AssocBondingCurve111111111111111111111111111";
const CREATOR = "CreatorAddr11111111111111111111111111111111A";
const SIG     = "5xSigNaTuReBase58xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const POOL    = "PoolAddr1111111111111111111111111111111111AB";
const POOLSIG = "6ySigPoolBase58xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

/** Un record legacy „pur" (ce scria buildLaunchRecord() pre-8.0h — DOAR bază, fără lifecycle). */
function legacyBase(): Record<string, unknown> {
  return {
    chain: "solana", recordType: "TOKEN_LAUNCH", launchSource: "PUMPFUN",
    mint: MINT, bondingCurveAddress: BCURVE, associatedBondingCurve: ABCURVE,
    creatorAddress: CREATOR, slot: 123456, signature: SIG,
    discoveredAt: "2025-01-01T00:00:00.000Z", indexerVersion: "8.0g",
    // FĂRĂ metadataStatus, lifecycleStage, graduated, raydiumPools — exact cauza NF2.
  };
}
function validLink(): Record<string, unknown> {
  return { poolAddress: POOL, program: "raydium_cpmm", slot: 200000, signature: POOLSIG, linkedAt: "2025-02-01T00:00:00.000Z" };
}

console.log("── A. Parsare (string / obiect / invalid) ──");
{
  const legacy = legacyBase();
  const fromObj = classifySolanaLaunchNormalization(legacy);
  const fromStr = classifySolanaLaunchNormalization(JSON.stringify(legacy));
  eq("A1 obiect legacy → normalized_pumpfun", fromObj.outcome, "normalized_pumpfun");
  eq("A2 string legacy → normalized_pumpfun", fromStr.outcome, "normalized_pumpfun");
  check("A3 string == obiect (value)", JSON.stringify(fromObj.value) === JSON.stringify(fromStr.value));
  eq("A4 JSON invalid → rejected", classifySolanaLaunchNormalization("{not json").outcome, "rejected");
  eq("A4b reason parse:json", classifySolanaLaunchNormalization("{not json").reason, "parse:json");
  eq("A5 null → rejected", classifySolanaLaunchNormalization(null).outcome, "rejected");
  eq("A6 array → rejected", classifySolanaLaunchNormalization([1, 2]).outcome, "rejected");
  eq("A6b array reason", classifySolanaLaunchNormalization([1, 2]).reason, "parse:not_object");
  eq("A7 number → rejected", classifySolanaLaunchNormalization(42).outcome, "rejected");
  eq("A8 string JSON-array → rejected", classifySolanaLaunchNormalization("[]").outcome, "rejected");
}

console.log("── B. Câmpuri factuale de bază (lipsă/greșit → fail-closed) ──");
{
  const fields = [
    "mint", "bondingCurveAddress", "associatedBondingCurve", "creatorAddress",
    "signature", "discoveredAt", "indexerVersion",
  ];
  for (const f of fields) {
    const missing = legacyBase(); delete missing[f];
    eq("B missing " + f + " → rejected", classifySolanaLaunchNormalization(missing).outcome, "rejected");
    eq("B missing " + f + " → reason base:" + f, classifySolanaLaunchNormalization(missing).reason, "base:" + f);
    const empty = legacyBase(); empty[f] = "";
    eq("B empty " + f + " → rejected", classifySolanaLaunchNormalization(empty).outcome, "rejected");
    const wrong = legacyBase(); wrong[f] = 123;
    eq("B wrongtype " + f + " → rejected", classifySolanaLaunchNormalization(wrong).outcome, "rejected");
  }
  // slot = number
  const noSlot = legacyBase(); delete noSlot.slot;
  eq("B missing slot → reason base:slot", classifySolanaLaunchNormalization(noSlot).reason, "base:slot");
  const strSlot = legacyBase(); strSlot.slot = "123";
  eq("B slot string → rejected", classifySolanaLaunchNormalization(strSlot).outcome, "rejected");
  const nanSlot = legacyBase(); nanSlot.slot = NaN;
  eq("B slot NaN → rejected", classifySolanaLaunchNormalization(nanSlot).outcome, "rejected");
  const infSlot = legacyBase(); infSlot.slot = Infinity;
  eq("B slot Infinity → rejected", classifySolanaLaunchNormalization(infSlot).outcome, "rejected");
  const zeroSlot = legacyBase(); zeroSlot.slot = 0;
  eq("B slot 0 → OK (0 e finit valid)", classifySolanaLaunchNormalization(zeroSlot).outcome, "normalized_pumpfun");
}

console.log("── C. Câmpuri-constantă de identitate ──");
{
  const noChain = legacyBase(); delete noChain.chain;
  const r = classifySolanaLaunchNormalization(noChain);
  eq("C1 chain absent → completat (normalized_pumpfun)", r.outcome, "normalized_pumpfun");
  eq("C1b chain completat = solana", r.value?.chain, "solana");
  const wrongChain = legacyBase(); wrongChain.chain = "ethereum";
  eq("C2 chain greșit → rejected", classifySolanaLaunchNormalization(wrongChain).reason, "base:chain_mismatch");
  const noRt = legacyBase(); delete noRt.recordType;
  eq("C3 recordType absent → completat", classifySolanaLaunchNormalization(noRt).value?.recordType, "TOKEN_LAUNCH");
  const wrongRt = legacyBase(); wrongRt.recordType = "SWAP";
  eq("C4 recordType greșit → rejected", classifySolanaLaunchNormalization(wrongRt).reason, "base:recordType_mismatch");
  const wrongLs = legacyBase(); wrongLs.launchSource = "MOONSHOT";
  eq("C5 launchSource greșit → rejected", classifySolanaLaunchNormalization(wrongLs).reason, "base:launchSource_mismatch");
}

console.log("── D. Metadata opțională ──");
{
  const withMeta = legacyBase();
  withMeta.symbol = "WSOL"; withMeta.name = "Wrapped SOL"; withMeta.decimals = 9; withMeta.metaSource = "JUPITER";
  const r = classifySolanaLaunchNormalization(withMeta);
  eq("D1 symbol păstrat", r.value?.symbol, "WSOL");
  eq("D2 name păstrat", r.value?.name, "Wrapped SOL");
  eq("D3 decimals păstrat", r.value?.decimals, 9);
  eq("D4 metaSource păstrat", r.value?.metaSource, "JUPITER");
  const badMeta = legacyBase();
  badMeta.symbol = 123; badMeta.decimals = "nine";
  const r2 = classifySolanaLaunchNormalization(badMeta);
  eq("D5 symbol greșit tipat → dropat (undefined)", r2.value?.symbol, undefined);
  eq("D6 decimals greșit tipat → dropat", r2.value?.decimals, undefined);
  const nullDec = legacyBase(); nullDec.decimals = null;
  eq("D7 decimals null → păstrat null", classifySolanaLaunchNormalization(nullDec).value?.decimals, null);
}

console.log("── E. metadataStatus ──");
{
  const valid = legacyBase(); valid.metadataStatus = "FAILED";
  eq("E1 status valid păstrat", classifySolanaLaunchNormalization(valid).value?.metadataStatus, "FAILED");
  // absent + symbol+metaSource → ENRICHED
  const enr = legacyBase(); enr.symbol = "BONK"; enr.metaSource = "JUPITER";
  eq("E2 absent + dovezi → ENRICHED", classifySolanaLaunchNormalization(enr).value?.metadataStatus, "ENRICHED");
  // absent + fără dovezi → PENDING
  eq("E3 absent + fără dovezi → PENDING", classifySolanaLaunchNormalization(legacyBase()).value?.metadataStatus, "PENDING");
  // absent + doar symbol (fără metaSource) → PENDING (nu ENRICHED)
  const half = legacyBase(); half.symbol = "BONK";
  eq("E4 absent + doar symbol → PENDING", classifySolanaLaunchNormalization(half).value?.metadataStatus, "PENDING");
  // status invalid → derivat (nu păstrat)
  const inv = legacyBase(); inv.metadataStatus = "WEIRD";
  eq("E5 status invalid → derivat PENDING", classifySolanaLaunchNormalization(inv).value?.metadataStatus, "PENDING");
  // status invalid dar cu dovezi → ENRICHED derivat
  const invEnr = legacyBase(); invEnr.metadataStatus = "WEIRD"; invEnr.symbol = "X"; invEnr.metaSource = "J";
  eq("E6 status invalid + dovezi → ENRICHED derivat", classifySolanaLaunchNormalization(invEnr).value?.metadataStatus, "ENRICHED");
}

console.log("── F. Cale PUMPFUN (legacy fără lifecycle) ──");
{
  const r = classifySolanaLaunchNormalization(legacyBase());
  eq("F1 outcome", r.outcome, "normalized_pumpfun");
  const v = r.value;
  eq("F2 lifecycleStage", v?.lifecycleStage, "PUMPFUN_LAUNCHED");
  eq("F3 graduated", v?.graduated, false);
  check("F4 raydiumPools = []", Array.isArray(v?.raydiumPools) && v!.raydiumPools.length === 0);
  check("F5 fără graduatedAt (nu inventat)", v?.graduatedAt === undefined);
  eq("F6 mint corect (base58 nelowercased)", v?.mint, MINT);
}

console.log("── G. Cale GRADUATED (dovezi coerente) ──");
{
  const g = legacyBase();
  g.raydiumPools = [validLink()];
  g.graduatedAt = "2025-02-01T00:00:00.000Z";
  const r = classifySolanaLaunchNormalization(g);
  eq("G1 outcome", r.outcome, "normalized_graduated");
  const v = r.value;
  eq("G2 lifecycleStage", v?.lifecycleStage, "RAYDIUM_POOL_FOUND");
  eq("G3 graduated", v?.graduated, true);
  eq("G4 graduatedAt păstrat", v?.graduatedAt, "2025-02-01T00:00:00.000Z");
  check("G5 un pool link", Array.isArray(v?.raydiumPools) && v!.raydiumPools.length === 1);
  eq("G6 pool program", v?.raydiumPools?.[0]?.program, "raydium_cpmm");
  eq("G7 pool address (base58)", v?.raydiumPools?.[0]?.poolAddress, POOL);
}

console.log("── H. Contradicții → fail-closed (niciodată inventat) ──");
{
  const gradNoPools = legacyBase(); gradNoPools.graduated = true;
  eq("H1 graduated:true fără pool-uri → rejected", classifySolanaLaunchNormalization(gradNoPools).reason, "graduation:graduated_true_no_pools");
  const stageNoPools = legacyBase(); stageNoPools.lifecycleStage = "RAYDIUM_POOL_FOUND";
  eq("H2 stage graduated fără pool-uri → rejected", classifySolanaLaunchNormalization(stageNoPools).reason, "graduation:stage_graduated_no_pools");
  const gradAtNoPools = legacyBase(); gradAtNoPools.graduatedAt = "2025-02-01T00:00:00.000Z";
  eq("H3 graduatedAt fără pool-uri → rejected", classifySolanaLaunchNormalization(gradAtNoPools).reason, "graduation:graduatedAt_no_pools");
  const poolsNoGradAt = legacyBase(); poolsNoGradAt.raydiumPools = [validLink()];
  eq("H4 pool-uri fără graduatedAt → rejected", classifySolanaLaunchNormalization(poolsNoGradAt).reason, "graduation:pools_without_graduatedAt");
  const poolsGradFalse = legacyBase(); poolsGradFalse.raydiumPools = [validLink()]; poolsGradFalse.graduatedAt = "2025-02-01T00:00:00.000Z"; poolsGradFalse.graduated = false;
  eq("H5 pool-uri + graduated:false → rejected", classifySolanaLaunchNormalization(poolsGradFalse).reason, "graduation:graduated_false_with_pools");
  const poolsStagePump = legacyBase(); poolsStagePump.raydiumPools = [validLink()]; poolsStagePump.graduatedAt = "2025-02-01T00:00:00.000Z"; poolsStagePump.lifecycleStage = "PUMPFUN_LAUNCHED";
  eq("H6 pool-uri + stage PUMPFUN → rejected", classifySolanaLaunchNormalization(poolsStagePump).reason, "graduation:stage_pumpfun_with_pools");
  const unknownStage = legacyBase(); unknownStage.lifecycleStage = "HALFWAY";
  eq("H7 lifecycleStage necunoscut → rejected", classifySolanaLaunchNormalization(unknownStage).reason, "graduation:lifecycleStage_unknown");
  const poolsNotArray = legacyBase(); poolsNotArray.raydiumPools = { a: 1 };
  eq("H8 raydiumPools non-array → rejected", classifySolanaLaunchNormalization(poolsNotArray).reason, "graduation:raydiumPools_not_array");
  const badLink = legacyBase(); badLink.raydiumPools = [{ poolAddress: POOL, program: "not_a_program", slot: 1, signature: SIG, linkedAt: "x" }]; badLink.graduatedAt = "2025-02-01T00:00:00.000Z";
  eq("H9 link cu program invalid → rejected", classifySolanaLaunchNormalization(badLink).reason, "graduation:invalid_pool_link");
  const linkMissingField = legacyBase(); linkMissingField.raydiumPools = [{ poolAddress: POOL, program: "raydium_cpmm", slot: 1, signature: SIG }]; linkMissingField.graduatedAt = "2025-02-01T00:00:00.000Z";
  eq("H10 link fără linkedAt → rejected", classifySolanaLaunchNormalization(linkMissingField).reason, "graduation:invalid_pool_link");
}

console.log("── I. Detecție 'current' (record deja curent, fără vindecare) ──");
{
  const curPump = { ...legacyBase(), metadataStatus: "PENDING", lifecycleStage: "PUMPFUN_LAUNCHED", graduated: false, raydiumPools: [] };
  eq("I1 pumpfun curent complet → current", classifySolanaLaunchNormalization(curPump).outcome, "current");
  const curGrad = { ...legacyBase(), metadataStatus: "ENRICHED", lifecycleStage: "RAYDIUM_POOL_FOUND", graduated: true, graduatedAt: "2025-02-01T00:00:00.000Z", raydiumPools: [validLink()] };
  eq("I2 graduated curent complet → current", classifySolanaLaunchNormalization(curGrad).outcome, "current");
  // Un record curent la care metadataStatus lipsește NU e 'current' (a fost derivat)
  const derivedStatus = { ...legacyBase(), lifecycleStage: "PUMPFUN_LAUNCHED", graduated: false, raydiumPools: [] };
  eq("I3 lifecycle explicit dar status derivat → normalized (nu current)", classifySolanaLaunchNormalization(derivedStatus).outcome, "normalized_pumpfun");
}

console.log("── J. Wrapper parseAndNormalizeSolanaLaunch ──");
{
  check("J1 legacy → obiect ne-null", parseAndNormalizeSolanaLaunch(legacyBase()) !== null);
  check("J2 rejected → null", parseAndNormalizeSolanaLaunch(null) === null);
  const v = parseAndNormalizeSolanaLaunch(legacyBase());
  eq("J3 wrapper value = clasificator value", v?.lifecycleStage, "PUMPFUN_LAUNCHED");
}

console.log("── K. Invarianți de onestitate ──");
{
  // Un record rejected NU întoarce niciodată un value.
  const outcomes: SolanaLaunchNormalizeOutcome[] = ["current", "normalized_pumpfun", "normalized_graduated", "rejected"];
  const samples: unknown[] = [null, "{bad", legacyBase(), { ...legacyBase(), graduated: true }];
  let invariantOk = true;
  for (const s of samples) {
    const r = classifySolanaLaunchNormalization(s);
    if (r.outcome === "rejected" && r.value !== null) invariantOk = false;
    if (r.outcome !== "rejected" && r.value === null) invariantOk = false;
    if (!outcomes.includes(r.outcome)) invariantOk = false;
  }
  check("K1 rejected⟺value:null (fail-closed strict)", invariantOk);
  // PUMPFUN nu are niciodată graduatedAt (nu inventăm graduation)
  const pv = parseAndNormalizeSolanaLaunch(legacyBase());
  check("K2 PUMPFUN fără graduatedAt", pv !== null && pv.graduatedAt === undefined);
}

console.log("── L. Discriminanți prezenți dar greșit tipați → fail-closed (fix cgpt #1) ──");
{
  const gStr = legacyBase(); gStr.graduated = "true";
  eq("L1 graduated:'true' (string) → rejected", classifySolanaLaunchNormalization(gStr).reason, "graduation:graduated_type");
  const gNum = legacyBase(); gNum.graduated = 1;
  eq("L2 graduated:1 (number) → rejected", classifySolanaLaunchNormalization(gNum).reason, "graduation:graduated_type");
  const gaNum = legacyBase(); gaNum.graduatedAt = 123;
  eq("L3 graduatedAt:123 (number) → rejected", classifySolanaLaunchNormalization(gaNum).reason, "graduation:graduatedAt_type");
  const gaEmpty = legacyBase(); gaEmpty.graduatedAt = "";
  eq("L4 graduatedAt:'' (empty) → rejected", classifySolanaLaunchNormalization(gaEmpty).reason, "graduation:graduatedAt_type");
  const rpObj = legacyBase(); rpObj.raydiumPools = { a: 1 };
  eq("L5 raydiumPools:{} (non-array) → rejected", classifySolanaLaunchNormalization(rpObj).reason, "graduation:raydiumPools_not_array");
  // ESENȚIAL: discriminant greșit tipat NU devine tăcut PUMPFUN
  eq("L6 graduated:'true' NU e tratat ca absent (nu normalized_pumpfun)", classifySolanaLaunchNormalization(gStr).outcome, "rejected");
}

console.log("── M. Extras forward-compat păstrate (fix cgpt #2) ──");
{
  const withExtra = legacyBase();
  withExtra.futureField = { nested: [1, 2, 3] };
  withExtra.anotherExtra = "keepme";
  const r = classifySolanaLaunchNormalization(withExtra);
  const v = r.value as unknown as Record<string, unknown> | null;
  eq("M1 outcome normalized_pumpfun (legacy + extras)", r.outcome, "normalized_pumpfun");
  check("M2 extra obiect păstrat", !!v && JSON.stringify(v.futureField) === JSON.stringify({ nested: [1, 2, 3] }));
  eq("M3 extra scalar păstrat", (v?.anotherExtra as string), "keepme");
  // Canonicele validate rămân corecte peste extras
  eq("M4 lifecycleStage canonic corect", v?.lifecycleStage, "PUMPFUN_LAUNCHED");
  // Un record DEJA curent + extras rămâne 'current' (păstrarea extras NU e o modificare)
  const curPlusExtra = { ...legacyBase(), metadataStatus: "PENDING", lifecycleStage: "PUMPFUN_LAUNCHED", graduated: false, raydiumPools: [], xtra: "v" };
  eq("M5 current + extras → tot current", classifySolanaLaunchNormalization(curPlusExtra).outcome, "current");
  const cpe = classifySolanaLaunchNormalization(curPlusExtra).value as unknown as Record<string, unknown>;
  eq("M6 extra păstrat și pe 'current'", cpe.xtra as string, "v");
}

console.log("── N. 'current' onest — orice vindecare canonică → normalized (fix cgpt #3) ──");
{
  // constante completate (chain lipsă) → NU current
  const noChain = { ...legacyBase(), metadataStatus: "PENDING", lifecycleStage: "PUMPFUN_LAUNCHED", graduated: false, raydiumPools: [] };
  delete (noChain as Record<string, unknown>).chain;
  eq("N1 chain completat → normalized (nu current)", classifySolanaLaunchNormalization(noChain).outcome, "normalized_pumpfun");
  // raydiumPools lipsă (restul discriminanți prezenți) → NU current (defaultat [])
  const noPools = { ...legacyBase(), metadataStatus: "PENDING", lifecycleStage: "PUMPFUN_LAUNCHED", graduated: false };
  eq("N2 raydiumPools defaultat [] → normalized (nu current)", classifySolanaLaunchNormalization(noPools).outcome, "normalized_pumpfun");
  // metadata invalidă dropată pe un record altfel curent → NU current
  const badMetaCurrent = { ...legacyBase(), metadataStatus: "PENDING", lifecycleStage: "PUMPFUN_LAUNCHED", graduated: false, raydiumPools: [], symbol: 999 };
  eq("N3 metadata canonică invalidă dropată → normalized (nu current)", classifySolanaLaunchNormalization(badMetaCurrent).outcome, "normalized_pumpfun");
  // graduated absent (dar pools+graduatedAt coerente) → normalized_graduated (nu current)
  const gradNoDisc = { ...legacyBase(), metadataStatus: "ENRICHED", graduatedAt: "2025-02-01T00:00:00.000Z", raydiumPools: [validLink()] };
  eq("N4 graduated derivat din dovezi → normalized_graduated", classifySolanaLaunchNormalization(gradNoDisc).outcome, "normalized_graduated");
}

console.log("── O. Extras forward-compat ÎN pool link păstrate (fix cgpt final) ──");
{
  // Un link cu câmp necunoscut, pe un record graduated ALTFEL complet-curent.
  const linkWithExtra = { ...validLink(), futureLinkField: "KEEP" };
  const curGradExtra = {
    ...legacyBase(), metadataStatus: "ENRICHED",
    lifecycleStage: "RAYDIUM_POOL_FOUND", graduated: true,
    graduatedAt: "2025-02-01T00:00:00.000Z", raydiumPools: [linkWithExtra],
  };
  const r = classifySolanaLaunchNormalization(curGradExtra);
  // (1) recordul complet rămâne 'current' (extra în link NU e o modificare canonică)
  eq("O1 record cu link-extra rămâne current", r.outcome, "current");
  // (2) extra-ul din link este PĂSTRAT (nu șters la reconstrucție)
  const link0 = (r.value?.raydiumPools?.[0] ?? {}) as Record<string, unknown>;
  eq("O2 futureLinkField păstrat în link", link0.futureLinkField as string, "KEEP");
  // (3) canonicele link-ului rămân corecte peste extra
  eq("O3 poolAddress canonic corect", link0.poolAddress as string, POOL);
  eq("O4 program canonic corect", link0.program as string, "raydium_cpmm");
  // (4) un link-extra pe un record legacy-graduated → normalized_graduated + extra păstrat
  const legGradExtra = { ...legacyBase(), metadataStatus: "ENRICHED", graduatedAt: "2025-02-01T00:00:00.000Z", raydiumPools: [linkWithExtra] };
  const r2 = classifySolanaLaunchNormalization(legGradExtra);
  eq("O5 legacy-graduated cu link-extra → normalized_graduated", r2.outcome, "normalized_graduated");
  const l2 = (r2.value?.raydiumPools?.[0] ?? {}) as Record<string, unknown>;
  eq("O6 extra păstrat și pe normalized_graduated", l2.futureLinkField as string, "KEEP");
}

// ── Sumar ─────────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log("normalizeLaunch.test: " + passed + " passed, " + failed + " failed");
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
