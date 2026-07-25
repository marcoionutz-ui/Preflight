/**
 * discovery/pumpfunFetcher.ts
 * 8.0g-b6: Fetch + parse pump.fun token launches.
 *
 * Suporta doua instructiuni:
 *
 *   shape=16 (CreateV2 — curent):
 *     [0] = mint               — noul token mint
 *     [1] = global             — TSLvdd1pWpHV (fix, PDA global pump.fun)
 *     [2] = bondingCurve       — PDA bonding curve per token
 *     [3] = associatedBondingCurve — vault cu tokens
 *     [4] = feeRecipient       — 4wTV1YmiEkRv (fix)
 *     [5] = creator            — wallet-ul care lanseaza tokenul
 *
 *   shape=14 (Create — legacy, inca activ):
 *     [0] = mint
 *     [1] = global             — TSLvdd1pWpHV (fix)
 *     [2] = bondingCurve
 *     [3] = associatedBondingCurve
 *     [4] = feeRecipient       — 4wTV1YmiEkRv (fix)
 *     [5] = MPL Token Metadata — metaqbxxUerd (fix)
 *     [6] = ?                  — PDA metadata per token
 *     [7] = creator
 *     [8] = SystemProgram
 *     [9] = TokenkegQfeZ
 *     [10] = ATokenGPvbdG
 *     [11] = SysvarRent
 *     [12] = Ce6TQqeHC9p8      — pump.fun event authority (fix)
 *     [13] = 6EF8rrecthR5      — PUMPFUN_PROGRAM (fix, exact)
 *
 * Fetcher-ul cauta in outer + inner instructions — pe unele versiuni de TX,
 * instructiunea outer vine ca ParsedInstruction (fara camp accounts) si e skipped.
 */

import { Connection } from "@solana/web3.js";
import { PUMPFUN_PROGRAM } from "../config/programs";
import { extractTargetProgramInstructions } from "./logStack";

export interface PumpfunCreateResult {
  mint:                     string;
  bondingCurveAddress:      string;
  associatedBondingCurve:   string;
  creatorAddress:           string;
  instructionShape:         "CREATE_V2" | "CREATE_LEGACY";
}

/**
 * NF3: rezultat DISCRIMINAT — separă cele TREI destine ale unui candidat, pe care înainte `null` le conflă
 * (→ retry → dead-letter → health DEGRADED blocat pe fals-pozitive ȘI pe variante reale pierdute):
 *   - `ok`          — Create/CreateV2 valid parsat → scrie.
 *   - `invalid`     — tx ADUS, dar sigur nu-i o creare de indexat: `NO_CREATE` (0 instrucțiuni pump.fun =
 *                     fals-pozitiv de log, SAU layout recunoscut 14/16 dar guard-urile stricte au picat) sau
 *                     `FAILED_TX` (tx eșuată). → ACK (nu-i pierdere recuperabilă).
 *   - `unsupported` — instrucțiune pump.fun cu account count NECUNOSCUT (≠14/16) → poate fi o VARIANTĂ
 *                     CreateV2 nouă = lansare REALĂ pe care parserul n-o înțelege încă. NU o arunca ca invalid;
 *                     `accountCounts` (doar cele necunoscute) → quarantine durabil + ACK (dovada pt. parserul următor).
 *   - `unavailable` — `getParsedTransaction` a întors null după toate retry-urile (RPC nu servește) → retry
 *                     (dead-letter pe MAX = semnal onest că RPC chiar n-a livrat, nu că nu-i candidat).
 */
export type PumpfunFetchOutcome =
  | { status: "ok";          result: PumpfunCreateResult }
  | { status: "invalid";     reason: "NO_PUMPFUN_IX" | "FAILED_TX" }
  | { status: "unsupported"; reason: "UNKNOWN_ACCOUNT_COUNT" | "KNOWN_LAYOUT_GUARDS_FAILED"; accountCounts: number[] }
  | { status: "unavailable" };

/** Shape-urile de conturi cunoscute (CreateV2=16, Create legacy=14). Un count în afara lor = variantă nouă. */
const KNOWN_CREATE_ACCOUNT_COUNTS = [14, 16];

// ── Pre-filter (ieftin, inainte de fetch) ────────────────────────────────────

const PUMPFUN_CREATE_NAMES = ["CreateV2", "Create"];

/**
 * Verifica daca logs-urile contin o instructiune pump.fun de tip create.
 * Stack-aware — ignora aceleasi instruction names din alte programe CPI.
 */
export function isPumpfunCreateLog(logs: string[]): boolean {
  const names = extractTargetProgramInstructions(logs, PUMPFUN_PROGRAM);
  return names.some(n => PUMPFUN_CREATE_NAMES.includes(n));
}

// ── Adrese fixe (prefixe confirmate live, exact acolo unde stim full address) ─

const PUMPFUN_GLOBAL_PREFIX  = "TSLvdd1pWpHV"; // accounts[1] in ambele shapes
const PUMPFUN_FEE_PREFIX     = "4wTV1YmiEkRv"; // accounts[4] in ambele shapes
const MPL_METADATA_PREFIX    = "metaqbxxUerd"; // accounts[5] in shape=14 — MPL Token Metadata
const PUMPFUN_EVENT_PREFIX   = "Ce6TQqeHC9p8"; // accounts[12] in shape=14 — event authority

