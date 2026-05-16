/**
 * Alchemy Multi-chain Client — Faza 1
 * HTTP JSON-RPC + WebSocket pentru ETH, BASE, ARB, SOL
 * BSC rămâne pe public RPC (Alchemy nu suportă BSC)
 */

// ── RPC URLs ──────────────────────────────────────────────────────────────────

export const ALCHEMY_RPC: Record<string, string> = {
  ethereum: process.env.ALCHEMY_ETH_RPC  ?? "https://eth-mainnet.g.alchemy.com/v2/demo",
  base:     process.env.ALCHEMY_BASE_RPC ?? "https://base-mainnet.g.alchemy.com/v2/demo",
  arbitrum: process.env.ALCHEMY_ARB_RPC  ?? "https://arb-mainnet.g.alchemy.com/v2/demo",
  solana:   process.env.ALCHEMY_SOL_RPC  ?? "https://solana-mainnet.g.alchemy.com/v2/demo",
  // BSC — Alchemy nu suportă, rămâne pe public
  bsc:      "https://bsc-dataseed1.binance.org/",
};

export const ALCHEMY_WS: Record<string, string> = {
  ethereum: process.env.ALCHEMY_ETH_WS  ?? "",
  base:     process.env.ALCHEMY_BASE_WS ?? "",
  arbitrum: process.env.ALCHEMY_ARB_WS  ?? "",
  // SOL + BSC nu au WS via Alchemy în planul free
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * JSON-RPC call generic către Alchemy (sau orice RPC compatibil EVM)
 */
async function rpcCall<T = unknown>(
  chain: string,
  method: string,
  params: unknown[] = []
): Promise<T> {
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

// ── Block helpers ─────────────────────────────────────────────────────────────

/** Returnează block number curent ca număr */
export async function getBlockNumber(chain: string): Promise<number> {
  const hex = await rpcCall<string>(chain, "eth_blockNumber");
  return parseInt(hex, 16);
}

/** Convertește număr de minute în număr aproximativ de blocuri */
function minutesToBlocks(chain: string, minutes: number): number {
  // Block times aproximative
  const blockTimes: Record<string, number> = {
    ethereum: 12,   // ~12s
    base:     2,    // ~2s
    arbitrum: 1,    // <1s (folosim 1 ca minimum)
    bsc:      3,    // ~3s
    solana:   0.4,  // ~400ms (folosim eth_getLogs nu merge, dar avem fallback)
  };
  const blockTime = blockTimes[chain] ?? 12;
  return Math.ceil((minutes * 60) / blockTime);
}

// ── On-chain data ─────────────────────────────────────────────────────────────

export interface UniqueBuyerResult {
  uniqueBuyers: number;
  totalTransfers: number;
  topBuyerPct: number;        // % din transfers al celui mai activ wallet
  blocksScanned: number;
  minutesScanned: number;
}

/**
 * Numără unique buyers ai unui token în ultimele N minute
 * Folosește Transfer events (ERC-20) — funcționează pe ETH, BASE, ARB, BSC
 */
export async function getUniqueBuyers(
  chain: string,
  tokenAddress: string,
  minutes = 10
): Promise<UniqueBuyerResult> {
  // Solana — nu avem eth_getLogs, returnăm fallback
  if (chain === "solana") {
    return { uniqueBuyers: 0, totalTransfers: 0, topBuyerPct: 0, blocksScanned: 0, minutesScanned: minutes };
  }

  try {
    const currentBlock = await getBlockNumber(chain);
    const blocksBack   = minutesToBlocks(chain, minutes);
    const fromBlock    = currentBlock - blocksBack;

    // ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    type Log = { topics: string[]; transactionHash: string };
    const logs = await rpcCall<Log[]>(chain, "eth_getLogs", [{
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock:   "latest",
      address:   tokenAddress,
      topics:    [TRANSFER_TOPIC],
    }]);

    if (!logs || logs.length === 0) {
      return { uniqueBuyers: 0, totalTransfers: 0, topBuyerPct: 0, blocksScanned: blocksBack, minutesScanned: minutes };
    }

    // Contorizează receivers (index 2 = "to" address)
    const buyerCounts = new Map<string, number>();
    for (const log of logs) {
      const to = log.topics[2];
      if (!to) continue;
      // Normalizează adresa (topics sunt padded la 32 bytes)
      const addr = "0x" + to.slice(26).toLowerCase();
      buyerCounts.set(addr, (buyerCounts.get(addr) ?? 0) + 1);
    }

    const uniqueBuyers  = buyerCounts.size;
    const totalTransfers = logs.length;
    const maxCount      = Math.max(...buyerCounts.values());
    const topBuyerPct   = totalTransfers > 0
      ? Math.round((maxCount / totalTransfers) * 100)
      : 0;

    return { uniqueBuyers, totalTransfers, topBuyerPct, blocksScanned: blocksBack, minutesScanned: minutes };
  } catch {
    return { uniqueBuyers: 0, totalTransfers: 0, topBuyerPct: 0, blocksScanned: 0, minutesScanned: minutes };
  }
}

// ── LP Events ─────────────────────────────────────────────────────────────────

export interface LPEventResult {
  adds:    number;   // Mint events
  removes: number;   // Burn events
  net:     number;   // adds - removes
  minutesScanned: number;
}

/**
 * Detectează LP add/remove events pentru un pair address
 * Mint(address,uint256,uint256) — LP add
 * Burn(address,uint256,uint256,address) — LP remove
 */
export async function getLPEvents(
  chain: string,
  pairAddress: string,
  minutes = 30
): Promise<LPEventResult> {
  if (chain === "solana") {
    return { adds: 0, removes: 0, net: 0, minutesScanned: minutes };
  }

  try {
    const currentBlock = await getBlockNumber(chain);
    const blocksBack   = minutesToBlocks(chain, minutes);
    const fromBlock    = currentBlock - blocksBack;

    // Uniswap V2 style topics
    const MINT_TOPIC = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
    const BURN_TOPIC = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";

    type Log = { topics: string[] };
    const [mintLogs, burnLogs] = await Promise.all([
      rpcCall<Log[]>(chain, "eth_getLogs", [{
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock:   "latest",
        address:   pairAddress,
        topics:    [MINT_TOPIC],
      }]),
      rpcCall<Log[]>(chain, "eth_getLogs", [{
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock:   "latest",
        address:   pairAddress,
        topics:    [BURN_TOPIC],
      }]),
    ]);

    const adds    = mintLogs?.length ?? 0;
    const removes = burnLogs?.length ?? 0;

    return { adds, removes, net: adds - removes, minutesScanned: minutes };
  } catch {
    return { adds: 0, removes: 0, net: 0, minutesScanned: minutes };
  }
}

// ── On-chain Confidence ───────────────────────────────────────────────────────

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

/**
 * Combină unique buyers + LP events într-un singur obiect
 * Folosit în Oracle Panel pentru badge-urile on-chain
 */
export async function getOnChainData(
  chain: string,
  tokenAddress: string,
  pairAddress: string
): Promise<OnChainData> {
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
        : Promise.resolve({ adds: 0, removes: 0, net: 0, minutesScanned: 30 }),
    ]);

    // Calculează confidence
    let confidence: OnChainConfidence = "LOW";
    if (buyers.uniqueBuyers >= 20 && buyers.topBuyerPct < 30 && lp.removes === 0) {
      confidence = "HIGH";
    } else if (buyers.uniqueBuyers >= 5 && lp.removes < 3) {
      confidence = "MEDIUM";
    }

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