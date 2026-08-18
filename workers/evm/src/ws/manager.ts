/**
 * ws/manager.ts
 * Conectare WS per chain, reconnect logic, message routing.
 */

import WebSocket from "ws";
import type { ChainConfig } from "../config/chains";
import { isShuttingDown, beginJob, closeSocketsBounded } from "../lib/lifecycle";
import { getQuoteFlowAsEth, toPoolConventionAmounts, extractBaseQuote, resolveLpNativeAmount } from "./quoteFlow";
import { createReconnectManager, type BackoffConfig } from "./wsBackoff";
import { startHeartbeat } from "./heartbeat";
import {
  wsClients, wsLastPongAt, wsLastMessageAt, wsLastMessageAtByKind, scopedConfirmedAt,
  v3PoolMap, v4PoolMap,
  swapSubIds, swapSubSnapshot, pendingSwapSubs,
  scopedSubStore, poolLiquidity, memory, hotCandidates,
  watchedPoolCache,
  incrementSwapSubReqId,
} from "../state/stores";
import { applyScopedSubResponse, clearScopedSubsForChain, scopedSubKey, isActiveKindMessage, type ScopedSubKind } from "./scopedSubs";
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
import { isBlockedSymbol } from "../sources/normalize";
import {
  SWAP_V4_TOPIC, MODIFY_LIQUIDITY_V4_TOPIC,
  V4_POOL_MANAGERS,
} from "../config/constants";

function int256FromWord(hex64: string): bigint {
  const x = BigInt("0x" + hex64);
  return x >= (1n << 255n) ? x - (1n << 256n) : x;
}

// Part B: topic0 → kind subscripție (v2/v3/v4), pentru `wsLastMessageAtByKind`. Un log livrat = data stream viu
// PT. ACEL KIND (distinge V2 mort tăcut de V3/V4 care curg — pe care agregatul per-chain `wsLastMessageAt` îl maschează).
const TOPIC_TO_KIND: Record<string, ScopedSubKind> = {
  [SWAP_V4_TOPIC]:              "v4",
  [MODIFY_LIQUIDITY_V4_TOPIC]:  "v4",
  [SWAP_V3_TOPIC]:              "v3",
  [MINT_V3_TOPIC]:              "v3",
  [BURN_V3_TOPIC]:              "v3",
  [SWAP_V2_TOPIC]:              "v2",
  [MINT_V2_TOPIC]:              "v2",
  [BURN_V2_TOPIC]:              "v2",
};
function kindForTopic(topic0: unknown): ScopedSubKind | null {
  return typeof topic0 === "string" ? (TOPIC_TO_KIND[topic0] ?? null) : null;
}

// extractBaseQuote a fost mutată în ./quoteFlow (pură, testabilă izolat — E18).

// E27: reconnect WS cu backoff exponențial + jitter (era fix 5s → hamerea endpoint-ul pe pană
// persistentă și reconnecta identic pe toate chain-urile = thundering herd). Logica trăiește în
// controller-ul PUR `createReconnectManager` (testabil izolat); aici doar îl cablăm cu timere/rand/connect reale.
const WS_RECONNECT_BACKOFF: BackoffConfig = { baseMs: 1_000, capMs: 30_000, jitterRatio: 0.5 };
const WS_STABLE_MS = 60_000; // socketul trebuie să reziste 60s neîntrerupt înainte de a reseta backoff-ul
const WS_HEARTBEAT_INTERVAL_MS = 30_000; // D1: fereastra ping→pong; un interval fără pong = socket zombie → terminate

// Registry chainId→ChainConfig: controller-ul lucrează cu chainId; aici recuperăm ChainConfig-ul pt. reconnect.
const chainRegistry = new Map<string, ChainConfig>();

// PH-13 (cgpt #1): registru al TUTUROR timer-elor de reconnect/stability programate de controller. La shutdown le
// oprim EXPLICIT (`stopWsReconnectTimers`), ca un reconnect deja programat să NU mai construiască un socket nou după
// `markShuttingDown()`. (Guard-ul de la intrarea în `connectChainWebSocket` e a doua plasă de siguranță.)
const wsReconnectTimers = new Set<ReturnType<typeof setTimeout>>();
function stopWsReconnectTimers(): number {
  let n = 0;
  for (const h of wsReconnectTimers) { clearTimeout(h); n++; }
  wsReconnectTimers.clear();
  return n;
}

