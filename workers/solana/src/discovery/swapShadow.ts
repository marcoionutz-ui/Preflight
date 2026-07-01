/**
 * discovery/swapShadow.ts
 * 8.0h-b1: Raydium swap shadow classifier — CPMM + CLMM.
 * 8.0h-b2: Dry-run swap parser integrat in sample fetch (parseSwapTx).
 * 8.0h-b3: Activity state write pentru knownPool=true (recordSwapActivity).
 *          Sample counters reset la 60s — sampling continuu, nu "ever".
 *
 * Swap instructions confirmate live (8.0h-b1):
 *   CPMM: SwapBaseInput (accounts[13]), SwapBaseOutput (accounts[13])
 *   CLMM: SwapV2 (accounts[15]), Swap legacy (accounts[12]/[16] — ignorat)
 */

import { Connection, ParsedTransactionWithMeta } from "@solana/web3.js";
import { RAYDIUM_CPMM, RAYDIUM_CLMM } from "../config/programs";
import { extractTargetProgramInstructions } from "./logStack";
import { parseSwapTx } from "./swapParser";
import { recordSwapActivity } from "./swapActivity";

// ── Tipuri ────────────────────────────────────────────────────────────────────

export type SwapProgram = "cpmm" | "clmm";

// ── Stats in-memory ───────────────────────────────────────────────────────────

/** instruction name -> total observate */
const cpmmStats  = new Map<string, number>();
const clmmStats  = new Map<string, number>();

/** instruction name -> cate sample TX am fetch-uit in fereastra curenta */
const cpmmSampled = new Map<string, number>();
const clmmSampled = new Map<string, number>();

// Max 2 sample TX per instruction name per fereastra de 60s.
// Dupa reset, se mai pot fetcha inca 2 → sampling continuu, nu "ever".
const MAX_SAMPLES_PER_INSTRUCTION = 2;

// ── Sample reset periodic ────────────────────────────────────────────────────

const SAMPLE_RESET_INTERVAL_MS = 60_000; // 60 secunde
let lastSampleReset = Date.now();

/**
 * Reseteaza contori de sample la fiecare 60s.
 * Permite sampling continuu pentru activity writes (b3) si nu blocheaza
 * observarea de noi instructiuni daca apar in viitor.
 */
function maybeResetSamples(): void {
  const now = Date.now();
  if (now - lastSampleReset < SAMPLE_RESET_INTERVAL_MS) return;
  lastSampleReset = now;
  cpmmSampled.clear();
  clmmSampled.clear();
}

// ── Dedupe pentru fetch ───────────────────────────────────────────────────────

const seenSigs = new Set<string>();
const MAX_SIGS = 5_000;

// ── Candidate filter ──────────────────────────────────────────────────────────

/** Instructiuni care cu siguranta NU sunt swaps */
const IGNORE_RE = /^(initialize|create|collect|close|set|update|admin|increase|decrease|deposit|withdraw|open|position|reward|transfer|lock|unlock|harvest)/i;

function isSwapCandidate(name: string): boolean {
  if (IGNORE_RE.test(name)) return false;
  return /swap/i.test(name);
}

// ── Fetch sample TX ───────────────────────────────────────────────────────────

// Un delay simplu — swap-urile sunt confirmate rapid la RPC.
const FETCH_DELAY_MS = 3_000;

