/**
 * ws/manager.ts
 * Conectare WS per chain, reconnect logic, message routing.
 */

import WebSocket from "ws";
import type { ChainConfig } from "../config/chains";
import {
  wsClients, v3PoolMap, v4PoolMap,
  swapSubIds, swapSubSnapshot, pendingSwapSubs,
  v3SwapSubIds, v4SwapSubIds, poolLiquidity, memory, hotCandidates,
  watchedPoolCache,
  incrementSwapSubReqId,
} from "../state/stores";
import { recordSwap, recordLp } from "../risk/flow";
import { getWsFlow } from "../risk/flow";
import { promoteHotCandidate } from "../pipeline/transitions";
import { subscribeV4Scoped, subscribeV3Scoped, subscribeV2Scoped, SWAP_V2_TOPIC, SWAP_V3_TOPIC, MINT_V2_TOPIC, BURN_V2_TOPIC } from "./subscriptions";import { supabase } from "../infra/supabase";
import { sendTelegram } from "../infra/telegram";
import { getEthPrice } from "../infra/ethPrice";
import { isBlockedSymbol, cleanEvmAddress } from "../sources/normalize";
import {
  SWAP_V4_TOPIC, MODIFY_LIQUIDITY_V4_TOPIC,
  MIN_LP_REMOVE_ETH, INSTANT_LP_EXIT_PCT,
} from "../config/constants";

function int256FromWord(hex64: string): bigint {
  const x = BigInt("0x" + hex64);
  return x >= (1n << 255n) ? x - (1n << 256n) : x;
}

function getQuoteFlowAsEth(
  chain:      ChainConfig,
  baseToken:  string,
  quoteToken: string,
  amount0:    bigint,
  amount1:    bigint,
): { ok: boolean; ethAmount: number; isBuy: boolean; quote: string | null } {
  const base   = baseToken.toLowerCase();
  const quoteT = quoteToken.toLowerCase();
  const token0 = base < quoteT ? base : quoteT;
  const amountFor = (t: string) => t === token0 ? amount0 : amount1;

  const stableAddrs = [
    chain.usdc?.toLowerCase(),
    chain.usdcLegacy?.toLowerCase(),
    ...(chain.stableQuotes ?? []).map(a => a.toLowerCase()),
  ].filter(Boolean) as string[];

  const quoteMetaFor = (addr: string): { symbol: string; decimals: number; kind: "native" | "stable" } | null => {
    const a = addr.toLowerCase();
    if (a === chain.weth.toLowerCase()) {
      return { symbol: chain.id === "bsc" ? "WBNB" : "WETH", decimals: 18, kind: "native" };
    }
    if (stableAddrs.includes(a)) {
      let symbol = "STABLE";
      if (chain.id === "bsc") {
        if (a === "0x55d398326f99059ff775485246999027b3197955") symbol = "USDT";
        else if (a === "0xe9e7cea3dedca5984780bafc599bd69add087d56") symbol = "BUSD";
        else if (a === "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d") symbol = "USDC";
      } else {
        symbol = a === chain.usdcLegacy?.toLowerCase() ? "USDC.e" : "USDC";
      }
      return { symbol, decimals: chain.id === "bsc" ? 18 : 6, kind: "stable" };
    }
    return null;
  };

  const baseMeta   = quoteMetaFor(base);
  const quoteMetaT = quoteMetaFor(quoteT);
  const quoteMeta  = baseMeta ?? quoteMetaT;

  if (!quoteMeta) return { ok: false, ethAmount: 0, isBuy: false, quote: null };

  const quoteAddr   = baseMeta ? base : quoteT;
  const amt         = amountFor(quoteAddr);
  const abs         = amt < 0n ? -amt : amt;
  const quoteAmount = Number(abs) / (10 ** quoteMeta.decimals);
  const ethAmount   = quoteMeta.kind === "native" ? quoteAmount : quoteAmount / getEthPrice();

  return { ok: true, ethAmount, isBuy: amt > 0n, quote: quoteMeta.symbol };
}

