/**
 * discovery/ammV4Shadow.ts — D4a: shadow diagnostics pentru Raydium AMM V4 (pool creation).
 *
 * CONTEXT: AMM V4 (`675kPX...`) e abonat în `logSubscriber.ts` și dovedește liveness (D2), DAR callback-ul
 * din `index.ts` nu-l procesează — cădea prin ramurile pumpfun/clmm/cpmm fără să facă nimic. Deci pool-urile
 * AMM V4 create direct (nu prin migrarea pump.fun / backfill) sunt ratate azi. D4 = să le procesăm, NU să
 * scoatem subscripția.
 *
 * DE CE SHADOW ÎNTÂI (lecția Fazei A): la A2/A4 un „swap prins ca pool init" a scris înregistrări corupte
 * PERMANENT. Shadow-ul confirmă din tranzacții REALE, cu ZERO scrieri în Redis, până avem destule exemple
 * ca să scriem un fetcher determinist (D4b/c).
 *
 * D4a.1 (rafinare după prima observare pe mainnet — analiză varu): prima versiune folosea un gate GLOBAL
 * (`logs.some(/initialize2/)`) care prindea orice `initialize2` din tranzacție, indiferent CE program îl emitea
 * → prindea swap-uri (tag 9/16) unde logul `initialize2` venea de la ALT program/CPI din același tx, iar
 * singura instrucțiune AMM V4 era un swap. Zero Initialize2 real prins. Fix:
 *   1. Gate SCOPED pe invocation-stack: candidat DOAR dacă logul `initialize2` e emis CÂND AMM V4 e pe vârful
 *      stivei de invoke (`isScopedAmmV4InitLog`). O subscripție `mentions` garantează doar că adresa apare în
 *      tx, nu că programul a fost invocat.
 *   2. Clasificare pe DISCRIMINATORUL real: Initialize2 candidat DOAR = instrucțiune AMM V4 cu tag `1` ȘI 21
 *      conturi (sursa oficială). Alte instrucțiuni AMM V4 în același tx (swap etc.) sunt PERMISE — nu fac tx-ul
 *      ambiguu; ambiguu = >1 Initialize2 real.
 *   3. Stats de migrare DOAR pentru Initialize2 confirmat (nu pe fals-pozitive).
 *   4. Zero Redis writes, `healthCritical:false` — pur diagnostic. Bugetul se resetează la redeploy.
 *
 * LAYOUT OFICIAL (raydium-amm/program/src/instruction.rs — `Initialize2`): tag `1`, 21 conturi, pool la index
 * 4, coin mint la 8, pc mint la 9. Loghează TOATE instrucțiunile AMM V4 (cu tag-urile lor) chiar și pe tx-uri
 * `rejected`, ca să observăm dacă mainnet-ul diferă de sursă înainte de a scrie fetcher-ul (D4b).
 */

import { Connection } from "@solana/web3.js";
import { RAYDIUM_AMM_V4, PUMPFUN_PROGRAM, PUMPFUN_MIGRATION } from "../config/programs";
import { base58Decode } from "./txFetcher";

// ── Layout oficial AMM V4 Initialize2 (instruction.rs) ───────────────────────────────────────────────────
export const AMM_V4_INIT2_TAG           = 1;
export const AMM_V4_INIT2_ACCOUNT_COUNT = 21;
export const AMM_V4_POOL_IDX      = 4;
export const AMM_V4_COIN_MINT_IDX = 8;
export const AMM_V4_PC_MINT_IDX   = 9;

// ── Gate SCOPED pe invocation-stack (D4a.1) ──────────────────────────────────────────────────────────────
//
// Logurile Solana au forma:
//   Program 675kPX... invoke [2]
//   Program log: initialize2: InitializeInstruction2 { ... }
//   Program 675kPX... success        (SAU: Program 675kPX... failed: <reason>)
// Candidat DOAR dacă logul `initialize`/`initialize2` e emis cât timp `programId` e pe VÂRFUL stivei de
// invoke ȘI acel frame se închide cu `success`. Un CPI poate emite logul de init dar apoi să EȘUEZE
// (`failed`), în timp ce părintele prinde eroarea și tx-ul GLOBAL rămâne `succeeded` — deci `event.succeeded`
// din index.ts NU garantează că invocarea AMM V4 a reușit. Reținem per-frame dacă a emis init și confirmăm
// abia la `success`-ul acelui frame (o tentativă eșuată de creare NU e candidat).
const AMM_V4_INIT_LOG_RE  = /^Program log: initialize2?\b/i;
const PROGRAM_INVOKE_RE   = /^Program (\S+) invoke \[\d+\]$/;
const PROGRAM_SUCCESS_RE  = /^Program (\S+) success$/;
const PROGRAM_FAILED_RE   = /^Program (\S+) failed(?::.*)?$/;

