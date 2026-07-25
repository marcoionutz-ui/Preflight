/**
 * discovery/pumpfunFetcher.ts
 * Fetch + parse pump.fun token launches. SELECȚIE PRIN DISCRIMINATOR (nu prin numărul de conturi).
 *
 * Instrucțiunea de creare e identificată după discriminatorul Anchor (primii 8 bytes), NU după câte conturi
 * are — fiindcă în același tx stau și buy/extend/event pump.fun cu alte count-uri. Layout-uri suportate:
 *
 *   create_v2 (disc d6904cec5f8b31b4) — LIVE, 19 conturi (sau 16, backward-compat):
 *     [0]mint [1]global(TSLvdd) [2]bondingCurve [3]assocBondingCurve [4]fee(4wTV) [5]creator
 *     [6]SystemProgram [14]eventAuthority(Ce6TQ) [15]PUMPFUN_PROGRAM [16]quoteMint(WSOL|USDC)
 *
 *   create (disc 181ec828051c0777) — legacy, 14 conturi:
 *     [0]mint [1]global [2]bondingCurve [3]assocBondingCurve [4]fee [5]MPL-metadata [7]creator
 *     [12]eventAuthority [13]PUMPFUN_PROGRAM
 *
 * Fetcher-ul caută în outer + inner instructions — pe unele TX instrucțiunea outer vine ca ParsedInstruction
 * (fără câmp accounts) și e skipped.
 */

import { Connection } from "@solana/web3.js";
import { PUMPFUN_PROGRAM } from "../config/programs";
import { extractTargetProgramInstructions } from "./logStack";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export interface PumpfunCreateResult {
  mint:                     string;
  bondingCurveAddress:      string;
  associatedBondingCurve:   string;
  creatorAddress:           string;
  instructionShape:         "CREATE_V2" | "CREATE_LEGACY";
  instructionAccountCount:  number; // 14 (legacy) | 16 | 19 (create_v2 live) — observabilitate layout
}

/**
 * NF3: rezultat DISCRIMINAT — separă cele TREI destine ale unui candidat, pe care înainte `null` le conflă
 * (→ retry → dead-letter → health DEGRADED blocat pe fals-pozitive ȘI pe variante reale pierdute):
 *   - `ok`          — create_v2/create valid parsat (selectat prin discriminator) → scrie.
 *   - `invalid`     — tx ADUS, dar sigur nu-i o creare de indexat: `NO_PUMPFUN_IX` (0 instrucțiuni pump.fun cu
 *                     accounts = fals-pozitiv de log), `NO_CREATE_IX` (doar buy/sell/extend, niciun discriminator
 *                     de creare + logul nu zice Create) sau `FAILED_TX` (tx eșuată). → ACK.
 *   - `unsupported` — NU o arunca; quarantine durabil (dovada pt. parserul următor):
 *                     `KNOWN_LAYOUT_GUARDS_FAILED` (discriminator de creare CUNOSCUT dar layout/guard picat) sau
 *                     `UNKNOWN_CREATE_DISCRIMINATOR` (logul zice Create dar discriminatorul e necunoscut = viitor
 *                     create_v3). `accountCounts` = toate count-urile pump.fun văzute.
 *   - `unavailable` — `getParsedTransaction` a întors null după toate retry-urile (RPC nu servește) → retry
 *                     (dead-letter pe MAX = semnal onest că RPC chiar n-a livrat, nu că nu-i candidat).
 */
export type PumpfunFetchOutcome =
  | { status: "ok";          result: PumpfunCreateResult }
  | { status: "invalid";     reason: "NO_PUMPFUN_IX" | "NO_CREATE_IX" | "FAILED_TX" }
  | { status: "unsupported"; reason: "KNOWN_LAYOUT_GUARDS_FAILED" | "UNKNOWN_CREATE_DISCRIMINATOR"; accountCounts: number[] }
  | { status: "unavailable" };

