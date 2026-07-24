/**
 * scripts/ammV4Shadow.test.ts — D4a (AMM V4 shadow, funcții PURE).
 *
 * Testează prefiltrul de log + rezumatul instrucțiunilor + detecția de migrare. Fără Connection/RPC.
 * Un `base58Encode` local (self-validat prin roundtrip cu `base58Decode`-ul real) construiește date de
 * instrucțiune cu un tag ales, ca să verificăm că `summarizeAmmV4Init` extrage discriminatorul corect.
 */

import {
  isAmmV4InitLog, summarizeAmmV4Init, detectMigration, isExpectedAmmV4Layout,
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

function main(): void {
  console.log("D4a — ammV4Shadow (pure: log gate, summary, migration)");

  // ── Sanity: base58Encode roundtrip cu base58Decode-ul real ──
  {
    const vectors = [[0], [1], [57], [1, 2, 3], [0, 0, 9], [255, 254, 1]];
    let ok = true;
    for (const v of vectors) {
      const dec = base58Decode(base58Encode(v));
      if (!dec || dec.length !== v.length || v.some((b, i) => dec[i] !== b)) ok = false;
    }
    check("D4.0. base58Encode roundtrip cu decoder-ul real", ok);
  }

  // ── isAmmV4InitLog (prefiltru) ──
  check("D4.1a. log initialize2 → candidat", isAmmV4InitLog([
    "Program " + RAYDIUM_AMM_V4 + " invoke [1]",
    "Program log: initialize2: InitializeInstruction2 { nonce: 254, open_time: 0 }",
  ]) === true);
  check("D4.1b. log initialize (init vechi) → candidat", isAmmV4InitLog([
    "Program log: initialize: InitializeInstruction { nonce: 253 }",
  ]) === true);
  check("D4.1c. ray_log (swap) → NU candidat", isAmmV4InitLog([
    "Program log: ray_log: A9c3Bd0eF...",
  ]) === false);
  check("D4.1d. Token InitializeAccount3 → NU candidat (evită bug-ul A2)", isAmmV4InitLog([
    "Program log: Instruction: InitializeAccount3",
  ]) === false);
  check("D4.1e. zgomot → NU candidat", isAmmV4InitLog(["Program log: some other thing"]) === false);
  check("D4.1f. logs goale → NU candidat", isAmmV4InitLog([]) === false);

  // ── summarizeAmmV4Init ──
  {
    const s = summarizeAmmV4Init([]);
    check("D4.2a. 0 instrucțiuni → rejected", s.outcome === "rejected");
    check("D4.2b. rejected → tag null", s.tag === null);
    check("D4.2c. rejected → accountCount null", s.accountCount === null);
  }
  {
    // initialize2 e presupus tag 1 în ecosistem — dar aici doar VERIFICĂM că extragem primul byte,
    // nu hardcodăm nimic în producție. Data = [1, ...payload].
    const s = summarizeAmmV4Init([ix([1, 254, 0, 0, 0, 0], 18)]);
    check("D4.3a. exact 1 instrucțiune → parsed", s.outcome === "parsed");
    check("D4.3b. tag = primul byte (1)", s.tag === 1);
    check("D4.3c. accountCount = 18", s.accountCount === 18);
  }
  {
    const s = summarizeAmmV4Init([ix([0, 9], 21)]);
    check("D4.4a. tag 0 extras corect", s.tag === 0 && s.outcome === "parsed");
    check("D4.4b. accountCount 21", s.accountCount === 21);
  }
  {
    const s = summarizeAmmV4Init([ix([1, 9], 18), ix([7, 1], 12)]);
    check("D4.5a. >1 instrucțiune AMM V4 → ambiguous", s.outcome === "ambiguous");
    check("D4.5b. ambiguous → tag/accountCount din PRIMA (diag)", s.tag === 1 && s.accountCount === 18);
  }
  {
    // Onestitate (fix varu): 1 instrucțiune cu date INVALIDE (fără discriminator) → rejected, nu parsed.
    const s = summarizeAmmV4Init([{ dataB58: "", accounts: ["a", "b"] }]);
    check("D4.6a. data goală (fără discriminator) → rejected", s.outcome === "rejected");
    check("D4.6b. rejected → tag null, accountCount păstrat (2)", s.tag === null && s.accountCount === 2);
  }
  {
    const s = summarizeAmmV4Init([{ dataB58: "0OIl", accounts: ["a"] }]); // caractere invalide base58 → decode null
    check("D4.6c. data base58 invalidă → rejected", s.outcome === "rejected" && s.tag === null);
  }

  // ── isExpectedAmmV4Layout (vs sursa oficială: tag 1, 21 conturi) ──
  check("D4.8a. tag 1 + 21 conturi → EXPECTED", isExpectedAmmV4Layout(1, 21) === true);
  check("D4.8b. tag 1 + 20 conturi → anomaly", isExpectedAmmV4Layout(1, 20) === false);
  check("D4.8c. tag 0 + 21 conturi → anomaly", isExpectedAmmV4Layout(0, 21) === false);
  check("D4.8d. tag null → anomaly", isExpectedAmmV4Layout(null, 21) === false);
  check("D4.8e. accountCount null → anomaly", isExpectedAmmV4Layout(1, null) === false);

  // ── detectMigration ──
  check("D4.7a. instrucțiune pump.fun în tx → confirmed", detectMigration(
    [RAYDIUM_AMM_V4, PUMPFUN_PROGRAM], ["x", "y"],
  ) === "confirmed");
  check("D4.7b. migration authority NU e tratată ca program (doar în programIds) → none", detectMigration(
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
