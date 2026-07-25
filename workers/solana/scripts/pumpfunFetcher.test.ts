/**
 * scripts/pumpfunFetcher.test.ts — NF3 + NF3.1 (discriminator-gated CreateV2 shape=19).
 *
 * (1) `fetchPumpfunCreate` cu Connection MOCK — selecție PRIN DISCRIMINATOR:
 *       create_v2 (d6904cec5f8b31b4) → parse shape 19 (live) sau 16; create (181ec828051c0777) → legacy 14.
 *       buy/sell/extend/event → NU sunt niciodată tratate ca create.
 *       ok / invalid(NO_PUMPFUN_IX|NO_CREATE_IX|FAILED_TX) / unsupported(KNOWN_LAYOUT_GUARDS_FAILED|
 *       UNKNOWN_CREATE_DISCRIMINATOR) / unavailable.
 * (2) Politica PURĂ `queueActionFor` + `reconcileActionFor` (regression protection — nu trăiește doar în index.ts).
 *
 * Golden real din autopsia dead-letter (2026-07-25, sig 4ZQ16…): create_v2 cu 19 conturi, layout confirmat pe mainnet.
 */

import { fetchPumpfunCreate, isPumpfunCreateLog } from "../src/discovery/pumpfunFetcher";
import { queueActionFor, reconcileActionFor } from "../src/discovery/discoveryQueue";
import { PUMPFUN_PROGRAM } from "../src/config/programs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

// ── Discriminator data (base58 al primilor 8 bytes = sha256("global:<name>")[:8], verificat) ──
const CREATE_V2_DATA     = "ctY7UoGVwdd"; // d6904cec5f8b31b4 — global:create_v2
const CREATE_LEGACY_DATA = "52zoRTfx1nE"; // 181ec828051c0777 — global:create
const BUY_V2_DATA        = "XnwNKXSbiDa"; // b817ee6167c5d33d — global:buy_v2 (NON-create)

// ── Conturi mock ──
// create_v2 shape=19 — golden REAL (sig 4ZQ16…): mint/global/bond/assoc/fee/creator la 0/1/2/3/4/5.
const V19_OK = [
  "Eg6bh3WHZYMboM4Hxr4mZmLkZLRGbVH3uU496Wepump", "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
  "HeNTTZ4ghZ3Nh6XRWyN87eXHzvp37wzWURupANHyCAYm", "5VV9SkL6LTHNUF6A8RwB39TYevTi8kF4GSkhhEksk3pB",
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf", "8P3DiQgQgJvARzrDk8jxwy8mTU4g6JxvJ94khUJoVVRg",
  "11111111111111111111111111111111", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e",
  "13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ", "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s",
  "CnpCsDQxcM89G4zfSMm9wP66g7A4CPVzZSi6CcuvGi6y", "6f4x3wQnVLHzNpsAKyqKBv6aJSA9gWzjJot1XT1ypk21",
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1", "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "So11111111111111111111111111111111111111112", "4Qq6PEVcAErqcoFfiQmLDHWMk4z13ztVU7jzWwG5E9ax",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // → 19
];
// create_v2 shape=16 (backward-compat) — mint/global/bond/assoc/fee/creator la 0/1/2/3/4/5.
const V16_OK = [
  "MintV2Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "TSLvdd1pWpHVglobalaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "BondingV2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "AssocV2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "4wTV1YmiEkRvfeeaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "CreatorV2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "a6", "a7", "a8", "a9", "a10", "a11", "a12", "a13", "a14", "a15", // → 16
];
// create legacy shape=14.
const LEGACY_OK = [
  "MintLegbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "TSLvdd1pWpHVglobbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "BondingLegbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "AssocLegbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "4wTV1YmiEkRvfeebbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "metaqbxxUerdmplbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "MetaPdabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "CreatorLegbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "Sysbbb", "Tokbbb", "Atabbb", "Rentbbb", "Ce6TQqeHC9p8evtbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", PUMPFUN_PROGRAM, // 14
];
const EXTEND_5 = ["e0", "e1", "e2", "e3", "e4"];                         // vecin extend_account
const BUY_18   = Array.from({ length: 18 }, (_, i) => "b" + i);           // vecin buy_exact_sol_in

// Log-uri stack-aware care conțin CreateV2 (ca la enqueue: isPumpfunCreateLog=true).
const CREATE_LOGS = [
  "Program " + PUMPFUN_PROGRAM + " invoke [1]",
  "Program log: Instruction: CreateV2",
  "Program " + PUMPFUN_PROGRAM + " success",
];
// Viitor CreateV3 — gate-ul de enqueue TREBUIE să-l recunoască (altfel plasa UNKNOWN_CREATE_DISCRIMINATOR nu rulează).
const CREATE_V3_LOGS = [
  "Program " + PUMPFUN_PROGRAM + " invoke [1]",
  "Program log: Instruction: CreateV3",
  "Program " + PUMPFUN_PROGRAM + " success",
];

