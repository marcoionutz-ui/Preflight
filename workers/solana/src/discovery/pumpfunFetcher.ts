/**
 * discovery/pumpfunFetcher.ts
 * 8.0g-b3: Fetch + parse pump.fun CreateV2 (token launch).
 *
 * Layout observat live (b1 shadow — 3 TX-uri confirmate):
 *   shape=16 (outer CreateV2):
 *     [0] = mint               — noul token mint
 *     [1] = global             — TSLvdd1pWpHV (fix, PDA global pump.fun)
 *     [2] = bondingCurve       — PDA bonding curve per token
 *     [3] = associatedBondingCurve — vault cu tokens
 *     [4] = feeRecipient       — 4wTV1YmiEkRv (fix)
 *     [5] = creator            — wallet-ul care lanseaza tokenul
 *
 * Inner instructions (accounts[18], accounts[27], accounts[1]) sunt CPI-uri
 * din acelasi TX — ignorate, parserul ia doar shape=16.
 */

import { Connection } from "@solana/web3.js";
import { PUMPFUN_PROGRAM } from "../config/programs";
import { extractTargetProgramInstructions } from "./logStack";

export interface PumpfunCreateResult {
  mint:                     string;
  bondingCurveAddress:      string;
  associatedBondingCurve:   string;
  creatorAddress:           string;
}

// ── Pre-filter (ieftin, inainte de fetch) ────────────────────────────────────

const PUMPFUN_CREATE_NAMES = ["CreateV2"];

/**
 * Verifica daca logs-urile contin o instructiune pump.fun CreateV2.
 * Stack-aware — ignora "Instruction: CreateV2" din alte programe din acelasi tx.
 */
export function isPumpfunCreateLog(logs: string[]): boolean {
  const names = extractTargetProgramInstructions(logs, PUMPFUN_PROGRAM);
  return names.some(n => PUMPFUN_CREATE_NAMES.includes(n));
}

// ── Account parser ────────────────────────────────────────────────────────────

// Known fixed addresses pentru sanity guards
const PUMPFUN_GLOBAL  = "TSLvdd1pWpHV2hER4LUwCJpFVJMTt3YMp8GFxKcGp7d";
const PUMPFUN_FEE     = "4wTV1YmiEkRvbMFrQyGE2n6TyR5NUBBQkbzcEyiJJeaS";

function parsePumpfunCreateAccounts(accounts: string[]): PumpfunCreateResult | null {
  if (accounts.length !== 16) return null;

  const mint                   = accounts[0];
  const global                 = accounts[1];
  const bondingCurveAddress    = accounts[2];
  const associatedBondingCurve = accounts[3];
  const feeRecipient           = accounts[4];
  const creatorAddress         = accounts[5];

  // Fixed-address guards — confirma ca e instructiunea corecta din protocolul pump.fun
  if (global      !== PUMPFUN_GLOBAL) return null;
  if (feeRecipient !== PUMPFUN_FEE)   return null;

  if (!mint || !bondingCurveAddress || !associatedBondingCurve || !creatorAddress) return null;
  if (mint === bondingCurveAddress)                   return null;
  if (mint === creatorAddress)                        return null;
  if (bondingCurveAddress === associatedBondingCurve) return null;

  return { mint, bondingCurveAddress, associatedBondingCurve, creatorAddress };
}

// ── Fetch cu retry ────────────────────────────────────────────────────────────

// logsSubscribe poate livra logul inainte ca tx-ul sa fie disponibil la RPC
const FETCH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

/**
 * Fetch tranzactia si extrage datele de launch.
 * Cauta DOAR instructiunea outer cu shape=16 — ignora inner CPI-uri.
 * Returneaza null daca TX nu poate fi gasit sau parsata.
 */
export async function fetchPumpfunCreate(
  connection: Connection,
  signature:  string,
): Promise<PumpfunCreateResult | null> {
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
        "[SOLANA][PUMPFUN] fetch attempt=" + (attempt + 1)
        + " null sig=" + signature.slice(0, 12),
      );
    } catch (err) {
      console.warn(
        "[SOLANA][PUMPFUN] fetch attempt=" + (attempt + 1)
        + " error sig=" + signature.slice(0, 12) + ":",
        (err as Error).message,
      );
      // continua cu urmatorul attempt
    }
  }

  if (!tx) return null;

  // Cauta DOAR in outer instructions — inner CPI-uri au alte shape-uri
  const outer = tx.transaction.message.instructions;

  for (const ix of outer) {
    if (ix.programId.toBase58() !== PUMPFUN_PROGRAM) continue;
    if (!("accounts" in ix)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    const result = parsePumpfunCreateAccounts(accs.map(a => a.toBase58()));
    if (result) return result;
  }

  return null;
}
