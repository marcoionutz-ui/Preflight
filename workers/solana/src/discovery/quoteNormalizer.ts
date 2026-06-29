/**
 * discovery/quoteNormalizer.ts
 * 8.0e: Determină baseMint / quoteMint / quoteType din cele două mint-uri ale unui pool.
 *
 * Prioritate quote asset (explicit, nu accidentală):
 *   STABLE (USDC/USDT) > WSOL > token necunoscut
 *
 * Cazuri:
 *   STABLE / token  → quoteType=STABLE,    quoteMint=STABLE
 *   WSOL   / token  → quoteType=WSOL,      quoteMint=WSOL
 *   STABLE / WSOL   → quoteType=AMBIGUOUS  (ambele sunt quote assets)
 *   STABLE / STABLE → quoteType=AMBIGUOUS
 *   token  / token  → quoteType=UNKNOWN,   quoteMint=mint1 (convenție)
 */

// ── Mint-uri cunoscute ────────────────────────────────────────────────────────

export const WSOL_MINT   = "So11111111111111111111111111111111111111112";
export const USDC_MINT   = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT   = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const STABLE_MINTS = new Set([USDC_MINT, USDT_MINT]);
const QUOTE_MINTS  = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

// ── Tipuri ────────────────────────────────────────────────────────────────────

export type SolanaQuoteType = "WSOL" | "STABLE" | "AMBIGUOUS" | "UNKNOWN";

export interface QuoteNormalization {
  baseMint:   string;
  quoteMint:  string;
  quoteType:  SolanaQuoteType;
}

// ── Funcție principală ────────────────────────────────────────────────────────

/**
 * Determină care mint e base și care e quote.
 * mint0 / mint1 = ordinea nativă din pool (nu contează care e "primul").
 */
export function normalizeQuote(mint0: string, mint1: string): QuoteNormalization {
  const m0IsStable = STABLE_MINTS.has(mint0);
  const m1IsStable = STABLE_MINTS.has(mint1);
  const m0IsWsol   = mint0 === WSOL_MINT;
  const m1IsWsol   = mint1 === WSOL_MINT;
  const m0IsQuote  = QUOTE_MINTS.has(mint0);
  const m1IsQuote  = QUOTE_MINTS.has(mint1);

  // Ambele sunt quote assets → AMBIGUOUS (USDC/USDT, WSOL/USDC, WSOL/USDT)
  if (m0IsQuote && m1IsQuote) {
    return { baseMint: mint0, quoteMint: mint1, quoteType: "AMBIGUOUS" };
  }

  // mint0 e STABLE → quoteMint=mint0
  if (m0IsStable) {
    return { baseMint: mint1, quoteMint: mint0, quoteType: "STABLE" };
  }

  // mint1 e STABLE → quoteMint=mint1
  if (m1IsStable) {
    return { baseMint: mint0, quoteMint: mint1, quoteType: "STABLE" };
  }

  // mint0 e WSOL → quoteMint=mint0
  if (m0IsWsol) {
    return { baseMint: mint1, quoteMint: mint0, quoteType: "WSOL" };
  }

  // mint1 e WSOL → quoteMint=mint1
  if (m1IsWsol) {
    return { baseMint: mint0, quoteMint: mint1, quoteType: "WSOL" };
  }

  // Niciun quote asset cunoscut → UNKNOWN, mint1 e quoteMint prin convenție
  return { baseMint: mint0, quoteMint: mint1, quoteType: "UNKNOWN" };
}
