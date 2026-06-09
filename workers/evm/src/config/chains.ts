/**
 * config/chains.ts
 * Chain configurations pentru EVM worker (Base + Arbitrum).
 */

export interface ChainConfig {
  id:          string;
  gecko:       string;
  weth:        string;
  usdc:        string;
  usdcLegacy?: string;
  wsUrl:       string;
}

export const CHAINS: ChainConfig[] = [
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
].filter(c => c.wsUrl || c.gecko);
