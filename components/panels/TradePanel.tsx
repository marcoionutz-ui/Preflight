"use client";

import { ethers } from "ethers";

import { useState, useEffect, useCallback } from "react";
import type { Pair, ChainId } from "@/types";
import { useWallet } from "@/hooks/useWallet";
import { NATIVE_SYMBOL, CHAIN_IDS } from "@/lib/trading/constants";
import { checkAntiFOMO } from "@/lib/engines/antiFomo";
import { simulateRoundTrip } from "@/lib/trading/simulation";
import type { EdgeScore } from "@/lib/engines/edgeScore";
import { LIVE_CONFIG, MODE_LABELS } from "@/lib/trading/liveConfig";
import { fmtPrice } from "@/lib/utils";
import type { SwapQuote } from "@/lib/trading/evm";
import type { OHLCVCandle } from "@/types";
import type { JupiterQuote } from "@/lib/trading/solana";

interface Props {
  pair: Pair | null;
  chain: ChainId;
  log: (msg: string, t?: "info" | "ok" | "warn" | "err") => void;
  edgeScore?: EdgeScore | null;
  ohlcv?: OHLCVCandle[];
}

type Side = "buy" | "sell";
type TxState = "idle" | "quoting" | "approving" | "swapping" | "done" | "error";

const SLIPPAGE_OPTIONS = [0.5, 1, 2, 3, 5];
const QUICK_AMOUNTS_NATIVE =
  LIVE_CONFIG.mode === "paper"
    ? ["0.01", "0.05", "0.1", "0.5"]
    : ["0.001", "0.002", "0.003"];
const QUICK_AMOUNTS_PERCENT = [25, 50, 75, 100];

