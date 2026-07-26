/**
 * discovery/ammV4Fetcher.ts — D4b: fetcher determinist pentru Raydium AMM V4 `Initialize2` (creare pool).
 *
 * Construit DUPĂ ce shadow-ul (D4a/D4a.1) a confirmat pe mainnet, cu o tranzacție reală, că layout-ul
 * corespunde EXACT sursei oficiale (raydium-amm/program/src/instruction.rs — `Initialize2`):
 *   tag NATIV `1`, 21 conturi, pool la index 4, coin mint la 8, pc mint la 9.
 * Golden fixture (sig `3wbXj5KG4UJq…`): pool=`6rNVp5kn…`, coinMint=`52U1CVjH…`, pcMint=WSOL.
 *
 * Refolosește helper-ele PURE din `ammV4Shadow.ts` (single-source al layout-ului): `AMM_V4_INIT2_*`,
 * `decodeTag` (primul byte = tag nativ), `AmmV4Instruction`. Structura de fetch/retry oglindește
 * `fetchCpmmInit` (același stil de tratare a `getParsedTransaction` + backoff).
 *
 * IMPORTANT: ZERO scrieri în Redis. Wire-uit în `index.ts`/coadă la D4c (după NF3, ca AMM V4
 * să NU moștenească dead-letter-ul INVALID/UNAVAILABLE nerezolvat). Aici doar EXTRAGEM + validăm structural.
 */

import type { Connection } from "@solana/web3.js";
import { RAYDIUM_AMM_V4 } from "../config/programs";
import {
  AMM_V4_INIT2_TAG, AMM_V4_INIT2_ACCOUNT_COUNT, AMM_V4_POOL_IDX, AMM_V4_COIN_MINT_IDX, AMM_V4_PC_MINT_IDX,
  decodeTag, type AmmV4Instruction,
} from "./ammV4Shadow";

export interface AmmV4InitResult {
  poolAddress: string;
  mint0:       string; // coin mint (accounts[8])
  mint1:       string; // pc mint   (accounts[9])
}

/**
 * D4c: rezultat DISCRIMINAT — AMM V4 NU trebuie să moștenească bug-ul pe care NF3 l-a reparat la pump.fun
 * (un `null` care conflă „RPC n-a livrat" cu „tx eșuată" cu „layout nou" → retry → dead-letter fals → health
 * DEGRADED blocat). Cele patru destine sunt separate explicit:
 *   - `ok`          — EXACT o instrucțiune AMM V4 cu tag 1, cu 21 conturi + guard-uri trecute → scrie pool.
 *   - `invalid`     — tx ADUS dar sigur nu-i o creare reușită: `FAILED_TX` (tx eșuată). → ACK.
 *   - `unsupported` — NU arunca; quarantine durabil (dovadă pt. parserul următor):
 *                     `AMBIGUOUS_INIT2` (>1 instrucțiune tag 1 în tx — nu ghicim care-i pool-ul),
 *                     `UNKNOWN_INIT2_LAYOUT` (o singură tag 1 dar count ≠ 21 = layout Raydium schimbat),
 *                     `KNOWN_LAYOUT_GUARDS_FAILED` (tag 1 / 21 dar guard-urile de distincție au picat),
 *                     `INIT2_EVIDENCE_MISMATCH` (gate-ul scoped a văzut un Initialize2 REUȘIT dar tx-ul n-are
 *                     NICIO instrucțiune tag 1 — dovezile se contrazic; NU ACK fail-open, păstrează suspiciunea).
 *   - `unavailable` — `getParsedTransaction` a întors null după toate retry-urile (RPC) → retry (onest).
 * (Clasificarea se face pe TOATE instrucțiunile cu tag 1, nu doar cele cu 21 conturi — altfel un tx cu
 *  `[tag1/21, tag1/20]` ar fi acceptat ca `ok`, ignorând tăcut a doua tag 1 cu layout necunoscut.)
 */
export type AmmV4FetchOutcome =
  | { status: "ok";          result: AmmV4InitResult }
  | { status: "invalid";     reason: "FAILED_TX" }
  | { status: "unsupported"; reason: "AMBIGUOUS_INIT2" | "UNKNOWN_INIT2_LAYOUT" | "KNOWN_LAYOUT_GUARDS_FAILED" | "INIT2_EVIDENCE_MISMATCH"; accountCounts: number[] }
  | { status: "unavailable" };

/** logsSubscribe poate livra logul înainte ca tx-ul să fie disponibil la RPC (ca la CPMM). */
const FETCH_RETRY_DELAYS_MS = [0, 2_000, 5_000, 15_000];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Validează layout-ul Initialize2 (21 conturi) și extrage pool/mint0/mint1 la indicii oficiali (4/8/9),
 * PUR. Guards: exact 21 conturi, toate prezente, distincte (pool≠mint, mint0≠mint1). Întoarce null altfel.
 * Conturile provin dintr-o instrucțiune Initialize2 REUȘITĂ + layout-ul oficial Raydium. Validarea
 * autoritativă a decimalelor se face ulterior (priceTracker → `resolveMintDecimals`, skip-dacă-necunoscut);
 * NU e un gate înainte de registry write, iar `resolveTokenMeta` din enrichment poate cădea pe FALLBACK —
 * deci nu pretindem aici o garanție on-chain pe care n-o avem. Fetcher-ul rămâne structural, fără RPC în plus.
 */