interface ProgramFrame {
  programId: string;
  sawInit:   boolean; // frame-ul a emis un log `initialize`/`initialize2`?
}

export function isScopedAmmV4InitLog(logs: readonly string[], programId: string): boolean {
  const stack: ProgramFrame[] = [];

  for (const line of logs) {
    const invoke = PROGRAM_INVOKE_RE.exec(line);
    if (invoke) { stack.push({ programId: invoke[1], sawInit: false }); continue; }

    const top = stack[stack.length - 1];
    if (top && top.programId === programId && AMM_V4_INIT_LOG_RE.test(line)) {
      top.sawInit = true;
      continue;
    }

    const success = PROGRAM_SUCCESS_RE.exec(line);
    const complete = success ?? PROGRAM_FAILED_RE.exec(line);
    if (!complete) continue;

    const completedProgramId = complete[1];
    let idx = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].programId === completedProgramId) { idx = i; break; }
    }
    if (idx < 0) continue;

    const frame = stack[idx];
    stack.splice(idx);

    // Confirmăm DOAR dacă frame-ul AMM V4 care a emis init s-a închis cu `success`.
    if (success && frame.programId === programId && frame.sawInit) return true;
  }

  return false;
}

// ── Rezumat PUR al instrucțiunilor AMM V4 dintr-un tx candidat (fără Connection → testabil) ───────────────

export interface AmmV4Instruction {
  dataB58:  string;   // `data` base58 al instrucțiunii (native → PartiallyDecodedInstruction)
  accounts: string[]; // pubkeys base58, în ordine
}

export type AmmV4Outcome = "parsed" | "ambiguous" | "rejected";

export interface AmmV4InitSummary {
  outcome:      AmmV4Outcome;
  tag:          number | null;
  accountCount: number | null;
}

/** Primul byte al datei base58 = discriminatorul nativ; null dacă data e goală / invalidă. */
export function decodeTag(dataB58: string): number | null {
  const decoded = base58Decode(dataB58);
  return decoded && decoded.length > 0 ? decoded[0] : null;
}

/** Instrucțiunile AMM V4 care sunt Initialize2 real = tag `1` ȘI 21 conturi (sursa oficială). */
export function findInitialize2Candidates(ammIxs: readonly AmmV4Instruction[]): AmmV4Instruction[] {
  return ammIxs.filter(
    (ix) => decodeTag(ix.dataB58) === AMM_V4_INIT2_TAG && ix.accounts.length === AMM_V4_INIT2_ACCOUNT_COUNT,
  );
}

/**
 * Clasifică un tx candidat DUPĂ Initialize2 real (tag 1 / 21 conturi), PUR:
 *   - 0 candidați Initialize2 → `rejected` (log scoped dar nicio instrucțiune de creare pool — ex. doar swap);
 *   - exact 1 → `parsed` (candidatul relevant; alte instrucțiuni AMM V4 în tx sunt permise);
 *   - >1 → `ambiguous` (mai multe Initialize2 în același tx — de investigat manual).
 */
export function summarizeAmmV4Init(ammIxs: readonly AmmV4Instruction[]): AmmV4InitSummary {
  const init2 = findInitialize2Candidates(ammIxs);
  if (init2.length === 0) return { outcome: "rejected", tag: null, accountCount: null };
  if (init2.length > 1)  return { outcome: "ambiguous", tag: AMM_V4_INIT2_TAG, accountCount: AMM_V4_INIT2_ACCOUNT_COUNT };
  return { outcome: "parsed", tag: AMM_V4_INIT2_TAG, accountCount: AMM_V4_INIT2_ACCOUNT_COUNT };
}

// ── Detecție migrare (PURĂ, determinist din tx — două niveluri) ───────────────────────────────────────────

export type MigrationLevel = "confirmed" | "suspected" | "none";

/**
 * `confirmed`: tx-ul conține o INSTRUCȚIUNE emisă de programul pump.fun (doar un program executabil emite
 *   instrucțiuni). `suspected`: autoritatea de migrare (`PUMPFUN_MIGRATION`) apare doar printre CONTURI — e
 *   authority (signer/PDA), NU program; prezența ei incidentală nu dovedește o migrare. `none`: niciun semn.
 * NB: se contorizează DOAR pentru Initialize2 confirmat (altfel ar descrie tranzacții fals-pozitive).
 */
