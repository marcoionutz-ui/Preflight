/**
 * discovery/swapParser.ts
 * 8.0h-b2: Dry-run swap parser — CPMM SwapBaseInput/SwapBaseOutput + CLMM SwapV2.
 *
 * Layout confirmat live (8.0h-b1 shadow):
 *   CPMM accounts[13]: pool=[3] inputVault=[6] outputVault=[7] inputMint=[10] outputMint=[11]
 *   CLMM SwapV2 accounts[15+]: pool=[2] inputVault=[5] outputVault=[6] inputMint=[11] outputMint=[12]
 *     (tick arrays variabile la final — vazut accounts[15], [16], [18] in productie)
 *
 * Zero Redis writes. Amounts via vault tokenBalance deltas (BigInt, nu uiAmount).
 */

import { ParsedTransactionWithMeta } from "@solana/web3.js";
import { getRedis }                  from "../infra/redis";
import { KEY_PAIR }                  from "../config/constants";
import { NATIVE_QUOTE_MINTS }        from "../config/programs";

// ── Tipuri ────────────────────────────────────────────────────────────────────

/** Directia fluxului de quote in schimb. */
export type SwapFlow = "QUOTE_IN" | "QUOTE_OUT" | "UNKNOWN";

export interface SwapParseResult {
  program:     "cpmm" | "clmm_swapv2";
  instruction: string;
  pool:        string;
  inputMint:   string;
  outputMint:  string;
  quoteMint:   string;
  baseMint:    string;
  flow:        SwapFlow;
  inputAmount:  bigint | null;
  outputAmount: bigint | null;
  knownPool:    boolean;
}

// ── Layout constants ──────────────────────────────────────────────────────────

// CPMM SwapBaseInput + SwapBaseOutput — ambele au accounts[13], acelasi layout.
const CPMM = {
  POOL:         3,
  INPUT_VAULT:  6,
  OUTPUT_VAULT: 7,
  INPUT_MINT:   10,
  OUTPUT_MINT:  11,
} as const;

