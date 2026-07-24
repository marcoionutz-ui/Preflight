/**
 * discovery/ammV4Shadow.ts — D4a: shadow diagnostics pentru Raydium AMM V4 (pool creation).
 *
 * CONTEXT: AMM V4 (`675kPX...`) e abonat în `logSubscriber.ts` și dovedește liveness (D2), DAR callback-ul
 * din `index.ts` nu-l procesează — cădea prin ramurile pumpfun/clmm/cpmm fără să facă nimic. Deci pool-urile
 * AMM V4 create direct (nu prin migrarea pump.fun / backfill) sunt ratate azi. D4 = să le procesăm, NU să
 * scoatem subscripția.
 *
 * DE CE SHADOW ÎNTÂI (lecția Fazei A): la A2/A4 un „swap prins ca pool init" a scris înregistrări corupte
 * PERMANENT (conturi greșite → poolAddress/mint-uri greșite → registry otrăvit). AMM V4 e NATIV (nu Anchor),
 * deci NU emite `Program log: Instruction: X` ca CPMM/CLMM. Shadow-ul confirmă din tranzacții REALE, cu ZERO
 * scrieri în Redis, până avem destule exemple ca să scriem un fetcher determinist (D4b/c).
 *
 * LAYOUT OFICIAL (raydium-amm/program/src/instruction.rs — `Initialize2`): tag NATIV `1`, 21 conturi,
 * pool la index 4, coin mint la 8, pc mint la 9. Shadow-ul NU presupune orbește: raportează `EXPECTED` dacă
 * mainnet-ul corespunde sursei, `ANOMALY` altfel (tag/layout diferit → merită investigat înainte de D4b).
 *
 * MĂSURI (ajustările varu):
 *   1. `isAmmV4InitLog` e DOAR prefiltru; adevărul vine din tranzacție (instrucțiunea către RAYDIUM_AMM_V4).
 *   2. BOUNDED — dedupe per signature, o singură fetch în zbor, cooldown, sampling; zero Redis writes.
 *   3. Migrare pe DOUĂ niveluri: `confirmed` (tx conține o INSTRUCȚIUNE a programului pump.fun) vs `suspected`
 *      (autoritatea de migrare apare doar printre CONTURI — e authority, NU program executabil).
 *   4. NU atinge coada, `healthCritical` sau registry — pur diagnostic.
 */

import { Connection } from "@solana/web3.js";
import { RAYDIUM_AMM_V4, PUMPFUN_PROGRAM, PUMPFUN_MIGRATION } from "../config/programs";
import { base58Decode } from "./txFetcher";

// ── Layout oficial AMM V4 Initialize2 (instruction.rs) — pt. verdictul EXPECTED/ANOMALY, NU pt. scriere ──
export const AMM_V4_INIT2_TAG          = 1;
export const AMM_V4_INIT2_ACCOUNT_COUNT = 21;
export const AMM_V4_POOL_IDX     = 4;
export const AMM_V4_COIN_MINT_IDX = 8;
export const AMM_V4_PC_MINT_IDX   = 9;

// ── Prefiltru de log (PROVIZORIU — doar reduce fetch-urile, NU e dovadă finală) ──────────────────────────
//
// AMM V4 e nativ: init2 emite tipic `Program log: initialize2: InitializeInstruction2 { ... }`, iar init
// vechi `Program log: initialize: ...`. Token Program emite `Program log: Instruction: InitializeAccount3`
// (cu prefixul „Instruction:") — regexul de mai jos NU se potrivește cu acelea (exact bug-ul A2 evitat),
// fiindcă cere `initialize` IMEDIAT după `Program log: `. Adevărul se confirmă din tranzacție.
const AMM_V4_INIT_LOG_RE = /^Program log: initialize2?\b/i;

/** Prefiltru ieftin: tx-ul (deja scoped pe AMM V4) pare o creare de pool? Provizoriu — vezi comentariul. */
export function isAmmV4InitLog(logs: readonly string[]): boolean {
  return logs.some((l) => AMM_V4_INIT_LOG_RE.test(l));
}

// ── Rezumat PUR al instrucțiunilor AMM V4 dintr-un tx candidat (fără Connection → testabil) ───────────────

export interface AmmV4Instruction {
  dataB58:  string;   // `data` base58 al instrucțiunii (native → PartiallyDecodedInstruction)
  accounts: string[]; // pubkeys base58, în ordine
}

