/**
 * discovery/clmmShadow.ts
 * 8.0g-a1: Shadow classifier pentru Raydium CLMM.
 *
 * Scop: invatam ce instruction-uri emite CLMM inainte sa scriem parserul final.
 * - Track stats pentru toate instruction names observate
 * - Log candidates (create/init/pool patterns)
 * - Fetch max 3 sample tx per instruction candidate
 * - Log accounts raw din fiecare sample tx
 *
 * Zero Redis. Zero parser. Zero offsets hardcodate. Doar observam.
 */

import { Connection } from "@solana/web3.js";
import { RAYDIUM_CLMM } from "../config/programs";

// ── Stats in-memory ───────────────────────────────────────────────────────────

/** instruction name -> count total observate */
const instructionStats = new Map<string, number>();

/** instruction name -> cate sample tx am fetch-uit */
const samplesFetched   = new Map<string, number>();

const MAX_SAMPLES_PER_INSTRUCTION = 3;

// ── Dedupe pentru fetch ───────────────────────────────────────────────────────

const seenSigs  = new Set<string>();
const MAX_SIGS  = 5_000;

// ── Patterns ──────────────────────────────────────────────────────────────────

/** Extrage "Instruction: <Name>" din fiecare linie de log */
const INSTRUCTION_RE = /Program log: Instruction:\s*([A-Za-z0-9_]+)/;

/** Instructiuni comune care cu siguranta nu sunt pool creation */
const IGNORE_RE = /swap|increase|decrease|collect|transfer|update|set|close|position|reward/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractInstructionNames(logs: string[]): string[] {
  return logs
    .map(l => l.match(INSTRUCTION_RE)?.[1])
    .filter((x): x is string => Boolean(x));
}

function isCandidate(name: string): boolean {
  const n = name.toLowerCase();
  if (IGNORE_RE.test(n)) return false;
  return n.includes("create") || n.includes("initialize") || n.includes("init") || n.includes("pool");
}

// ── Fetch sample tx ───────────────────────────────────────────────────────────

async function fetchSampleTx(
  connection:      Connection,
  signature:       string,
  instructionName: string,
): Promise<void> {
  let tx;
  try {
    tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch (err) {
    console.warn("[SOLANA][CLMM][TX] fetch failed sig=" + signature.slice(0, 12) + ":", (err as Error).message);
    return;
  }

  if (!tx) {
    console.warn("[SOLANA][CLMM][TX] null tx sig=" + signature.slice(0, 12));
    return;
  }

  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions);
  const all   = [...outer, ...inner];

  let found = false;
  for (const ix of all) {
    if (ix.programId.toBase58() !== RAYDIUM_CLMM) continue;
    if (!("accounts" in ix)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    const accList = accs
      .map((a, idx) => idx + ":" + a.toBase58().slice(0, 12))
      .join(" ");

    console.log(
      "[SOLANA][CLMM][TX]"
      + " instruction=" + instructionName
      + " sig=" + signature.slice(0, 12) + "..."
      + " accounts[" + accs.length + "]"
      + " | " + accList,
    );
    found = true;
  }

  if (!found) {
    console.log(
      "[SOLANA][CLMM][TX] no CLMM ix found"
      + " instruction=" + instructionName
      + " sig=" + signature.slice(0, 12),
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Proceseaza un event CLMM din onLogs.
 * Apelat pentru FIECARE event raydium_clmm — track stats mereu,
 * fetch tx doar pentru candidate instructions sub limita de sample.
 */
export function handleClmmShadow(
  connection: Connection,
  signature:  string,
  slot:       number,
  logs:       string[],
): void {
  const names = extractInstructionNames(logs);

  // 1. Track stats pentru toate instruction names
  for (const name of names) {
    instructionStats.set(name, (instructionStats.get(name) ?? 0) + 1);
  }

  // 2. Gasim candidates — dedupe per tx (acelasi instruction poate aparea de mai multe ori in logs)
  const candidates = [...new Set(names.filter(isCandidate))];
  if (candidates.length === 0) return;

  // 3. Dedupe signature
  if (seenSigs.has(signature)) return;
  if (seenSigs.size >= MAX_SIGS) seenSigs.clear();
  seenSigs.add(signature);

  // 4. Fetch sample tx pentru fiecare candidate (pana la MAX_SAMPLES_PER_INSTRUCTION)
  for (const name of candidates) {
    const already = samplesFetched.get(name) ?? 0;
    if (already >= MAX_SAMPLES_PER_INSTRUCTION) continue;
    samplesFetched.set(name, already + 1);

    console.log(
      "[SOLANA][CLMM][CANDIDATE]"
      + " instruction=" + name
      + " slot=" + slot
      + " sig=" + signature.slice(0, 12) + "...",
    );

    fetchSampleTx(connection, signature, name).catch((err: Error) => {
      console.warn("[SOLANA][CLMM][TX] error:", err.message);
    });
  }
}

/**
 * Logheaza stats acumulate.
 * Apelat periodic din health loop.
 */
export function logClmmStats(): void {
  if (instructionStats.size === 0) return;
  const sorted = [...instructionStats.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => name + "=" + count)
    .join(" ");
  console.log("[SOLANA][CLMM][STATS] instructions " + sorted);
}
