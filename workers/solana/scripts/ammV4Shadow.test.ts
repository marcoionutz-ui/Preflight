/**
 * scripts/ammV4Shadow.test.ts — D4a (AMM V4 shadow, funcții PURE).
 *
 * D4a.1: gate SCOPED pe invocation-stack + clasificare pe Initialize2 real (tag 1 / 21 conturi).
 * Fără Connection/RPC. Un `base58Encode` local (self-validat prin roundtrip cu `base58Decode`-ul real)
 * construiește date de instrucțiune cu tag ales.
 */

import {
  isScopedAmmV4InitLog, summarizeAmmV4Init, findInitialize2Candidates, decodeTag, detectMigration,
  type AmmV4Instruction,
} from "../src/discovery/ammV4Shadow";
import { base58Decode } from "../src/discovery/txFetcher";
import { PUMPFUN_PROGRAM, PUMPFUN_MIGRATION, RAYDIUM_AMM_V4 } from "../src/config/programs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// base58 encode (inversul base58Decode-ului real din txFetcher) — validat prin roundtrip mai jos.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: number[]): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let k = zeros; k < bytes.length; k++) {
    let carry = bytes[k];
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function ix(dataBytes: number[], nAccounts: number): AmmV4Instruction {
  return { dataB58: base58Encode(dataBytes), accounts: Array.from({ length: nAccounts }, (_, i) => "acc" + i) };
}

