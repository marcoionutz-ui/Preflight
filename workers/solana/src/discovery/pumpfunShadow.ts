/**
 * discovery/pumpfunShadow.ts
 * pump.fun shadow diagnostics — observa instructiuni live, sample TX accounts.
 * Zero Redis writes. Scopul: verifica instruction names + account layout
 * inainte de a scrie parserul de productie (8.0g-b fetcher).
 *
 * Analogul clmmShadow.ts pentru pump.fun.
 */

import { Connection } from "@solana/web3.js";
import { PUMPFUN_PROGRAM } from "../config/programs";
import { extractTargetProgramInstructions } from "./logStack";

// ── Stats in-memory ───────────────────────────────────────────────────────────

/** instruction name -> count total observate (doar pumpfun-native) */
const instructionStats = new Map<string, number>();

/** instruction name -> cate sample TX am fetch-uit */
const samplesFetched   = new Map<string, number>();

const MAX_SAMPLES_PER_INSTRUCTION = 3;

// ── Dedupe pentru fetch ───────────────────────────────────────────────────────

const seenSigs = new Set<string>();
const MAX_SIGS = 10_000; // pump.fun e mult mai voluminos decat CLMM

// ── Candidate filter ──────────────────────────────────────────────────────────

/** Instructiuni pump.fun cu siguranta non-launch */
const IGNORE_RE = /^(buy|sell|withdraw|set|update|collect|close|transfer)/i;

/**
 * Returneaza true daca instructiunea ar putea fi un token launch / create.
 * Conservator: mai bine un false positive decat sa ratam Create.
 */
function isCandidate(name: string): boolean {
  const n = name.toLowerCase();
  if (IGNORE_RE.test(n)) return false;
  return (
    n.includes("create") ||
    n.includes("launch") ||
    n.includes("initialize") ||
    n.includes("init") ||
    n.includes("mint")
  );
}

// ── Fetch sample TX ───────────────────────────────────────────────────────────

// logsSubscribe poate livra logul inainte ca tx-ul sa fie disponibil la RPC
const FETCH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

async function fetchParsedTxWithRetry(
  connection: Connection,
  signature:  string,
  instructionName: string,
): Promise<import("@solana/web3.js").ParsedTransactionWithMeta | null> {
  for (let attempt = 0; attempt < FETCH_RETRY_DELAYS_MS.length; attempt++) {
    await new Promise(r => setTimeout(r, FETCH_RETRY_DELAYS_MS[attempt]));
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) return tx;
      console.log(
        "[SOLANA][PUMPFUN][TX_RETRY]"
        + " instruction=" + instructionName
        + " sig=" + signature.slice(0, 12) + "..."
        + " attempt=" + (attempt + 1) + " null",
      );
    } catch (err) {
      console.warn(
        "[SOLANA][PUMPFUN][TX_RETRY]"
        + " instruction=" + instructionName
        + " sig=" + signature.slice(0, 12) + "..."
        + " attempt=" + (attempt + 1)
        + " error=" + (err as Error).message,
      );
      // continua cu urmatorul attempt
    }
  }
  return null;
}

async function fetchSampleTx(
  connection:      Connection,
  signature:       string,
  instructionName: string,
): Promise<void> {
  const tx = await fetchParsedTxWithRetry(connection, signature, instructionName);

  if (!tx) {
    console.warn("[SOLANA][PUMPFUN][TX] null after all retries sig=" + signature.slice(0, 12));
    return;
  }

  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions);
  const all   = [...outer, ...inner];

  // Signer = tx.transaction.message.accountKeys[0] (fee payer / creator)
  const accountKeys = tx.transaction.message.accountKeys;
  const signer      = accountKeys[0]?.pubkey?.toBase58() ?? "?";

  let found = false;
  for (const ix of all) {
    if (ix.programId.toBase58() !== PUMPFUN_PROGRAM) continue;
    if (!("accounts" in ix)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    const accList = accs
      .map((a, idx) => idx + ":" + a.toBase58().slice(0, 12))
      .join(" ");

    console.log(
      "[SOLANA][PUMPFUN][TX]"
      + " instruction=" + instructionName
      + " sig=" + signature.slice(0, 12) + "..."
      + " signer=" + signer.slice(0, 12)
      + " accounts[" + accs.length + "]"
      + " | " + accList,
    );
    found = true;
  }

  if (!found) {
    console.log(
      "[SOLANA][PUMPFUN][TX] no pumpfun ix found"
      + " instruction=" + instructionName
      + " sig=" + signature.slice(0, 12),
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Proceseaza un event pump.fun din onLogs.
 * Apelat pentru FIECARE event pumpfun — track stats mereu,
 * fetch TX doar pentru candidate instructions sub limita de sample.
 */
export function handlePumpfunShadow(
  connection: Connection,
  signature:  string,
  slot:       number,
  logs:       string[],
): void {
  // Stack-aware: extrage doar instructiunile emise de pump.fun, nu CPI-uri
  const names = extractTargetProgramInstructions(logs, PUMPFUN_PROGRAM);

  // 1. Track stats pentru instruction names pumpfun-native
  for (const name of names) {
    instructionStats.set(name, (instructionStats.get(name) ?? 0) + 1);
  }

  // 2. Gasim candidates (dedupe per tx)
  const candidates = [...new Set(names.filter(isCandidate))];
  if (candidates.length === 0) return;

  // 3. Dedupe signature
  if (seenSigs.has(signature)) return;
  if (seenSigs.size >= MAX_SIGS) seenSigs.clear();
  seenSigs.add(signature);

  // 4. Fetch sample TX pentru fiecare candidate (pana la MAX_SAMPLES_PER_INSTRUCTION)
  for (const name of candidates) {
    const already = samplesFetched.get(name) ?? 0;
    if (already >= MAX_SAMPLES_PER_INSTRUCTION) continue;
    samplesFetched.set(name, already + 1);

    console.log(
      "[SOLANA][PUMPFUN][CANDIDATE]"
      + " instruction=" + name
      + " slot=" + slot
      + " sig=" + signature.slice(0, 12) + "...",
    );

    fetchSampleTx(connection, signature, name).catch((err: Error) => {
      console.warn("[SOLANA][PUMPFUN][TX] error:", err.message);
    });
  }
}

/**
 * Logheaza stats acumulate.
 * Apelat periodic din health loop.
 */
export function logPumpfunStats(): void {
  if (instructionStats.size === 0) return;
  const sorted = [...instructionStats.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => name + "=" + count)
    .join(" ");
  console.log("[SOLANA][PUMPFUN][STATS] instructions " + sorted);
}