const wsReconnect = createReconnectManager({
  connect: (chainId) => {
    // PH-13: nu reconecta în timpul shutdown-ului (chiar dacă un timer a scăpat de stopWsReconnectTimers).
    if (isShuttingDown()) return;
    const chain = chainRegistry.get(chainId);
    if (chain) connectChainWebSocket(chain);
  },
  config:     WS_RECONNECT_BACKOFF,
  stableMs:   WS_STABLE_MS,
  setTimer:   (fn, ms) => { const h = setTimeout(() => { wsReconnectTimers.delete(h); fn(); }, ms); wsReconnectTimers.add(h); return h; },
  clearTimer: (h) => { wsReconnectTimers.delete(h as ReturnType<typeof setTimeout>); clearTimeout(h as ReturnType<typeof setTimeout>); },
  rand:       Math.random,
  log:        (m) => console.log(m),
});

export function connectChainWebSocket(chain: ChainConfig): void {
  // PH-13 (cgpt #1): guard CHIAR LA INTRARE — un timer de reconnect deja programat înainte de shutdown poate ajunge
  // aici după `markShuttingDown()`; refuzăm să construim un socket nou în timpul închiderii.
  if (isShuttingDown()) {
    console.log(`[WS ${chain.id}] connect ignorat — shutdown în curs.`);
    return;
  }
  if (!chain.wsUrl) {
    console.log(`[CHAIN MODE] ${chain.id.toUpperCase()} — scan-only, WS/flow disabled`);
    return;
  }
  console.log(`[CHAIN MODE] ${chain.id.toUpperCase()} — full mode (scan + WS flow)`);
  chainRegistry.set(chain.id, chain); // E27: pt. reconnect-ul din controller (înainte de constructor)

  // E27: protejează ȘI conexiunea INIȚIALĂ (index.ts o pornește direct, nu prin controller/runConnect).
  // Un throw sincron la `new WebSocket` (ex. URL invalid) → programează reconnect prin controller și
  // iese, în loc să propage excepția și să oprească workerul. Retry-urile vor găsi chain-ul în registry.
  let wsClient: WebSocket;
  try {
    wsClient = new WebSocket(chain.wsUrl);
  } catch (e) {
    console.log(`[WS ${chain.id}] Constructor WebSocket a eșuat`, e);
    // PH-13: în timpul shutdown-ului NU reprogramăm reconnect (altfel un socket nou ar învia după ce am oprit tot).
    if (!isShuttingDown()) wsReconnect.handleClose(chain.id);
    return;
  }
  wsClients.set(chain.id, wsClient);

  // D1 (fix wiring): heartbeat ping/pong REAL — detectează socketul zombie (TCP OPEN, dar serverul nu
  // mai livrează nimic) și-l `terminate()` → `close` → reconnect. Înainte se trimitea DOAR `ping()`,
  // fără listener de `pong` și fără terminate → zombie-ul rămânea OPEN pe veci, `close` nu se emitea,
  // reconnect-ul nu pornea, iar health-ul îl raporta „conectat" cu flow zero. Wiring-ul e în
  // `startHeartbeat` (heartbeat.ts) → testat pe socket fals (scripts/wsHeartbeatWiring.test.ts).
  const heartbeat = startHeartbeat(wsClient, {
    openState:     WebSocket.OPEN,
    intervalMs:    WS_HEARTBEAT_INTERVAL_MS,
    setInterval:   (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    log:           (m) => console.log(`[WS ${chain.id}] ${m}`),
    onPong:        () => wsLastPongAt.set(chain.id, Date.now()), // transport viu (distinct de data stream)
  });

  wsClient.on("open", () => {
    // PH-13 (cgpt #1): un `open` poate sosi DUPĂ începerea shutdown-ului (socket deschis chiar înainte de semnal).
    // Nu (re)subscriem și nu resetăm backoff-ul — lăsăm closeAllWebSockets să-l închidă.
    if (isShuttingDown()) { console.log(`[WS ${chain.id}] open ignorat — shutdown în curs.`); return; }
    console.log(`[WS] Connected to Alchemy ${chain.id.toUpperCase()}`);
    wsReconnect.handleOpen(chain.id); // E27: reset backoff DOAR după WS_STABLE_MS de conexiune neîntreruptă
    swapSubIds.delete(chain.id);
    swapSubSnapshot.delete(chain.id);
    clearScopedSubsForChain(scopedSubStore, chain.id); // D3: reconnect → stare scoped goală (active+pending+latest)
    // Part B: golește semnalele per-kind ale chain-ului — subscripțiile vechi au murit cu socketul, iar un
    // lastMessage/confirmedAt vechi ar raporta fals „proaspăt" până la expirare pe socketul NOU (gol).
    for (const m of [wsLastMessageAtByKind, scopedConfirmedAt]) {
      for (const k of [...m.keys()]) if (k.startsWith(chain.id + ":")) m.delete(k);
    }
    for (const [reqId, reqChain] of pendingSwapSubs.entries()) {
      if (reqChain === chain.id) pendingSwapSubs.delete(reqId);
    }
    setTimeout(() => subscribeV4Scoped(chain), 2500);
    setTimeout(() => subscribeV3Scoped(chain), 3000);
	setTimeout(() => subscribeV2Scoped(chain), 3500);
  });

  wsClient.on("message", async (data: Buffer) => {
    // PH-13 (cgpt #3): un handler de mesaj poate MUTA memoria (recordSwap/recordLp/promote…). Nu porni procesare
    // nouă după shutdown, iar cea deja pornită e URMĂRITĂ prin lifecycle (drain-ul așteaptă `__wsJob` înainte de
    // snapshot) — altfel un mesaj async ar putea scrie memoria DUPĂ ce am persistat.
    if (isShuttingDown()) return;
    const __wsJob = beginJob();
    try {
      const msg = JSON.parse(data.toString());

      // D3: confirmări scoped V2/V3/V4 — snapshot-ul devine ACTIV doar aici, după răspunsul serverului.
      // Succes pe cea mai recentă cerere → promovează + anulează subscripția veche; eroare → păstrează
      // subscripția veche (retry la scanul următor); răspuns depășit → anulează subId-ul orfan.
      if (typeof msg.id === "number" && scopedSubStore.pending.has(msg.id)) {
        // Part B: cheia cererii ÎNAINTE ca reducer-ul s-o consume — ca s-o marcăm confirmată pe „promoted".
        const pendKey = scopedSubStore.pending.get(msg.id)?.key;
        const result = typeof msg.result === "string"
          ? { ok: true as const, subId: msg.result }
          : { ok: false as const };
        const { unsub, outcome } = applyScopedSubResponse(scopedSubStore, msg.id, result);
        // Part B: o subscripție NOU confirmată → resetează momentul confirmării (baza pt. confirmedAgeSec) ȘI
        // șterge vârsta de mesaj a generației VECHI (corectitudine cgpt): altfel un lastMessage moștenit ar
        // raporta fals „ACTIVE" pentru subscripția nouă până la primul ei mesaj real.
        if (outcome === "promoted" && pendKey) {
          scopedConfirmedAt.set(pendKey, Date.now());
          wsLastMessageAtByKind.delete(pendKey);
        }
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

      // D1 (health onestitate): o NOTIFICARE de log livrată prin subscripție = data stream viu — distinct
      // de pong (= doar transport viu). Marcăm înainte de a filtra pe topic, ca orice log de la orice
      // subscripție să conteze ca „stream care curge" (nu doar swap-urile de care ne pasă mai jos).
      if (msg.params?.result) {
        wsLastMessageAt.set(chain.id, Date.now()); // per-chain: ORICE log livrat = data stream curge (transport)
        // Part B (corectitudine cgpt): per-kind DOAR dacă mesajul vine de la subscripția ACTIVĂ confirmată
        // (`msg.params.subscription === active.subId`) — nu de la una veche/orfană/stale cu ACELAȘI topic0,
        // altfel am marca fals kind-ul „viu" (și l-am face „sibling recent" fals în clasificarea cross-kind).
        const kind = kindForTopic(msg.params.result.topics?.[0]);
        if (kind && isActiveKindMessage(scopedSubStore.active, chain.id, kind, msg.params.subscription)) {
          wsLastMessageAtByKind.set(scopedSubKey(chain.id, kind), Date.now());
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
          console.log(`[V3 LP ADD ${chain.id}] ${mem3.symbol} +${qflow3.ethAmount.toFixed(3)} ${chain.id === "bsc" ? "BNB" : "ETH"} quote=${qflow3.quote}`);
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
          console.log(`[V3 LP REMOVE ${chain.id}] ${mem3.symbol} -${qflow3.ethAmount.toFixed(3)} ${chain.id === "bsc" ? "BNB" : "ETH"} (${(removedPct * 100).toFixed(1)}%) quote=${qflow3.quote}`);
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
      // E18: quote-agnostic (ca V3 Mint + swap). Înainte presupunea WETH-quoted (wethIsT0 + /1e18) →
      // pe stable-quoted (token/USDT pe BSC) alegea rezerva greșită → recordLp cu valoare gunoi.
      if (topic0 === MINT_V2_TOPIC) {
        const amount0 = BigInt("0x" + raw.slice(0,  64));
        const amount1 = BigInt("0x" + raw.slice(64, 128));
        const memLp   = memory.get(chain.id, pairAddress);
        const pool2Lp = watchedPoolCache.get(chain.id, pairAddress);
        const lp      = resolveLpNativeAmount(chain, pool2Lp, amount0, amount1);
        if (lp.ok) {
          recordLp(chain.id, pairAddress, true, lp.ethAmount);
          const nativeSymbol = chain.id === "bsc" ? "BNB" : "ETH";
          console.log(`[LP ADD ${chain.id}] ${memLp?.symbol} +${lp.ethAmount.toFixed(3)} ${nativeSymbol} quote=${lp.quote}`);
        }
      }

      // ── LP Burn ──────────────────────────────────────────────────────────
      // E18: quote-agnostic (ca V3 Burn + swap). Detecția de rug (LP removed %) era MOARTĂ pe stable-quoted:
      // valoarea removed era calculată presupunând WETH-quoted (rezerva greșită / 1e18) → prag niciodată atins
      // corect. Acum reutilizează resolveLpNativeAmount → native-echivalent corect indiferent de quote.
      if (topic0 === BURN_V2_TOPIC) {
        const amount0 = BigInt("0x" + raw.slice(0,  64));
        const amount1 = BigInt("0x" + raw.slice(64, 128));
        const memLp   = memory.get(chain.id, pairAddress);
        const pool2Lp = watchedPoolCache.get(chain.id, pairAddress);
        const lp      = resolveLpNativeAmount(chain, pool2Lp, amount0, amount1);
        if (!lp.ok) return;
        const ethAmount = lp.ethAmount;
        recordLp(chain.id, pairAddress, false, ethAmount);

        // E18 nit varu: valoarea e native-echivalent (BNB pe BSC, altfel ETH) — nu eticheta mereu "ETH".
        const nativeSymbol = chain.id === "bsc" ? "BNB" : "ETH";
        const poolEth    = poolLiquidity.get(chain.id, pairAddress)?.reserveEth ?? 0;
        const removedPct = poolEth > 0 ? ethAmount / poolEth : 0;

        console.log(
          `[LP REMOVE ${chain.id}] ${memLp?.symbol} -${ethAmount.toFixed(3)} ${nativeSymbol} (quote=${lp.quote})`
          + (poolEth > 0 ? ` (${(removedPct * 100).toFixed(1)}% of pool)` : " (no reserve estimate)")
          + ` ⚠️`,
        );
      }

    } catch (e) { console.log(`[WS ERR ${chain.id}]`, e); }
    finally { __wsJob(); } // PH-13: eliberează job-ul urmărit de drain (chiar și pe eroare/return timpuriu)
  });

  wsClient.on("error", (err: Error) => console.log(`[WS ${chain.id}] Error: ${err.message}`));

  wsClient.on("close", () => {
    heartbeat.stop();
    clearScopedSubsForChain(scopedSubStore, chain.id); // D3: subscripțiile mor cu socketul → stare goală
    // PH-13 (cgpt #3): dacă închidem în cadrul unui shutdown, NU reprogramăm reconnect — `close` a fost provocat de
    // `closeAllWebSockets()`, iar un socket nou reînviat ar rata drain-ul/persistarea și ar bloca ieșirea.
    if (isShuttingDown()) {
      console.log(`[WS ${chain.id}] Disconnected în timpul shutdown — fără reconnect.`);
      return;
    }
    console.log(`[WS ${chain.id}] Disconnected — programez reconnect (backoff + jitter)...`);
    wsReconnect.handleClose(chain.id); // E27: backoff + jitter + reprogramare protejată/contorizată (wsBackoff.ts)
  });
}

/**
 * PH-13 (cgpt #4): închide TOATE socket-urile WS la shutdown, ASINCRON și BOUNDED. Se cheamă DUPĂ `markShuttingDown()`.
 * Pași:
 *   1. oprește EXPLICIT toate timer-ele de reconnect/stability (un reconnect programat nu mai construiește socket nou);
 *   2. pentru fiecare socket: `close()` (FIN curat) + AȘTEAPTĂ evenimentul `close`; dacă handshake-ul nu se termină în
 *      `perSocketTimeoutMs`, cade pe `terminate()` (închidere dură). Socket-urile se închid concurent → wall-clock
 *      ≤ perSocketTimeoutMs, sub deadline-ul global de shutdown.
 * Await-ul e important: fără el, un handshake în curs putea lăsa un handler să mute memoria DUPĂ snapshot (cgpt #4).
 * Golim registrul ca un scan/health întârziat să nu mai vadă socket-uri moarte.
 */
export async function closeAllWebSockets(perSocketTimeoutMs = 2_000): Promise<void> {
  const canceledTimers = stopWsReconnectTimers();
  const sockets = [...wsClients.values()];
  wsClients.clear();
  // Adaptor la `ClosableSocket` (evită fricțiunea de tip cu supraîncărcările `once` din `ws`).
  const adapters = sockets.map(s => ({
    close:     () => s.close(),
    terminate: () => s.terminate(),
    once:      (ev: "close", cb: () => void) => { s.once(ev, cb); },
  }));
  const res = await closeSocketsBounded(adapters, {
    perSocketTimeoutMs,
    setTimer:   (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  console.log(`[WS] closeAllWebSockets — ${res.closed} socket(uri) închise (${res.terminated} terminate hard), ${canceledTimers} timer(e) de reconnect anulate.`);
}