const OTHER = "OtheRProgram1111111111111111111111111111111";
const ROUTER = "RouteRProgram111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function main(): void {
  console.log("D4a — ammV4Shadow (scoped gate, init2 classification, migration)");

  // ── Sanity: base58Encode roundtrip ──
  {
    const vectors = [[0], [1], [57], [1, 2, 3], [0, 0, 9], [255, 254, 1], [16], [9]];
    let ok = true;
    for (const v of vectors) {
      const dec = base58Decode(base58Encode(v));
      if (!dec || dec.length !== v.length || v.some((b, i) => dec[i] !== b)) ok = false;
    }
    check("D4.0. base58Encode roundtrip cu decoder-ul real", ok);
  }

  // ── isScopedAmmV4InitLog (gate scoped pe stivă) ──
  check("D4.1a. AMM V4 invoke → initialize2 → success → true", isScopedAmmV4InitLog([
    "Program " + RAYDIUM_AMM_V4 + " invoke [1]",
    "Program log: initialize2: InitializeInstruction2 { nonce: 254 }",
    "Program " + RAYDIUM_AMM_V4 + " success",
  ], RAYDIUM_AMM_V4) === true);

  check("D4.1b. ALT program → initialize2 → success → false (log nu-i al AMM V4)", isScopedAmmV4InitLog([
    "Program " + OTHER + " invoke [1]",
    "Program log: initialize2: ceva",
    "Program " + OTHER + " success",
  ], RAYDIUM_AMM_V4) === false);

  check("D4.1c. init2 sub ALT program + AMM V4 (swap) în același tx → false", isScopedAmmV4InitLog([
    "Program " + OTHER + " invoke [1]",
    "Program log: initialize2: ceva",
    "Program " + OTHER + " success",
    "Program " + RAYDIUM_AMM_V4 + " invoke [1]",
    "Program log: ray_log: swapdata",
    "Program " + RAYDIUM_AMM_V4 + " success",
  ], RAYDIUM_AMM_V4) === false);

  check("D4.1d. AMM V4 nested CPI → initialize2 → true", isScopedAmmV4InitLog([
    "Program " + ROUTER + " invoke [1]",
    "Program " + RAYDIUM_AMM_V4 + " invoke [2]",
    "Program log: initialize2: InitializeInstruction2 { }",
    "Program " + RAYDIUM_AMM_V4 + " success",
    "Program " + ROUTER + " success",
  ], RAYDIUM_AMM_V4) === true);

  check("D4.1e. Token InitializeAccount3 → false (evită bug-ul A2)", isScopedAmmV4InitLog([
    "Program " + TOKEN + " invoke [1]",
    "Program log: Instruction: InitializeAccount3",
    "Program " + TOKEN + " success",
  ], RAYDIUM_AMM_V4) === false);

  check("D4.1f. AMM V4 invoke fără initialize2 (doar swap) → false", isScopedAmmV4InitLog([
    "Program " + RAYDIUM_AMM_V4 + " invoke [1]",
    "Program log: ray_log: swapdata",
    "Program " + RAYDIUM_AMM_V4 + " success",
  ], RAYDIUM_AMM_V4) === false);

  check("D4.1g. logs goale → false", isScopedAmmV4InitLog([], RAYDIUM_AMM_V4) === false);

  check("D4.1h. AMM V4 failed (nu success) tot golește stiva corect", isScopedAmmV4InitLog([
    "Program " + RAYDIUM_AMM_V4 + " invoke [1]",
    "Program " + RAYDIUM_AMM_V4 + " failed: custom error",
    "Program log: initialize2: ceva", // după ce AMM V4 a ieșit → nu mai e pe stivă
  ], RAYDIUM_AMM_V4) === false);

  // BLOCKER varu: init2 emis, DAR invocarea AMM V4 eșuează (părintele prinde eroarea, tx global succeeded) → false
  check("D4.1i. AMM init2 apoi failed → false (tentativă eșuată de creare)", isScopedAmmV4InitLog([
    "Program " + ROUTER + " invoke [1]",
    "Program " + RAYDIUM_AMM_V4 + " invoke [2]",
    "Program log: initialize2: InitializeInstruction2 {}",
    "Program " + RAYDIUM_AMM_V4 + " failed: custom program error: 0x1",
    "Program " + ROUTER + " success",
  ], RAYDIUM_AMM_V4) === false);

  check("D4.1j. prima creare AMM eșuează, a doua reușește → true", isScopedAmmV4InitLog([
    "Program " + RAYDIUM_AMM_V4 + " invoke [1]",
    "Program log: initialize2: failed attempt",
    "Program " + RAYDIUM_AMM_V4 + " failed: custom error",
    "Program " + RAYDIUM_AMM_V4 + " invoke [1]",
    "Program log: initialize2: successful attempt",
    "Program " + RAYDIUM_AMM_V4 + " success",
  ], RAYDIUM_AMM_V4) === true);

  check("D4.1k. init2 fără log de completion → false (conservator)", isScopedAmmV4InitLog([
    "Program " + RAYDIUM_AMM_V4 + " invoke [1]",
    "Program log: initialize2: truncated logs",
  ], RAYDIUM_AMM_V4) === false);

  // ── findInitialize2Candidates + summarizeAmmV4Init (clasificare pe tag 1 / 21 conturi) ──
  {
    const s = summarizeAmmV4Init([]);
    check("D4.2a. 0 instrucțiuni → rejected", s.outcome === "rejected" && s.tag === null);
  }
  {
    // tag 16 / 8 conturi (ce prindea gate-ul vechi — un swap) → NU Initialize2 → rejected
    const s = summarizeAmmV4Init([ix([16, 1, 2], 8)]);
    check("D4.3a. swap (tag 16, 8 conturi) → rejected (nu-i Initialize2)", s.outcome === "rejected");
  }
  {
    // tag 1 dar 20 conturi (layout greșit) → rejected
    const s = summarizeAmmV4Init([ix([1], 20)]);
    check("D4.3b. tag 1 dar 20 conturi → rejected", s.outcome === "rejected");
  }
  {
    const s = summarizeAmmV4Init([ix([1, 254, 0, 0], 21)]);
    check("D4.4a. tag 1 + 21 conturi → parsed", s.outcome === "parsed");
    check("D4.4b. parsed → tag 1, accountCount 21", s.tag === 1 && s.accountCount === 21);
  }
  {
    // KEY (varu): Initialize2 real + un swap AMM V4 în același tx → tot parsed (nu ambiguous)
    const s = summarizeAmmV4Init([ix([1, 9], 21), ix([9, 1], 17)]);
    check("D4.5a. Initialize2 + swap AMM V4 în același tx → parsed (nu ambiguous)", s.outcome === "parsed");
  }
  {
    const s = summarizeAmmV4Init([ix([1], 21), ix([1], 21)]);
    check("D4.5b. DOUĂ Initialize2 reale → ambiguous", s.outcome === "ambiguous");
  }
  {
    const cands = findInitialize2Candidates([ix([1], 21), ix([9], 17), ix([1], 20), ix([1], 21)]);
    check("D4.6a. findInitialize2Candidates filtrează exact tag1/21", cands.length === 2);
  }
  {
    check("D4.6b. decodeTag primul byte (tag 1)", decodeTag(base58Encode([1, 2, 3])) === 1);
    check("D4.6c. decodeTag data goală → null", decodeTag("") === null);
    check("D4.6d. decodeTag base58 invalid → null", decodeTag("0OIl") === null);
  }

  // ── detectMigration ──
  check("D4.7a. instrucțiune pump.fun în tx → confirmed", detectMigration(
    [RAYDIUM_AMM_V4, PUMPFUN_PROGRAM], ["x", "y"],
  ) === "confirmed");
  check("D4.7b. migration authority DOAR în programIds → none (authority ≠ program)", detectMigration(
    [RAYDIUM_AMM_V4, PUMPFUN_MIGRATION], ["x"],
  ) === "none");
  check("D4.7c. migration authority DOAR în conturi → suspected", detectMigration(
    [RAYDIUM_AMM_V4], ["x", PUMPFUN_MIGRATION, "y"],
  ) === "suspected");
  check("D4.7d. niciun semn → none", detectMigration([RAYDIUM_AMM_V4], ["x", "y"]) === "none");
  check("D4.7e. pump.fun program → confirmed chiar cu authority în conturi", detectMigration(
    [PUMPFUN_PROGRAM], [PUMPFUN_MIGRATION],
  ) === "confirmed");

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
