/**
 * discovery/clmmFetcher.ts
 * 8.0g-a5: Fetch + parse Raydium CLMM CreatePool / CreateCustomizablePool.
 *
 * Layout-uri observate live (a4 dry-run):
 *   shape=13: [2]=poolState  [3]=mint0  [4]=mint1
 *   shape=20: [4]=poolState  [18]=mint0 [19]=mint1
 *   shape=21: acelasi ca 20 (variant defensiv)
 */

import { Connection } from "@solana/web3.js";
import { RAYDIUM_CLMM } from "../config/programs";
import { extractTargetProgramInstructions } from "./logStack";

export interface ClmmCreateResult {
  poolAddress: string;
  mint0:       string;
  mint1:       string;
}

// ── Pre-filter (ieftin, inainte de fetch) ────────────────────────────────────

const CLMM_CREATE_NAMES = ["CreatePool", "CreateCustomizablePool"];

/**
 * Verifica daca logs-urile contin o instructiune CLMM de pool creation.
 * Stack-aware — ignora "Instruction: CreatePool" din alte programe din acelasi tx.
 */
export function isClmmCreateLog(logs: string[]): boolean {
  const names = extractTargetProgramInstructions(logs, RAYDIUM_CLMM);
  return names.some(n => CLMM_CREATE_NAMES.includes(n));
}

// ── Account parser ────────────────────────────────────────────────────────────

function parseClmmCreateAccounts(accounts: string[]): ClmmCreateResult | null {
  let poolAddress: string | undefined;
  let mint0:       string | undefined;
  let mint1:       string | undefined;

  if (accounts.length === 13) {
    poolAddress = accounts[2];
    mint0       = accounts[3];
    mint1       = accounts[4];
  } else if (accounts.length === 20 || accounts.length === 21) {
    poolAddress = accounts[4];
    mint0       = accounts[18];
    mint1       = accounts[19];
  } else {
    return null;
  }

  // Sanity guards
  if (!poolAddress || !mint0 || !mint1)             return null;
  if (poolAddress === mint0 || poolAddress === mint1) return null;
  if (mint0 === mint1)                               return null;

  return { poolAddress, mint0, mint1 };
}

// ── Fetch cu retry ────────────────────────────────────────────────────────────

// logsSubscribe poate livra logul inainte ca tx-ul sa fie disponibil la RPC
const FETCH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

/**
 * Fetch tranzactia si extrage poolAddress, mint0, mint1.
 * Returneaza null daca tx nu poate fi gasit sau parsata.
 */
export async function fetchClmmCreate(
  connection: Connection,
  signature:  string,
): Promise<ClmmCreateResult | null> {
  let tx = null;

  for (let attempt = 0; attempt < FETCH_RETRY_DELAYS_MS.length; attempt++) {
    await new Promise(r => setTimeout(r, FETCH_RETRY_DELAYS_MS[attempt]));
    try {
      tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) break;
      console.log(
        "[SOLANA][CLMM] fetch attempt=" + (attempt + 1)
        + " null sig=" + signature.slice(0, 12),
      );
    } catch (err) {
      console.warn(
        "[SOLANA][CLMM] fetch attempt=" + (attempt + 1)
        + " error sig=" + signature.slice(0, 12) + ":",
        (err as Error).message,
      );
    }
  }

  if (!tx) return null;

  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions);
  const all   = [...outer, ...inner];

  // Returneaza primul CLMM ix cu layout recunoscut (shape 13 sau 20/21)
  for (const ix of all) {
    if (ix.programId.toBase58() !== RAYDIUM_CLMM) continue;
    if (!("accounts" in ix)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    const result = parseClmmCreateAccounts(accs.map(a => a.toBase58()));
    if (result) return result;
  }

  return null;
}
