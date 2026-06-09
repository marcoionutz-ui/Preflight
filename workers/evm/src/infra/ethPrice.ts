/**
 * infra/ethPrice.ts
 * Citește prețul ETH/USD de la Chainlink on-chain.
 */

import { CHAINLINK_ETH_USD, CHAINLINK_LATEST_ROUND_DATA } from "../config/constants";

let ethPriceCached = 2500;

export function getEthPrice(): number {
  return ethPriceCached;
}

export async function refreshEthPrice(): Promise<void> {
  const rpcUrl = process.env.ALCHEMY_BASE_RPC ?? process.env.ALCHEMY_ARB_RPC ?? "";
  if (!rpcUrl) {
    console.log(`[ETH PRICE] No RPC URL, using cached: $${ethPriceCached}`);
    return;
  }

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 8_000);

  try {
    const res = await fetch(rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  ctrl.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          { to: CHAINLINK_ETH_USD, data: CHAINLINK_LATEST_ROUND_DATA },
          "latest",
        ],
      }),
    });

    const json   = await res.json();
    const result = (json as any)?.result;
    if (!result || result === "0x") throw new Error("Empty Chainlink result");

    const answerHex = "0x" + result.slice(66, 130);
    const price     = Number(BigInt(answerHex)) / 1e8;

    if (Number.isFinite(price) && price > 500) {
      ethPriceCached = price;
      console.log(`[ETH PRICE] Chainlink: $${price.toFixed(2)}`);
    }
  } catch {
    console.log(`[ETH PRICE] Using cached fallback: $${ethPriceCached}`);
  } finally {
    clearTimeout(t);
  }
}
