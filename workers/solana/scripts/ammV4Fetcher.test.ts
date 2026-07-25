/**
 * scripts/ammV4Fetcher.test.ts — D4b (fetcher determinist AMM V4 Initialize2).
 *
 * Testează `parseAmmV4InitAccounts` PUR pe GOLDEN FIXTURE-ul real (sig `3wbXj5KG4UJq…`, confirmat de
 * shadow-ul D4a.1: tag 1, 21 conturi) + `fetchAmmV4Init` cu Connection MOCK (outer/inner, filtrare programId,
 * tag/count, ignorare swap, ambiguitate, retry, tx eșuată) — stil `txFetcher.test.ts`.
 */

import { parseAmmV4InitAccounts, fetchAmmV4Init } from "../src/discovery/ammV4Fetcher";
import { RAYDIUM_AMM_V4 } from "../src/config/programs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// base58 encode (inversul base58Decode-ului real) — pt. `data` de instrucțiune cu tag ales.
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
const DATA_TAG1 = base58Encode([1, 254, 0, 0, 0, 0]); // Initialize2 (tag 1)
const DATA_TAG16 = base58Encode([16, 1, 2]);          // swap-ish (tag 16)

// GOLDEN FIXTURE — cele 21 conturi ale instrucțiunii Initialize2 din tx-ul real
// sig 3wbXj5KG4UJqgPqNYWjsKcCkhgDiJzNAAHT7qLu9P3NvQTYHPpUNxUqSq5wH3C6cRR3hREtfkcxCMw9tMipZFPcs
const GOLDEN = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // 0
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // 1
  "11111111111111111111111111111111",            // 2
  "SysvarRent111111111111111111111111111111111",  // 3
  "6rNVp5kn3CudacPCKhYPGA6mQFPfCyKWKUbxLJ8pCGHS", // 4  POOL
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // 5
  "GPmwSPrKE8x5j1gBfH2AMtrRgN8MCgC4qfB7XQicwvXL", // 6
  "HhtRa6MfxftVGa2SsHSjXUYTQWCctx1QpTWKr1i1Aqce", // 7
  "52U1CVjHbmQkr9E9pMU4i7ozNjkce6p8f2h8nyMJC5kE", // 8  MINT0 (coin)
  "So11111111111111111111111111111111111111112",  // 9  MINT1 (pc = WSOL)
  "Cs8SDbyWuhqDBCU35ConHY9Bvet7mxyt3ASHQW8qtUrC", // 10
  "ALYD6v1ZXzYwLKrWANi8Z6PjceA67sfnt69ufPxuQmxs", // 11
  "F5ZCSJHfWWDvdxkbrpzEBG8bPf9XtTFa3DYw8KBi6j3N", // 12
  "9DCxsMizn3H1hprZ7xWe6LDzeUeZBksYFpBWBtSf1PQX", // 13
  "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5", // 14
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",  // 15
  "FWpXE1b97nnZB6EgtLwLxRDTzyZeavmRcWzVNcCHGt1G", // 16
  "6YQbZfg5eiLrGsVFGGMQ8mxf4FSMciyKiFWrDgaN1K8Q", // 17
  "EXXVWiSUWs4UvpfBPXpBZ82aWX1Z5Bh3nmwbmHpNDMSz", // 18
  "5761GVAZu8PsipPt7RnhZwrdoNq8ggnmpy1w7maquGsp", // 19
  "CLKKiwVtcoAhbAm1gKTALwh78vxYy9iVzdYH4FKczAnn", // 20
];

const POOL = GOLDEN[4], MINT0 = GOLDEN[8], MINT1 = GOLDEN[9];

