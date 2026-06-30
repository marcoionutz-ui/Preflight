/**
 * discovery/clmmShadow.ts
 * CLMM shadow diagnostics / dry-run parser.
 * Kept for observing CLMM instructions while clmmFetcher handles production writes.
 */

import { Connection } from "@solana/web3.js";
import { RAYDIUM_CLMM } from "../config/programs";
import { normalizeQuote } from "./quoteNormalizer";
import { extractTargetProgramInstructions } from "./logStack";

// ── Stats in-memory ───────────────────────────────────────────────────────────

/** instruction name -> count total observate (doar CLMM-native) */
const instructionStats = new Map<string, number>();

/** instruction name -> cate sample tx am fetch-uit */
const samplesFetched   = new Map<string, number>();

const MAX_SAMPLES_PER_INSTRUCTION = 3;

// ── Dedupe pentru fetch ───────────────────────────────────────────────────────

const seenSigs = new Set<string>();
const MAX_SIGS = 5_000;

// extractTargetProgramInstructions vine din logStack.ts (shared cu clmmFetcher.ts)

// ── Candidate filter ──────────────────────────────────────────────────────────

/** Instructiuni CLMM cu siguranta non-pool-creation */
const IGNORE_RE = /swap|increase|decrease|collect|transfer|update|set|close|position|reward/i;

function isCandidate(name: string): boolean {
  const n = name.toLowerCase();
  if (IGNORE_RE.test(n)) return false;
  return n.includes("create") || n.includes("initialize") || n.includes("init") || n.includes("pool");
}

// ── Fetch sample tx ───────────────────────────────────────────────────────────

// ── Dry-run parser (8.0g-a4) ─────────────────────────────────────────────────

interface ClmmCreatePoolResult {
  shape:       string;
  poolAddress: string;
  mint0:       string;
  mint1:       string;
}

/**
 * Parseaza accounts din instructiunea CLMM CreatePool.
 * Layout-uri observate live:
 *   shape=13: [0]=payer [1]=ammConfig [2]=pool [3]=mint0 [4]=mint1 ...
 *   shape=21: [0]=payer [4]=pool ... [18]=mint0 [19]=mint1 ...
 *
 * Returneaza null daca layout-ul nu e recunoscut sau datele nu sunt valide.
 */
const CLMM_CREATE_INSTRUCTIONS = new Set(["CreatePool", "CreateCustomizablePool"]);

function parseClmmCreatePool(instructionName: string, accounts: string[]): ClmmCreatePoolResult | null {
  // Guard: parseaza doar instructiuni de pool creation, nu orice ix cu 13/21 accounts
  if (!CLMM_CREATE_INSTRUCTIONS.has(instructionName)) return null;

  let result: ClmmCreatePoolResult | null = null;

  if (accounts.length === 13) {
    result = {
      shape:       "CREATE_POOL_13",
      poolAddress: accounts[2],
      mint0:       accounts[3],
      mint1:       accounts[4],
    };
  } else if (accounts.length === 20 || accounts.length === 21) {
    // shape=20 observat live; shape=21 lasat defensiv daca apare alt variant
    result = {
      shape:       "CREATE_POOL_" + accounts.length,
      poolAddress: accounts[4],
      mint0:       accounts[18],
      mint1:       accounts[19],
    };
  }

  if (!result) return null;

  // Sanity guards
  const { poolAddress, mint0, mint1 } = result;
  if (
    !poolAddress || !mint0 || !mint1 ||
    poolAddress === mint0 ||
    poolAddress === mint1 ||
    mint0 === mint1
  ) return null;

  return result;
}

// Retry delays: 2s → 5s → 15s
// logsSubscribe poate livra logul inainte ca getParsedTransaction sa fie disponibil la RPC
const FETCH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

async function fetchParsedTxWithRetry(
  connection: Connection,
  signature:  string,
  instructionName: string,
) {
  for (let attempt = 0; attempt < FETCH_RETRY_DELAYS_MS.length; attempt++) {
    await new Promise(r => setTimeout(r, FETCH_RETRY_DELAYS_MS[attempt]));
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) return tx;
      console.log(
        "[SOLANA][CLMM][TX_RETRY]"
        + " instruction=" + instructionName
        + " sig=" + signature.slice(0, 12) + "..."
        + " attempt=" + (attempt + 1) + " null",
      );
    } catch (err) {
      console.warn(
        "[SOLANA][CLMM][TX_RETRY]"
        + " instruction=" + instructionName
        + " sig=" + signature.slice(0, 12) + "..."
        + " attempt=" + (attempt + 1)
        + " error=" + (err as Error).message,
      );
      // continua cu urmatorul attempt — nu iesi din loop
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
    console.warn("[SOLANA][CLMM][TX] null after all retries sig=" + signature.slice(0, 12));
    return;
  }

  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions);
  const all   = [...outer, ...inner];

  // Dedupe pool addresses — un tx poate contine mai multe CLMM ix (shape 13 + shape 21)
  const parsedPools = new Set<string>();

  let found = false;
  for (const ix of all) {
    if (ix.programId.toBase58() !== RAYDIUM_CLMM) continue;
    if (!("accounts" in ix)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    const accStrs = accs.map(a => a.toBase58());

    const accList = accStrs
      .map((a, idx) => idx + ":" + a.slice(0, 12))
      .join(" ");

    console.log(
      "[SOLANA][CLMM][TX]"
      + " instruction=" + instructionName
      + " sig=" + signature.slice(0, 12) + "..."
      + " accounts[" + accs.length + "]"
      + " | " + accList,
    );
    found = true;

    // 8.0g-a4 — dry-run parser, zero Redis
    const parsed = parseClmmCreatePool(instructionName, accStrs);
    if (parsed && !parsedPools.has(parsed.poolAddress)) {
      parsedPools.add(parsed.poolAddress);

      const { baseMint, quoteMint, quoteType } = normalizeQuote(parsed.mint0, parsed.mint1);
      console.log(
        "[SOLANA][CLMM][PARSED]"
        + " instruction=" + instructionName
        + " shape=" + parsed.shape
        + " pool=" + parsed.poolAddress.slice(0, 12) + "..."
        + " mint0=" + parsed.mint0.slice(0, 12) + "..."
        + " mint1=" + parsed.mint1.slice(0, 12) + "..."
        + " base=" + baseMint.slice(0, 12) + "..."
        + " quote=" + quoteMint.slice(0, 12) + "..."
        + " quoteType=" + quoteType,
      );
    }
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
  // Stack-aware: extrage doar instruction-urile emise de CLMM, nu din CPI-uri catre alte programe
  const names = extractTargetProgramInstructions(logs, RAYDIUM_CLMM);

  // 1. Track stats pentru instruction names CLMM-native
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
