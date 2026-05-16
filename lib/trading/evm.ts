import { ethers } from "ethers";
import {
  DEX_ROUTERS, WRAPPED_NATIVE, CHAIN_IDS,
  ROUTER_ABI, ERC20_ABI,
  DEFAULT_SLIPPAGE_BPS, SWAP_DEADLINE_SECONDS,
} from "./constants";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, cb: (...args: unknown[]) => void) => void;
      removeListener: (event: string, cb: (...args: unknown[]) => void) => void;
    };
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────
export interface SwapQuote {
  amountIn: bigint;           // wei
  amountOutMin: bigint;       // wei (after slippage)
  amountOutExpected: bigint;  // wei (before slippage)
  slippagePct: number;   // slippage tolerance, NOT real price impact
  path: string[];
  routerAddress: string;
}

export interface SwapResult {
  txHash: string;
  success: boolean;
  error?: string;
}

// ─── Connect MetaMask ─────────────────────────────────────────────────────────
export async function connectEVMWallet(): Promise<string> {
  if (!window.ethereum) throw new Error("MetaMask not installed");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
  if (!accounts?.[0]) throw new Error("No account returned");
  return accounts[0];
}

export async function getEVMWalletAddress(): Promise<string | null> {
  if (!window.ethereum) return null;
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" }) as string[];
    return accounts?.[0] ?? null;
  } catch { return null; }
}

// ─── Switch to correct chain ──────────────────────────────────────────────────
export async function switchChain(chainId: string): Promise<void> {
  const id = CHAIN_IDS[chainId];
  if (!id) throw new Error("Unsupported chain: " + chainId);
  const hexId = "0x" + id.toString(16);
  try {
    await window.ethereum!.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
  } catch (err: unknown) {
    // Chain not added to MetaMask — add it
    if ((err as { code?: number }).code === 4902) {
      throw new Error(`Please add ${chainId.toUpperCase()} network to MetaMask manually`);
    }
    throw err;
  }
}

// ─── Get provider + signer ────────────────────────────────────────────────────
async function getSigner(): Promise<ethers.JsonRpcSigner> {
  if (!window.ethereum) throw new Error("MetaMask not installed");
  const provider = new ethers.BrowserProvider(window.ethereum);
  return provider.getSigner();
}

// ─── Get BUY quote (native → token) ──────────────────────────────────────────
export async function getBuyQuote(
  chainId: string,
  tokenAddress: string,
  amountInEth: string,   // e.g. "0.1"
  slippageBps = DEFAULT_SLIPPAGE_BPS
): Promise<SwapQuote> {
  if (!window.ethereum) throw new Error("MetaMask not installed");
  const provider = new ethers.BrowserProvider(window.ethereum);
  const routerAddr = DEX_ROUTERS[chainId];
  const weth = WRAPPED_NATIVE[chainId];
  if (!routerAddr || !weth) throw new Error("Chain not supported: " + chainId);

  const router = new ethers.Contract(routerAddr, ROUTER_ABI, provider);
  const amountIn = ethers.parseEther(amountInEth);
  const path = [weth, tokenAddress];

  const amounts: bigint[] = await router.getAmountsOut(amountIn, path);
  const amountOutExpected = amounts[1];
  const amountOutMin = amountOutExpected * BigInt(10000 - slippageBps) / 10000n;

  // Rough price impact (simplified)
  const slippagePct = slippageBps / 100;

  return { amountIn, amountOutMin, amountOutExpected, slippagePct, path, routerAddress: routerAddr };
}

// ─── Get SELL quote (token → native) ─────────────────────────────────────────
export async function getSellQuote(
  chainId: string,
  tokenAddress: string,
  amountIn: bigint,      // token amount in wei
  slippageBps = DEFAULT_SLIPPAGE_BPS
): Promise<SwapQuote> {
  if (!window.ethereum) throw new Error("MetaMask not installed");
  const provider = new ethers.BrowserProvider(window.ethereum);
  const routerAddr = DEX_ROUTERS[chainId];
  const weth = WRAPPED_NATIVE[chainId];
  if (!routerAddr || !weth) throw new Error("Chain not supported: " + chainId);

  const router = new ethers.Contract(routerAddr, ROUTER_ABI, provider);
  const path = [tokenAddress, weth];

  const amounts: bigint[] = await router.getAmountsOut(amountIn, path);
  const amountOutExpected = amounts[1];
  const amountOutMin = amountOutExpected * BigInt(10000 - slippageBps) / 10000n;
  const slippagePct = slippageBps / 100;

  return { amountIn, amountOutMin, amountOutExpected, slippagePct, path, routerAddress: routerAddr };
}

// ─── Get token balance ────────────────────────────────────────────────────────
export async function getTokenBalance(
  tokenAddress: string,
  walletAddress: string
): Promise<{ raw: bigint; formatted: string; decimals: number }> {
  if (!window.ethereum) throw new Error("MetaMask not installed");
  const provider = new ethers.BrowserProvider(window.ethereum);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [raw, decimals] = await Promise.all([
    token.balanceOf(walletAddress) as Promise<bigint>,
    token.decimals() as Promise<number>,
  ]);
  return {
    raw,
    formatted: ethers.formatUnits(raw, decimals),
    decimals,
  };
}

// ─── Check and set allowance ──────────────────────────────────────────────────
export async function ensureAllowance(
  tokenAddress: string,
  routerAddress: string,
  amount: bigint,
  walletAddress: string
): Promise<{ needed: boolean; txHash?: string }> {
  const signer = await getSigner();
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

  const allowance: bigint = await token.allowance(walletAddress, routerAddress);
  if (allowance >= amount) return { needed: false };

  // Exact approval — never approve more than needed (safer)
  const tx = await token.approve(routerAddress, amount);
  await tx.wait();
  return { needed: true, txHash: tx.hash };
}

// ─── Execute BUY ─────────────────────────────────────────────────────────────
export async function executeBuy(
  quote: SwapQuote,
  walletAddress: string
): Promise<SwapResult> {
  try {
    const signer = await getSigner();
    const router = new ethers.Contract(quote.routerAddress, ROUTER_ABI, signer);
    const deadline = Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS;

    // Use FeeOnTransfer variant — works for both standard and tax tokens
    const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      quote.amountOutMin,
      quote.path,
      walletAddress,
      deadline,
      { value: quote.amountIn }
    );
    await tx.wait();
    return { txHash: tx.hash, success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { txHash: "", success: false, error: msg };
  }
}

// ─── Execute SELL ─────────────────────────────────────────────────────────────
export async function executeSell(
  quote: SwapQuote,
  walletAddress: string
): Promise<SwapResult> {
  try {
    const signer = await getSigner();
    const router = new ethers.Contract(quote.routerAddress, ROUTER_ABI, signer);
    const deadline = Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS;

    // Ensure allowance first
    await ensureAllowance(quote.path[0], quote.routerAddress, quote.amountIn, walletAddress);

    // Use FeeOnTransfer variant — required for tax tokens
    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      quote.amountIn,
      quote.amountOutMin,
      quote.path,
      walletAddress,
      deadline
    );
    await tx.wait();
    return { txHash: tx.hash, success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return { txHash: "", success: false, error: msg };
  }
}

// ─── Get native balance ────────────────────────────────────────────────────────
export async function getNativeBalance(walletAddress: string): Promise<string> {
  if (!window.ethereum) return "0";
  const provider = new ethers.BrowserProvider(window.ethereum);
  const balance = await provider.getBalance(walletAddress);
  return ethers.formatEther(balance);
}
