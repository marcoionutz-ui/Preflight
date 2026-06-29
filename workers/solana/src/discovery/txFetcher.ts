/**
 * discovery/txFetcher.ts
 * 8.0d: fetch + parse Raydium CPMM Initialize transaction.
 *
 * Raydium CPMM Initialize instruction accounts (index):
 *   0  creator
 *   1  ammConfig
 *   2  authority (PDA)
 *   3  poolState     <- pool address
 *   4  token0Mint    <- mint0
 *   5  token1Mint    <- mint1
 *   6  lpMint
 *   ...
 *
 * Cautam in outer instructions + inner instructions (CPI).
 */

import { Connection } from "@solana/web3.js";
import { RAYDIUM_CPMM } from "../config/programs";

export interface CpmmInitResult {
  poolAddress: string;
  mint0:       string;
  mint1:       string;
}

/** Log pattern emis de Raydium CPMM la Initialize. */
const CPMM_INIT_LOG = "Program log: Instruction: Initialize";

/** Verifica daca logs-urile contin instructiunea Initialize (filtru ieftin inainte de fetch). */
export function isCpmmInitLog(logs: string[]): boolean {
  return logs.some(l => l === CPMM_INIT_LOG);
}

/**
 * Fetch tranzactia si extrage poolAddress, mint0, mint1 din instructiunea CPMM Initialize.
 * Returneaza null daca tx nu contine instructiunea sau nu poate fi parsata.
 */
export async function fetchCpmmInit(
  connection: Connection,
  signature:  string,
): Promise<CpmmInitResult | null> {
  let tx;
  try {
    tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch (err) {
    console.warn("[SOLANA][TX] getParsedTransaction failed:", (err as Error).message);
    return null;
  }

  if (!tx) return null;

  // Outer + inner instructions
  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions);
  const all = [...outer, ...inner];

  for (const ix of all) {
    if (ix.programId.toBase58() !== RAYDIUM_CPMM) continue;
    // PartiallyDecodedInstruction are campul `accounts`; ParsedInstruction nu.
    if (!("accounts" in ix)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    if (accs.length < 6) continue;

    return {
      poolAddress: accs[3].toBase58(),
      mint0:       accs[4].toBase58(),
      mint1:       accs[5].toBase58(),
    };
  }

  return null;
}
