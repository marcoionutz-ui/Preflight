/**
 * scripts/pumpfunFetcher.test.ts — NF3 (rezultat discriminat + politica de coadă).
 *
 * (1) `fetchPumpfunCreate` cu Connection MOCK — ok / invalid(NO_CREATE|FAILED_TX) / unsupported / unavailable.
 * (2) Politica PURĂ `queueActionFor` (outcome → acțiune coadă) + `reconcileActionFor` (status → acțiune dead)
 *     — partea cea mai importantă a NF3, cu regression protection (nu trăiește doar în index.ts).
 */

import { fetchPumpfunCreate } from "../src/discovery/pumpfunFetcher";
import { queueActionFor, reconcileActionFor } from "../src/discovery/discoveryQueue";
import { PUMPFUN_PROGRAM } from "../src/config/programs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// ── Conturi mock ──
const V2_OK = [
  "MintV2Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "TSLvdd1pWpHVglobalaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "BondingV2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "AssocV2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "4wTV1YmiEkRvfeeaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "CreatorV2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "a6", "a7", "a8", "a9", "a10", "a11", "a12", "a13", "a14", "a15", // → total 16
];
const LEGACY_OK = [
  "MintLegbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "TSLvdd1pWpHVglobbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "BondingLegbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "AssocLegbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "4wTV1YmiEkRvfeebbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "metaqbxxUerdmplbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "MetaPdabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "CreatorLegbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "Sysbbb", "Tokbbb", "Atabbb", "Rentbbb", "Ce6TQqeHC9p8evtbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", PUMPFUN_PROGRAM, // 14
];

function acct(s: string) { return { toBase58: () => s }; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkIx(programId: string, accounts: string[]): any { return { programId: { toBase58: () => programId }, accounts: accounts.map(acct), data: "x" }; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkParsedIx(programId: string): any { return { programId: { toBase58: () => programId }, parsed: { type: "x" } }; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkTx(outer: any[], inner: any[] = [], err: unknown = null): any {
  return { transaction: { message: { instructions: outer } }, meta: { err, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [] } };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkConn(sequence: any[]): any {
  let index = 0;
  return { getParsedTransaction: async () => { const v = sequence[Math.min(index++, sequence.length - 1)]; if (v === "throw") throw new Error("rpc lag"); return v; } };
}
const FAST = [0, 0, 0];
const PF = PUMPFUN_PROGRAM, OTHER = "OtheRProgram1111111111111111111111111111111";

async function main(): Promise<void> {
  console.log("NF3 — pumpfunFetcher + queue policy");

  // ── ok ──
  {
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, V2_OK)])]), "sig", FAST);
    check("NF3.1. CreateV2 valid → ok (CREATE_V2)", r.status === "ok" && r.result.instructionShape === "CREATE_V2" && r.result.mint === V2_OK[0]);
  }
  check("NF3.2. Create legacy valid → ok", (await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, LEGACY_OK)])]), "sig", FAST)).status === "ok");
  check("NF3.3. CreateV2 în inner → ok", (await fetchPumpfunCreate(mkConn([mkTx([mkIx(OTHER, ["a"])], [mkIx(PF, V2_OK)])]), "sig", FAST)).status === "ok");

  // ── unsupported (instrucțiune pump.fun găsită dar neparsată → quarantine, NU aruncare) ──
  {
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, [...V2_OK, "a16"])])]), "sig", FAST); // 17 conturi
    check("NF3.4a. pump.fun ix 17 conturi → unsupported UNKNOWN_ACCOUNT_COUNT",
      r.status === "unsupported" && r.reason === "UNKNOWN_ACCOUNT_COUNT" && r.accountCounts.join(",") === "17");
  }
  {
    // BLOCKER 1 varu: 16 conturi (count cunoscut) dar guard-uri picate (prefix schimbat) → NU invalid, ci
    // unsupported (poate fi versiune nouă care păstrează 16 conturi; account count ≠ versiunea protocolului).
    const badGlobal = [...V2_OK]; badGlobal[1] = "WRONGglobalaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, badGlobal)])]), "sig", FAST);
    check("NF3.5. 16 conturi + guard picat → unsupported KNOWN_LAYOUT_GUARDS_FAILED (nu invalid)",
      r.status === "unsupported" && r.reason === "KNOWN_LAYOUT_GUARDS_FAILED" && r.accountCounts.join(",") === "16");
  }

  // ── invalid (sigur nu-i o creare de indexat) ──
  {
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(OTHER, ["a", "b"])])]), "sig", FAST); // niciun ix pump.fun
    check("NF3.6. niciun ix pump.fun → invalid NO_PUMPFUN_IX", r.status === "invalid" && r.reason === "NO_PUMPFUN_IX");
  }
  {
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkParsedIx(PF)])]), "sig", FAST); // ParsedInstruction fără accounts
    check("NF3.7. ParsedInstruction pump.fun fără accounts → invalid NO_PUMPFUN_IX", r.status === "invalid" && r.reason === "NO_PUMPFUN_IX");
  }
  {
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, V2_OK)], [], { InstructionError: [0, "x"] })]), "sig", FAST); // tx eșuată
    check("NF3.8. tx eșuată (meta.err) → invalid FAILED_TX", r.status === "invalid" && r.reason === "FAILED_TX");
  }

  // ── unavailable ──
  check("NF3.9. RPC null la toate → unavailable", (await fetchPumpfunCreate(mkConn([null, null, null]), "sig", FAST)).status === "unavailable");
  check("NF3.10. RPC aruncă mereu → unavailable (fără throw)", (await fetchPumpfunCreate(mkConn(["throw"]), "sig", FAST)).status === "unavailable");
  check("NF3.11. RPC null,null,tx valid → ok după retry", (await fetchPumpfunCreate(mkConn([null, null, mkTx([mkIx(PF, V2_OK)])]), "sig", FAST)).status === "ok");

  // ── queueActionFor (politica de coadă — regression protection) ──
  check("NF3.12a. written → ack_advance",      queueActionFor({ kind: "written" }) === "ack_advance");
  check("NF3.12b. retry → fail",               queueActionFor({ kind: "retry" }) === "fail");
  check("NF3.12c. invalid → ack (nu fail)",    queueActionFor({ kind: "invalid" }) === "ack");
  check("NF3.12d. unsupported → quarantine_ack", queueActionFor({ kind: "unsupported", accountCounts: [17], reason: "UNKNOWN_ACCOUNT_COUNT" }) === "quarantine_ack");

  // ── reconcileActionFor (politica pt. dead-set existent) ──
  check("NF3.13a. ok → requeue",          reconcileActionFor("ok") === "requeue");
  check("NF3.13b. invalid → drop",        reconcileActionFor("invalid") === "drop");
  check("NF3.13c. unsupported → quarantine", reconcileActionFor("unsupported") === "quarantine");
  check("NF3.13d. unavailable → leave (nu drop!)", reconcileActionFor("unavailable") === "leave");

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