function acct(s: string) { return { toBase58: () => s }; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkIx(programId: string, accounts: string[], data = "x"): any { return { programId: { toBase58: () => programId }, accounts: accounts.map(acct), data }; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkParsedIx(programId: string): any { return { programId: { toBase58: () => programId }, parsed: { type: "x" } }; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkTx(outer: any[], inner: any[] = [], err: unknown = null, logMessages: string[] = []): any {
  return { transaction: { message: { instructions: outer } }, meta: { err, logMessages, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [] } };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mkConn(sequence: any[]): any {
  let index = 0;
  return { getParsedTransaction: async () => { const v = sequence[Math.min(index++, sequence.length - 1)]; if (v === "throw") throw new Error("rpc lag"); return v; } };
}
const FAST = [0, 0, 0];
const PF = PUMPFUN_PROGRAM, OTHER = "OtheRProgram1111111111111111111111111111111";

async function main(): Promise<void> {
  console.log("NF3 — pumpfunFetcher (discriminator-gated) + queue policy");

  // ── pre-filter enqueue gate: recunoaște ORICE versiune de create (Create/V2/V3…), nu accidental altele ──
  check("NF3.0a. isPumpfunCreateLog recunoaște CreateV2", isPumpfunCreateLog(CREATE_LOGS));
  check("NF3.0b. isPumpfunCreateLog recunoaște viitor CreateV3", isPumpfunCreateLog(CREATE_V3_LOGS));
  check("NF3.0c. NU prinde CreateMetadata (fals-pozitiv)", isPumpfunCreateLog([
    "Program " + PUMPFUN_PROGRAM + " invoke [1]", "Program log: Instruction: CreateMetadata",
    "Program " + PUMPFUN_PROGRAM + " success",
  ]) === false);

  // ── ok (create_v2 live shape=19) ──
  {
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, V19_OK, CREATE_V2_DATA)])]), "sig", FAST);
    check("NF3.1. create_v2 shape=19 → ok (mint/bond/assoc/creator + accountCount 19)",
      r.status === "ok" && r.result.instructionShape === "CREATE_V2" && r.result.instructionAccountCount === 19
      && r.result.mint === V19_OK[0] && r.result.bondingCurveAddress === V19_OK[2]
      && r.result.associatedBondingCurve === V19_OK[3] && r.result.creatorAddress === V19_OK[5]);
  }
  check("NF3.1b. create_v2 shape=16 (backward-compat) → ok",
    (await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, V16_OK, CREATE_V2_DATA)])]), "sig", FAST)).status === "ok");
  check("NF3.2. create legacy shape=14 → ok",
    (await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, LEGACY_OK, CREATE_LEGACY_DATA)])]), "sig", FAST)).status === "ok");
  check("NF3.3. create_v2 shape=19 în inner → ok",
    (await fetchPumpfunCreate(mkConn([mkTx([mkIx(OTHER, ["a"])], [mkIx(PF, V19_OK, CREATE_V2_DATA)])]), "sig", FAST)).status === "ok");

  // ── REGRESIA CHEIE: create_v2 + extend + buy + events în ACELAȘI tx (fingerprint 19,5,18,…) → selectează create ──
  {
    const tx = mkTx([
      mkIx(PF, V19_OK, CREATE_V2_DATA),  // 19 — create_v2
      mkIx(PF, EXTEND_5),                // 5  — extend_account (disc irelevant, nu-i create)
      mkIx(PF, BUY_18, BUY_V2_DATA),     // 18 — buy
      mkIx(PF, ["ev"]),                  // 1  — event
    ]);
    const r = await fetchPumpfunCreate(mkConn([tx]), "sig", FAST);
    check("NF3.4. create_v2(19)+extend(5)+buy(18)+event → ok, alege create (mint corect)",
      r.status === "ok" && r.result.mint === V19_OK[0] && r.result.instructionAccountCount === 19);
  }

  // ── unsupported: discriminator de create CUNOSCUT dar layout picat → quarantine (nu invalid) ──
  {
    const bad = [...V19_OK]; bad[1] = "WRONGglobalaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // global guard pică
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, bad, CREATE_V2_DATA)])]), "sig", FAST);
    check("NF3.5. create_v2 disc + guard picat → unsupported KNOWN_LAYOUT_GUARDS_FAILED",
      r.status === "unsupported" && r.reason === "KNOWN_LAYOUT_GUARDS_FAILED");
  }

  // ── unsupported: log ZICE Create dar discriminatorul e NECUNOSCUT (viitor create_v3) → quarantine, NU pierde ──
  {
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, BUY_18, BUY_V2_DATA)], [], null, CREATE_LOGS)]), "sig", FAST);
    check("NF3.5b. disc necunoscut + log=CreateV2 → unsupported UNKNOWN_CREATE_DISCRIMINATOR (nu invalid)",
      r.status === "unsupported" && r.reason === "UNKNOWN_CREATE_DISCRIMINATOR");
  }
  {
    // Viitor CreateV3: instrucțiune de creare cu discriminator NECUNOSCUT + log CreateV3 → quarantine (NU pierde).
    const unknownCreateData = "11111111"; // 8 bytes zero, base58 valid, discriminator necunoscut
    const unknownLayout = Array.from({ length: 20 }, (_, i) => "u" + i);
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, unknownLayout, unknownCreateData)], [], null, CREATE_V3_LOGS)]), "sig", FAST);
    check("NF3.5c. CreateV3 log + discriminator necunoscut → unsupported UNKNOWN_CREATE_DISCRIMINATOR",
      r.status === "unsupported" && r.reason === "UNKNOWN_CREATE_DISCRIMINATOR");
  }

  // ── invalid ──
  check("NF3.6. ix pump.fun non-create (buy) fără log de create → invalid NO_CREATE_IX",
    (await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, BUY_18, BUY_V2_DATA)])]), "sig", FAST)).status === "invalid");
  {
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, BUY_18, BUY_V2_DATA)])]), "sig", FAST);
    check("NF3.6b. …reason = NO_CREATE_IX", r.status === "invalid" && r.reason === "NO_CREATE_IX");
  }
  {
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(OTHER, ["a", "b"])])]), "sig", FAST); // niciun ix pump.fun
    check("NF3.7. niciun ix pump.fun → invalid NO_PUMPFUN_IX", r.status === "invalid" && r.reason === "NO_PUMPFUN_IX");
  }
  check("NF3.7b. ParsedInstruction pump.fun fără accounts → invalid NO_PUMPFUN_IX",
    (await fetchPumpfunCreate(mkConn([mkTx([mkParsedIx(PF)])]), "sig", FAST)).status === "invalid");
  {
    const r = await fetchPumpfunCreate(mkConn([mkTx([mkIx(PF, V19_OK, CREATE_V2_DATA)], [], { InstructionError: [0, "x"] })]), "sig", FAST);
    check("NF3.8. tx eșuată (meta.err) → invalid FAILED_TX", r.status === "invalid" && r.reason === "FAILED_TX");
  }

  // ── unavailable ──
  check("NF3.9. RPC null la toate → unavailable", (await fetchPumpfunCreate(mkConn([null, null, null]), "sig", FAST)).status === "unavailable");
  check("NF3.10. RPC aruncă mereu → unavailable (fără throw)", (await fetchPumpfunCreate(mkConn(["throw"]), "sig", FAST)).status === "unavailable");
  check("NF3.11. RPC null,null,create valid → ok după retry",
    (await fetchPumpfunCreate(mkConn([null, null, mkTx([mkIx(PF, V19_OK, CREATE_V2_DATA)])]), "sig", FAST)).status === "ok");

  // ── queueActionFor (politica de coadă — regression protection) ──
  check("NF3.12a. written → ack_advance",      queueActionFor({ kind: "written" }) === "ack_advance");
  check("NF3.12b. retry → fail",               queueActionFor({ kind: "retry" }) === "fail");
  check("NF3.12c. invalid → ack (nu fail)",    queueActionFor({ kind: "invalid" }) === "ack");
  check("NF3.12d. unsupported → quarantine_ack", queueActionFor({ kind: "unsupported", accountCounts: [19, 5, 18], reason: "KNOWN_LAYOUT_GUARDS_FAILED" }) === "quarantine_ack");

  // ── reconcileActionFor (politica pt. dead-set existent) ──
  check("NF3.13a. ok → requeue",          reconcileActionFor("ok") === "requeue");
  check("NF3.13b. invalid → drop",        reconcileActionFor("invalid") === "drop");
  check("NF3.13c. unsupported → quarantine", reconcileActionFor("unsupported") === "quarantine");
  check("NF3.13d. unavailable → leave (nu drop!)", reconcileActionFor("unavailable") === "leave");

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