export type AmmV4Outcome = "parsed" | "ambiguous" | "rejected";

export interface AmmV4InitSummary {
  outcome:      AmmV4Outcome;
  tag:          number | null; // primul byte al instrucțiunii = discriminatorul NATIV (descoperit, nu presupus)
  accountCount: number | null;
}

/** Primul byte al datei base58 = discriminatorul nativ; null dacă data e goală / invalidă. */
function decodeTag(dataB58: string): number | null {
  const decoded = base58Decode(dataB58);
  return decoded && decoded.length > 0 ? decoded[0] : null;
}

/**
 * Clasifică instrucțiunile emise de AMM V4 într-un tx candidat, PUR (fără RPC), fără să presupună layout-ul:
 *   - 0 instrucțiuni AMM V4 → `rejected` (prefiltrul de log a dat fals-pozitiv — ex. CPI/log asemănător);
 *   - exact 1 CU date valide → `parsed`, cu `tag` = primul byte (discriminatorul real) + `accountCount`;
 *   - exact 1 cu date INVALIDE (fără discriminator lizibil) → `rejected` (nu-l numărăm ca „parsed" — onest);
 *   - >1 → `ambiguous` (nu decidem care e init-ul dintr-un shadow — îl marcăm ca să-l investigăm manual).
 * NU extrage pool/mint aici: shadow-ul loghează lista COMPLETĂ de conturi + verdictul EXPECTED/ANOMALY.
 */
export function summarizeAmmV4Init(ammIxs: readonly AmmV4Instruction[]): AmmV4InitSummary {
  if (ammIxs.length === 0) return { outcome: "rejected", tag: null, accountCount: null };

  const first = ammIxs[0];
  const tag = decodeTag(first.dataB58);

  if (ammIxs.length > 1) {
    return { outcome: "ambiguous", tag, accountCount: first.accounts.length };
  }
  // exact 1 instrucțiune
  if (tag === null) {
    return { outcome: "rejected", tag: null, accountCount: first.accounts.length };
  }
  return { outcome: "parsed", tag, accountCount: first.accounts.length };
}

/** `true` dacă (tag, accountCount) corespund layout-ului oficial Initialize2 (tag 1, 21 conturi). */
export function isExpectedAmmV4Layout(tag: number | null, accountCount: number | null): boolean {
  return tag === AMM_V4_INIT2_TAG && accountCount === AMM_V4_INIT2_ACCOUNT_COUNT;
}

// ── Detecție migrare (PURĂ, determinist din tx — două niveluri) ───────────────────────────────────────────

export type MigrationLevel = "confirmed" | "suspected" | "none";

/**
 * `confirmed`: tx-ul conține o INSTRUCȚIUNE emisă de programul pump.fun → init-ul e parte dintr-o migrare
 *   (determinist; doar un program executabil poate emite instrucțiuni).
 * `suspected`: autoritatea de migrare (`PUMPFUN_MIGRATION`) apare doar printre CONTURILE tx-ului — e o
 *   AUTORITATE (signer/PDA), NU un program; prezența ei incidentală nu dovedește o migrare. Nu tragem
 *   concluzia „acoperit" doar fiindcă adresa apare în conturi.
 * `none`: niciun semn.
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
  candidateLogs:      0, // prefiltrul de log a trecut
  fetchSuccess:       0, // getParsedTransaction a întors un tx
  fetchNull:          0, // null după toate retry-urile
  parsed:             0, // exact 1 instrucțiune AMM V4 cu date valide
  ambiguous:          0, // >1 instrucțiune AMM V4
  rejected:           0, // 0 instrucțiuni AMM V4 (fals-pozitiv), date invalide, sau fetch null
  layoutExpected:     0, // parsed ȘI (tag 1, 21 conturi)
  layoutAnomaly:      0, // parsed DAR tag/layout diferit de sursa oficială
  migrationConfirmed: 0,
  migrationSuspected: 0,
  migrationNone:      0,
};

/** tag (primul byte, hex) → count — DISTRIBUȚIA discriminatorilor reali observați. */
const tagStats = new Map<string, number>();
/** numărul de conturi → count — DISTRIBUȚIA layout-urilor observate. */
const accountCountStats = new Map<number, number>();

// ── Bounded fetch ─────────────────────────────────────────────────────────────────────────────────────────