// ── Discriminatori Anchor de CREARE (verificați sha256("global:<name>")[:8]) ─────────────────────────
// Selectăm instrucțiunea de creare după DISCRIMINATOR, NU după numărul de conturi. Motivul (autopsia
// dead-letter, 2026-07-25): pump.fun a trecut live la `create_v2` cu 19 conturi, iar în ACELAȘI tx stau
// `extend_account`(5), `buy_exact_sol_in`(18), `buy_v2`/`buy_exact_quote_in_v2`(27) + event-CPI(1). Parserul
// vechi (doar count 14/16) rejecta create-ul de 19 → dead-letter fals pe LANSĂRI REALE. Discriminatorul e
// singura ancoră stabilă a identității instrucțiunii.
const CREATE_V2_DISCRIMINATOR     = "d6904cec5f8b31b4"; // global:create_v2 — 19 conturi (curent live pe mainnet)
const CREATE_LEGACY_DISCRIMINATOR = "181ec828051c0777"; // global:create — layout legacy 14 conturi

// ── base58 → discriminator (primii 8 bytes din instruction data, big-endian) ─────────────────────────
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = {};
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]] = i;

/** Primii 8 bytes ai `data` (base58) → hex. `null` dacă base58 invalid sau < 8 bytes. */
export function instructionDiscriminator(dataB58: string): string | null {
  const bytes: number[] = [];
  for (const ch of dataB58) {
    const val = B58_MAP[ch];
    if (val === undefined) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < dataB58.length && dataB58[k] === "1"; k++) bytes.push(0);
  bytes.reverse();
  if (bytes.length < 8) return null;
  return bytes.slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Pre-filter (ieftin, inainte de fetch) ────────────────────────────────────

// `Create`, `CreateV2`, `CreateV3`, … — orice versiune viitoare de creare. DELIBERAT lat: gate-ul de enqueue
// trebuie să aibă ACEEAȘI noțiune de „create" ca plasa `UNKNOWN_CREATE_DISCRIMINATOR` din fetcher — altfel un
// `CreateV3` nou n-ar ajunge NICIODATĂ în coadă și protecția n-ar rula. NU prinde `CreateMetadata`/`CreateAccount`.
const PUMPFUN_CREATE_NAME = /^Create(?:V\d+)?$/;

/**
 * Verifica daca logs-urile contin o instructiune pump.fun de tip create (orice versiune).
 * Stack-aware — ignora aceleasi instruction names din alte programe CPI.
 */
export function isPumpfunCreateLog(logs: string[]): boolean {
  const names = extractTargetProgramInstructions(logs, PUMPFUN_PROGRAM);
  return names.some(name => PUMPFUN_CREATE_NAME.test(name));
}

// ── Adrese fixe (prefixe confirmate live, exact acolo unde stim full address) ─

const PUMPFUN_GLOBAL_PREFIX  = "TSLvdd1pWpHV"; // accounts[1] in ambele shapes
const PUMPFUN_FEE_PREFIX     = "4wTV1YmiEkRv"; // accounts[4] in ambele shapes
const MPL_METADATA_PREFIX    = "metaqbxxUerd"; // accounts[5] in shape=14 — MPL Token Metadata
const PUMPFUN_EVENT_PREFIX   = "Ce6TQqeHC9p8"; // accounts[12] in shape=14 — event authority

// ── Parsere ───────────────────────────────────────────────────────────────────

/** CreateV2 — layout backward-compatible cu 16 conturi. */
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

  return { mint, bondingCurveAddress, associatedBondingCurve, creatorAddress, instructionShape: "CREATE_V2", instructionAccountCount: 16 };
}

/**
 * create_v2 — layout LIVE (19 conturi), confirmat pe mainnet 2026-07-25 (autopsie dead-letter + Dune).
 * Primele 6 poziții = identice cu V2/legacy; guard-uri pe conturile-program fixe ([6]/[8]/[15]/[18]) + adrese fixe.
 *   [0]mint [1]global(TSLvdd) [2]bondingCurve [3]assocBondingCurve [4]fee(4wTV) [5]creator
 *   [6]SystemProgram [14]eventAuthority(Ce6TQ) [15]PUMPFUN_PROGRAM [16]quoteMint(WSOL|USDC)
 * Guard-uri DOAR pe cele 5 invariante CERTE (identice pe toate probele mainnet 2026-07-25): global/fee/event
 * (prefix), System + PUMPFUN_PROGRAM (exact). NU guardăm [8]/[18] (ATA/Token) — constantele nu-s de încredere
 * (ATA_PROGRAM din config diferă de on-chain) și riscul e fals-negativ pe create-uri reale.
 */
