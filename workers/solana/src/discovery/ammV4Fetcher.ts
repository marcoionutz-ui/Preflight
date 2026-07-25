/**
 * discovery/ammV4Fetcher.ts — D4b: fetcher determinist pentru Raydium AMM V4 `Initialize2` (creare pool).
 *
 * Construit DUPĂ ce shadow-ul (D4a/D4a.1) a confirmat pe mainnet, cu o tranzacție reală, că layout-ul
 * corespunde EXACT sursei oficiale (raydium-amm/program/src/instruction.rs — `Initialize2`):
 *   tag NATIV `1`, 21 conturi, pool la index 4, coin mint la 8, pc mint la 9.
 * Golden fixture (sig `3wbXj5KG4UJq…`): pool=`6rNVp5kn…`, coinMint=`52U1CVjH…`, pcMint=WSOL.
 *
 * Refolosește helper-ele PURE din `ammV4Shadow.ts` (single-source al layout-ului): `AMM_V4_INIT2_*`,
 * `findInitialize2Candidates` (tag 1 ȘI 21 conturi), `AmmV4Instruction`. Structura de fetch/retry oglindește
 * `fetchCpmmInit` (același stil de tratare a `getParsedTransaction` + backoff).
 *
 * IMPORTANT: ZERO scrieri în Redis. Nu e încă wire-uit în `index.ts`/coadă — asta e D4c (după NF3, ca AMM V4
 * să NU moștenească dead-letter-ul INVALID/UNAVAILABLE nerezolvat). Aici doar EXTRAGEM + validăm structural.
 */

import type { Connection } from "@solana/web3.js";
import { RAYDIUM_AMM_V4 } from "../config/programs";
import {
  AMM_V4_INIT2_ACCOUNT_COUNT, AMM_V4_POOL_IDX, AMM_V4_COIN_MINT_IDX, AMM_V4_PC_MINT_IDX,
  findInitialize2Candidates, type AmmV4Instruction,
} from "./ammV4Shadow";

export interface AmmV4InitResult {
  poolAddress: string;
  mint0:       string; // coin mint (accounts[8])
  mint1:       string; // pc mint   (accounts[9])
}

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
 * Fetch tranzacția și extrage poolAddress/mint0/mint1 din instrucțiunea AMM V4 `Initialize2` (tag 1 / 21
 * conturi). Retry pe null/eroare RPC; întoarce null dacă tx nu poate fi găsit sau nu conține exact un
 * Initialize2 valid. Nu face retry pentru tx găsit dar cu instrucțiune invalidă (ca `fetchCpmmInit`).
 * retryDelaysMs injectabil pentru teste.
 */
export async function fetchAmmV4Init(
  connection:    Connection,
  signature:     string,
  retryDelaysMs: number[] = FETCH_RETRY_DELAYS_MS,
): Promise<AmmV4InitResult | null> {
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

  if (!tx) return null;
  if (tx.meta?.err) return null; // tx eșuată → nu-i o creare de pool reușită (autonom, nu depinde de gate-ul din index.ts)

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

  // Exact instrucțiunile Initialize2 reale (tag 1 / 21 conturi). Alte instrucțiuni AMM V4 (swap) sunt ignorate.
  const init2 = findInitialize2Candidates(ammIxs);
  if (init2.length !== 1) return null; // 0 = nu-i creare pool; >1 = ambiguu → nu ghicim

  return parseAmmV4InitAccounts(init2[0].accounts);
}
