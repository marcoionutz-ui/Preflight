import type { ChainId, ChainConfig } from "@/types";

export const CHAINS: Record<ChainId, ChainConfig> = {
  base:     { name: "BASE",     short: "BASE", color: "#0052ff", gecko: "base"     },
  solana:   { name: "SOLANA",   short: "SOL",  color: "#9945ff", gecko: "solana"   },
  ethereum: { name: "ETHEREUM", short: "ETH",  color: "#627eea", gecko: "eth"      },
  bsc:      { name: "BSC",      short: "BSC",  color: "#f0b90b", gecko: "bsc"      },
  arbitrum: { name: "ARBITRUM", short: "ARB",  color: "#12aaff", gecko: "arbitrum" },
};

export const CHAIN_IDS = Object.keys(CHAINS) as ChainId[];

export const DEFAULT_CHAIN: ChainId = "base";