export function connectChainWebSocket(chain: ChainConfig): void {
  if (!chain.wsUrl) {
    console.log(`[CHAIN MODE] ${chain.id.toUpperCase()} — scan-only, WS/flow disabled`);
    return;
  }
  console.log(`[CHAIN MODE] ${chain.id.toUpperCase()} — full mode (scan + WS flow)`);

  const wsClient    = new WebSocket(chain.wsUrl);
  wsClients.set(chain.id, wsClient);

  const pingInterval = setInterval(() => {
    if (wsClient.readyState === WebSocket.OPEN) wsClient.ping();
  }, 30_000);

  wsClient.on("open", () => {
    console.log(`[WS] Connected to Alchemy ${chain.id.toUpperCase()}`);
    swapSubIds.delete(chain.id);
    swapSubSnapshot.delete(chain.id);
    v4SwapSubIds.delete(chain.id);
    v4SwapSubIds.delete(chain.id + "_snap");
    v3SwapSubIds.delete(chain.id);
    v3SwapSubIds.delete(chain.id + "_snap");
    for (const [reqId, reqChain] of pendingSwapSubs.entries()) {
      if (reqChain === chain.id) pendingSwapSubs.delete(reqId);
    }
    setTimeout(() => subscribeV4Scoped(chain), 2500);
    setTimeout(() => subscribeV3Scoped(chain), 3000);
	setTimeout(() => subscribeV2Scoped(chain), 3500);
  });

  wsClient.on("message", async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      // Sub confirmations pentru V3/V4
      if (msg.id === 5 || msg.id === 6 || msg.id === 7 || msg.id === 52) {
        if (msg.id === 5  && typeof msg.result === "string") v4SwapSubIds.set(chain.id, msg.result);
	    if (msg.id === 7  && typeof msg.result === "string") v3SwapSubIds.set(chain.id, msg.result);
	    if (msg.id === 52 && typeof msg.result === "string") v3SwapSubIds.set(chain.id + "_v2_id", msg.result);
        console.log(`[SUB DEBUG ${chain.id}] ${data.toString()}`);
        return;
      }

      // Scoped swap sub confirmations
      if (typeof msg.id === "number" && pendingSwapSubs.has(msg.id)) {
        const subChain = pendingSwapSubs.get(msg.id)!;
        pendingSwapSubs.delete(msg.id);
        console.log(`[WS DEBUG scoped] ${data.toString()}`);
        if (msg.error) {
          swapSubSnapshot.delete(subChain);
          console.log(`[WS] Scoped SWAP subscribe failed (${subChain}) — will retry`);
          return;
        }
        if (msg.result && typeof msg.result === "string") {
          const ids = swapSubIds.get(subChain) ?? [];
          ids.push(msg.result);
          swapSubIds.set(subChain, ids);
          console.log(`[WS] Scoped SWAP sub active: ${msg.result} (${subChain})`);
          return;
        }
      }

      // ── V4 Swap ──────────────────────────────────────────────────────────
      if (chain.id === "base" && msg.params?.result?.topics?.[0] === SWAP_V4_TOPIC) {
        const log4   = msg.params.result;
        const raw4   = log4.data?.slice(2) ?? "";
        const poolId = log4.topics?.[1]?.toLowerCase();
        if (!poolId || raw4.length < 128) return;

        const pool  = v4PoolMap.get(poolId);
        const memV4 = memory.get(poolId);
        if (!pool || !memV4) {
          if (pool && !memV4) console.log(`[V4 NO MEM] poolId=${poolId} pool=${pool.symbol}`);
          return;
        }

        const amount0 = int256FromWord(raw4.slice(0,  64));
        const amount1 = int256FromWord(raw4.slice(64, 128));

        const baseToken  = pool._raw ? (pool._raw as any).relationships?.base_token?.data?.id?.replace(`${chain.id}_`, "").toLowerCase() : "";
        const quoteToken = pool._raw ? (pool._raw as any).relationships?.quote_token?.data?.id?.replace(`${chain.id}_`, "").toLowerCase() : "";
        if (!quoteToken) {
          console.log(`[V4 SKIP] ${memV4.symbol} missing quote token for poolId=${poolId}`);
          return;
        }

        const qflow4 = getQuoteFlowAsEth(chain, baseToken, quoteToken, amount0, amount1);
        if (!qflow4.ok) {
          console.log(`[V4 SKIP] ${memV4.symbol} no WETH/USDC side base=${baseToken} quote=${quoteToken}`);
          return;
        }

        if (qflow4.ethAmount > 0) {
          recordSwap(poolId, qflow4.isBuy, qflow4.ethAmount);
          console.log(
            `[V4 SWAP ${chain.id}] ${memV4.symbol} ${qflow4.isBuy ? "BUY" : "SELL"} `
            + `quote=${qflow4.quote} eth=${qflow4.ethAmount.toFixed(4)} `
            + `amount0=${amount0} amount1=${amount1} `
            + `base=${baseToken} quoteToken=${quoteToken} tx=${log4.transactionHash}`,
          );

          if (qflow4.isBuy && qflow4.ethAmount >= 0.005) {
            const flow = getWsFlow(poolId);
            if (flow.hasData && flow.pressure === "BUYING" && flow.buys5m >= 5) {
              if (!hotCandidates.has(poolId)) {
                promoteHotCandidate(poolId, chain.id, undefined);
              }
            }
          }
        }
        return;
      }

      // ── V4 ModifyLiquidity (log-only) ─────────────────────────────────────
      if (chain.id === "base" && msg.params?.result?.topics?.[0] === MODIFY_LIQUIDITY_V4_TOPIC) {
        const log4   = msg.params.result;
        const poolId = log4.topics?.[1]?.toLowerCase();
        console.log(`[V4 LIQ RAW] poolId=${poolId} data=${log4.data?.slice(0, 258)} tx=${log4.transactionHash}`);
        return;
      }

      // ── V3 Swap ──────────────────────────────────────────────────────────
      if (msg.params?.result?.topics?.[0] === SWAP_V3_TOPIC) {
        const log3      = msg.params.result;
        const pairAddr3 = log3.address?.toLowerCase();
        const pool3     = v3PoolMap.get(pairAddr3);
        const mem3      = memory.get(pairAddr3);
        if (!pool3 || !mem3) return;
        if (isBlockedSymbol(mem3.symbol)) return;

        const raw3 = log3.data?.slice(2) ?? "";
        if (raw3.length < 128) return;

        const amount0 = int256FromWord(raw3.slice(0,  64));
        const amount1 = int256FromWord(raw3.slice(64, 128));
        const base3   = pool3._raw ? (pool3._raw as any).relationships?.base_token?.data?.id?.replace(`${chain.id}_`, "").toLowerCase() : "";
        const quote3  = pool3._raw ? (pool3._raw as any).relationships?.quote_token?.data?.id?.replace(`${chain.id}_`, "").toLowerCase() : "";

        const qflow3 = getQuoteFlowAsEth(chain, base3, quote3, amount0, amount1);
        if (!qflow3.ok) return;

        if (qflow3.ethAmount > 0) {
          recordSwap(pairAddr3, qflow3.isBuy, qflow3.ethAmount);
          console.log(`[V3 SWAP ${chain.id}] ${mem3.symbol} ${qflow3.isBuy ? "BUY" : "SELL"} quote=${qflow3.quote} eth=${qflow3.ethAmount.toFixed(4)} tx=${log3.transactionHash}`);
          if (qflow3.isBuy && qflow3.ethAmount >= 0.005) {
            const flow3 = getWsFlow(pairAddr3);
            if (flow3.hasData && flow3.pressure === "BUYING" && flow3.buys5m >= 5) {
              if (!hotCandidates.has(pairAddr3)) promoteHotCandidate(pairAddr3, chain.id, undefined);
            }
          }
        }
        return;
      }

      if (!msg.params?.result) return;

      const log         = msg.params.result;
      const pairAddress = log.address?.toLowerCase();
      if (!pairAddress || !memory.has(pairAddress)) return;

      const raw = log.data?.slice(2);
      if (!raw || raw.length < 128) return;

      const topic0 = log.topics?.[0];

      // ── V2 Swap ──────────────────────────────────────────────────────────
      if (topic0 === SWAP_V2_TOPIC && raw.length >= 256) {
        const amount0In  = BigInt("0x" + raw.slice(0,   64));
        const amount1In  = BigInt("0x" + raw.slice(64,  128));
        const amount0Out = BigInt("0x" + raw.slice(128, 192));
        const amount1Out = BigInt("0x" + raw.slice(192, 256));

        if (amount0In === 0n && amount1In === 0n) return;

        const mem   = memory.get(pairAddress)!;
        const pool2 = watchedPoolCache.get(pairAddress);

        const base2  = pool2?._raw
          ? (pool2._raw as any).relationships?.base_token?.data?.id?.replace(`${chain.id}_`, "").toLowerCase()
          : "";
        const quote2 = pool2?._raw
          ? (pool2._raw as any).relationships?.quote_token?.data?.id?.replace(`${chain.id}_`, "").toLowerCase()
          : "";

        if (!base2 || !quote2) return;

        const amount0 = amount0In > 0n ? amount0In : -amount0Out;
        const amount1 = amount1In > 0n ? amount1In : -amount1Out;

        const qflow2 = getQuoteFlowAsEth(chain, base2, quote2, amount0, amount1);
        if (!qflow2.ok || qflow2.ethAmount <= 0) return;

        recordSwap(pairAddress, qflow2.isBuy, qflow2.ethAmount);
        console.log(`[V2 SWAP ${chain.id}] ${mem.symbol} ${qflow2.isBuy ? "BUY" : "SELL"} quote=${qflow2.quote} eth:${qflow2.ethAmount.toFixed(4)}`);
        if (qflow2.isBuy) {
          const flow = getWsFlow(pairAddress);
          if (flow.hasData && flow.pressure === "BUYING" && flow.buys5m >= 5) {
            if (!hotCandidates.has(pairAddress)) {
              promoteHotCandidate(pairAddress, chain.id, undefined);
            }
          }
        }
      }

      // ── LP Mint ──────────────────────────────────────────────────────────
      if (topic0 === MINT_V2_TOPIC) {
        const amount0   = BigInt("0x" + raw.slice(0,  64));
        const amount1   = BigInt("0x" + raw.slice(64, 128));
        const memLp     = memory.get(pairAddress);
        const tokenAddrLp = memLp?.tokenAddress.replace(`${chain.id}_`, "").toLowerCase() ?? "";
        const wethIsT0  = chain.weth.toLowerCase() < tokenAddrLp.replace(/^[a-z]+_/, "");
        const ethAmount = Number(wethIsT0 ? amount0 : amount1) / 1e18;
        recordLp(pairAddress, true, ethAmount);
        console.log(`[LP ADD] ${memLp?.symbol} +${ethAmount.toFixed(3)} ETH`);
      }

      // ── LP Burn ──────────────────────────────────────────────────────────
      if (topic0 === BURN_V2_TOPIC) {
        const amount0     = BigInt("0x" + raw.slice(0,  64));
        const amount1     = BigInt("0x" + raw.slice(64, 128));
        const memLp       = memory.get(pairAddress);
        const tokenAddrLp = memLp?.tokenAddress.replace(`${chain.id}_`, "").toLowerCase() ?? "";
        const wethIsT0    = chain.weth.toLowerCase() < tokenAddrLp.replace(/^[a-z]+_/, "");
        const ethAmount   = Number(wethIsT0 ? amount0 : amount1) / 1e18;
        recordLp(pairAddress, false, ethAmount);

        const poolEth    = poolLiquidity.get(pairAddress)?.reserveEth ?? 0;
        const removedPct = poolEth > 0 ? ethAmount / poolEth : 0;

        console.log(
          `[LP REMOVE] ${memLp?.symbol} -${ethAmount.toFixed(3)} ETH`
          + (poolEth > 0 ? ` (${(removedPct * 100).toFixed(1)}% of pool)` : " (no reserve estimate)")
          + ` ⚠️`,
        );

        if (poolEth && ethAmount >= MIN_LP_REMOVE_ETH && removedPct >= INSTANT_LP_EXIT_PCT) {
          const { data: openTrades } = await supabase
            .from("shadow_trades")
            .select("id, symbol, entry_price, current_price, chain")
            .eq("pair_address", pairAddress)
            .is("exited_at", null);

          if (openTrades?.length) {
            for (const trade of openTrades) {
              const exitPrice = memLp?.currentPrice ?? Number(trade.current_price);
              const entry     = Number(trade.entry_price);
              await supabase.from("shadow_trades").update({
                exited_at:   Date.now(),
                exit_price:  exitPrice,
                exit_reason: "LP REMOVED",
              }).eq("id", trade.id);

              const m = memory.get(pairAddress);
              if (m) {
                m.badExits24h      += 1;
                m.consecutiveLosses += 1;
                m.lastExitReason    = "LP REMOVED";
                m.lastExitTime      = Date.now();
              }

              console.log(`[LP EXIT INSTANT] ${trade.symbol} — ${ethAmount.toFixed(3)} ETH (${(removedPct * 100).toFixed(1)}%) removed`);
              await sendTelegram(
                `⚡ <b>LP EXIT INSTANT</b> ${trade.symbol} [${chain.id.toUpperCase()}]\n`
                + `LP removed ${ethAmount.toFixed(3)} ETH (${(removedPct * 100).toFixed(1)}% of pool)\n`
                + `P&L: ${((exitPrice - entry) / entry * 100).toFixed(1)}%`,
              );
            }
          }
        }
      }

    } catch (e) { console.log(`[WS ERR ${chain.id}]`, e); }
  });

  wsClient.on("error", (err: Error) => console.log(`[WS ${chain.id}] Error: ${err.message}`));

  wsClient.on("close", () => {
    clearInterval(pingInterval);
    v4SwapSubIds.delete(chain.id);
    v4SwapSubIds.delete(chain.id + "_snap");
    v3SwapSubIds.delete(chain.id);
    v3SwapSubIds.delete(chain.id + "_snap");
	v3SwapSubIds.delete(chain.id + "_v2_id");
	v3SwapSubIds.delete(chain.id + "_v2_snap");
    console.log(`[WS ${chain.id}] Disconnected — reconnecting in 5s...`);
    setTimeout(() => connectChainWebSocket(chain), 5_000);
  });
}