// ── Parsere ───────────────────────────────────────────────────────────────────

/** CreateV2 — instructiunea curenta, accounts[16] */
function parseCreateV2(accounts: string[]): PumpfunCreateResult | null {
  if (accounts.length !== 16) return null;

  const mint                   = accounts[0];
  const global                 = accounts[1];
  const bondingCurveAddress    = accounts[2];
  const associatedBondingCurve = accounts[3];
  const feeRecipient           = accounts[4];
  const creatorAddress         = accounts[5];

  if (!global.startsWith(PUMPFUN_GLOBAL_PREFIX))     return null;
  if (!feeRecipient.startsWith(PUMPFUN_FEE_PREFIX))  return null;

  if (!mint || !bondingCurveAddress || !associatedBondingCurve || !creatorAddress) return null;
  if (mint === bondingCurveAddress)                    return null;
  if (mint === creatorAddress)                         return null;
  if (bondingCurveAddress === associatedBondingCurve)  return null;

  return { mint, bondingCurveAddress, associatedBondingCurve, creatorAddress, instructionShape: "CREATE_V2" };
}

/** Create (legacy) — inca activ, accounts[14] */
function parseCreateLegacy(accounts: string[]): PumpfunCreateResult | null {
  if (accounts.length !== 14) return null;

  const mint                   = accounts[0];
  const global                 = accounts[1];
  const bondingCurveAddress    = accounts[2];
  const associatedBondingCurve = accounts[3];
  const feeRecipient           = accounts[4];
  const mplMetadata            = accounts[5];
  const creatorAddress         = accounts[7];
  const eventAuthority         = accounts[12];
  const programSelf            = accounts[13];

  // Guards — shape=14 e mai strict, avem mai multe adrese fixe confirmate
  if (!global.startsWith(PUMPFUN_GLOBAL_PREFIX))       return null;
  if (!feeRecipient.startsWith(PUMPFUN_FEE_PREFIX))    return null;
  if (!mplMetadata.startsWith(MPL_METADATA_PREFIX))    return null;
  if (!eventAuthority.startsWith(PUMPFUN_EVENT_PREFIX)) return null;
  if (programSelf !== PUMPFUN_PROGRAM)                  return null; // exact — stim full address

  if (!mint || !bondingCurveAddress || !associatedBondingCurve || !creatorAddress) return null;
  if (mint === bondingCurveAddress)                    return null;
  if (mint === creatorAddress)                         return null;
  if (bondingCurveAddress === associatedBondingCurve)  return null;

  return { mint, bondingCurveAddress, associatedBondingCurve, creatorAddress, instructionShape: "CREATE_LEGACY" };
}

// ── Fetch cu retry ────────────────────────────────────────────────────────────────────────────────────

const FETCH_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

export async function fetchPumpfunCreate(
  connection:    Connection,
  signature:     string,
  retryDelaysMs: number[] = FETCH_RETRY_DELAYS_MS,
): Promise<PumpfunFetchOutcome> {
  let tx = null;

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    await new Promise(r => setTimeout(r, retryDelaysMs[attempt]));
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
    }
  }

  if (!tx) return { status: "unavailable" };                          // n-am putut aduce → tranzitoriu (retry)
  if (tx.meta?.err) return { status: "invalid", reason: "FAILED_TX" }; // tx eșuată → nu-i o creare validă (ACK)

  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions);
  const allIx = [...outer, ...inner];

  const pumpfunAccountCounts: number[] = [];
  for (const ix of allIx) {
    if (ix.programId.toBase58() !== PUMPFUN_PROGRAM) continue;
    if (!("accounts" in ix)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    const strs = accs.map(a => a.toBase58());
    pumpfunAccountCounts.push(strs.length);

    const result = parseCreateV2(strs) ?? parseCreateLegacy(strs);
    if (result) return { status: "ok", result };
  }

  // Nicio instrucțiune pump.fun n-a parsat un Create valid.
  //   - 0 instrucțiuni pump.fun în tx → `invalid` NO_PUMPFUN_IX (fals-pozitiv de log; programul n-a fost
  //     invocat cu o instrucțiune) → ACK sigur.
  //   - EXISTĂ o instrucțiune pump.fun dar n-a parsat → `unsupported` → quarantine. Account count-ul NU e
  //     versiunea protocolului: un layout de 16 conturi cu PDA/ordine/fee schimbate poate fi o versiune NOUĂ
  //     care păstrează 16 → NU-l arunca ca invalid. `KNOWN_LAYOUT_GUARDS_FAILED` (14/16 dar guard-uri picate)
  //     vs `UNKNOWN_ACCOUNT_COUNT` (≠14/16) — ambele = necunoscute, păstrăm dovada.
  if (pumpfunAccountCounts.length === 0) return { status: "invalid", reason: "NO_PUMPFUN_IX" };
  const hasUnknownCount = pumpfunAccountCounts.some(c => !KNOWN_CREATE_ACCOUNT_COUNTS.includes(c));
  return {
    status: "unsupported",
    reason: hasUnknownCount ? "UNKNOWN_ACCOUNT_COUNT" : "KNOWN_LAYOUT_GUARDS_FAILED",
    accountCounts: pumpfunAccountCounts,
  };
}