const seenSigs = new Set<string>();
const MAX_SIGS = 10_000;             // AMM V4 e voluminos → cap pe dedupe
const MAX_INIT_SAMPLES = 20;         // câte tx-uri candidate eșantionăm în total (nu vrem DDoS pe RPC-ul propriu)
const FETCH_COOLDOWN_MS = 3_000;     // rate-limit între fetch-uri
const MAX_CONCURRENT_FETCH = 1;      // o singură fetch în zbor (serializat)
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

  const summary = summarizeAmmV4Init(ammIxs);
  if (summary.outcome === "parsed")         stats.parsed++;
  else if (summary.outcome === "ambiguous") stats.ambiguous++;
  else                                      stats.rejected++;

  const expected = summary.outcome === "parsed" && isExpectedAmmV4Layout(summary.tag, summary.accountCount);
  if (summary.outcome === "parsed") {
    if (expected) stats.layoutExpected++;
    else          stats.layoutAnomaly++;
  }

  if (summary.tag !== null) {
    const hex = "0x" + summary.tag.toString(16).padStart(2, "0");
    tagStats.set(hex, (tagStats.get(hex) ?? 0) + 1);
  }
  if (summary.accountCount !== null) {
    accountCountStats.set(summary.accountCount, (accountCountStats.get(summary.accountCount) ?? 0) + 1);
  }

  // Migrare (determinist din tx): programId-urile TUTUROR instrucțiunilor + toate conturile tx-ului.
  const instrProgramIds = all.map((ix) => ix.programId.toBase58());
  const accountKeys = tx.transaction.message.accountKeys.map((a) => a.pubkey.toBase58());
  const migration = detectMigration(instrProgramIds, accountKeys);
  if (migration === "confirmed")      stats.migrationConfirmed++;
  else if (migration === "suspected") stats.migrationSuspected++;
  else                                stats.migrationNone++;

  // Candidați pool/mint DOAR când layout=EXPECTED (indicii oficiali) — PUR diagnostic, zero scrieri.
  const primary = ammIxs[0]?.accounts ?? [];
  const candidate = expected
    ? {
        poolCandidate:     primary[AMM_V4_POOL_IDX] ?? null,
        coinMintCandidate: primary[AMM_V4_COIN_MINT_IDX] ?? null,
        pcMintCandidate:   primary[AMM_V4_PC_MINT_IDX] ?? null,
      }
    : null;

  // Log structurat: TOATE instrucțiunile AMM V4 (nu doar prima) cu ADRESELE COMPLETE — ca să copiem un
  // exemplu real într-un test la D4b și să comparăm layout-uri / să verificăm mint-urile on-chain.
  console.log("[SOLANA][AMMV4][TX] " + JSON.stringify({
    kind:         "AMMV4_SHADOW",
    outcome:      summary.outcome,
    tag:          summary.tag,
    accountCount: summary.accountCount,
    layout:       summary.outcome === "parsed" ? (expected ? "EXPECTED" : "ANOMALY") : "N/A",
    migration,
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
 * Procesează un event AMM V4 din onLogs (DOAR diagnostic). Prefiltru de log → dedupe → bounded fetch.
 * Zero Redis writes. Nu enqueue, nu registry.
 */
export function handleAmmV4Shadow(
  connection: Connection,
  signature:  string,
  slot:       number,
  logs:       string[],
): void {
  if (!isAmmV4InitLog(logs)) return;
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

/** Logează stats acumulate (apelat periodic din health loop). */
export function logAmmV4Stats(): void {
  if (stats.candidateLogs === 0) return;
  const tags = [...tagStats.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => t + "=" + c).join(",") || "-";
  const accs = [...accountCountStats.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => n + "=" + c).join(",") || "-";
  console.log(
    "[SOLANA][AMMV4][STATS]"
    + " candidateLogs=" + stats.candidateLogs
    + " fetch(ok/null)=" + stats.fetchSuccess + "/" + stats.fetchNull
    + " parsed=" + stats.parsed
    + " ambiguous=" + stats.ambiguous
    + " rejected=" + stats.rejected
    + " layout(exp/anom)=" + stats.layoutExpected + "/" + stats.layoutAnomaly
    + " | migration(conf/susp/none)=" + stats.migrationConfirmed + "/" + stats.migrationSuspected + "/" + stats.migrationNone
    + " | tags=" + tags
    + " | accountCounts=" + accs,
  );
}
