/**
 * discovery/txFetcher.ts
 * 8.0d: fetch + parse Raydium CPMM Initialize transaction.
 *
 * A2 (2026-07-18): reparat filtrul + parserul care scriau înregistrări corupte
 * permanent (SET NX) cu token-account-uri în loc de mint-uri:
 *   1. isCpmmInitLog e acum stack-aware + exact-match "Initialize" (înainte
 *      `logs.some(l => l.includes("Instruction: Initialize"))` prindea și
 *      `InitializeAccount3`/`InitializeImmutableOwner` din Token/ATA în orice
 *      swap CPMM).
 *   2. fetchCpmmInit verifică discriminatorul Anchor al instrucțiunii (primii 8
 *      bytes din `ix.data` = sha256("global:initialize")[:8]) — nu mai ia prima
 *      instrucțiune CPMM cu suficiente conturi. Un CPMM Deposit/Swap ordonat
 *      înaintea unui Initialize în același tx nu mai poate fi interpretat greșit.
 *   3. min 20 conturi (layout-ul oficial Initialize are ≥20, până la `rent`).
 *   4. retry pe null/eroare RPC (H8/A4) — logsSubscribe poate livra logul înainte
 *      ca tx-ul să fie disponibil la RPC.
 *
 * Discriminator dovedit dependency-free (decoder base58 inline) — bs58 n-are
 * types bundle și ar cere npm install; nu merită o dependență nouă pentru 8 bytes.
 *
 * Raydium CPMM Initialize instruction accounts (index):
 *   0  creator
 *   1  ammConfig
 *   2  authority (PDA)
 *   3  poolState     <- pool address
 *   4  token0Mint    <- mint0
 *   5  token1Mint    <- mint1
 *   6  lpMint
 *   ...  (≥20 conturi în total, până la systemProgram/rent)
 */

import type { Connection } from "@solana/web3.js";
import { RAYDIUM_CPMM } from "../config/programs";
import { extractTargetProgramInstructions } from "./logStack";

export interface CpmmInitResult {
  poolAddress: string;
  mint0:       string;
  mint1:       string;
}

/** Numele instrucțiunii Anchor de creare pool CPMM (Program log: "Instruction: Initialize"). */
const CPMM_INIT_NAME = "Initialize";

/** Anchor discriminator = sha256("global:initialize")[:8] = af af 6d 1f 0d 98 9b ed */
const CPMM_INITIALIZE_DISCRIMINATOR = Uint8Array.from([
  0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed,
]);

/** Layout-ul oficial Initialize declară ≥20 conturi (până la rent). */
const CPMM_INITIALIZE_MIN_ACCOUNTS = 20;

/** logsSubscribe poate livra logul înainte ca tx-ul să fie disponibil la RPC. */
const FETCH_RETRY_DELAYS_MS = [0, 2_000, 5_000, 15_000];

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ── base58 decode (inline, fără dependență) ──────────────────────────────────
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]] = i;

/**
 * Decode base58 → bytes (big-endian). Returnează null dacă un caracter e invalid.
 * Exportat pentru test direct (partea cu istoric de bug-uri merită testată izolat).
 */
export function base58Decode(str: string): Uint8Array | null {
  if (str.length === 0) return new Uint8Array(0);
  const bytes: number[] = [];
  for (const ch of str) {
    const val = B58_MAP[ch];
    if (val === undefined) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // leading '1' → leading zero bytes
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/**
 * Verifică dacă instrucțiunea (PartiallyDecodedInstruction cu `data` base58) e
 * un CPMM Initialize, prin discriminatorul Anchor din primii 8 bytes.
 */
export function isCpmmInitializeInstruction(ix: { data?: string }): boolean {
  if (!ix.data) return false;
  const decoded = base58Decode(ix.data);
  if (!decoded || decoded.length < CPMM_INITIALIZE_DISCRIMINATOR.length) return false;
  for (let i = 0; i < CPMM_INITIALIZE_DISCRIMINATOR.length; i++) {
    if (decoded[i] !== CPMM_INITIALIZE_DISCRIMINATOR[i]) return false;
  }
  return true;
}

/**
 * Verifica daca logs-urile contin o instructiune CPMM Initialize (filtru ieftin
 * inainte de fetch). Stack-aware — extractTargetProgramInstructions returneaza
 * DOAR numele instructiunilor emise de RAYDIUM_CPMM, ignorand Token/ATA/Jupiter,
 * iar match-ul exact "Initialize" exclude variantele "InitializeAccount3" etc.
 */
export function isCpmmInitLog(logs: string[]): boolean {
  const names = extractTargetProgramInstructions(logs, RAYDIUM_CPMM);
  return names.includes(CPMM_INIT_NAME);
}

/**
 * Valideaza layout-ul instructiunii Initialize (accounts[3]=pool, [4]=mint0,
 * [5]=mint1) cu min-20 conturi + sanity guards (distincte, prezente).
 */
function parseCpmmInitAccounts(accounts: string[]): CpmmInitResult | null {
  if (accounts.length < CPMM_INITIALIZE_MIN_ACCOUNTS) return null;

  const poolAddress = accounts[3];
  const mint0       = accounts[4];
  const mint1       = accounts[5];

  if (!poolAddress || !mint0 || !mint1)               return null;
  if (poolAddress === mint0 || poolAddress === mint1) return null;
  if (mint0 === mint1)                                return null;

  return { poolAddress, mint0, mint1 };
}

/**
 * Fetch tranzactia si extrage poolAddress, mint0, mint1 din instructiunea CPMM
 * Initialize. Retry pe null/eroare RPC; returneaza null daca tx nu poate fi gasit
 * sau nu contine un Initialize valid (discriminator + layout). Nu face retry
 * pentru tx gasit dar cu instructiune invalida.
 *
 * retryDelaysMs e injectabil pentru teste (default: FETCH_RETRY_DELAYS_MS).
 */
export async function fetchCpmmInit(
  connection:    Connection,
  signature:     string,
  retryDelaysMs: number[] = FETCH_RETRY_DELAYS_MS,
): Promise<CpmmInitResult | null> {
  let tx = null;

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) await sleep(retryDelaysMs[attempt]);
    try {
      tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) break;
      console.log(
        "[SOLANA][CPMM] fetch attempt=" + (attempt + 1)
        + " null sig=" + signature.slice(0, 12),
      );
    } catch (err) {
      console.warn(
        "[SOLANA][CPMM] fetch attempt=" + (attempt + 1)
        + " error sig=" + signature.slice(0, 12) + ":",
        (err as Error).message,
      );
    }
  }

  if (!tx) return null;

  // Outer + inner instructions
  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions);
  const all = [...outer, ...inner];

  for (const ix of all) {
    if (ix.programId.toBase58() !== RAYDIUM_CPMM) continue;
    // PartiallyDecodedInstruction are `accounts` + `data`; ParsedInstruction nu.
    if (!("accounts" in ix) || !("data" in ix)) continue;
    if (!isCpmmInitializeInstruction(ix as { data?: string })) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    const result = parseCpmmInitAccounts(accs.map(a => a.toBase58()));
    if (result) return result;
  }

  return null;
}