export function detectMigration(
  allInstructionProgramIds: readonly string[],
  allAccountKeys: readonly string[],
): MigrationLevel {
  if (allInstructionProgramIds.includes(PUMPFUN_PROGRAM)) return "confirmed";
  if (allAccountKeys.includes(PUMPFUN_MIGRATION))         return "suspected";
  return "none";
}

// ── Stats in-memory (pur diagnostic; resetat la restart) ──────────────────────────────────────────────────

const stats = {
  candidateLogs:      0, // gate SCOPED a trecut
  fetchSuccess:       0,
  fetchNull:          0,
  parsed:             0, // exact 1 Initialize2 real (tag 1 / 21 conturi)
  ambiguous:          0, // >1 Initialize2 real
  rejected:           0, // 0 Initialize2 real (doar swap etc.), sau fetch null
  migrationConfirmed: 0, // DOAR pe parsed
  migrationSuspected: 0,
  migrationNone:      0,
};

/** tag (primul byte, hex) → count — DISTRIBUȚIA discriminatorilor AMM V4 din tx-urile scoped (diagnostic). */
const tagStats = new Map<string, number>();
/** numărul de conturi → count — DISTRIBUȚIA layout-urilor observate. */
const accountCountStats = new Map<number, number>();

// ── Bounded fetch ─────────────────────────────────────────────────────────────────────────────────────────

const seenSigs = new Set<string>();
const MAX_SIGS = 10_000;
const MAX_INIT_SAMPLES = 20;         // câte tx-uri candidate scoped eșantionăm în total (protejăm RPC-ul propriu)
const FETCH_COOLDOWN_MS = 3_000;
const MAX_CONCURRENT_FETCH = 1;
const FETCH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

let samplesFetched = 0;
let inFlight = 0;
let lastFetchStartedAt = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchParsedTxWithRetry(
  connection: Connection,
  signature:  string,
): Promise<import("@solana/web3.js").ParsedTransactionWithMeta | null> {
  for (let attempt = 0; attempt < FETCH_RETRY_DELAYS_MS.length; attempt++) {
    await sleep(FETCH_RETRY_DELAYS_MS[attempt]);
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) return tx;
    } catch (err) {
      console.warn(
        "[SOLANA][AMMV4][TX_RETRY] sig=" + signature.slice(0, 12) + "..."
        + " attempt=" + (attempt + 1) + " error=" + (err as Error).message,
      );
    }
  }
  return null;
}

async function fetchSampleTx(connection: Connection, signature: string, slot: number): Promise<void> {
  const tx = await fetchParsedTxWithRetry(connection, signature);

  if (!tx) {
    stats.fetchNull++;
    stats.rejected++;
    console.warn("[SOLANA][AMMV4][TX] null după retries sig=" + signature.slice(0, 12));
    return;
  }
  stats.fetchSuccess++;

  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions);
  const all = [...outer, ...inner];

  // Instrucțiunile AMM V4 (native → PartiallyDecodedInstruction cu `accounts` + `data`).
  const ammIxs: AmmV4Instruction[] = [];
  for (const ix of all) {
    if (ix.programId.toBase58() !== RAYDIUM_AMM_V4) continue;
    if (!("accounts" in ix) || !("data" in ix)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataB58: string = (ix as any).data;
    ammIxs.push({ dataB58, accounts: accs.map((a) => a.toBase58()) });
  }

  const init2 = findInitialize2Candidates(ammIxs);
  const summary = summarizeAmmV4Init(ammIxs);
  if (summary.outcome === "parsed")         stats.parsed++;
  else if (summary.outcome === "ambiguous") stats.ambiguous++;
  else                                      stats.rejected++;

  // Distribuția tag/accountCount pe TOATE instrucțiunile AMM V4 (ca să observăm dacă mainnet diferă de sursă).
  for (const ix of ammIxs) {
    const t = decodeTag(ix.dataB58);
    if (t !== null) {
      const hex = "0x" + t.toString(16).padStart(2, "0");
      tagStats.set(hex, (tagStats.get(hex) ?? 0) + 1);
    }
    accountCountStats.set(ix.accounts.length, (accountCountStats.get(ix.accounts.length) ?? 0) + 1);
  }

  // Migrare — DOAR pentru Initialize2 confirmat (altfel ar descrie tranzacții fals-pozitive).
  let migration: MigrationLevel = "none";
  if (summary.outcome === "parsed") {
    const instrProgramIds = all.map((ix) => ix.programId.toBase58());
    const accountKeys = tx.transaction.message.accountKeys.map((a) => a.pubkey.toBase58());
    migration = detectMigration(instrProgramIds, accountKeys);
    if (migration === "confirmed")      stats.migrationConfirmed++;
    else if (migration === "suspected") stats.migrationSuspected++;
    else                                stats.migrationNone++;
  }

  // Candidați pool/mint din Initialize2 confirmat, la indicii oficiali — PUR diagnostic, zero scrieri.
  const primary = init2[0]?.accounts ?? [];
  const candidate = summary.outcome === "parsed"
    ? {
        poolCandidate:     primary[AMM_V4_POOL_IDX] ?? null,
        coinMintCandidate: primary[AMM_V4_COIN_MINT_IDX] ?? null,
        pcMintCandidate:   primary[AMM_V4_PC_MINT_IDX] ?? null,
      }
    : null;

  // Log structurat: TOATE instrucțiunile AMM V4 cu ADRESE COMPLETE + tag-urile lor — inclusiv pe `rejected`,
  // ca să vedem ce e de fapt în tx-urile scoped (dacă mainnet-ul folosește alt tag/layout decât sursa).
  console.log("[SOLANA][AMMV4][TX] " + JSON.stringify({
    kind:         "AMMV4_SHADOW",
    outcome:      summary.outcome,
    init2Count:   init2.length,
    ammIxCount:   ammIxs.length,
    migration:    summary.outcome === "parsed" ? migration : "n/a",
    slot,
    signature,
    candidate,
    instructions: ammIxs.map((ix) => ({
      tag:          decodeTag(ix.dataB58),
      accountCount: ix.accounts.length,
      accounts:     ix.accounts, // ADRESE COMPLETE
    })),
  }));
}

