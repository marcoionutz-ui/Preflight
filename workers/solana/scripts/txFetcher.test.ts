/* eslint-disable @typescript-eslint/no-explicit-any */
import { isCpmmInitLog, fetchCpmmInit, isCpmmInitializeInstruction, base58Decode } from "../src/discovery/txFetcher";

const RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKEN_PROG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROG     = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS";

// ── base58 encode (test-only, ca să construim ix.data) ───────────────────────
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: number[]): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let str = "";
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) str += "1";
  for (let q = digits.length - 1; q >= 0; q--) str += ALPHABET[digits[q]];
  return str;
}

const INIT_DISC  = [0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed];
const WRONG_DISC = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]; // ex. Swap
const DATA_INIT  = base58Encode([...INIT_DISC, 0, 0, 0, 0]);
const DATA_WRONG = base58Encode([...WRONG_DISC, 0, 0, 0, 0]);

function acct(s: string) { return { toBase58: () => s }; }
function mkIx(programId: string, nAccounts: number, data: string) {
  return {
    programId: { toBase58: () => programId },
    accounts:  Array.from({ length: nAccounts }, (_, i) => acct("acc" + i)),
    data,
  } as any;
}
function mkTx(instructions: any[]) {
  return { transaction: { message: { instructions } }, meta: { innerInstructions: [] } } as any;
}
// conn care întoarce câte un element din secvență la fiecare apel ("throw" aruncă)
function mkConn(seq: any[]) {
  let i = 0;
  return {
    getParsedTransaction: async () => {
      const v = seq[Math.min(i, seq.length - 1)];
      i++;
      if (v === "throw") throw new Error("rpc lag");
      return v;
    },
  } as any;
}

const FAST = [0, 0, 0, 0]; // fără delay în teste

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else       { failed++; console.log("  ❌ " + name); }
}

async function run() {
  console.log("A2 txFetcher tests");

  // 1. Token InitializeAccount3, fără CPMM Initialize → false
  check("1. Token InitializeAccount3 (no CPMM init) → false", isCpmmInitLog([
    `Program ${TOKEN_PROG} invoke [1]`,
    "Program log: Instruction: InitializeAccount3",
    `Program ${TOKEN_PROG} success`,
  ]) === false);

  // 2. CPMM swap cu ATA initialization → false
  check("2. CPMM swap + ATA init → false", isCpmmInitLog([
    `Program ${RAYDIUM_CPMM} invoke [1]`,
    "Program log: Instruction: SwapBaseInput",
    `Program ${ATA_PROG} invoke [2]`,
    "Program log: Instruction: InitializeAccount3",
    `Program ${ATA_PROG} success`,
    `Program ${RAYDIUM_CPMM} success`,
  ]) === false);

  // 3. CPMM Initialize real → true
  check("3. CPMM Initialize real → true", isCpmmInitLog([
    `Program ${RAYDIUM_CPMM} invoke [1]`,
    "Program log: Instruction: Initialize",
    `Program ${RAYDIUM_CPMM} success`,
  ]) === true);

  // discriminator direct
  check("3b. discriminator corect → true", isCpmmInitializeInstruction({ data: DATA_INIT }) === true);
  check("3c. discriminator greșit → false", isCpmmInitializeInstruction({ data: DATA_WRONG }) === false);
  check("3d. data lipsă → false", isCpmmInitializeInstruction({}) === false);

  // decoder base58 — leading-zero corect (fix bug ChatGPT: bytes=[] nu [0])
  const d1 = base58Decode("1");
  check("3e. base58Decode('1') → exact 1 byte [0]", !!d1 && d1.length === 1 && d1[0] === 0);
  const d11 = base58Decode("11");
  check("3f. base58Decode('11') → exact 2 bytes [0,0]", !!d11 && d11.length === 2 && d11[0] === 0 && d11[1] === 0);
  // round-trip pe primul byte non-zero (0xaf al discriminatorului)
  const dz = base58Decode("z"); // 'z' = index 57
  check("3g. base58Decode('z') → [57]", !!dz && dz.length === 1 && dz[0] === 57);
  check("3h. base58Decode(char invalid) → null", base58Decode("0") === null); // '0' nu e în alfabet
  check("3i. isCpmmInitializeInstruction({data:'1'}) → false (prea scurt)",
    isCpmmInitializeInstruction({ data: "1" }) === false);

  // 4. tx cu alt CPMM ix (swap) ÎNAINTE de Initialize → extrage Initialize, nu primul ix
  const swapIx = mkIx(RAYDIUM_CPMM, 13, DATA_WRONG);
  const initIx = mkIx(RAYDIUM_CPMM, 20, DATA_INIT);
  const r4 = await fetchCpmmInit(mkConn([mkTx([swapIx, initIx])]), "sig4", FAST);
  check("4. CPMM swap înainte de Initialize → conturile Initialize",
    !!r4 && r4.poolAddress === "acc3" && r4.mint0 === "acc4" && r4.mint1 === "acc5");

  // 5. discriminator greșit + 20 conturi → null
  const fakeInit = mkIx(RAYDIUM_CPMM, 20, DATA_WRONG);
  const r5 = await fetchCpmmInit(mkConn([mkTx([fakeInit])]), "sig5", FAST);
  check("5. discriminator greșit + 20 conturi → null", r5 === null);

  // 5b. discriminator corect dar doar 13 conturi (min-20) → null
  const shortInit = mkIx(RAYDIUM_CPMM, 13, DATA_INIT);
  const r5b = await fetchCpmmInit(mkConn([mkTx([shortInit])]), "sig5b", FAST);
  check("5b. Initialize disc dar <20 conturi → null", r5b === null);

  // 6. RPC null, null, apoi tx valid → succes după retry
  const r6 = await fetchCpmmInit(mkConn([null, null, mkTx([initIx])]), "sig6", FAST);
  check("6. null, null, tx valid → succes după retry", !!r6 && r6.poolAddress === "acc3");

  // 7. RPC eșuează toate încercările → null, fără throw
  let threw = false;
  let r7: any = "unset";
  try { r7 = await fetchCpmmInit(mkConn(["throw", "throw", "throw", "throw"]), "sig7", FAST); }
  catch { threw = true; }
  check("7. RPC eșuează tot → null fără throw", threw === false && r7 === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error("test harness error:", e); process.exit(1); });
