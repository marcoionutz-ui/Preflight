/**
 * Pre-trade AMM Route Check
 *
 * Rule: no valid buy+sell route = no buy.
 *
 * Uses getAmountsOut() to verify that AMM routes exist and estimate
 * rough round-trip loss. This is NOT a full honeypot/sell simulation.
 *
 * For stronger protection combine this with GoPlus and/or real static swap simulation.
 */

import { ethers } from "ethers";
import { ROUTER_ABI, WRAPPED_NATIVE, DEX_ROUTERS } from "./constants";

export interface SimulationResult {
  canBuy:            boolean;
  canSell:           boolean;
  estimatedTokens:   bigint;   // tokens received from buy sim
  estimatedEthBack:  bigint;   // ETH received from sell sim
  priceImpact:       number;   // rough round-trip loss %
  blocked:           boolean;
  blockReason:       string | null;
  warning:           string | null;
}

/**
 * AMM Route Sanity Check — NOT a full sell simulation.
 *
 * Uses getAmountsOut() to verify:
 * - Buy route exists
 * - Sell route exists
 * - Round-trip loss is acceptable
 *
 * Does NOT guarantee sellability for honeypot tokens.
 * For full protection use GoPlus + this check combined.
 */
export async function simulateRoundTrip(
  chainId: string,
  tokenAddress: string,
  amountInEth: string,   // e.g. "0.01"
): Promise<SimulationResult> {
  const empty: SimulationResult = {
    canBuy: false, canSell: false,
    estimatedTokens: 0n, estimatedEthBack: 0n,
    priceImpact: 0, blocked: true,
    blockReason: null, warning: null,
  };

  if (typeof window === "undefined" || !(window as any).ethereum) {
    return { ...empty, blockReason: "Wallet not connected" };
  }

  try {
    const provider   = new ethers.BrowserProvider((window as any).ethereum);
    const routerAddr = DEX_ROUTERS[chainId];
    const weth       = WRAPPED_NATIVE[chainId];

    if (!routerAddr || !weth) {
      return { ...empty, blockReason: `Chain not supported: ${chainId}` };
    }

    const router   = new ethers.Contract(routerAddr, ROUTER_ABI, provider);
    const amountIn = ethers.parseEther(amountInEth);
    const buyPath  = [weth, tokenAddress];
    const sellPath = [tokenAddress, weth];

    // ── Step 1: Simulate BUY ──────────────────────────────────────────────
    let estimatedTokens: bigint;
    try {
      const buyAmounts: bigint[] = await router.getAmountsOut(amountIn, buyPath);
      estimatedTokens = buyAmounts[1];
    } catch (err) {
      return {
        ...empty,
        canBuy: false,
        blockReason: "Buy simulation failed — pair may not exist on this router",
      };
    }

    if (estimatedTokens === 0n) {
      return { ...empty, canBuy: false, blockReason: "Buy returns 0 tokens" };
    }

    // ── Step 2: Simulate SELL ─────────────────────────────────────────────
    let estimatedEthBack: bigint;
    try {
      const sellAmounts: bigint[] = await router.getAmountsOut(estimatedTokens, sellPath);
      estimatedEthBack = sellAmounts[1];
    } catch (err) {
      // getAmountsOut failing for sell path is a red flag
      return {
        ...empty,
        canBuy: true,
        canSell: false,
        estimatedTokens,
        blockReason: "Sell simulation failed — possible honeypot or broken sell",
      };
    }

    if (estimatedEthBack === 0n) {
      return {
        ...empty,
        canBuy: true,
        canSell: false,
        estimatedTokens,
        blockReason: "Sell returns 0 ETH — honeypot suspected",
      };
    }

    // ── Step 3: Check round-trip loss ─────────────────────────────────────
    const roundTripLoss = Number(amountIn - estimatedEthBack) / Number(amountIn);
    const priceImpact   = roundTripLoss * 100;

    let warning: string | null = null;
    if (priceImpact > 20) {
      warning = `Round-trip loss ${priceImpact.toFixed(1)}% — high tax or low liquidity`;
    } else if (priceImpact > 10) {
      warning = `Round-trip loss ${priceImpact.toFixed(1)}% — check tax`;
    }

    // Block if total loss > 30% (tax + slippage combined)
    if (priceImpact > 30) {
      return {
        ...empty,
        canBuy: true,
        canSell: true,
        estimatedTokens,
        estimatedEthBack,
        priceImpact,
        blocked: true,
        blockReason: `Round-trip loss ${priceImpact.toFixed(1)}% — too expensive`,
      };
    }

    return {
      canBuy:           true,
      canSell:          true,
      estimatedTokens,
      estimatedEthBack,
      priceImpact,
      blocked:          false,
      blockReason:      null,
      warning,
    };
  } catch (err) {
    return {
      ...empty,
      blockReason: `Simulation error: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}