// ── Public API ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Procesează un event AMM V4 din onLogs (DOAR diagnostic). Gate SCOPED → dedupe → bounded fetch.
 * Zero Redis writes. Nu enqueue, nu registry.
 */
export function handleAmmV4Shadow(
  connection: Connection,
  signature:  string,
  slot:       number,
  logs:       string[],
): void {
  if (!isScopedAmmV4InitLog(logs, RAYDIUM_AMM_V4)) return;
  stats.candidateLogs++;

  // Dedupe signature
  if (seenSigs.has(signature)) return;
  if (seenSigs.size >= MAX_SIGS) seenSigs.clear();
  seenSigs.add(signature);

  // Bounded: cap total de eșantioane + o singură fetch în zbor + cooldown (nu DDoS pe RPC-ul propriu).
  if (samplesFetched >= MAX_INIT_SAMPLES) return;
  if (inFlight >= MAX_CONCURRENT_FETCH) return;
  const nowMs = Date.now();
  if (nowMs - lastFetchStartedAt < FETCH_COOLDOWN_MS) return;

  samplesFetched++;
  inFlight++;
  lastFetchStartedAt = nowMs;
  console.log(
    "[SOLANA][AMMV4][CANDIDATE] slot=" + slot + " sig=" + signature.slice(0, 12) + "..."
    + " (sample " + samplesFetched + "/" + MAX_INIT_SAMPLES + ")",
  );

  fetchSampleTx(connection, signature, slot)
    .catch((err: Error) => console.warn("[SOLANA][AMMV4][TX] error:", err.message))
    .finally(() => { inFlight--; });
}

/** Logează stats acumulate (apelat periodic din health loop). Loghează DOAR când s-a schimbat ceva —
 *  altfel, la sursă rară (ex. AMM V4, ~2 pool-uri/zi), fiecare health tick ar repeta același snapshot
 *  și ar umple Railway-ul de ecou. */
let lastStatsFingerprint = "";
export function logAmmV4Stats(): void {
  if (stats.candidateLogs === 0) return;
  const fingerprint = JSON.stringify({
    ...stats,
    tags: [...tagStats.entries()],
    accountCounts: [...accountCountStats.entries()],
  });
  if (fingerprint === lastStatsFingerprint) return;
  lastStatsFingerprint = fingerprint;

  const tags = [...tagStats.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => t + "=" + c).join(",") || "-";
  const accs = [...accountCountStats.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => n + "=" + c).join(",") || "-";
  console.log(
    "[SOLANA][AMMV4][STATS]"
    + " candidateLogs=" + stats.candidateLogs
    + " fetch(ok/null)=" + stats.fetchSuccess + "/" + stats.fetchNull
    + " parsed=" + stats.parsed
    + " ambiguous=" + stats.ambiguous
    + " rejected=" + stats.rejected
    + " | migration(conf/susp/none)=" + stats.migrationConfirmed + "/" + stats.migrationSuspected + "/" + stats.migrationNone
    + " | tags=" + tags
    + " | accountCounts=" + accs,
  );
}
