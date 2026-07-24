/**
 * ws/manager.ts
 * Conectare WS per chain, reconnect logic, message routing.
 */

import WebSocket from "ws";
import type { ChainConfig } from "../config/chains";
import { getQuoteFlowAsEth, toPoolConventionAmounts } from "./quoteFlow";
import {
  wsClients, v3PoolMap, v4PoolMap,
  swapSubIds, swapSubSnapshot, pendingSwapSubs,
  scopedSubStore, poolLiquidity, memory, hotCandidates,
  watchedPoolCache,
  incrementSwapSubReqId,
} from "../state/stores";
import { applyScopedSubResponse, clearScopedSubsForChain } from "./scopedSubs";
import { heartbeatTick } from "./heartbeat";
import { recordSwap, recordLp } from "../risk/flow";
import { getWsFlow } from "../risk/flow";
import { promoteHotCandidate } from "../pipeline/transitions";
import {
  subscribeV4Scoped,
  subscribeV3Scoped,
  subscribeV2Scoped,
  SWAP_V2_TOPIC,
  SWAP_V3_TOPIC,
  MINT_V2_TOPIC,
  BURN_V2_TOPIC,
  MINT_V3_TOPIC,
  BURN_V3_TOPIC,
} from "./subscriptions";
import { supabase } from "../infra/supabase";
import { sendTelegram } from "../infra/telegram";
import { isBlockedSymbol } from "../sources/normalize";
import {
  SWAP_V4_TOPIC, MODIFY_LIQUIDITY_V4_TOPIC,
  V4_POOL_MANAGERS,
  MIN_LP_REMOVE_ETH, INSTANT_LP_EXIT_PCT,
} from "../config/constants";

/** D1: intervalul heartbeat (ping + verificare pong). Un ping fără pong într-un interval → socket zombie. */
const WS_PING_INTERVAL_MS = 30_000;

function int256FromWord(hex64: string): bigint {
  const x = BigInt("0x" + hex64);
  return x >= (1n << 255n) ? x - (1n << 256n) : x;
}

/**
 * Extrage baseToken + quoteToken dintr-un SourcePool.
 * INDEXER pools au _raw.baseToken / _raw.quoteToken direct (IndexedPair format).
 * Gecko pools au _raw.relationships.{base,quote}_token.data.id cu prefix chain.
 */
function extractBaseQuote(pool: { discoverySource?: string; _raw?: unknown; tokenAddress?: string }): { baseToken: string; quoteToken: string } {
  const raw = pool._raw as Record<string, unknown> | undefined;
  if (!raw) return { baseToken: pool.tokenAddress?.toLowerCase() ?? "", quoteToken: "" };

  // IndexedPair format: baseToken / quoteToken direct pe _raw (indiferent de discoverySource)
  const indexedBase  = typeof raw.baseToken  === "string" ? raw.baseToken.toLowerCase()  : "";
  const indexedQuote = typeof raw.quoteToken === "string" ? raw.quoteToken.toLowerCase() : "";
  if (indexedBase || indexedQuote) {
    return {
      baseToken:  indexedBase  || pool.tokenAddress?.toLowerCase() || "",
      quoteToken: indexedQuote,
    };
  }

  // Gecko format: relationships.{base,quote}_token.data.id are prefixul rețelei
  // Gecko ("{gecko}_0x...", ex. "eth_0x..." / "base_0x...").
  // A1: strip generic al prefixului "{alnum}_" — înainte se folosea chain.id
  // ("ethereum"), dar prefixul Gecko e chain.gecko ("eth"), deci pe Ethereum
  // adresa nu era curățată → quoteMetaFor nu potrivea → flow WS tăcut zero.
  const stripGeckoPrefix = (id: string | undefined): string =>
    id?.replace(/^[a-z0-9-]+_/i, "").toLowerCase() ?? "";
  const rel = raw.relationships as Record<string, unknown> | undefined;
  const base  = stripGeckoPrefix(((rel?.base_token  as Record<string, unknown>)?.data as Record<string, unknown>)?.id  as string | undefined);
  const quote = stripGeckoPrefix(((rel?.quote_token as Record<string, unknown>)?.data as Record<string, unknown>)?.id as string | undefined);
  return { baseToken: base, quoteToken: quote };
}