export default function TradePanel({ pair, chain, log, edgeScore, ohlcv = [] }: Props) {
  const wallet = useWallet();
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(1);
  const [customSlippage, setCustomSlippage] = useState("");
  const [txState, setTxState] = useState<TxState>("idle");
  const [quote, setQuote] = useState<SwapQuote | JupiterQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<{ hash: string; success: boolean } | null>(null);
  const [nativeBalance, setNativeBalance] = useState<string | null>(null);
  const [tokenBalance, setTokenBalance] = useState<{ formatted: string; decimals: number } | null>(null);

  const isSolana = chain === "solana";
  const nativeSym = NATIVE_SYMBOL[chain] ?? "ETH";
  const slippageBps = Math.round((customSlippage ? Number(customSlippage) : slippage) * 100);
  const isEVMChain = !isSolana && !!CHAIN_IDS[chain];

  // Anti-FOMO check
  const fomoCheck = pair ? checkAntiFOMO(pair, ohlcv) : { blocked: false, reason: null, warnings: [] };

  // Trade gate — blocked if EdgeScore says no OR Anti-FOMO triggered
  const buyBlockedByGate =
    side === "buy" &&
    edgeScore !== undefined &&
    edgeScore !== null &&
    (!edgeScore.canEnterTrade || fomoCheck.blocked);

  const buyBlockReasons = [
    ...(edgeScore && !edgeScore.canEnterTrade ? edgeScore.blockers : []),
    ...(fomoCheck.blocked && fomoCheck.reason ? [`FOMO: ${fomoCheck.reason}`] : []),
  ];

  // Mode label
  const modeInfo = MODE_LABELS[LIVE_CONFIG.mode];

  // Load balances when wallet connects or pair changes
  useEffect(() => {
    if (!wallet.address || !pair) return;
    loadBalances();
  }, [wallet.address, pair?.pairAddress, chain]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadBalances = useCallback(async () => {
    if (!wallet.address || !pair) return;
    try {
      if (isSolana) {
        // Solana balance via public RPC
        const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
        const conn = new Connection("https://api.mainnet-beta.solana.com");
        const lamports = await conn.getBalance(new PublicKey(wallet.address));
        setNativeBalance((lamports / LAMPORTS_PER_SOL).toFixed(4));
      } else {
        const { getNativeBalance, getTokenBalance } = await import("@/lib/trading/evm");
        const [nb, tb] = await Promise.all([
          getNativeBalance(wallet.address),
          pair.baseToken?.address ? getTokenBalance(pair.baseToken.address, wallet.address) : null,
        ]);
        setNativeBalance(Number(nb).toFixed(4));
        if (tb) setTokenBalance({ formatted: Number(tb.formatted).toFixed(6), decimals: tb.decimals });
      }
    } catch { /* silent */ }
  }, [wallet.address, pair, isSolana]);

  // Get quote when amount changes (debounced)
  useEffect(() => {
    if (!amount || !pair || !wallet.address) { setQuote(null); setQuoteError(null); return; }
    const t = setTimeout(() => fetchQuote(), 600);
    return () => clearTimeout(t);
  }, [amount, side, slippageBps, pair?.pairAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchQuote = async () => {
    if (!pair?.baseToken?.address || !amount || Number(amount) <= 0) return;
    setTxState("quoting"); setQuoteError(null);
    try {
      if (isSolana) {
        const { getSolanaBuyQuote, getSolanaSellQuote } = await import("@/lib/trading/solana");
        const q = side === "buy"
          ? await getSolanaBuyQuote(pair.baseToken.address, Number(amount), slippageBps)
          : await getSolanaSellQuote(pair.baseToken.address, Math.floor(Number(amount) * 1e6), slippageBps); // assume 6 decimals
        setQuote(q);
      } else {
        const { getBuyQuote, getSellQuote, getTokenBalance } = await import("@/lib/trading/evm");
        if (side === "buy") {
          const q = await getBuyQuote(chain, pair.baseToken.address, amount, slippageBps);
          setQuote(q);
        } else {
          // Get token decimals first
          let decimals = tokenBalance?.decimals ?? 18;
          if (!tokenBalance && wallet.address) {
            try {
              const tb = await getTokenBalance(pair.baseToken.address, wallet.address);
              decimals = tb.decimals;
              setTokenBalance({ formatted: Number(tb.formatted).toFixed(6), decimals });
            } catch { /* use default */ }
          }
          const { ethers } = await import("ethers");
          const amountIn = ethers.parseUnits(amount, decimals);
          const q = await getSellQuote(chain, pair.baseToken.address, amountIn, slippageBps);
          setQuote(q);
        }
      }
      setTxState("idle");
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : "Quote failed");
      setQuote(null);
      setTxState("idle");
    }
  };

  const handleSwap = async () => {
    if (!pair?.baseToken?.address || !wallet.address || !quote) return;

	// Block all real swaps in paper mode
	if (LIVE_CONFIG.mode === "paper") {
	  log("Paper mode — live swaps disabled. Use Paper tab instead.", "warn");
	  return;
	}	

    // Double-check gate before executing
    if (buyBlockedByGate) {
      log("Buy blocked by Trade Gate — check Oracle panel", "err");
      return;
    }
	
	// Apply LIVE_CONFIG limits for semi/live mode
	if (LIVE_CONFIG.mode !== "paper" && side === "buy") {
	  const liquidityUsd = Number(pair.liquidity?.usd ?? 0);
	  if (liquidityUsd < LIVE_CONFIG.minLiquidityUsd) {
		log(`Trade blocked: liquidity $${Math.round(liquidityUsd)} < min $${LIVE_CONFIG.minLiquidityUsd}`, "err");
		return;
	  }
	  const amt = Number(amount || 0);
	  if (amt > LIVE_CONFIG.maxTradeEth) {
		log(`Trade blocked: ${amt} ETH > max ${LIVE_CONFIG.maxTradeEth} ETH`, "err");
		return;
	  }
	  if (slippageBps > LIVE_CONFIG.maxSlippageBps) {
		log(`Trade blocked: slippage ${slippageBps}bps > max ${LIVE_CONFIG.maxSlippageBps}bps`, "err");
		return;
	  }
	  if (edgeScore && edgeScore.total < LIVE_CONFIG.minEdgeScore) {
		log(`Trade blocked: Edge ${edgeScore.total} < min ${LIVE_CONFIG.minEdgeScore}`, "err");
		return;
	  }
	  if (edgeScore && edgeScore.safety < LIVE_CONFIG.minSafetyScore) {
		log(`Trade blocked: Safety ${edgeScore.safety} < min ${LIVE_CONFIG.minSafetyScore}`, "err");
		return;
	  }
	  if (LIVE_CONFIG.requireGoPlus && edgeScore?.dataSource !== "goplus+market") {
		log("Trade blocked: GoPlus data required in live mode", "err");
		return;
	  }
	}

    // Ensure correct chain for EVM
    if (isEVMChain) {
      const ok = await wallet.ensureCorrectChain(chain);
      if (!ok) return;
    }

    // Pre-trade simulation for EVM buys
    if (side === "buy" && isEVMChain && LIVE_CONFIG.requireSimulation) {
      log("Running AMM route check…", "info");
      setTxState("quoting");
      try {
        const sim = await simulateRoundTrip(chain, pair.baseToken.address, amount || "0.01");
        if (sim.blocked) {
          log(`Simulation blocked: ${sim.blockReason}`, "err");
          setTxState("error");
          setLastTx({ hash: "", success: false });
          return;
        }
        if (sim.warning) log(`Simulation warning: ${sim.warning}`, "warn");
        else log(`Simulation OK — round-trip loss ~${sim.priceImpact.toFixed(1)}%`, "ok");
      } catch {
		  if (LIVE_CONFIG.requireSimulation) {
			log("Simulation failed — buy blocked (requireSimulation=true)", "err");
			setTxState("error");
			return;
		  }
		  log("Simulation failed — proceeding (requireSimulation=false)", "warn");
		}
    }

    setTxState(side === "sell" ? "approving" : "swapping");
    log(`${side.toUpperCase()} ${pair.baseToken.symbol} — sending tx…`, "warn");

    try {
      let result: { success: boolean; txHash?: string; signature?: string; error?: string };

      if (isSolana) {
        const { executeJupiterSwap } = await import("@/lib/trading/solana");
        const r = await executeJupiterSwap(quote as JupiterQuote, wallet.address);
        result = { success: r.success, signature: r.signature, error: r.error };
      } else {
        if (side === "buy") {
          setTxState("swapping");
          const { executeBuy } = await import("@/lib/trading/evm");
          const r = await executeBuy(quote as SwapQuote, wallet.address);
          result = r;
        } else {
          // Approve first if needed (executeSell handles this internally)
          const { executeSell } = await import("@/lib/trading/evm");
          const r = await executeSell(quote as SwapQuote, wallet.address);
          result = r;
        }
      }

      const hash = result.txHash || result.signature || "";
      if (result.success) {
        setLastTx({ hash, success: true });
        setTxState("done");
        log(`✓ ${side.toUpperCase()} confirmed: ${hash.slice(0, 16)}…`, "ok");
        setAmount("");
        setQuote(null);
        setTimeout(() => loadBalances(), 3000); // refresh balances
      } else {
        setLastTx({ hash: "", success: false });
        setTxState("error");
        log(`✗ ${side.toUpperCase()} failed: ${result.error}`, "err");
      }
    } catch (e) {
      setTxState("error");
      log(`Trade error: ${e instanceof Error ? e.message : "unknown"}`, "err");
    }
  };

  // ─── Explorer links ──────────────────────────────────────────────────────────
  const explorerTx = (hash: string) => {
    const explorers: Record<string, string> = {
      bsc: `https://bscscan.com/tx/${hash}`,
      ethereum: `https://etherscan.io/tx/${hash}`,
      base: `https://basescan.org/tx/${hash}`,
      arbitrum: `https://arbiscan.io/tx/${hash}`,
      solana: `https://solscan.io/tx/${hash}`,
    };
    return explorers[chain] ?? "#";
  };

  // ─── Quote display helpers ────────────────────────────────────────────────────
  const getQuoteDisplay = (): string => {
    if (!quote) return "—";
    if (isSolana) {
      const q = quote as JupiterQuote;
      return side === "buy"
        ? Number(q.outAmount).toLocaleString() + " " + (pair?.baseToken?.symbol ?? "tokens")
        : (Number(q.outAmount) / 1e9).toFixed(6) + " SOL";
    } else {
      const q = quote as SwapQuote;
      
      return side === "buy"
        ? Number(ethers.formatUnits(q.amountOutExpected, tokenBalance?.decimals ?? 18)).toFixed(4) + " " + (pair?.baseToken?.symbol ?? "tokens")
        : Number(ethers.formatEther(q.amountOutExpected)).toFixed(6) + " " + nativeSym;
    }
  };

  if (!pair) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60%", gap: 10 }}>
        <div style={{ color: "#1a1a1a", fontSize: 40 }}>⟁</div>
        <div style={{ color: "#222", fontSize: 13, fontFamily: "monospace", letterSpacing: 3 }}>SELECT TOKEN TO TRADE</div>
      </div>
    );
  }
  
  if (isSolana && !LIVE_CONFIG.solanaEnabled) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60%", gap: 10 }}>
      <div style={{ color: "#9945ff", fontSize: 40 }}>◎</div>
      <div style={{ color: "#9945ff", fontSize: 13, fontFamily: "monospace", letterSpacing: 2 }}>SOLANA EXECUTION DISABLED</div>
      <div style={{ color: "#333", fontSize: 11, fontFamily: "monospace", textAlign: "center" }}>
        Solana trading is pending decimals fix.<br/>Use Oracle + Radar for analysis only.
      </div>
    </div>
  );
}

  const liveDisabled = LIVE_CONFIG.mode === "paper";

  const canTrade =
    wallet.connected &&
    !liveDisabled &&
    !buyBlockedByGate &&
   (
      (isSolana && wallet.type === "phantom") ||
      (!isSolana && wallet.type === "metamask")
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 480 }} className="fade-in">
      {/* Wallet Connection */}
      <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 6, padding: 14 }}>
        <div style={{ color: "#282828", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 10 }}>WALLET</div>
        {wallet.connected ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#39ff14", boxShadow: "0 0 6px #39ff14" }} />
                <span style={{ color: "#c0c0c0", fontSize: 12, fontFamily: "monospace" }}>
                  {wallet.address?.slice(0, 6)}…{wallet.address?.slice(-4)}
                </span>
                <span style={{ color: "#444", fontSize: 10, fontFamily: "monospace" }}>
                  {wallet.type === "metamask" ? "MetaMask" : "Phantom"}
                </span>
              </div>
              {nativeBalance && (
                <div style={{ color: "#555", fontSize: 10, fontFamily: "monospace", marginTop: 4 }}>
                  Balance: {nativeBalance} {nativeSym}
                  {tokenBalance && ` · ${tokenBalance.formatted} ${pair.baseToken?.symbol}`}
                </div>
              )}
            </div>
            <button onClick={wallet.disconnect} style={{ background: "transparent", border: "1px solid #1a1a1a", color: "#444", borderRadius: 3, padding: "4px 10px", fontSize: 10 }}>
              DISCONNECT
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            {!isSolana && (
              <button
                onClick={wallet.connectMetaMask}
                disabled={wallet.connecting}
                style={{ flex: 1, background: "rgba(240,185,11,0.08)", border: "1px solid #f0b90b44", color: "#f0b90b", borderRadius: 4, padding: "8px 14px", fontSize: 11, fontWeight: "bold" }}
              >
                {wallet.connecting ? "CONNECTING…" : "🦊 METAMASK"}
              </button>
            )}
            {isSolana && (
              <button
                onClick={wallet.connectPhantom}
                disabled={wallet.connecting}
                style={{ flex: 1, background: "rgba(153,69,255,0.08)", border: "1px solid #9945ff44", color: "#9945ff", borderRadius: 4, padding: "8px 14px", fontSize: 11, fontWeight: "bold" }}
              >
                {wallet.connecting ? "CONNECTING…" : "👻 PHANTOM"}
              </button>
            )}
          </div>
        )}
        {wallet.error && <div style={{ color: "#ff3b3b", fontSize: 10, fontFamily: "monospace", marginTop: 6 }}>⚠ {wallet.error}</div>}

        {/* Wrong chain warning */}
        {wallet.connected && wallet.type === "metamask" && !wallet.isCorrectChain(chain) && (
          <div style={{ marginTop: 8, padding: "6px 10px", background: "rgba(255,179,71,0.08)", border: "1px solid #ffb34733", borderRadius: 3 }}>
            <span style={{ color: "#ffb347", fontSize: 10, fontFamily: "monospace" }}>
              ⚠ Wrong network — click Swap to auto-switch to {chain.toUpperCase()}
            </span>
          </div>
        )}
      </div>

      {/* Token info */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ color: "#e0e0e0", fontSize: 15, fontFamily: "monospace", fontWeight: "bold" }}>
            {pair.baseToken?.symbol}
          </div>
          <div style={{ color: "#333", fontSize: 10, fontFamily: "monospace" }}>
            ${fmtPrice(pair.priceUsd)} · {pair.chainId?.toUpperCase()}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ color: Number(pair.priceChange?.h24 ?? 0) >= 0 ? "#39ff14" : "#ff3b3b", fontSize: 13, fontFamily: "monospace" }}>
            {Number(pair.priceChange?.h24 ?? 0) >= 0 ? "+" : ""}{Number(pair.priceChange?.h24 ?? 0).toFixed(2)}%
          </div>
          <div style={{ color: "#333", fontSize: 9, fontFamily: "monospace" }}>24h</div>
        </div>
      </div>

      {/* Mode badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#252525", fontSize: 9, fontFamily: "monospace" }}>MODE:</span>
        <span style={{ color: modeInfo.color, fontSize: 10, fontFamily: "monospace", fontWeight: "bold",
          border: `1px solid ${modeInfo.color}44`, borderRadius: 3, padding: "1px 8px" }}>
          {modeInfo.label}
        </span>
        {edgeScore && (
          <span style={{ color: edgeScore.canEnterTrade ? "#39ff14" : "#ff3b3b", fontSize: 10, fontFamily: "monospace", marginLeft: 4 }}>
            GATE: {edgeScore.canEnterTrade ? "OPEN ✓" : "BLOCKED ⛔"}
          </span>
        )}
      </div>

      {/* Buy/sell blocked warning */}
      {buyBlockedByGate && side === "buy" && (
        <div style={{ padding: "8px 12px", background: "rgba(255,59,59,0.05)", border: "1px solid #ff3b3b33", borderRadius: 4 }}>
          <div style={{ color: "#ff3b3b", fontSize: 11, fontFamily: "monospace", fontWeight: "bold", marginBottom: 4 }}>
            ⛔ BUY BLOCKED BY TRADE GATE
          </div>
          {buyBlockReasons.map((r, i) => (
            <div key={i} style={{ color: "#ff5555", fontSize: 10, fontFamily: "monospace" }}>▸ {r}</div>
          ))}
          <div style={{ color: "#555", fontSize: 9, fontFamily: "monospace", marginTop: 4 }}>
            Sell is always allowed. Check Oracle panel to see what&apos;s blocking buy.
          </div>
        </div>
      )}

      {/* Buy / Sell tabs */}
      <div style={{ display: "flex", gap: 0 }}>
        {(["buy", "sell"] as Side[]).map((s) => (
          <button
            key={s}
            onClick={() => { setSide(s); setQuote(null); setAmount(""); setTxState("idle"); }}
            style={{
              flex: 1,
              background: side === s ? (s === "buy" ? "rgba(57,255,20,0.12)" : "rgba(255,59,59,0.12)") : "transparent",
              border: "1px solid " + (side === s ? (s === "buy" ? "#39ff14" : "#ff3b3b") : "#1a1a1a"),
              color: side === s ? (s === "buy" ? "#39ff14" : "#ff3b3b") : "#333",
              borderRadius: s === "buy" ? "4px 0 0 4px" : "0 4px 4px 0",
              padding: "8px",
              fontSize: 12,
              fontWeight: "bold",
              letterSpacing: 2,
            }}
          >
            {s.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Amount Input */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 1 }}>
            {side === "buy" ? `AMOUNT (${nativeSym})` : `AMOUNT (${pair.baseToken?.symbol})`}
          </span>
          {side === "buy" && nativeBalance && (
            <span style={{ color: "#333", fontSize: 9, fontFamily: "monospace" }}>
              Balance: {nativeBalance} {nativeSym}
            </span>
          )}
          {side === "sell" && tokenBalance && (
            <span style={{ color: "#333", fontSize: 9, fontFamily: "monospace" }}>
              Balance: {tokenBalance.formatted} {pair.baseToken?.symbol}
            </span>
          )}
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={side === "buy" ? `0.0 ${nativeSym}` : `0 ${pair.baseToken?.symbol}`}
          type="number"
          min="0"
          style={{ width: "100%", padding: "10px 12px", fontSize: 16, borderRadius: 4 }}
        />

        {/* Quick amounts */}
        <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
          {side === "buy"
            ? QUICK_AMOUNTS_NATIVE.map((a) => (
                <button key={a} onClick={() => setAmount(a)} style={{ flex: 1, background: "#0a0a0a", border: "1px solid #1a1a1a", color: "#555", borderRadius: 3, padding: "4px 0", fontSize: 10 }}>
                  {a}
                </button>
              ))
            : QUICK_AMOUNTS_PERCENT.map((p) => (
                <button key={p} onClick={() => {
                  if (!tokenBalance) return;
                  const val = (Number(tokenBalance.formatted) * p / 100).toFixed(6);
                  setAmount(val);
                }} style={{ flex: 1, background: "#0a0a0a", border: "1px solid #1a1a1a", color: "#555", borderRadius: 3, padding: "4px 0", fontSize: 10 }}>
                  {p}%
                </button>
              ))
          }
        </div>
      </div>

      {/* Slippage */}
      <div>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 1, marginBottom: 6 }}>SLIPPAGE TOLERANCE</div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {SLIPPAGE_OPTIONS.map((s) => (
            <button key={s} onClick={() => { setSlippage(s); setCustomSlippage(""); }} style={{
              background: slippage === s && !customSlippage ? "rgba(57,255,20,0.08)" : "#0a0a0a",
              border: "1px solid " + (slippage === s && !customSlippage ? "#39ff14" : "#1a1a1a"),
              color: slippage === s && !customSlippage ? "#39ff14" : "#444",
              borderRadius: 3, padding: "4px 8px", fontSize: 10
            }}>
              {s}%
            </button>
          ))}
          <input
            value={customSlippage}
            onChange={(e) => { setCustomSlippage(e.target.value); }}
            placeholder="custom %"
            type="number"
            style={{ width: 80, padding: "4px 8px", fontSize: 10, borderRadius: 3, border: customSlippage ? "1px solid #39ff14" : "1px solid #1a1a1a" }}
          />
        </div>
        {slippageBps > 300 && (
          <div style={{ color: "#ffb347", fontSize: 10, fontFamily: "monospace", marginTop: 4 }}>
            ⚠ High slippage — risk of sandwich attack
          </div>
        )}
      </div>

      {/* Quote Display */}
      {(quote || quoteError || txState === "quoting") && (
        <div style={{ background: "#080808", border: "1px solid #1a1a1a", borderRadius: 4, padding: "10px 14px" }}>
          <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", marginBottom: 6, letterSpacing: 1 }}>QUOTE</div>
          {txState === "quoting" ? (
            <div style={{ color: "#444", fontSize: 11, fontFamily: "monospace" }}>Fetching quote…</div>
          ) : quoteError ? (
            <div style={{ color: "#ff3b3b", fontSize: 11, fontFamily: "monospace" }}>⚠ {quoteError}</div>
          ) : quote ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#444", fontSize: 11, fontFamily: "monospace" }}>Expected out</span>
                <span style={{ color: "#c0c0c0", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>{getQuoteDisplay()}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#444", fontSize: 11, fontFamily: "monospace" }}>Slippage</span>
                <span style={{ color: "#ffb347", fontSize: 11, fontFamily: "monospace" }}>{(slippageBps / 100).toFixed(1)}%</span>
              </div>
              </div>
          ) : null}
        </div>
      )}

      {/* Swap Button */}
      <button
        onClick={handleSwap}
        disabled={!canTrade || !quote || txState === "quoting" || txState === "swapping" || txState === "approving"}
        style={{
          padding: "12px",
          fontSize: 14,
          fontWeight: "bold",
          letterSpacing: 2,
          borderRadius: 4,
          border: "none",
          background: !canTrade
            ? "#0a0a0a"
            : side === "buy"
            ? "rgba(57,255,20,0.15)"
            : "rgba(255,59,59,0.15)",
          color: !canTrade ? "#333"
            : txState === "swapping" || txState === "approving" ? "#555"
            : side === "buy" ? "#39ff14" : "#ff3b3b",
          boxShadow: canTrade && quote ? `0 0 20px ${side === "buy" ? "rgba(57,255,20,0.2)" : "rgba(255,59,59,0.2)"}` : "none",
          cursor: canTrade && quote ? "pointer" : "default",
        }}
      >
        {liveDisabled
		  ? "PAPER MODE — LIVE SWAPS DISABLED"
		  : !canTrade
		  ? `CONNECT ${isSolana ? "PHANTOM" : "METAMASK"} TO TRADE`
          : txState === "approving" ? "APPROVING TOKEN…"
          : txState === "swapping" ? "SENDING TX…"
          : `${side.toUpperCase()} ${pair.baseToken?.symbol}`
        }
      </button>

      {/* Last TX */}
      {lastTx && (
        <div style={{ padding: "8px 12px", background: lastTx.success ? "rgba(57,255,20,0.05)" : "rgba(255,59,59,0.05)", border: `1px solid ${lastTx.success ? "#39ff1433" : "#ff3b3b33"}`, borderRadius: 4 }}>
          <span style={{ color: lastTx.success ? "#39ff14" : "#ff3b3b", fontSize: 11, fontFamily: "monospace" }}>
            {lastTx.success ? "✓ TX CONFIRMED" : "✗ TX FAILED"}
          </span>
          {lastTx.hash && (
            <a href={explorerTx(lastTx.hash)} target="_blank" rel="noreferrer" style={{ color: "#555", fontSize: 10, fontFamily: "monospace", marginLeft: 10 }}>
              {lastTx.hash.slice(0, 12)}… ↗
            </a>
          )}
        </div>
      )}

      {/* Disclaimer */}
      <div style={{ color: "#1e1e1e", fontSize: 9, fontFamily: "monospace", lineHeight: 1.6, borderTop: "1px solid #0d0d0d", paddingTop: 8 }}>
        Personal trading tool. Not financial advice. Always verify transactions before signing. Use at your own risk.
      </div>
    </div>
  );
}
