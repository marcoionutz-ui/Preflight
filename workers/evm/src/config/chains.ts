/**
 * config/chains.ts
 * Chain configurations pentru EVM worker.
 * ENABLED_CHAINS env var controlează ce chainuri pornesc în acest runtime.
 */

export interface ChainConfig {
  id:          	 string;
  gecko:       	 string;
  weth:        	 string;
  usdc:        	 string;
  usdcLegacy?:   string;
  stableQuotes?: string[];
  wsUrl:         string;
}

const enabledChains = new Set(
  (process.env.ENABLED_CHAINS ?? "base,arbitrum")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

const ALL_CHAINS: ChainConfig[] = [
  {
    id:    "base",
    gecko: "base",
    weth:  "0x4200000000000000000000000000000000000006",
    usdc:  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    wsUrl: process.env.ALCHEMY_BASE_WS ?? "",
  },
  {
    id:          "arbitrum",
    gecko:       "arbitrum",
    weth:        "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc:        "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    usdcLegacy:  "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
    wsUrl:       process.env.ALCHEMY_ARB_WS ?? "",
  },
  {
    id:    "bsc",
    gecko: "bsc",
    weth:  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    usdc:  "0x55d398326f99059ff775485246999027b3197955", // USDT (câmp usdc = stable quote token)
    stableQuotes: [
      "0x55d398326f99059ff775485246999027b3197955", // USDT
      "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
      "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC BSC
    ],
    wsUrl: process.env.ALCHEMY_BNB_WS ?? "",
  },
  // ── Ethereum mainnet (shadow-first — requires ENABLED_CHAINS=...ethereum AND INDEXER_ENABLE_ETHEREUM=1) ──
  {
    id:    "ethereum",
    gecko: "eth",
    weth:  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc:  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    stableQuotes: [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
      "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
    ],
    wsUrl: process.env.ALCHEMY_ETH_WS ?? "",
  },
];

export const CHAINS: ChainConfig[] = ALL_CHAINS.filter(c =>
  enabledChains.has(c.id) &&
  (c.id !== "ethereum" || process.env.INDEXER_ENABLE_ETHEREUM === "1")
);