function parseCreateV2Layout19(accounts: string[]): PumpfunCreateResult | null {
  if (accounts.length !== 19) return null;

  const mint                   = accounts[0];
  const global                 = accounts[1];
  const bondingCurveAddress    = accounts[2];
  const associatedBondingCurve = accounts[3];
  const feeRecipient           = accounts[4];
  const creatorAddress         = accounts[5];
  const systemProgram          = accounts[6];
  const eventAuthority         = accounts[14];
  const programSelf            = accounts[15];

  // Guards pe cele 5 invariante CERTE — ancorează layout-ul (buy/swap n-au această combinație pe aceste poziții).
  if (!global.startsWith(PUMPFUN_GLOBAL_PREFIX))       return null;
  if (!feeRecipient.startsWith(PUMPFUN_FEE_PREFIX))    return null;
  if (!eventAuthority.startsWith(PUMPFUN_EVENT_PREFIX)) return null;
  if (systemProgram !== SYSTEM_PROGRAM)                return null;
  if (programSelf   !== PUMPFUN_PROGRAM)               return null;

  if (!mint || !bondingCurveAddress || !associatedBondingCurve || !creatorAddress) return null;
  if (mint === bondingCurveAddress)                    return null;
  if (mint === creatorAddress)                         return null;
  if (bondingCurveAddress === associatedBondingCurve)  return null;

  return { mint, bondingCurveAddress, associatedBondingCurve, creatorAddress, instructionShape: "CREATE_V2", instructionAccountCount: 19 };
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

  return { mint, bondingCurveAddress, associatedBondingCurve, creatorAddress, instructionShape: "CREATE_LEGACY", instructionAccountCount: 14 };
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
  let sawCreateDiscriminator = false; // am văzut o instrucțiune pump.fun cu discriminator CUNOSCUT de creare
  for (const ix of allIx) {
    if (ix.programId.toBase58() !== PUMPFUN_PROGRAM) continue;
    if (!("accounts" in ix)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    const strs = accs.map(a => a.toBase58());
    pumpfunAccountCounts.push(strs.length);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const disc = instructionDiscriminator((ix as any).data ?? "");

    // Selecție PRIN DISCRIMINATOR: doar create_v2 / create (legacy) sunt candidate de parsare. buy/sell/
    // extend/event NU sunt niciodată tratate ca create (chiar dacă au un count care ar păcăli un parser naiv).
    if (disc === CREATE_V2_DISCRIMINATOR) {
      sawCreateDiscriminator = true;
      const result = parseCreateV2Layout19(strs) ?? parseCreateV2(strs); // create_v2 live=19; tolerăm și 16
      if (result) return { status: "ok", result };
    } else if (disc === CREATE_LEGACY_DISCRIMINATOR) {
      sawCreateDiscriminator = true;
      const result = parseCreateLegacy(strs);
      if (result) return { status: "ok", result };
    }
  }

  // Nicio instrucțiune pump.fun n-a parsat un Create valid. Clasificăm ONEST cele patru cazuri:
  if (pumpfunAccountCounts.length === 0) {
    return { status: "invalid", reason: "NO_PUMPFUN_IX" };            // fals-pozitiv de log; programul n-a fost invocat cu accounts
  }
  if (sawCreateDiscriminator) {
    // Discriminator de creare CUNOSCUT, dar layout-ul/guard-urile au picat → variantă nouă de layout (ex.
    // create_v2 cu aranjament schimbat) → quarantine (dovada pt. parserul următor), NU arunca.
    return { status: "unsupported", reason: "KNOWN_LAYOUT_GUARDS_FAILED", accountCounts: pumpfunAccountCounts };
  }
  // Niciun discriminator CUNOSCUT de creare printre instrucțiunile pump.fun. Două sub-cazuri:
  //   - logul (stack-aware) ZICE totuși Create/CreateV2 → e o creare cu discriminator NECUNOSCUT (ex. viitor
  //     create_v3) → `unsupported` → quarantine (NU o pierde ca invalid — exact bug-ul pe care NF3 îl previne).
  //   - logul nu indică nicio creare → tx-ul are doar buy/sell/extend pump.fun → chiar NU-i o creare → `invalid`.
  if (isPumpfunCreateLog(tx.meta?.logMessages ?? [])) {
    return { status: "unsupported", reason: "UNKNOWN_CREATE_DISCRIMINATOR", accountCounts: pumpfunAccountCounts };
  }
  return { status: "invalid", reason: "NO_CREATE_IX" };
}