async function fetchSampleTx(
  connection:      Connection,
  signature:       string,
  instructionName: string,
  programId:       string,
  label:           string,
  program:         SwapProgram,
): Promise<void> {
  await new Promise(r => setTimeout(r, FETCH_DELAY_MS));

  let tx: ParsedTransactionWithMeta | null = null;
  try {
    tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch (err) {
    console.warn(
      "[SOLANA][SWAP][" + label + "][SHADOW] fetch error"
      + " sig=" + signature.slice(0, 12) + ":",
      (err as Error).message,
    );
    return;
  }

  if (!tx) {
    console.log(
      "[SOLANA][SWAP][" + label + "][SHADOW] null tx sig=" + signature.slice(0, 12),
    );
    return;
  }

  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions);
  const allIx = [...outer, ...inner];

  let found = false;
  for (const ix of allIx) {
    if (ix.programId.toBase58() !== programId) continue;
    if (!("accounts" in ix)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    const accList = accs
      .map((a, idx) => idx + ":" + a.toBase58().slice(0, 12))
      .join(" ");

    console.log(
      "[SOLANA][SWAP][" + label + "][SHADOW]"
      + " instruction=" + instructionName
      + " sig=" + signature.slice(0, 12) + "..."
      + " accounts[" + accs.length + "]"
      + " | " + accList,
    );
    found = true;
  }

  if (!found) {
    console.log(
      "[SOLANA][SWAP][" + label + "][SHADOW] no ix found"
      + " instruction=" + instructionName
      + " sig=" + signature.slice(0, 12),
    );
    return;
  }

  // b2: parse — zero Redis writes in parser
  parseSwapTx(tx, programId, instructionName, program, signature)
    .then((result) => {
      if (!result) {
        console.log(
          "[SOLANA][SWAP][" + label + "][PARSE] layout unrecognized"
          + " instruction=" + instructionName
          + " sig=" + signature.slice(0, 12),
        );
        return;
      }

      console.log(
        "[SOLANA][SWAP][" + label + "][PARSE]"
        + " pool=" + result.pool.slice(0, 8) + "..."
        + " base=" + result.baseMint.slice(0, 8) + "..."
        + " quote=" + result.quoteMint.slice(0, 8) + "..."
        + " flow=" + result.flow
        + " inputAmt=" + (result.inputAmount?.toString() ?? "null")
        + " outputAmt=" + (result.outputAmount?.toString() ?? "null")
        + " knownPool=" + result.knownPool
        + " sig=" + signature.slice(0, 12) + "...",
      );

      // b3: activity write — doar pentru pooluri cunoscute
      if (!result.knownPool) return;
      recordSwapActivity(result, signature).catch((err: Error) => {
        console.warn("[SOLANA][SWAP][" + label + "][ACTIVITY] error:", err.message);
      });
    })
    .catch((err: Error) => {
      console.warn("[SOLANA][SWAP][" + label + "][PARSE] error:", err.message);
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Proceseaza un event Raydium din onLogs pentru swap shadow + activity.
 * Apelat pentru ORICE event CPMM / CLMM — track stats mereu,
 * fetch TX sample pentru swap candidates (max 2/instruction/60s).
 *
 * Non-blocking — fetch e async, nu incetineste discovery pipeline.
 */
export function handleSwapShadow(
  connection: Connection,
  signature:  string,
  slot:       number,
  logs:       string[],
  program:    SwapProgram,
): void {
  // Reset periodic al sample contorilor (60s) — sampling continuu pentru b3
  maybeResetSamples();

  const programId = program === "cpmm" ? RAYDIUM_CPMM : RAYDIUM_CLMM;
  const label     = program.toUpperCase();
  const stats     = program === "cpmm" ? cpmmStats   : clmmStats;
  const sampled   = program === "cpmm" ? cpmmSampled : clmmSampled;

  // Stack-aware: extrage instructiunile emise de program, ignora CPI noise
  const names = extractTargetProgramInstructions(logs, programId);

  // 1. Track stats pentru toate instruction names observate
  for (const name of names) {
    stats.set(name, (stats.get(name) ?? 0) + 1);
  }

  // 2. Identifica swap candidates
  const candidates = [...new Set(names.filter(isSwapCandidate))];
  if (candidates.length === 0) return;

  // 3. Dedupe signature (nu fetch acelasi tx de mai multe ori)
  if (seenSigs.has(signature)) return;
  if (seenSigs.size >= MAX_SIGS) seenSigs.clear();
  seenSigs.add(signature);

  // 4. Sample TX pentru fiecare candidate (max 2/instruction/60s dupa reset)
  for (const name of candidates) {
    const already = sampled.get(name) ?? 0;
    if (already >= MAX_SAMPLES_PER_INSTRUCTION) continue;
    sampled.set(name, already + 1);

    console.log(
      "[SOLANA][SWAP][" + label + "][SHADOW] candidate"
      + " instruction=" + name
      + " slot=" + slot
      + " sig=" + signature.slice(0, 12) + "...",
    );

    fetchSampleTx(connection, signature, name, programId, label, program).catch((err: Error) => {
      console.warn("[SOLANA][SWAP][" + label + "][SHADOW] error:", err.message);
    });
  }
}

/**
 * Logheaza stats acumulate pentru CPMM si CLMM swap shadow.
 * Apelat periodic din health loop.
 */
export function logSwapStats(): void {
  const fmt = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => n + "=" + c)
      .join(" ");

  if (cpmmStats.size > 0) {
    console.log("[SOLANA][SWAP][CPMM][STATS] " + fmt(cpmmStats));
  }
  if (clmmStats.size > 0) {
    console.log("[SOLANA][SWAP][CLMM][STATS] " + fmt(clmmStats));
  }
}