export function connectChainWebSocket(chain: ChainConfig): void {
  if (!chain.wsUrl) {
    console.log(`[CHAIN MODE] ${chain.id.toUpperCase()} — scan-only, WS/flow disabled`);
    return;
  }
  console.log(`[CHAIN MODE] ${chain.id.toUpperCase()} — full mode (scan + WS flow)`);

  // D1: `handshakeTimeout` — o conexiune blocată în `CONNECTING` (TCP prins, dar upgrade-ul WS nu se
  // finalizează niciodată) ar rămâne fără `open` ȘI fără `close` → reconnect-ul nu s-ar declanșa (aceeași
  // familie ca socketul zombie, dar în faza de conectare). La timeout, `ws` emite `error` → `close` →
  // reconnect (handlerele existente). Heartbeat-ul de mai jos acoperă socketul deja `OPEN` care devine mut.
  const wsClient    = new WebSocket(chain.wsUrl, { handshakeTimeout: 30_000 });
  wsClients.set(chain.id, wsClient);

  // D1: heartbeat cu detecție de socket ZOMBIE. Fără listener de `pong` + fără `terminate`, un socket
  // half-open (TCP viu, server mut) rămâne `OPEN` pe veci → `close` nu se emite → reconnect-ul din
  // `on("close")` nu se declanșează → flow tăcut zero. Acum: dacă ping-ul precedent n-a primit pong într-un
  // interval → socket mort → `terminate()` (forțează `close` → reconnect). `pong` de la server resetează.
  let awaitingPong = false;
  wsClient.on("pong", () => { awaitingPong = false; });
  const pingInterval = setInterval(() => {
    if (wsClient.readyState !== WebSocket.OPEN) return;
    const tick = heartbeatTick(awaitingPong);
    awaitingPong = tick.awaitingPong;
    if (tick.action === "terminate") {
      console.warn(`[WS ${chain.id}] no pong to last ping — terminating stale socket (D1 watchdog)`);
      wsClient.terminate(); // → emite `close` → reconnect (handler existent)
    } else {
      wsClient.ping();
    }
  }, WS_PING_INTERVAL_MS);

  wsClient.on("open", () => {
    console.log(`[WS] Connected to Alchemy ${chain.id.toUpperCase()}`);
    swapSubIds.delete(chain.id);
    swapSubSnapshot.delete(chain.id);
    clearScopedSubsForChain(scopedSubStore, chain.id); // D3: reconnect → stare scoped goală (active+pending+latest)
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

      // D3: confirmări scoped V2/V3/V4 — snapshot-ul devine ACTIV doar aici, după răspunsul serverului.
      // Succes pe cea mai recentă cerere → promovează + anulează subscripția veche; eroare → păstrează
      // subscripția veche (retry la scanul următor); răspuns depășit → anulează subId-ul orfan.
      if (typeof msg.id === "number" && scopedSubStore.pending.has(msg.id)) {
        const result = typeof msg.result === "string"
          ? { ok: true as const, subId: msg.result }
          : { ok: false as const };
        const { unsub, outcome } = applyScopedSubResponse(scopedSubStore, msg.id, result);
        for (const subId of unsub) {
          wsClient.send(JSON.stringify({ jsonrpc: "2.0", id: 88, method: "eth_unsubscribe", params: [subId] }));
        }
        console.log(`[SCOPED SUB ${chain.id}] req#${msg.id} → ${outcome}${unsub.length ? ` (unsub ${unsub.join(",")})` : ""}`);
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

      // ── V4 Swap (all chains) ─────────────────────────────────────────────
      if (msg.params?.result?.topics?.[0] === SWAP_V4_TOPIC) {
        const log4   = msg.params.result;
        // Guard: only process if log came from the correct PoolManager for this chain
        if (log4.address?.toLowerCase() !== V4_POOL_MANAGERS[chain.id]?.toLowerCase()) return;

        const raw4   = log4.data?.slice(2) ?? "";
        const poolId = log4.topics?.[1]?.toLowerCase();
        if (!poolId || raw4.length < 128) return;

        const pool  = v4PoolMap.get(chain.id, poolId);
        const memV4 = memory.get(chain.id, poolId);
        if (!pool || !memV4) {
          if (pool && !memV4) console.log(`[V4 NO MEM] poolId=${poolId} pool=${pool.symbol}`);
          return;
        }

        const amount0 = int256FromWord(raw4.slice(0,  64));
        const amount1 = int256FromWord(raw4.slice(64, 128));

        const { baseToken, quoteToken } = extractBaseQuote(pool);
        if (!quoteToken) {
          console.log(`[V4 SKIP] ${memV4.symbol} missing quote token for poolId=${poolId}`);
          return;
        }

        // A5: V4 Swap event = perspectiva swapper-ului (negativ = plătit în pool),
        // OPUS lui V3. Aducem la convenția pool, altfel buy/sell inversat.
        const [v4a0, v4a1] = toPoolConventionAmounts(amount0, amount1, true);
        const qflow4 = getQuoteFlowAsEth(chain, baseToken, quoteToken, v4a0, v4a1);
        if (!qflow4.ok) {
          console.log(`[V4 SKIP] ${memV4.symbol} no WETH/USDC side base=${baseToken} quote=${quoteToken}`);
          return;
        }

        if (qflow4.ethAmount > 0) {
          recordSwap(chain.id, poolId, qflow4.isBuy, qflow4.ethAmount, qflow4.usdAmount);
          console.log(
            `[V4 SWAP ${chain.id}] ${memV4.symbol} ${qflow4.isBuy ? "BUY" : "SELL"} `
            + `quote=${qflow4.quote} nativeEq=${qflow4.ethAmount.toFixed(4)} usd=$${qflow4.usdAmount.toFixed(0)} `
            + `amount0=${amount0} amount1=${amount1} `
            + `base=${baseToken} quoteToken=${quoteToken} tx=${log4.transactionHash}`,
          );

          if (qflow4.isBuy && qflow4.ethAmount >= 0.005) {
            const flow = getWsFlow(chain.id, poolId);
            if (flow.hasData && flow.pressure === "BUYING" && flow.buys5m >= 5) {
              if (!hotCandidates.has(chain.id, poolId)) {
                promoteHotCandidate(poolId, chain.id, undefined);
              }
            }
          }
        }
        return;
      }

      // ── V4 ModifyLiquidity (investigating layout) ─────────────────────────
      if (msg.params?.result?.topics?.[0] === MODIFY_LIQUIDITY_V4_TOPIC && msg.params?.result?.address?.toLowerCase() === V4_POOL_MANAGERS[chain.id]?.toLowerCase()) {
        const log4   = msg.params.result;
        const poolId = log4.topics?.[1]?.toLowerCase();
        const mem4   = poolId ? memory.get(chain.id, poolId) : null;
        const raw4   = log4.data?.slice(2) ?? "";
        console.log(`[V4 LIQ] ${mem4?.symbol ?? poolId} len=${raw4.length} data=${raw4.slice(0, 192)} tx=${log4.transactionHash}`);
        return;
      }

      // ── V3 Swap ──────────────────────────────────────────────────────────
      if (msg.params?.result?.topics?.[0] === SWAP_V3_TOPIC) {
        const log3      = msg.params.result;
        const pairAddr3 = log3.address?.toLowerCase();
        if (!pairAddr3) return;
        const pool3     = v3PoolMap.get(chain.id, pairAddr3);
        const mem3      = memory.get(chain.id, pairAddr3);
        if (!pool3 || !mem3) return;
        if (isBlockedSymbol(mem3.symbol)) return;

        const raw3 = log3.data?.slice(2) ?? "";
        if (raw3.length < 128) return;

        const amount0 = int256FromWord(raw3.slice(0,  64));
        const amount1 = int256FromWord(raw3.slice(64, 128));
        const { baseToken: base3, quoteToken: quote3 } = extractBaseQuote(pool3);

        const qflow3 = getQuoteFlowAsEth(chain, base3, quote3, amount0, amount1);
        if (!qflow3.ok) return;

        if (qflow3.ethAmount > 0) {
          recordSwap(chain.id, pairAddr3, qflow3.isBuy, qflow3.ethAmount, qflow3.usdAmount);
          console.log(`[V3 SWAP ${chain.id}] ${mem3.symbol} ${qflow3.isBuy ? "BUY" : "SELL"} quote=${qflow3.quote} nativeEq=${qflow3.ethAmount.toFixed(4)} usd=$${qflow3.usdAmount.toFixed(0)} tx=${log3.transactionHash}`);
          if (qflow3.isBuy && qflow3.ethAmount >= 0.005) {
            const flow3 = getWsFlow(chain.id, pairAddr3);
            if (flow3.hasData && flow3.pressure === "BUYING" && flow3.buys5m >= 5) {
              if (!hotCandidates.has(chain.id, pairAddr3)) promoteHotCandidate(pairAddr3, chain.id, undefined);
            }
          }
        }
        return;
      }
	  
	  // ── V3 Mint ──────────────────────────────────────────────────────────
      if (msg.params?.result?.topics?.[0] === MINT_V3_TOPIC) {
        const log3  = msg.params.result;
        const addr3 = log3.address?.toLowerCase();
        if (!addr3) return;
        const pool3 = v3PoolMap.get(chain.id, addr3);
        const mem3  = pool3 ? memory.get(chain.id, addr3) : null;
        if (!pool3 || !mem3) return;
        const raw3 = log3.data?.slice(2) ?? "";
        if (raw3.length < 256) return;
        // V3 Mint data: sender(32) amount(32) amount0(32) amount1(32)
        const amount0 = BigInt("0x" + raw3.slice(128, 192));
        const amount1 = BigInt("0x" + raw3.slice(192, 256));
        const { baseToken: base3, quoteToken: quote3 } = extractBaseQuote(pool3);
        const qflow3 = getQuoteFlowAsEth(chain, base3, quote3, amount0, amount1);
        if (qflow3.ok && qflow3.ethAmount > 0) {
          recordLp(chain.id, addr3, true, qflow3.ethAmount);
          console.log(`[V3 LP ADD ${chain.id}] ${mem3.symbol} +${qflow3.ethAmount.toFixed(3)} ETH quote=${qflow3.quote}`);
        }
        return;
      }

      // ── V3 Burn ──────────────────────────────────────────────────────────
      if (msg.params?.result?.topics?.[0] === BURN_V3_TOPIC) {
        const log3  = msg.params.result;
        const addr3 = log3.address?.toLowerCase();
        if (!addr3) return;
        const pool3 = v3PoolMap.get(chain.id, addr3);
        const mem3  = pool3 ? memory.get(chain.id, addr3) : null;
        if (!pool3 || !mem3) return;
        const raw3 = log3.data?.slice(2) ?? "";
        if (raw3.length < 192) return;
        // V3 Burn data: amount(32) amount0(32) amount1(32)
        const amount0 = BigInt("0x" + raw3.slice(64, 128));
        const amount1 = BigInt("0x" + raw3.slice(128, 192));
        const { baseToken: base3, quoteToken: quote3 } = extractBaseQuote(pool3);
        const qflow3 = getQuoteFlowAsEth(chain, base3, quote3, amount0, amount1);
        if (qflow3.ok && qflow3.ethAmount > 0) {
          recordLp(chain.id, addr3, false, qflow3.ethAmount);
          const poolEth    = poolLiquidity.get(chain.id, addr3)?.reserveEth ?? 0;
          const removedPct = poolEth > 0 ? qflow3.ethAmount / poolEth : 0;
          console.log(`[V3 LP REMOVE ${chain.id}] ${mem3.symbol} -${qflow3.ethAmount.toFixed(3)} ETH (${(removedPct * 100).toFixed(1)}%) quote=${qflow3.quote}`);
        }
        return;
      }

      if (!msg.params?.result) return;

      const log         = msg.params.result;
      const pairAddress = log.address?.toLowerCase();
      if (!pairAddress || !memory.has(chain.id, pairAddress)) return;

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

        const mem   = memory.get(chain.id, pairAddress)!;
        const pool2 = watchedPoolCache.get(chain.id, pairAddress);

        const { baseToken: base2, quoteToken: quote2 } = pool2
          ? extractBaseQuote(pool2)
          : { baseToken: "", quoteToken: "" };

        if (!base2 || !quote2) return;

        const amount0 = amount0In > 0n ? amount0In : -amount0Out;
        const amount1 = amount1In > 0n ? amount1In : -amount1Out;

        const qflow2 = getQuoteFlowAsEth(chain, base2, quote2, amount0, amount1);
        if (!qflow2.ok || qflow2.ethAmount <= 0) return;

        recordSwap(chain.id, pairAddress, qflow2.isBuy, qflow2.ethAmount, qflow2.usdAmount);
        console.log(`[V2 SWAP ${chain.id}] ${mem.symbol} ${qflow2.isBuy ? "BUY" : "SELL"} quote=${qflow2.quote} nativeEq:${qflow2.ethAmount.toFixed(4)} usd:$${qflow2.usdAmount.toFixed(0)}`);
        if (qflow2.isBuy) {
          const flow = getWsFlow(chain.id, pairAddress);
          if (flow.hasData && flow.pressure === "BUYING" && flow.buys5m >= 5) {
            if (!hotCandidates.has(chain.id, pairAddress)) {
              promoteHotCandidate(pairAddress, chain.id, undefined);
            }
          }
        }
      }

      // ── LP Mint ──────────────────────────────────────────────────────────
      if (topic0 === MINT_V2_TOPIC) {
        const amount0   = BigInt("0x" + raw.slice(0,  64));
        const amount1   = BigInt("0x" + raw.slice(64, 128));
        const memLp     = memory.get(chain.id, pairAddress);
        const tokenAddrLp = memLp?.tokenAddress.replace(`${chain.id}_`, "").toLowerCase() ?? "";
        const wethIsT0  = chain.weth.toLowerCase() < tokenAddrLp.replace(/^[a-z]+_/, "");
        const ethAmount = Number(wethIsT0 ? amount0 : amount1) / 1e18;
        recordLp(chain.id, pairAddress, true, ethAmount);
        console.log(`[LP ADD] ${memLp?.symbol} +${ethAmount.toFixed(3)} ETH`);
      }

      // ── LP Burn ──────────────────────────────────────────────────────────
      if (topic0 === BURN_V2_TOPIC) {
        const amount0     = BigInt("0x" + raw.slice(0,  64));
        const amount1     = BigInt("0x" + raw.slice(64, 128));
        const memLp       = memory.get(chain.id, pairAddress);
        const tokenAddrLp = memLp?.tokenAddress.replace(`${chain.id}_`, "").toLowerCase() ?? "";
        const wethIsT0    = chain.weth.toLowerCase() < tokenAddrLp.replace(/^[a-z]+_/, "");
        const ethAmount   = Number(wethIsT0 ? amount0 : amount1) / 1e18;
        recordLp(chain.id, pairAddress, false, ethAmount);

        const poolEth    = poolLiquidity.get(chain.id, pairAddress)?.reserveEth ?? 0;
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
            .eq("chain", chain.id)   // B5a: never match cross-chain data only by address (P0-1) — aceeași adresă pe base+arbitrum nu mai închide trade-ul celuilalt chain
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

              const m = memory.get(chain.id, pairAddress);
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
    clearScopedSubsForChain(scopedSubStore, chain.id); // D3: subscripțiile mor cu socketul → stare goală
    console.log(`[WS ${chain.id}] Disconnected — reconnecting in 5s...`);
    setTimeout(() => connectChainWebSocket(chain), 5_000);
  });
}
