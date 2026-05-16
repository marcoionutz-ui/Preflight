/**
 * x402 Client — lets our agent autonomously PAY for external x402-protected APIs
 *
 * When our agent fetches a URL that returns 402 Payment Required,
 * this client automatically:
 *   1. Reads the payment requirements from the response headers
 *   2. Pays the required USDC on Base using the configured wallet
 *   3. Retries the request with payment proof
 *   4. Returns the paid response
 *
 * Usage:
 *   import { agentFetch } from "@/lib/trading/x402client";
 *   const data = await agentFetch("https://some-premium-api.com/data");
 *   // Automatically pays if 402 is returned
 *
 * Configure X402_PAYER_PRIVATE_KEY in .env.local to enable.
 * Use a dedicated wallet with a small USDC balance (e.g. $5-10).
 */

import type { LogType } from "@/types";

export interface X402PaymentRecord {
  url: string;
  amount: string;
  txHash: string;
  timestamp: number;
}

// In-memory payment log (per session)
const paymentLog: X402PaymentRecord[] = [];

export function getPaymentLog(): X402PaymentRecord[] {
  return [...paymentLog];
}

export function clearPaymentLog(): void {
  paymentLog.length = 0;
}

/**
 * Create an x402-aware fetch client.
 * On the server side (API routes), this uses the payer private key.
 * On the client side, this is a no-op wrapper (payments happen server-side).
 */
export async function createPaidFetch() {
  // Server-side only — requires private key in env
  if (typeof window !== "undefined") {
    // Client side: just return normal fetch
    return fetch;
  }

  try {
    const { wrapFetchWithPayment } = await import("x402-fetch");
    const { ethers } = await import("ethers");

    const privateKey = process.env.X402_PAYER_PRIVATE_KEY;
    if (!privateKey) {
      console.warn("[x402] X402_PAYER_PRIVATE_KEY not set — using standard fetch");
      return fetch;
    }

    const wallet = new ethers.Wallet(privateKey);
    const paidFetch = wrapFetchWithPayment(fetch, wallet);
    return paidFetch;
  } catch {
    return fetch;
  }
}

/**
 * Server-side fetch that automatically handles x402 payment.
 * Use this in API routes when calling external paid endpoints.
 */
export async function agentFetch(
  url: string,
  options?: RequestInit,
  onLog?: (msg: string, t: LogType) => void
): Promise<Response> {
  const paidFetch = await createPaidFetch();

  onLog?.(`[x402] Fetching ${url}`, "info");

  try {
    const response = await paidFetch(url, options);

    // Log if payment was made (x402 adds these headers)
    const paymentAmount = response.headers.get("x-payment-amount");
    const paymentTx = response.headers.get("x-payment-tx");

    if (paymentAmount && paymentTx) {
      const record: X402PaymentRecord = {
        url,
        amount: paymentAmount,
        txHash: paymentTx,
        timestamp: Date.now(),
      };
      paymentLog.push(record);
      onLog?.(`[x402] Paid ${paymentAmount} → ${paymentTx.slice(0, 12)}…`, "ok");
    }

    return response;
  } catch (err: unknown) {
    onLog?.(`[x402] Fetch error: ${err instanceof Error ? err.message : "unknown"}`, "err");
    throw err;
  }
}

/**
 * Discover if a URL supports x402 by making a preflight GET request.
 * Returns the payment requirements if it does.
 */
export async function discoverX402(url: string): Promise<{
  supported: boolean;
  price?: string;
  network?: string;
  description?: string;
} | null> {
  try {
    const res = await fetch(url, { method: "GET" });
    if (res.status === 402) {
      const requirements = res.headers.get("x-payment-requirements");
      if (requirements) {
        const parsed = JSON.parse(requirements);
        return {
          supported: true,
          price: parsed.maxAmountRequired,
          network: parsed.network,
          description: parsed.description,
        };
      }
    }
    // Check if endpoint returns x402 info in body (our GET endpoints do this)
    if (res.ok) {
      const body = await res.json();
      if (body.payment) {
        return { supported: true, price: body.payment.price, network: body.payment.network, description: body.description };
      }
    }
    return { supported: false };
  } catch {
    return null;
  }
}
