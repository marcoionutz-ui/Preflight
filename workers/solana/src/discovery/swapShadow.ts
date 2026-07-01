/**
 * discovery/swapShadow.ts
 * 8.0h-b1: Raydium swap shadow classifier — CPMM + CLMM.
 *
 * Shadow-first: observa swap instructions live, sample account layouts.
 * Zero Redis writes. Scopul: identifica instruction names + account layout
 * inainte de parser real in 8.0h-b2.
 *
 * Swap instructions asteptate (bazate pe Raydium IDL):
 *   CPMM: SwapBaseInput, SwapBaseOutput
 *   CLMM: Swap, SwapV2
 */

import { Connection } from "@solana/web3.js";
import { RAYDIUM_CPMM, RAYDIUM_CLMM } from "../config/programs";
import { extractTargetProgramInstructions } from "./logStack";

// ── Tipuri ────────────────────────────────────────────────────────────────────

export type SwapProgram = "cpmm" | "clmm";

// ── Stats in-memory ───────────────────────────────────────────────────────────

/** instruction name -> total observate */
const cpmmStats  = new Map<string, number>();
const clmmStats  = new Map<string, number>();

/** instruction name -> cate sample TX am fetch-uit */
const cpmmSampled = new Map<string, number>();
const clmmSampled = new Map<string, number>();

// Conservative: swaps sunt MULT mai frecvente decat pool creation.
// 2 sample TX per instruction name e suficient pentru layout observation.
const MAX_SAMPLES_PER_INSTRUCTION = 2;

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

// Un delay simplu — nu e nevoie de multi-retry ca la pool creation.
// Swap-urile sunt confirmate rapid si RPC le are disponibile mai repede.
const FETCH_DELAY_MS = 3_000;

async function fetchSampleTx(
  connection:      Connection,
  signature:       string,
  instructionName: string,
  programId:       string,
  label:           string,
): Promise<void> {
  await new Promise(r => setTimeout(r, FETCH_DELAY_MS));

  let tx = null;
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
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Proceseaza un event Raydium din onLogs pentru swap shadow.
 * Apelat pentru ORICE event CPMM / CLMM (inclusiv non-swap) — track stats mereu,
 * fetch TX sample doar pentru swap candidates (max MAX_SAMPLES_PER_INSTRUCTION pe instruction name).
 *
 * Nu incetineste discovery pipeline — fetch e async, non-blocking.
 */
export function handleSwapShadow(
  connection: Connection,
  signature:  string,
  slot:       number,
  logs:       string[],
  program:    SwapProgram,
): void {
  const programId = program === "cpmm" ? RAYDIUM_CPMM : RAYDIUM_CLMM;
  const label     = program.toUpperCase();
  const stats     = program === "cpmm" ? cpmmStats  : clmmStats;
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

  // 4. Sample TX pentru fiecare swap candidate (max 2 per instruction name, ever)
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

    fetchSampleTx(connection, signature, name, programId, label).catch((err: Error) => {
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
