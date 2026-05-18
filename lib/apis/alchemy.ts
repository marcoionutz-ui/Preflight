/**
 * Alchemy Multi-chain Client — Faza 1
 */

export const ALCHEMY_RPC: Record<string, string> = {
  ethereum: process.env.ALCHEMY_ETH_RPC  ?? "https://eth-mainnet.g.alchemy.com/v2/demo",
  base:     process.env.ALCHEMY_BASE_RPC ?? "https://base-mainnet.g.alchemy.com/v2/demo",
  arbitrum: process.env.ALCHEMY_ARB_RPC  ?? "https://arb-mainnet.g.alchemy.com/v2/demo",
  solana:   process.env.ALCHEMY_SOL_RPC  ?? "https://solana-mainnet.g.alchemy.com/v2/demo",
  bsc:      process.env.ALCHEMY_BSC_RPC ?? "https://bsc-dataseed1.binance.org/",
};

export const ALCHEMY_WS: Record<string, string> = {
  ethereum: process.env.ALCHEMY_ETH_WS ?? "",
  base:     process.env.ALCHEMY_BASE_WS ?? "",
  arbitrum: process.env.ALCHEMY_ARB_WS ?? "",
};

async function rpcCall<T = unknown>(chain: string, method: string, params: unknown[] = []): Promise<T> {
  const url = ALCHEMY_RPC[chain];
  if (!url) throw new Error(`No RPC for chain: ${chain}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result as T;
}

export async function getBlockNumber(chain: string): Promise<number> {
  const hex = await rpcCall<string>(chain, "eth_blockNumber");
  return parseInt(hex, 16);
}

function minutesToBlocks(chain: string, minutes: number): number {
  const blockTimes: Record<string, number> = {
    ethereum: 12, base: 2, arbitrum: 1, bsc: 3, solana: 0.4,
  };
  return Math.ceil((minutes * 60) / (blockTimes[chain] ?? 12));
}

export interface UniqueBuyerResult {
  uniqueBuyers: number;
  totalTransfers: number;
  topBuyerPct: number;
  blocksScanned: number;
  minutesScanned: number;
  available: boolean;
}

export async function getUniqueBuyers(chain: string, tokenAddress: string, minutes = 10): Promise<UniqueBuyerResult> {
  if (chain === "solana") {
    return { uniqueBuyers: 0, totalTransfers: 0, topBuyerPct: 0, blocksScanned: 0, minutesScanned: minutes, available: false };
  }
  try {
    const currentBlock = await getBlockNumber(chain);
    const blocksBack   = minutesToBlocks(chain, minutes);
    const fromBlock    = currentBlock - blocksBack;
    const toBlockHex   = "0x" + currentBlock.toString(16);
    const fromBlockHex = "0x" + fromBlock.toString(16);
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    type Log = { topics: string[]; transactionHash: string };
    const logs = await rpcCall<Log[]>(chain, "eth_getLogs", [{
      fromBlock: fromBlockHex,
      toBlock:   toBlockHex,
      address:   tokenAddress,
      topics:    [TRANSFER_TOPIC],
    }]);
    if (!logs || logs.length === 0) {
      return { uniqueBuyers: 0, totalTransfers: 0, topBuyerPct: 0, blocksScanned: blocksBack, minutesScanned: minutes, available: true };
    }
    const buyerCounts = new Map<string, number>();
    for (const log of logs) {
      const to = log.topics[2];
      if (!to) continue;
      const addr = "0x" + to.slice(26).toLowerCase();
      buyerCounts.set(addr, (buyerCounts.get(addr) ?? 0) + 1);
    }
    const uniqueBuyers   = buyerCounts.size;
    const totalTransfers = logs.length;
    const maxCount       = Math.max(...buyerCounts.values());
    const topBuyerPct    = totalTransfers > 0 ? Math.round((maxCount / totalTransfers) * 100) : 0;
    return { uniqueBuyers, totalTransfers, topBuyerPct, blocksScanned: blocksBack, minutesScanned: minutes, available: true };
  } catch {
    return { uniqueBuyers: 0, totalTransfers: 0, topBuyerPct: 0, blocksScanned: 0, minutesScanned: minutes, available: false };
  }
}

export interface LPEventResult {
  adds: number;
  removes: number;
  net: number;
  minutesScanned: number;
  available: boolean;
}

export async function getLPEvents(chain: string, pairAddress: string, minutes = 30): Promise<LPEventResult> {
  if (chain === "solana") {
    return { adds: 0, removes: 0, net: 0, minutesScanned: minutes, available: false };
  }
  try {
    const currentBlock = await getBlockNumber(chain);
    const blocksBack   = minutesToBlocks(chain, minutes);
    const fromBlock    = currentBlock - blocksBack;
    const toBlockHex   = "0x" + currentBlock.toString(16);
    const fromBlockHex = "0x" + fromBlock.toString(16);
    const MINT_TOPIC = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
    const BURN_TOPIC = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";
    type Log = { topics: string[] };
    const [mintLogs, burnLogs] = await Promise.all([
      rpcCall<Log[]>(chain, "eth_getLogs", [{ fromBlock: fromBlockHex, toBlock: toBlockHex, address: pairAddress, topics: [MINT_TOPIC] }]),
      rpcCall<Log[]>(chain, "eth_getLogs", [{ fromBlock: fromBlockHex, toBlock: toBlockHex, address: pairAddress, topics: [BURN_TOPIC] }]),
    ]);
    const adds    = mintLogs?.length ?? 0;
    const removes = burnLogs?.length ?? 0;
    return { adds, removes, net: adds - removes, minutesScanned: minutes, available: true };
  } catch {
    return { adds: 0, removes: 0, net: 0, minutesScanned: minutes, available: false };
  }
}

export type OnChainConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNAVAILABLE";

export interface OnChainData {
  uniqueBuyers:   number;
  totalTransfers: number;
  topBuyerPct:    number;
  lpAdds:         number;
  lpRemoves:      number;
  lpNet:          number;
  confidence:     OnChainConfidence;
  available:      boolean;
}

export async function getOnChainData(chain: string, tokenAddress: string, pairAddress: string): Promise<OnChainData> {
  const empty: OnChainData = {
    uniqueBuyers: 0, totalTransfers: 0, topBuyerPct: 0,
    lpAdds: 0, lpRemoves: 0, lpNet: 0,
    confidence: "UNAVAILABLE", available: false,
  };
  if (!tokenAddress || tokenAddress.length < 10) return empty;
  try {
    const [buyers, lp] = await Promise.all([
      getUniqueBuyers(chain, tokenAddress, 10),
      pairAddress?.length > 10
        ? getLPEvents(chain, pairAddress, 30)
        : Promise.resolve({ adds: 0, removes: 0, net: 0, minutesScanned: 30, available: false }),
    ]);
    const dataAvailable = buyers.available || lp.available;
    if (!dataAvailable) return empty;
    let confidence: OnChainConfidence = "LOW";
    if (buyers.uniqueBuyers >= 20 && buyers.topBuyerPct < 30 && lp.removes === 0) confidence = "HIGH";
    else if (buyers.uniqueBuyers >= 5 && lp.removes < 3) confidence = "MEDIUM";
    return {
      uniqueBuyers:   buyers.uniqueBuyers,
      totalTransfers: buyers.totalTransfers,
      topBuyerPct:    buyers.topBuyerPct,
      lpAdds:         lp.adds,
      lpRemoves:      lp.removes,
      lpNet:          lp.net,
      confidence,
      available:      true,
    };
  } catch {
    return empty;
  }
}