export function parseAmmV4InitAccounts(accounts: readonly string[]): AmmV4InitResult | null {
  if (accounts.length !== AMM_V4_INIT2_ACCOUNT_COUNT) return null;

  const poolAddress = accounts[AMM_V4_POOL_IDX];
  const mint0       = accounts[AMM_V4_COIN_MINT_IDX];
  const mint1       = accounts[AMM_V4_PC_MINT_IDX];

  if (!poolAddress || !mint0 || !mint1)               return null;
  if (poolAddress === mint0 || poolAddress === mint1) return null;
  if (mint0 === mint1)                                return null;

  return { poolAddress, mint0, mint1 };
}

/**
 * Fetch tranzacția și clasifică DISCRIMINAT rezultatul (D4c — vezi `AmmV4FetchOutcome`). Retry pe null/eroare
 * RPC (→ `unavailable`). Selecția instrucțiunii de creare e după TAG (1) + count (21), nu se ghicește din
 * null-uri. retryDelaysMs injectabil pentru teste.
 */
export async function fetchAmmV4Init(
  connection:    Connection,
  signature:     string,
  retryDelaysMs: number[] = FETCH_RETRY_DELAYS_MS,
): Promise<AmmV4FetchOutcome> {
  let tx = null;

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) await sleep(retryDelaysMs[attempt]);
    try {
      tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (tx) break;
      console.log("[SOLANA][AMMV4] fetch attempt=" + (attempt + 1) + " null sig=" + signature.slice(0, 12));
    } catch (err) {
      console.warn(
        "[SOLANA][AMMV4] fetch attempt=" + (attempt + 1) + " error sig=" + signature.slice(0, 12) + ":",
        (err as Error).message,
      );
    }
  }

  if (!tx) return { status: "unavailable" };                         // RPC n-a livrat → retry (onest)
  if (tx.meta?.err) return { status: "invalid", reason: "FAILED_TX" }; // tx eșuată → nu-i creare reușită → ACK

  // Instrucțiunile AMM V4 (native → PartiallyDecodedInstruction cu `accounts` + `data`).
  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions);
  const all = [...outer, ...inner];

  const ammIxs: AmmV4Instruction[] = [];
  for (const ix of all) {
    if (ix.programId.toBase58() !== RAYDIUM_AMM_V4) continue;
    if (!("accounts" in ix) || !("data" in ix)) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dataB58: string = (ix as any).data;
    ammIxs.push({ dataB58, accounts: accs.map((a) => a.toBase58()) });
  }

  // Selecție PRIN TAG: TOATE instrucțiunile AMM V4 cu tag 1 (Initialize2), indiferent de count. buy/swap
  // (alte tag-uri) sunt ignorate. Clasificăm pe MULȚIMEA COMPLETĂ de tag-1 (nu doar cele cu 21 conturi) —
  // altfel `[tag1/21, tag1/20]` ar trece drept `ok`, ratând tăcut al doilea Initialize2 cu layout necunoscut.
  const tag1Ixs = ammIxs.filter((ix) => decodeTag(ix.dataB58) === AMM_V4_INIT2_TAG);

  if (tag1Ixs.length === 0) {
    // Gate-ul scoped a văzut un Initialize2 reușit, dar tx-ul n-are nicio instrucțiune tag 1 → dovezile se
    // contrazic. NU ACK (fail-open) — quarantine (volumul AMM V4 e mic; mai bine păstrezi un suspect decât
    // să arunci o posibilă creare reală).
    return { status: "unsupported", reason: "INIT2_EVIDENCE_MISMATCH", accountCounts: [] };
  }
  if (tag1Ixs.length > 1) {
    // Mai multe Initialize2 în același tx → ambiguu, nu ghicim care-i pool-ul → quarantine.
    return { status: "unsupported", reason: "AMBIGUOUS_INIT2", accountCounts: tag1Ixs.map((i) => i.accounts.length) };
  }

  const candidate = tag1Ixs[0];
  if (candidate.accounts.length !== AMM_V4_INIT2_ACCOUNT_COUNT) {
    // O singură tag 1 dar count ≠ 21 → layout-ul Raydium s-a schimbat → quarantine (plasa NF3 pt. AMM V4).
    return { status: "unsupported", reason: "UNKNOWN_INIT2_LAYOUT", accountCounts: [candidate.accounts.length] };
  }

  const parsed = parseAmmV4InitAccounts(candidate.accounts);
  if (!parsed) {
    // tag 1 / 21 dar guard-urile de distincție (pool≠mint, mint0≠mint1) au picat → variantă → quarantine.
    return { status: "unsupported", reason: "KNOWN_LAYOUT_GUARDS_FAILED", accountCounts: [candidate.accounts.length] };
  }
  return { status: "ok", result: parsed };
}
