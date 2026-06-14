/**
 * infra/nativePrice.ts
 * Prețuri native token per chain — ETH, BNB.
 * Chainlink on-chain reads, cu fallback cached.
 */

import { CHAINLINK_ETH_USD, CHAINLINK_LATEST_ROUND_DATA } from "../config/constants";

// Chainlink BNB/USD pe BSC mainnet
const CHAINLINK_BNB_USD = "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE";

const prices: Record<string, number> = {
  eth: 2500,
  bnb: 600,
};

export function getNativePrice(nativeSymbol: "ETH" | "BNB"): number {
  return prices[nativeSymbol.toLowerCase()] ?? 0;
}

// backward compat — identic cu getEthPrice din vechiul ethPrice.ts
export function getEthPrice(): number {
  return prices.eth;
}

async function fetchChainlinkPrice(rpcUrl: string, contract: string): Promise<number | null> {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  ctrl.signal,
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method:  "eth_call",
        params:  [{ to: contract, data: CHAINLINK_LATEST_ROUND_DATA }, "latest"],
      }),
    });
    const json   = await res.json() as any;
    const result = json?.result;
    if (!result || result === "0x") return null;
    const answerHex = "0x" + result.slice(66, 130);
    const price     = Number(BigInt(answerHex)) / 1e8;
    return Number.isFinite(price) && price > 10 ? price : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function refreshNativePrices(): Promise<void> {
  const ethRpc = process.env.ALCHEMY_BASE_RPC ?? process.env.ALCHEMY_ARB_RPC ?? "";
  const bnbRpc = process.env.ALCHEMY_BNB_RPC ?? "";

  if (ethRpc) {
    const p = await fetchChainlinkPrice(ethRpc, CHAINLINK_ETH_USD);
    if (p) { prices.eth = p; console.log(`[NATIVE PRICE] ETH: $${p.toFixed(2)}`); }
    else    { console.log(`[NATIVE PRICE] ETH fallback: $${prices.eth}`); }
  } else {
    console.log(`[NATIVE PRICE] ETH: no RPC configured, using cached $${prices.eth}`);
  }

  if (bnbRpc) {
    const p = await fetchChainlinkPrice(bnbRpc, CHAINLINK_BNB_USD);
    if (p) { prices.bnb = p; console.log(`[NATIVE PRICE] BNB: $${p.toFixed(2)}`); }
    else    { console.log(`[NATIVE PRICE] BNB fallback: $${prices.bnb}`); }
  } else {
    console.log(`[NATIVE PRICE] BNB: no RPC configured, using cached $${prices.bnb}`);
  }
}

export type NativeSymbol = "ETH" | "BNB";

export function getNativeSymbolForChain(chainId: string): NativeSymbol {
  return chainId === "bsc" ? "BNB" : "ETH";
}