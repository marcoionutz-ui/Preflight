/**
 * lib/mcp/tools/pairAddressSchema.test.ts — E37 (bound Zod pentru pair_address).
 *
 * Dovedește că bound-ul partajat acceptă adresele reale (EVM 0x…, V4 pool ID) și EXACT 120 caractere, dar respinge
 * 121 (peste limită) și sub 10 (min) — deci Zod respinge un pair_address prea lung ÎNAINTE să intre în handler.
 */
import { pairAddressSchema } from "./pairAddressSchema";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  XX  " + name); }
}

const ok = (s: string) => pairAddressSchema.safeParse(s).success;

function main(): void {
  console.log("E37 — pairAddressSchema (10..120)");

  // Adrese reale acceptate.
  const evm = "0x" + "a".repeat(40);          // 42 caractere
  const v4  = "0x" + "b".repeat(64);          // 66 caractere (V4 pool ID)
  const sol = "So11111111111111111111111111111111111111112"; // base58 Solana (43)
  check("1. EVM 0x (42) acceptat", ok(evm));
  check("2. V4 pool ID (66) acceptat", ok(v4));
  check("3. Solana base58 (43) acceptat", ok(sol));

  // Limita superioară: EXACT 120 acceptat, 121 respins.
  const at120 = "0x" + "c".repeat(118);       // exact 120
  const at121 = "0x" + "c".repeat(119);       // exact 121
  check("4. lungime exact 120 = " + at120.length + " -> acceptat", at120.length === 120 && ok(at120));
  check("5. * lungime 121 = " + at121.length + " -> RESPINS (peste max, înainte de handler)", at121.length === 121 && !ok(at121));

  // Limita inferioară (.min(10) păstrat).
  check("6. lungime 9 -> respins (sub min)", !ok("0x1234567"));   // 9 caractere
  check("7. lungime exact 10 -> acceptat", ok("0x12345678"));      // 10 caractere

  // Tip greșit respins.
  check("8. non-string (număr) -> respins", !pairAddressSchema.safeParse(123 as unknown as string).success);

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) process.exit(1);
}

main();