// CLMM SwapV2 — accounts[15].
// Nota: CLMM Swap legacy (accounts[12], accounts[16]) nu are minturi in accounts — ignorat in b2.
const CLMM_V2 = {
  POOL:         2,
  INPUT_VAULT:  5,
  OUTPUT_VAULT: 6,
  INPUT_MINT:   11,
  OUTPUT_MINT:  12,
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Calculeaza delta de token pentru un vault dintr-un swap TX.
 * Foloseste preTokenBalances / postTokenBalances, nu uiAmount (pierde precizie).
 * Returneaza null daca vault-ul nu e in balances sau delta e negativa (directie neasteptata).
 */
function getVaultDelta(
  tx:          ParsedTransactionWithMeta,
  vaultPubkey: string,
  mode:        "input" | "output",
): bigint | null {
  const keys = tx.transaction.message.accountKeys;
  const idx  = keys.findIndex(k => k.pubkey.toBase58() === vaultPubkey);
  if (idx === -1) return null;

  const pre  = tx.meta?.preTokenBalances?.find(b => b.accountIndex === idx);
  const post = tx.meta?.postTokenBalances?.find(b => b.accountIndex === idx);
  if (!pre || !post) return null;

  const preBig  = BigInt(pre.uiTokenAmount.amount);
  const postBig = BigInt(post.uiTokenAmount.amount);

  // inputVault primeste tokeni → post > pre (delta pozitiva)
  // outputVault trimite tokeni → post < pre (delta pozitiva)
  const delta = mode === "input" ? postBig - preBig : preBig - postBig;
  return delta >= 0n ? delta : null;
}

/**
 * Determina directia fluxului de quote si identifica quote/base mints.
 * QUOTE_IN  = inputMint e WSOL/USDC/USDT → cumparare token cu quote
 * QUOTE_OUT = outputMint e WSOL/USDC/USDT → vanzare token contra quote
 * UNKNOWN   = ambele sau niciunul nu e quote mint known
 */
function classifyFlow(inputMint: string, outputMint: string): {
  flow:      SwapFlow;
  quoteMint: string;
  baseMint:  string;
} {
  const inIsQuote  = NATIVE_QUOTE_MINTS.has(inputMint);
  const outIsQuote = NATIVE_QUOTE_MINTS.has(outputMint);

  if (inIsQuote && !outIsQuote) {
    return { flow: "QUOTE_IN",  quoteMint: inputMint,  baseMint: outputMint };
  }
  if (outIsQuote && !inIsQuote) {
    return { flow: "QUOTE_OUT", quoteMint: outputMint, baseMint: inputMint  };
  }
  // stable-stable, pereche necunoscuta, sau ambii sunt quote
  return { flow: "UNKNOWN", quoteMint: inputMint, baseMint: outputMint };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parseaza un swap TX in dry-run — extrage pool, mints, directie, amounts.
 * Apelat dupa fetchSampleTx din swapShadow cu TX-ul deja disponibil.
 * Zero Redis writes (knownPool = GET read-only).
 *
 * Returneaza null daca:
 * - layout-ul nu e recunoscut (nu e 13 sau 15 accounts)
 * - programId-ul nu se gaseste in TX
 */
export async function parseSwapTx(
  tx:          ParsedTransactionWithMeta,
  programId:   string,
  instruction: string,
  program:     "cpmm" | "clmm",
  // signature folosita doar pentru logging extern — nu e folosita intern
  _signature:  string,
): Promise<SwapParseResult | null> {
  const outer = tx.transaction.message.instructions;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions);

  for (const ix of [...outer, ...inner]) {
    if (ix.programId.toBase58() !== programId) continue;
    if (!("accounts" in ix)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accs: { toBase58(): string }[] = (ix as any).accounts;
    const strs = accs.map(a => a.toBase58());

    let pool:        string | undefined;
    let inputMint:   string | undefined;
    let outputMint:  string | undefined;
    let inputVault:  string | undefined;
    let outputVault: string | undefined;
    let prog:        "cpmm" | "clmm_swapv2";

    const isCpmmSwap =
      program === "cpmm"
      && (instruction === "SwapBaseInput" || instruction === "SwapBaseOutput")
      && strs.length === 13;

    const isClmmSwapV2 =
      program === "clmm"
      && instruction === "SwapV2"
      && strs.length >= 15;
    // Guard explicit pe instruction name: previne Swap legacy accounts[16] tratat ca SwapV2.
    // CLMM Swap legacy (accounts[11]/[12]/[13]/[16]) — ignorat, nu are mints in accounts.

    if (isCpmmSwap) {
      pool        = strs[CPMM.POOL];
      inputMint   = strs[CPMM.INPUT_MINT];
      outputMint  = strs[CPMM.OUTPUT_MINT];
      inputVault  = strs[CPMM.INPUT_VAULT];
      outputVault = strs[CPMM.OUTPUT_VAULT];
      prog        = "cpmm";
    } else if (isClmmSwapV2) {
      pool        = strs[CLMM_V2.POOL];
      inputMint   = strs[CLMM_V2.INPUT_MINT];
      outputMint  = strs[CLMM_V2.OUTPUT_MINT];
      inputVault  = strs[CLMM_V2.INPUT_VAULT];
      outputVault = strs[CLMM_V2.OUTPUT_VAULT];
      prog        = "clmm_swapv2";
    } else {
      continue;
    }

    if (!pool || !inputMint || !outputMint || !inputVault || !outputVault) continue;

    const { flow, quoteMint, baseMint } = classifyFlow(inputMint, outputMint);
    const inputAmount  = getVaultDelta(tx, inputVault,  "input");
    const outputAmount = getVaultDelta(tx, outputVault, "output");

    // knownPool — read-only Redis GET (nu e write)
    let knownPool = false;
    try {
      knownPool = (await getRedis().get(KEY_PAIR(pool))) !== null;
    } catch {
      // non-blocking — parsam mai departe chiar daca Redis da eroare
    }

    return {
      program: prog,
      instruction,
      pool,
      inputMint,
      outputMint,
      quoteMint,
      baseMint,
      flow,
      inputAmount,
      outputAmount,
      knownPool,
    };
  }

  return null;
}
