import { JUPITER_QUOTE_API, JUPITER_SWAP_API, SOL_MINT } from "./constants";

declare global {
  interface Window {
    solana?: {
      isPhantom?: boolean;
      connect: () => Promise<{ publicKey: { toString: () => string } }>;
      disconnect: () => Promise<void>;
      signAndSendTransaction: (tx: { serialize: () => Uint8Array }) => Promise<{ signature: string }>;
      publicKey: { toString: () => string } | null;
    };
  }
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  raw: unknown; // full quote object for swap
}

export interface SolanaSwapResult {
  signature: string;
  success: boolean;
  error?: string;
}

// ─── Connect Phantom ──────────────────────────────────────────────────────────
export async function connectPhantom(): Promise<string> {
  if (!window.solana?.isPhantom) throw new Error("Phantom wallet not installed");
  const resp = await window.solana.connect();
  return resp.publicKey.toString();
}

export function getPhantomAddress(): string | null {
  return window.solana?.publicKey?.toString() ?? null;
}

// ─── Get Jupiter quote ────────────────────────────────────────────────────────
export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,          // in lamports (SOL) or token smallest unit
  slippageBps = 100
): Promise<JupiterQuote> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: slippageBps.toString(),
  });

  const res = await fetch(`${JUPITER_QUOTE_API}?${params}`);
  if (!res.ok) throw new Error("Jupiter quote failed: " + res.statusText);
  const quote = await res.json();

  return {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    otherAmountThreshold: quote.otherAmountThreshold,
    priceImpactPct: quote.priceImpactPct,
    routePlan: quote.routePlan,
    raw: quote,
  };
}

// ─── Get SOL buy quote (SOL → token) ─────────────────────────────────────────
export async function getSolanaBuyQuote(
  tokenMint: string,
  solAmount: number,    // SOL amount (e.g. 0.1)
  slippageBps = 100
): Promise<JupiterQuote> {
  const lamports = Math.floor(solAmount * 1e9);
  return getJupiterQuote(SOL_MINT, tokenMint, lamports, slippageBps);
}

// ─── Get SOL sell quote (token → SOL) ────────────────────────────────────────
export async function getSolanaSellQuote(
  tokenMint: string,
  tokenAmount: number,  // token amount in smallest unit
  slippageBps = 100
): Promise<JupiterQuote> {
  return getJupiterQuote(tokenMint, SOL_MINT, tokenAmount, slippageBps);
}

// ─── Execute Solana swap via Jupiter ──────────────────────────────────────────
export async function executeJupiterSwap(
  quote: JupiterQuote,
  walletAddress: string
): Promise<SolanaSwapResult> {
  if (!window.solana?.isPhantom) {
    return { signature: "", success: false, error: "Phantom not connected" };
  }

  try {
    // Get swap transaction from Jupiter
    const swapRes = await fetch(JUPITER_SWAP_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey: walletAddress,
        wrapAndUnwrapSol: true,
      }),
    });

    if (!swapRes.ok) throw new Error("Jupiter swap build failed");
    const { swapTransaction } = await swapRes.json();

    // Decode transaction
    const { VersionedTransaction } = await import("@solana/web3.js");
    const txBuffer = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuffer);

    // Sign and send via Phantom
    const result = await window.solana.signAndSendTransaction(tx as unknown as { serialize: () => Uint8Array });
    return { signature: result.signature, success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { signature: "", success: false, error: msg };
  }
}

// ─── Format helpers ───────────────────────────────────────────────────────────
export const lamportsToSOL = (lamports: string | number): string =>
  (Number(lamports) / 1e9).toFixed(6);

export const solToLamports = (sol: number): number => Math.floor(sol * 1e9);