// ── Mock helpers (stil txFetcher.test.ts) ──
function acct(s: string) { return { toBase58: () => s }; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkIx(programId: string, accounts: string[], data: string): any {
  return { programId: { toBase58: () => programId }, accounts: accounts.map(acct), data };
}
/** ParsedInstruction fără accounts/data (ex. o instrucțiune parsată de RPC) — trebuie ignorată. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkParsedIx(programId: string): any {
  return { programId: { toBase58: () => programId }, parsed: { type: "x" } };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkTx(outer: any[], inner: any[] = [], err: unknown = null): any {
  return {
    transaction: { message: { instructions: outer } },
    meta: { err, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [] },
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkConn(sequence: any[]): any {
  let index = 0;
  return {
    getParsedTransaction: async () => {
      const value = sequence[Math.min(index++, sequence.length - 1)];
      if (value === "throw") throw new Error("rpc lag");
      return value;
    },
  };
}
const FAST = [0, 0, 0, 0];
const AMM = RAYDIUM_AMM_V4;
const OTHER = "OtheRProgram1111111111111111111111111111111";
const init2Ix = () => mkIx(AMM, GOLDEN, DATA_TAG1);

async function main(): Promise<void> {
  console.log("D4b — ammV4Fetcher (parse + fetch)");

  // ── parseAmmV4InitAccounts (golden fixture + negative) ──
  {
    const r = parseAmmV4InitAccounts(GOLDEN);
    check("D4b.1a. golden → non-null", r !== null);
    check("D4b.1b. pool = [4]", r?.poolAddress === POOL);
    check("D4b.1c. mint0 = [8]", r?.mint0 === MINT0);
    check("D4b.1d. mint1 = [9]", r?.mint1 === MINT1);
  }
  check("D4b.2. 20 conturi → null", parseAmmV4InitAccounts(GOLDEN.slice(0, 20)) === null);
  check("D4b.3. 22 conturi → null", parseAmmV4InitAccounts([...GOLDEN, "extra1111"]) === null);
  check("D4b.4. listă goală → null", parseAmmV4InitAccounts([]) === null);
  { const a = [...GOLDEN]; a[4] = a[8]; check("D4b.5. pool === mint0 → null", parseAmmV4InitAccounts(a) === null); }
  { const a = [...GOLDEN]; a[9] = a[8]; check("D4b.6. mint0 === mint1 → null", parseAmmV4InitAccounts(a) === null); }
  { const a = [...GOLDEN]; a[4] = "";   check("D4b.7. pool gol → null", parseAmmV4InitAccounts(a) === null); }

  // ── fetchAmmV4Init (Connection mock) ──
  {
    const conn = mkConn([mkTx([init2Ix()])]);
    const r = await fetchAmmV4Init(conn, "sig", FAST);
    check("D4b.8. Initialize2 în OUTER → rezultat corect", r?.poolAddress === POOL && r?.mint0 === MINT0 && r?.mint1 === MINT1);
  }
  {
    const conn = mkConn([mkTx([mkIx(OTHER, ["a", "b"], "1")], [init2Ix()])]);
    const r = await fetchAmmV4Init(conn, "sig", FAST);
    check("D4b.9. Initialize2 în INNER → rezultat corect", r?.poolAddress === POOL);
  }
  {
    // swap tag16 ÎNAINTE de Initialize2 → ia Initialize2, ignoră swap-ul
    const conn = mkConn([mkTx([mkIx(AMM, GOLDEN.slice(0, 14), DATA_TAG16), init2Ix()])]);
    const r = await fetchAmmV4Init(conn, "sig", FAST);
    check("D4b.10. swap tag16 înainte de Initialize2 → ia Initialize2", r?.poolAddress === POOL);
  }
  {
    const conn = mkConn([mkTx([mkIx(AMM, GOLDEN.slice(0, 20), DATA_TAG1)])]); // tag1 dar 20 conturi
    check("D4b.11. tag1 cu 20 conturi → null", (await fetchAmmV4Init(conn, "sig", FAST)) === null);
  }
  {
    const conn = mkConn([mkTx([mkIx(AMM, GOLDEN, DATA_TAG16)])]); // tag16 cu 21 conturi
    check("D4b.12. tag16 cu 21 conturi → null", (await fetchAmmV4Init(conn, "sig", FAST)) === null);
  }
  {
    const conn = mkConn([mkTx([init2Ix(), init2Ix()])]); // două Initialize2 tag1/21
    check("D4b.13. două Initialize2 → null (ambiguu)", (await fetchAmmV4Init(conn, "sig", FAST)) === null);
  }
  {
    // ParsedInstruction AMM V4 fără accounts/data → ignorată; + Initialize2 valid alături
    const conn = mkConn([mkTx([mkParsedIx(AMM), init2Ix()])]);
    const r = await fetchAmmV4Init(conn, "sig", FAST);
    check("D4b.14. ParsedInstruction fără accounts/data ignorată → tot ia Initialize2", r?.poolAddress === POOL);
  }
  {
    const conn = mkConn([null, null, mkTx([init2Ix()])]); // RPC null, null, apoi tx valid
    const r = await fetchAmmV4Init(conn, "sig", FAST);
    check("D4b.15. RPC null,null,tx → succes după retry", r?.poolAddress === POOL);
  }
  {
    const conn = mkConn(["throw"]); // RPC aruncă la toate încercările
    let threw = false; let r = null;
    try { r = await fetchAmmV4Init(conn, "sig", FAST); } catch { threw = true; }
    check("D4b.16. RPC aruncă mereu → null fără throw", threw === false && r === null);
  }
  {
    const conn = mkConn([mkTx([mkIx(OTHER, ["a", "b"], "1")])]); // tx fără AMM V4
    check("D4b.17. tx fără AMM V4 → null", (await fetchAmmV4Init(conn, "sig", FAST)) === null);
  }
  {
    const conn = mkConn([mkTx([init2Ix()], [], { InstructionError: [0, "x"] })]); // tx eșuată (meta.err)
    check("D4b.18. tx eșuată (meta.err) → null (chiar cu Initialize2)", (await fetchAmmV4Init(conn, "sig", FAST)) === null);
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
