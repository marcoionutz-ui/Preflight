"use client";

import { useState, useEffect, useCallback } from "react";
import type { ChainId } from "@/types";
import { CHAIN_IDS } from "@/lib/trading/constants";

export type WalletType = "metamask" | "phantom" | null;

export interface WalletState {
  address: string | null;
  type: WalletType;
  chainId: number | null;  // current chain ID in wallet
  connected: boolean;
  connecting: boolean;
  error: string | null;
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null, type: null, chainId: null,
    connected: false, connecting: false, error: null,
  });

  // Check if already connected on mount
  useEffect(() => {
    const checkExisting = async () => {
      if (typeof window === "undefined") return;

      // Check MetaMask
      if (window.ethereum) {
        const { getEVMWalletAddress } = await import("@/lib/trading/evm");
        const addr = await getEVMWalletAddress();
        if (addr) {
          const chainId = await window.ethereum.request({ method: "eth_chainId" }) as string;
          setState((s) => ({ ...s, address: addr, type: "metamask", chainId: parseInt(chainId, 16), connected: true }));
          return;
        }
      }

      // Check Phantom
      if (window.solana?.isPhantom && window.solana.publicKey) {
        setState((s) => ({ ...s, address: window.solana!.publicKey!.toString(), type: "phantom", chainId: null, connected: true }));
      }
    };
    checkExisting();
  }, []);

  // Listen for MetaMask account/chain changes
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;
    const onAccountsChanged = (accounts: unknown) => {
      const arr = accounts as string[];
      if (arr.length === 0) setState((s) => ({ ...s, address: null, connected: false, type: null }));
      else setState((s) => ({ ...s, address: arr[0], connected: true }));
    };
    const onChainChanged = (chainId: unknown) => {
      setState((s) => ({ ...s, chainId: parseInt(chainId as string, 16) }));
    };
    window.ethereum.on("accountsChanged", onAccountsChanged);
    window.ethereum.on("chainChanged", onChainChanged);
    return () => {
      window.ethereum?.removeListener("accountsChanged", onAccountsChanged);
      window.ethereum?.removeListener("chainChanged", onChainChanged);
    };
  }, []);

  const connectMetaMask = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const { connectEVMWallet } = await import("@/lib/trading/evm");
      const addr = await connectEVMWallet();
      const chainId = await window.ethereum!.request({ method: "eth_chainId" }) as string;
      setState({ address: addr, type: "metamask", chainId: parseInt(chainId, 16), connected: true, connecting: false, error: null });
    } catch (e) {
      setState((s) => ({ ...s, connecting: false, error: e instanceof Error ? e.message : "Connection failed" }));
    }
  }, []);

  const connectPhantom = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const { connectPhantom: connect } = await import("@/lib/trading/solana");
      const addr = await connect();
      setState({ address: addr, type: "phantom", chainId: null, connected: true, connecting: false, error: null });
    } catch (e) {
      setState((s) => ({ ...s, connecting: false, error: e instanceof Error ? e.message : "Connection failed" }));
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (state.type === "phantom" && window.solana) {
      await window.solana.disconnect();
    }
    setState({ address: null, type: null, chainId: null, connected: false, connecting: false, error: null });
  }, [state.type]);

  // Check if wallet is on the correct chain for the app's selected chain
  const ensureCorrectChain = useCallback(async (appChain: ChainId): Promise<boolean> => {
    if (state.type !== "metamask") return true; // Phantom handles its own chain
    const requiredChainId = CHAIN_IDS[appChain];
    if (!requiredChainId) return false;
    if (state.chainId === requiredChainId) return true;
    try {
      const { switchChain } = await import("@/lib/trading/evm");
      await switchChain(appChain);
      return true;
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Chain switch failed" }));
      return false;
    }
  }, [state.type, state.chainId]);

  const isCorrectChain = useCallback((appChain: ChainId): boolean => {
    if (state.type !== "metamask") return true;
    return state.chainId === CHAIN_IDS[appChain];
  }, [state.type, state.chainId]);

  return {
    ...state,
    connectMetaMask,
    connectPhantom,
    disconnect,
    ensureCorrectChain,
    isCorrectChain,
  };
}
