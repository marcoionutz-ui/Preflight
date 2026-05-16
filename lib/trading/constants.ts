export const DEX_ROUTERS: Record<string, string> = {
  bsc:      "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  ethereum: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  base:     "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  arbitrum: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
};

export const WRAPPED_NATIVE: Record<string, string> = {
  bsc:      "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  base:     "0x4200000000000000000000000000000000000006",
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};

export const NATIVE_SYMBOL: Record<string, string> = {
  bsc:      "BNB",
  ethereum: "ETH",
  base:     "ETH",
  arbitrum: "ETH",
  solana:   "SOL",
};

export const RPC_URLS: Record<string, string> = {
  bsc:      "https://bsc-dataseed1.binance.org/",
  ethereum: "https://ethereum.publicnode.com",
  base:     "https://mainnet.base.org",
  arbitrum: "https://arb1.arbitrum.io/rpc",
};

export const CHAIN_IDS: Record<string, number> = {
  bsc:      56,
  ethereum: 1,
  base:     8453,
  arbitrum: 42161,
};

// Updated ABI — includes fee-on-transfer variants for tax tokens
export const ROUTER_ABI = [
  // Standard swaps
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  // Fee-on-transfer variants (required for tax tokens / memecoins)
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external",
  // Quote
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function WETH() external pure returns (address)",
] as const;

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
] as const;

export const JUPITER_QUOTE_API   = "https://quote-api.jup.ag/v6/quote";
export const JUPITER_SWAP_API    = "https://quote-api.jup.ag/v6/swap";
export const SOL_MINT             = "So11111111111111111111111111111111111111112";
export const DEFAULT_SLIPPAGE_BPS = 100;
export const SWAP_DEADLINE_SECONDS = 300;
