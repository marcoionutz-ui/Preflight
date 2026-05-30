/**
 * Supreme Trader Worker v5.15
 * P1: Multi-chain (BASE + ARB)
 * P2: Second Wave Detection
 * P3: LP Events Monitoring (Mint/Burn)
 * P5: Telegram Alerts
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient }            from "@supabase/supabase-js";
import WebSocket                   from "ws";
import { detectPhase }             from "../lib/engines/phaseDetector";
import type { Phase }              from "../lib/engines/phaseDetector";
import { checkEntryGate }          from "../lib/engines/pairMemory";
import type { PairMemoryEntry }    from "../lib/engines/pairMemory";
import { computeFlowFromTxns, NEUTRAL_FLOW, STABLE_LIQUIDITY } from "../lib/engines/flowTypes";
import type { FlowSignal, LiquiditySignal } from "../lib/engines/flowTypes";
import { detectSecondWave }        from "../lib/engines/secondWave";
import { classifyNewPool } from "../lib/engines/newPoolDetector";
import type { KnownPool }  from "../lib/engines/newPoolDetector";
import { getRedis } from "../lib/db/redis";

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL        = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TELEGRAM_TOKEN      = process.env.TELEGRAM_BOT_TOKEN  ?? "";
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID    ?? "";
const GECKO_BASE          = "https://api.geckoterminal.com/api/v2";
const SCAN_INTERVAL       = 30_000;
const MAX_SHADOW_PER_SCAN = 5;
const MIN_SEEN_COUNT      = 5;
const COOLDOWN_MS         = 2 * 60 * 60_000;
const SECOND_WAVE_COOLDOWN_MS = 60 * 60_000; // 1h cooldown pentru second wave
const MAX_HOLD_MS         = 4 * 60 * 60_000;
const WATCH_TTL_MS    = 10 * 60_000;
const FOMO_WATCH_TTL_MS = 90_000;
const MAX_FOMO_WATCH    = 5;
const MAX_ACTIVE_WATCH  = 20;
const WATCH_MIN_SCORE = 70;
const MIN_LP_REMOVE_ETH   = 0.05;  // ignoră dust burns
const INSTANT_LP_EXIT_PCT = 0.30;  // 30%+ din pool = instant exit
let ethPriceCached = 2500;
const MIN_FLOW_ETH        = 0.001;
const MIN_TOTAL_FLOW_ETH  = 0.01;
const FLOW_IMBALANCE      = 0.20;
const WORKER_VERSION      = "v5.15";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: WebSocket },
});

// ── Multi-chain Config ────────────────────────────────────────────────────────

interface ChainConfig {
  id:          string;
  gecko:       string;
  weth:        string;
  usdc:        string;
  usdcLegacy?: string;
  wsUrl:       string;
}

const CHAINS: ChainConfig[] = [
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
].filter(c => c.wsUrl || c.gecko); // include chain dacă are cel puțin gecko

// ── Types ─────────────────────────────────────────────────────────────────────

interface GeckoPool {
  id: string;
  attributes: {
    name:                    string;
    base_token_price_usd:    string;
    price_change_percentage: { m5?: string; h1?: string; h24?: string };
    reserve_in_usd:          string;
    volume_usd:              { h24: string };
    address:                 string;
    transactions?: {
      m5?: { buys: number; sells: number };
      h1?: { buys: number; sells: number };
    };
  };
  relationships: {
    base_token:   { data: { id: string } };
    quote_token?: { data: { id: string } };
    dex?:         { data: { id: string } };
  };
  _chain: ChainConfig; // adăugat de noi
}

interface SwapEvent { ts: number; isBuy: boolean; ethAmount: number; }
interface LpEvent   { ts: number; isAdd: boolean; ethAmount: number; }

// ── In-memory stores ──────────────────────────────────────────────────────────

const memory          = new Map<string, PairMemoryEntry>();
const wsFlow          = new Map<string, SwapEvent[]>();
const lpEvents        = new Map<string, LpEvent[]>();
const hotCandidates   = new Map<string, { chain: string; promotedAt: number }>();
const poolLiquidity = new Map<string, {
  reserveUsd: number;
  reserveEth: number;
  updatedAt:  number;
}>();
const activeWatch     = new Map<string, { chain: string; addedAt: number; kind?: "NORMAL" | "FOMO" }>();
const wsClients       = new Map<string, WebSocket>();
const swapSubIds       = new Map<string, string[]>();
const pendingSwapSubs  = new Map<number, string>();
let   swapSubReqId     = 10_000;
const swapSubSnapshot = new Map<string, string>();
const v3SwapSubIds = new Map<string, string>();
const v4SwapSubIds = new Map<string, string>();
const v4PoolMap = new Map<string, GeckoPool>();
const armedEntries = new Map<string, {
  armedAt:       number;
  price:         number;
  score:         number;
  flowPressure:  string;
}>();
const ARM_CONFIRM_MS        = 30_000;
const ARM_TTL_MS            = 2 * 60_000;
const ARM_MIN_PRICE_CONFIRM = 0.997;

// ── New Pool Tracker ──────────────────────────────────────────────────────────
// tokenAddress → Set<pairAddress> per chain
const tokenPools = new Map<string, Set<string>>();
const BLUECHIP_SYMBOLS = new Set(["usdc", "weth", "wbtc", "eth", "usdt", "dai", "arb", "pendle"]);

const BLOCKED_SYMBOLS = new Set([
  "usdc", "usdt", "dai", "weth", "wbtc", "eth",
  "arb", "op", "matic", "bnb", "avax", "pendle",
  "cbbtc", "cbeth", "usdbc",
]);

function isBlockedAsset(symbol: string): boolean {
  return BLOCKED_SYMBOLS.has(symbol.trim().toLowerCase());
}

function cleanEvmAddress(addr: string | undefined | null): string | null {
  if (!addr) return null;
  const raw = addr.toLowerCase().trim();
  const cleaned = raw.includes("_")
    ? raw.split("_").pop()!
    : raw.includes(":")
      ? raw.split(":").pop()!
      : raw;
  return /^0x[a-f0-9]{40}$/.test(cleaned) ? cleaned : null;
}

function isEvmAddress(addr: string | undefined | null): boolean {
  return cleanEvmAddress(addr) !== null;
}

function trackPool(tokenAddress: string, pairAddress: string, chain: string): boolean {
  const sym = memory.get(pairAddress.toLowerCase())?.symbol?.trim().toLowerCase() ?? "";
  if (BLUECHIP_SYMBOLS.has(sym)) return false; // skip tokens majori
  const key = `${chain}:${tokenAddress.toLowerCase()}`;
  const known = tokenPools.get(key) ?? new Set<string>();
  const isNew = !known.has(pairAddress.toLowerCase());
  known.add(pairAddress.toLowerCase());
  tokenPools.set(key, known);
  return isNew && known.size > 1; // true doar dacă e pool NOU pentru token cunoscut
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(msg: string): Promise<void> {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       msg,
        parse_mode: "HTML",
      }),
    });
  } catch { /* silent */ }
}

const CHAINLINK_ETH_USD           = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const CHAINLINK_LATEST_ROUND_DATA = "0xfeaf968c";

async function refreshEthPrice(): Promise<void> {
  try {
    const rpcUrl = process.env.ALCHEMY_BASE_RPC ?? process.env.ALCHEMY_ARB_RPC ?? "";
    if (!rpcUrl) {
      console.log(`[ETH PRICE] No RPC URL, using cached: $${ethPriceCached}`);
      return;
    }
    const res = await fetch(rpcUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "eth_call",
        params: [
          { to: CHAINLINK_ETH_USD, data: CHAINLINK_LATEST_ROUND_DATA },
          "latest",
        ],
      }),
    });
    const json   = await res.json();
    const result = json?.result;
    if (!result || result === "0x") throw new Error("Empty Chainlink result");
    const answerHex = "0x" + result.slice(66, 130);
    const price     = Number(BigInt(answerHex)) / 1e8;
    if (Number.isFinite(price) && price > 500) {
      ethPriceCached = price;
      console.log(`[ETH PRICE] Chainlink: $${price.toFixed(2)}`);
    }
  } catch {
    console.log(`[ETH PRICE] Using cached fallback: $${ethPriceCached}`);
  }
}

// ── Flow helpers ──────────────────────────────────────────────────────────────

function recordSwap(pairAddress: string, isBuy: boolean, ethAmount: number): void {
  const addr   = pairAddress.toLowerCase();
  const now    = Date.now();
  const events = (wsFlow.get(addr) ?? []).filter(e => now - e.ts < 5 * 60_000);
  events.push({ ts: now, isBuy, ethAmount });
  wsFlow.set(addr, events);
}

function recordLp(pairAddress: string, isAdd: boolean, ethAmount: number): void {
  const addr   = pairAddress.toLowerCase();
  const now    = Date.now();
  const events = (lpEvents.get(addr) ?? []).filter(e => now - e.ts < 5 * 60_000);
  events.push({ ts: now, isAdd, ethAmount });
  lpEvents.set(addr, events);
}

function getWsFlow(pairAddress: string): FlowSignal {
  const addr   = pairAddress.toLowerCase();
  const now    = Date.now();
  const events = (wsFlow.get(addr) ?? []).filter(e => now - e.ts < 5 * 60_000);
  if (!events.length) {
    wsFlow.delete(addr);
    return NEUTRAL_FLOW;
  }
  wsFlow.set(addr, events);
  const e1m = events.filter(e => now - e.ts < 60_000);
  const m5 = events.filter(e => e.ethAmount >= MIN_FLOW_ETH);
  const m1  = e1m.filter(e => e.ethAmount >= MIN_FLOW_ETH);

  const buyVol5m  = m5.filter(e =>  e.isBuy).reduce((s, e) => s + e.ethAmount, 0);
  const sellVol5m = m5.filter(e => !e.isBuy).reduce((s, e) => s + e.ethAmount, 0);
  const buyVol1m  = m1.filter(e =>  e.isBuy).reduce((s, e) => s + e.ethAmount, 0);
  const sellVol1m = m1.filter(e => !e.isBuy).reduce((s, e) => s + e.ethAmount, 0);

  const buyCount5m  = m5.filter(e =>  e.isBuy).length;
  const sellCount5m = m5.filter(e => !e.isBuy).length;

  const totalVol  = buyVol5m + sellVol5m;
  const netVol    = buyVol5m - sellVol5m;
  const imbalance = totalVol > 0 ? netVol / totalVol : 0;

  const pressure: "BUYING" | "SELLING" | "NEUTRAL" =
    totalVol < MIN_TOTAL_FLOW_ETH ? "NEUTRAL" :
    imbalance >  FLOW_IMBALANCE   ? "BUYING"  :
    imbalance < -FLOW_IMBALANCE   ? "SELLING" : "NEUTRAL";

  return {
    hasData:   true,
    pressure,
    buys5m:    buyCount5m,
    sells5m:   sellCount5m,
    buyVol5m:  Math.round(buyVol5m  * 1000) / 1000,
    sellVol5m: Math.round(sellVol5m * 1000) / 1000,
    netVol5m:  Math.round(netVol    * 1000) / 1000,
  } as FlowSignal;
}

function getLpSignal(pairAddress: string): LiquiditySignal {
  const addr   = pairAddress.toLowerCase();
  const events = lpEvents.get(addr) ?? [];
  if (!events.length) return STABLE_LIQUIDITY;
  const now    = Date.now();
  const e5m    = events.filter(e => now - e.ts < 5 * 60_000);
  const added  = e5m.filter(e =>  e.isAdd).reduce((s, e) => s + e.ethAmount, 0);
  const removed = e5m.filter(e => !e.isAdd).reduce((s, e) => s + e.ethAmount, 0);
  const net    = added - removed;
  const status = net > 0.01 ? "ADDED" : net < -0.01 ? "REMOVED" : "STABLE";
  return { lpAdded5m: added, lpRemoved5m: removed, lpNet5m: net, status, hasData: true };
}

function getFlow(pool: GeckoPool): FlowSignal {
  const pairAddr = cleanEvmAddress(pool.attributes.address) ?? pool.attributes.address.toLowerCase();
  const ws = getWsFlow(pairAddr);
  if (ws.hasData) return ws;
  const buys5m  = pool.attributes.transactions?.m5?.buys  ?? 0;
  const sells5m = pool.attributes.transactions?.m5?.sells ?? 0;
  if (buys5m + sells5m === 0) return NEUTRAL_FLOW;
  return computeFlowFromTxns(buys5m, sells5m);
}

function getLiquidityContext(pairAddress: string): {
  reserveUsd:  number;
  reserveEth:  number;
  freshnessMs: number | null;
  status:      "CONFIRMED" | "WEAK" | "MISSING";
} {
  const ctx = poolLiquidity.get(pairAddress.toLowerCase());
  if (!ctx) return { reserveUsd: 0, reserveEth: 0, freshnessMs: null, status: "MISSING" };

  const freshnessMs = Date.now() - ctx.updatedAt;

  if (ctx.reserveUsd >= 25_000 && freshnessMs < 5 * 60_000)
    return { ...ctx, freshnessMs, status: "CONFIRMED" };

  if (ctx.reserveUsd >= 5_000 && freshnessMs < 10 * 60_000)
    return { ...ctx, freshnessMs, status: "WEAK" };

  return { ...ctx, freshnessMs, status: "MISSING" };
}

function rebuildPoolMaps(pools: GeckoPool[]): void {
  const chainsPresent = new Set(pools.map(p => p._chain.id));
  
  // Șterge doar mapurile pentru chain-urile care au date noi
  for (const [addr, p] of v3PoolMap.entries()) {
    if (chainsPresent.has(p._chain.id)) v3PoolMap.delete(addr);
  }
  for (const [addr, p] of v4PoolMap.entries()) {
    if (chainsPresent.has(p._chain.id)) v4PoolMap.delete(addr);
  }
  
  for (const p of pools) {
    const sym   = p.attributes.name.split("/")[0]?.trim().toLowerCase() ?? "";
    if (isBlockedAsset(sym)) continue;
    const dexId = (p as any).relationships?.dex?.data?.id ?? "";
    const addr  = p.attributes.address.toLowerCase();
	if (cleanEvmAddress(p.attributes.address) !== null && V3_DEXES.has(dexId)) {
      v3PoolMap.set(addr, p);
    }
    if (p._chain.id === "base" && cleanEvmAddress(p.attributes.address) === null) {
      v4PoolMap.set(addr, p);
    }
  }
}

function getQuoteFlowAsEth(
  chain:      ChainConfig,
  baseToken:  string,
  quoteToken: string,
  amount0:    bigint,
  amount1:    bigint,
): { ok: boolean; ethAmount: number; isBuy: boolean; quote: "WETH" | "USDC" | "USDC.e" | null } {
  const base   = baseToken.toLowerCase();
  const quoteT = quoteToken.toLowerCase();
  const weth   = chain.weth.toLowerCase();
  const usdc   = chain.usdc.toLowerCase();
  const usdcLegacy = chain.usdcLegacy?.toLowerCase();
  const token0 = base < quoteT ? base : quoteT;
  const amountFor = (t: string) => t === token0 ? amount0 : amount1;

  if (base === weth || quoteT === weth) {
    const amt = amountFor(weth);
    return { ok: true, ethAmount: Number(amt < 0n ? -amt : amt) / 1e18, isBuy: amt > 0n, quote: "WETH" };
  }
  if (base === usdc || quoteT === usdc || (usdcLegacy && (base === usdcLegacy || quoteT === usdcLegacy))) {
    const stable = (base === usdc || quoteT === usdc) ? usdc : usdcLegacy!;
    const amt    = amountFor(stable);
    const usdAmt = Number(amt < 0n ? -amt : amt) / 1e6;
    return { ok: true, ethAmount: usdAmt / ethPriceCached, isBuy: amt > 0n, quote: stable === usdc ? "USDC" : "USDC.e" };
  }
  return { ok: false, ethAmount: 0, isBuy: false, quote: null };
}

// ── WebSocket per chain ───────────────────────────────────────────────────────

const SWAP_V2_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const MINT_V2_TOPIC = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
const BURN_V2_TOPIC = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";
const SWAP_V3_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V3_DEXES = new Set([
  "uniswap-v3-base",
  "aerodrome-slipstream",
  "pancakeswap-v3-base",
  "uniswap_v3_arbitrum",
  "pancakeswap-v3-arbitrum",
  "camelot-v3",
  "ramses-v3-arbitrum",
  "sushiswap_arbitrum",
]);
const v3PoolMap = new Map<string, GeckoPool>();
const UNISWAP_V4_POOL_MANAGER   = "0x498581ff718922c3f8e6a244956af099b2652b2b";
const SWAP_V4_TOPIC             = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const MODIFY_LIQUIDITY_V4_TOPIC = "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";

function int256FromWord(hex64: string): bigint {
  const x = BigInt("0x" + hex64);
  return x >= (1n << 255n) ? x - (1n << 256n) : x;
}

function cleanupActiveWatch(): void {
  const now = Date.now();
  for (const [addr, info] of activeWatch.entries()) {
    const ttl = info.kind === "FOMO" ? FOMO_WATCH_TTL_MS : WATCH_TTL_MS;
    if (now - info.addedAt > ttl) activeWatch.delete(addr);
	}
}

function clearExpiredArmedEntries(): void {
  const now = Date.now();
  for (const [addr, armed] of armedEntries.entries()) {
    if (now - armed.armedAt > ARM_TTL_MS) {
      console.log(`[ARM EXPIRE] ${addr} — confirmation window expired`);
      armedEntries.delete(addr);
    }
  }
}

function updateScopedSwap(chain: ChainConfig): void {
  const ws = wsClients.get(chain.id);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  cleanupActiveWatch();

  const openTradeAddresses = new Set<string>();
  const watchAddresses = new Set<string>();

//  for (const [addr, mem] of memory.entries()) {
//    const cleanAddr = cleanEvmAddress(addr);
//    if (!cleanAddr) continue;
//    if (mem.totalEntries > 0 && Date.now() - mem.lastEntryTime < MAX_HOLD_MS) {
//     openTradeAddresses.add(cleanAddr);
//    }
//  }
  for (const [addr, info] of activeWatch.entries()) {
    const cleanAddr = cleanEvmAddress(addr);
    if (!cleanAddr) continue;
    if (info.chain === chain.id) watchAddresses.add(cleanAddr);
  }

  const addrList = [
    ...openTradeAddresses,
    ...[...watchAddresses].sort().filter(a => !openTradeAddresses.has(a)),
  ].slice(0, 20);

  if (addrList.length === 0) {
    const oldIds = swapSubIds.get(chain.id) ?? [];
    if (oldIds.length) {
      for (const oldId of oldIds) {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "eth_unsubscribe", params: [oldId] }));
      }
      swapSubIds.delete(chain.id);
      swapSubSnapshot.delete(chain.id);
      console.log(`[WS] Scoped SWAP cleared (${chain.id})`);
    }
    return;
  }

  const snapshot = addrList.join(",");
  if (swapSubSnapshot.get(chain.id) === snapshot) return;
  swapSubSnapshot.set(chain.id, snapshot);

  const oldIds = swapSubIds.get(chain.id) ?? [];
  for (const oldId of oldIds) {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "eth_unsubscribe", params: [oldId] }));
  }
  swapSubIds.delete(chain.id);

  for (const addr of addrList) {
    const reqId = swapSubReqId++;
    pendingSwapSubs.set(reqId, chain.id);
    ws.send(JSON.stringify({
      jsonrpc: "2.0", id: reqId,
      method: "eth_subscribe",
      params: ["logs", { address: addr, topics: [SWAP_V2_TOPIC] }],
    }));
  }

  console.log(`[WS] Scoped SWAP updated: ${addrList.length} pair subscriptions requested (${chain.id})`);
}

function subscribeV3Scoped(chain: ChainConfig): void {
  const ws = wsClients.get(chain.id);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const addrs = [...activeWatch.entries()]
    .filter(([addr, info]) => info.chain === chain.id && v3PoolMap.has(addr))
    .map(([addr]) => addr)
    .slice(0, 20);

  if (!addrs.length) {
    const oldId = v3SwapSubIds.get(chain.id);
    if (oldId) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 51, method: "eth_unsubscribe", params: [oldId] }));
      v3SwapSubIds.delete(chain.id);
      v3SwapSubIds.delete(chain.id + "_snap");
      console.log(`[V3] Unsubscribed — nothing in watch`);
    }
    return;
  }

  const snapshot = addrs.join(",");
  if (v3SwapSubIds.get(chain.id + "_snap") === snapshot) return;
  v3SwapSubIds.set(chain.id + "_snap", snapshot);

  const oldId = v3SwapSubIds.get(chain.id);
  if (oldId) {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 51, method: "eth_unsubscribe", params: [oldId] }));
  }
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 7,
    method: "eth_subscribe",
    params: ["logs", { address: addrs, topics: [SWAP_V3_TOPIC] }],
  }));
  console.log(`[V3] Scoped subscribe: ${addrs.length} watched pools`);
}

function subscribeV4Scoped(chain: ChainConfig): void {
  const ws = wsClients.get(chain.id);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const poolIds = [...activeWatch.entries()]
    .filter(([addr, info]) => info.chain === chain.id && v4PoolMap.has(addr))
    .map(([addr]) => addr)
    .slice(0, 50);

  if (!poolIds.length) {
    const oldId = v4SwapSubIds.get(chain.id);
    if (oldId) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 50, method: "eth_unsubscribe", params: [oldId] }));
      v4SwapSubIds.delete(chain.id);
      v4SwapSubIds.delete(chain.id + "_snap");
      console.log(`[V4] Unsubscribed — nothing in watch`);
    }
    return;
  }

  const snapshot = poolIds.join(",");
  if (v4SwapSubIds.get(chain.id + "_snap") === snapshot) return;
  v4SwapSubIds.set(chain.id + "_snap", snapshot);

  const oldId = v4SwapSubIds.get(chain.id);
  if (oldId) {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 50, method: "eth_unsubscribe", params: [oldId] }));
  }
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 5,
    method: "eth_subscribe",
    params: ["logs", { address: UNISWAP_V4_POOL_MANAGER, topics: [SWAP_V4_TOPIC, poolIds] }],
  }));
  console.log(`[V4] Scoped subscribe: ${poolIds.length} watched pools`);
}

function connectChainWebSocket(chain: ChainConfig): void {
  if (!chain.wsUrl) {
    console.log(`[WS] No WS URL for ${chain.id} — flow layer disabled for this chain`);
    return;
  }

  const wsClient = new WebSocket(chain.wsUrl);
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
    setTimeout(() => subscribeV4Scoped(chain), 2500);
    setTimeout(() => subscribeV3Scoped(chain), 3000);
  });

  wsClient.on("message", async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
	 if (msg.id === 5 || msg.id === 6 || msg.id === 7) {
        if (msg.id === 5 && msg.result) v4SwapSubIds.set(chain.id, msg.result);
        if (msg.id === 7 && msg.result) v3SwapSubIds.set(chain.id, msg.result);
        console.log(`[V3/V4 SUB DEBUG] ${data.toString()}`);
        return;
      }
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
	    if (pool && !memV4) console.log(`[V4 NO MEM] poolId=${poolId} pool=${pool.attributes.name}`);
		  return;
		}

        const amount0 = int256FromWord(raw4.slice(0,  64));
        const amount1 = int256FromWord(raw4.slice(64, 128));

        const baseToken    = pool.relationships.base_token.data.id.replace(`${chain.id}_`, "").toLowerCase();
        const quoteToken   = pool.relationships.quote_token?.data.id?.replace(`${chain.id}_`, "").toLowerCase() ?? "";
        if (!quoteToken) {
           console.log(`[V4 SKIP] ${memV4.symbol} missing quote token for poolId=${poolId}`);
           return;
         }

        const qflow4 = getQuoteFlowAsEth(chain, baseToken, quoteToken, amount0, amount1);
        if (!qflow4.ok) {
          console.log(`[V4 SKIP] ${memV4.symbol} no WETH/USDC side base=${baseToken} quote=${quoteToken}`);
          return;
        }
        const ethAmount = qflow4.ethAmount;
        const isBuy     = qflow4.isBuy;

        if (ethAmount > 0) {
          recordSwap(poolId, isBuy, ethAmount);
          console.log(
           `[V4 SWAP] ${memV4.symbol} ${isBuy ? "BUY" : "SELL"} `
            + `quote=${qflow4.quote} eth=${ethAmount.toFixed(4)} `
            + `amount0=${amount0} amount1=${amount1} `
            + `base=${baseToken} quoteToken=${quoteToken} tx=${log4.transactionHash}`
          );

          if (isBuy && ethAmount >= 0.005) {
            const flow = getWsFlow(poolId);
            if (flow.hasData && flow.pressure === "BUYING" && flow.buys5m >= 5) {
              if (!hotCandidates.has(poolId)) {
                hotCandidates.set(poolId, { chain: chain.id, promotedAt: Date.now() });
              }
            }
          }
        }
        return;
      }

      // ── V4 ModifyLiquidity (log-only) ────────────────────────────────────
      if (chain.id === "base" && msg.params?.result?.topics?.[0] === MODIFY_LIQUIDITY_V4_TOPIC) {
        const log4   = msg.params.result;
        const poolId = log4.topics?.[1]?.toLowerCase();
        console.log(`[V4 LIQ RAW] poolId=${poolId} data=${log4.data?.slice(0, 258)} tx=${log4.transactionHash}`);
        return;
      }

	  // ── V3 Swap ──────────────────────────────────────────────────────────
      if (msg.params?.result?.topics?.[0] === SWAP_V3_TOPIC) {
        const log3       = msg.params.result;
        const pairAddr3  = log3.address?.toLowerCase();
        const pool3      = v3PoolMap.get(pairAddr3);
        const mem3       = memory.get(pairAddr3);
        if (!pool3 || !mem3) return;
        if (isBlockedAsset(mem3.symbol)) return;
        const raw3 = log3.data?.slice(2) ?? "";
        if (raw3.length < 128) return;
        const amount0  = int256FromWord(raw3.slice(0,  64));
        const amount1  = int256FromWord(raw3.slice(64, 128));
        const base3    = pool3.relationships.base_token.data.id.replace(`${chain.id}_`, "").toLowerCase();
        const quote3   = pool3.relationships.quote_token?.data.id?.replace(`${chain.id}_`, "").toLowerCase() ?? "";
        const qflow3 = getQuoteFlowAsEth(chain, base3, quote3, amount0, amount1);
        if (!qflow3.ok) return;
        const ethAmount = qflow3.ethAmount;
        const isBuy     = qflow3.isBuy;
        if (ethAmount > 0) {
          recordSwap(pairAddr3, isBuy, ethAmount);
          console.log(`[V3 SWAP] ${mem3.symbol} ${isBuy ? "BUY" : "SELL"} quote=${qflow3.quote} eth=${ethAmount.toFixed(4)} tx=${log3.transactionHash}`);
          if (isBuy && ethAmount >= 0.005) {
            const flow3 = getWsFlow(pairAddr3);
            if (flow3.hasData && flow3.pressure === "BUYING" && flow3.buys5m >= 5) {
              if (!hotCandidates.has(pairAddr3)) hotCandidates.set(pairAddr3, { chain: chain.id, promotedAt: Date.now() });
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

      // ── Swap Event ──────────────────────────────────────────────────────
      if (topic0 === SWAP_V2_TOPIC && raw.length >= 256) {
        const amount0In  = BigInt("0x" + raw.slice(0,   64));
        const amount1In  = BigInt("0x" + raw.slice(64,  128));
        const amount0Out = BigInt("0x" + raw.slice(128, 192));
        const amount1Out = BigInt("0x" + raw.slice(192, 256));

        if (amount0In === 0n && amount1In === 0n) return;

        const mem          = memory.get(pairAddress)!;
        const tokenAddr    = mem.tokenAddress.replace(`${chain.id}_`, "").toLowerCase();
        const wethIsToken0 = chain.weth.toLowerCase() < tokenAddr;

        let isBuy: boolean;
        let ethAmount: number;
        if (wethIsToken0) {
          isBuy     = amount0In > 0n && amount1Out > 0n;
          ethAmount = Number(isBuy ? amount0In : amount1In) / 1e18;
        } else {
          isBuy     = amount1In > 0n && amount0Out > 0n;
          ethAmount = Number(isBuy ? amount1In : amount0In) / 1e18;
        }
        recordSwap(pairAddress, isBuy, ethAmount);

        // Promovează în hotCandidates dacă buy pressure e puternică
        if (isBuy) {
          const flow = getWsFlow(pairAddress);
          if (flow.hasData && flow.pressure === "BUYING" && flow.buys5m >= 5) {
            if (!hotCandidates.has(pairAddress)) {
              hotCandidates.set(pairAddress, { chain: chain.id, promotedAt: Date.now() });
            }
          }
        }
      }

      // ── LP Mint Event (liquidity added) ─────────────────────────────────
      if (topic0 === MINT_V2_TOPIC) {
        const amount0      = BigInt("0x" + raw.slice(0,  64));
        const amount1      = BigInt("0x" + raw.slice(64, 128));
        const memLp        = memory.get(pairAddress);
        const tokenAddrLp  = memLp?.tokenAddress.replace(`${chain.id}_`, "").toLowerCase() ?? "";
        const wethIsToken0 = chain.weth.toLowerCase() < tokenAddrLp;
        const ethAmount    = Number(wethIsToken0 ? amount0 : amount1) / 1e18;
        recordLp(pairAddress, true, ethAmount);
        console.log(`[LP ADD] ${memLp?.symbol} +${ethAmount.toFixed(3)} ETH`);
      }

      // ── LP Burn Event (liquidity removed) ───────────────────────────────
      if (topic0 === BURN_V2_TOPIC) {
        const amount0      = BigInt("0x" + raw.slice(0,  64));
        const amount1      = BigInt("0x" + raw.slice(64, 128));
        const memLp        = memory.get(pairAddress);
        const tokenAddrLp  = memLp?.tokenAddress.replace(`${chain.id}_`, "").toLowerCase() ?? "";
        const wethIsToken0 = chain.weth.toLowerCase() < tokenAddrLp;
        const ethAmount    = Number(wethIsToken0 ? amount0 : amount1) / 1e18;
        recordLp(pairAddress, false, ethAmount);
        const poolEth    = poolLiquidity.get(pairAddress)?.reserveEth ?? 0;
const removedPct = poolEth > 0 ? ethAmount / poolEth : 0;

console.log(
  `[LP REMOVE] ${memLp?.symbol} -${ethAmount.toFixed(3)} ETH`
  + (poolEth > 0 ? ` (${(removedPct * 100).toFixed(1)}% of pool)` : " (no reserve estimate)")
  + ` ⚠️`
);

if (!poolEth) {
  // Nu putem calcula procentul, skip instant exit
} else if (ethAmount >= MIN_LP_REMOVE_ETH && removedPct >= INSTANT_LP_EXIT_PCT) {
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

      const mem = memory.get(pairAddress);
      if (mem) {
        mem.badExits24h      += 1;
        mem.consecutiveLosses += 1;
        mem.lastExitReason    = "LP REMOVED";
        mem.lastExitTime      = Date.now();
      }

      console.log(`[LP EXIT INSTANT] ${trade.symbol} — ${ethAmount.toFixed(3)} ETH (${(removedPct * 100).toFixed(1)}%) removed`);
      await sendTelegram(
        `⚡ <b>LP EXIT INSTANT</b> ${trade.symbol} [${chain.id.toUpperCase()}]\n`
        + `LP removed ${ethAmount.toFixed(3)} ETH (${(removedPct * 100).toFixed(1)}% of pool)\n`
        + `P&L: ${((exitPrice - entry) / entry * 100).toFixed(1)}%`
      );
    }
  }
}
      }

    } catch { /* silent */ }
  });

  wsClient.on("error", (err: Error) => console.log(`[WS ${chain.id}] Error: ${err.message}`));

  wsClient.on("close", () => {
    clearInterval(pingInterval);
    v4SwapSubIds.delete(chain.id);
    v4SwapSubIds.delete(chain.id + "_snap");
    v3SwapSubIds.delete(chain.id);
    v3SwapSubIds.delete(chain.id + "_snap");
    console.log(`[WS ${chain.id}] Disconnected — reconnecting in 5s...`);
    setTimeout(() => connectChainWebSocket(chain), 5_000);
  });
}

function updatePoolLiquidity(addr: string, pool: GeckoPool): void {
  const reserveUsd = Number(pool.attributes.reserve_in_usd ?? 0);
  if (reserveUsd > 0) {
    poolLiquidity.set(addr.toLowerCase(), {
      reserveUsd,
      reserveEth: reserveUsd / 2 / ethPriceCached,
      updatedAt:  Date.now(),
    });
  }
}

// ── Pair Memory ───────────────────────────────────────────────────────────────

function updateMemory(pool: GeckoPool, price: number): PairMemoryEntry {
  const addr         = cleanEvmAddress(pool.attributes.address) ?? pool.attributes.address.toLowerCase();
  const symbol       = pool.attributes.name.split("/")[0]?.trim() ?? "?";
  const tokenAddress = pool.relationships.base_token.data.id ?? "";
  const now          = Date.now();
  const m5           = Number(pool.attributes.price_change_percentage?.m5  ?? 0);
  const h24          = Number(pool.attributes.price_change_percentage?.h24 ?? 0);

  const existing = memory.get(addr);
  if (!existing) {
    const mem: PairMemoryEntry = {
      pairAddress: addr, symbol, tokenAddress,
      firstSeen: now, lastSeen: now, seenCount: 1,
      priceAtFirstSeen: price, highPrice: price, lowPrice: price, currentPrice: price,
      totalEntries: 0, lastEntryTime: 0, lastEntryPrice: 0,
      wins24h: 0, losses24h: 0, badExits24h: 0, consecutiveLosses: 0,
      lastExitReason: null, lastExitTime: null,
      phase: detectPhase({
        seenCount: 1, consecutiveLosses: 0, m5, h24,
        highPrice: price, lowPrice: price, currentPrice: price,
        totalEntries: 0, wins24h: 0, losses24h: 0, badExits24h: 0,
      }),
    };
    memory.set(addr, mem);
    updatePoolLiquidity(addr, pool);
    return mem;
  }

  existing.lastSeen      = now;
  existing.seenCount    += 1;
  existing.currentPrice  = price;
  existing.tokenAddress  = tokenAddress;
  if (price > existing.highPrice) existing.highPrice = price;
  if (price < existing.lowPrice)  existing.lowPrice  = price;

  existing.phase = detectPhase({
    seenCount: existing.seenCount, consecutiveLosses: existing.consecutiveLosses,
    m5, h24,
    highPrice: existing.highPrice, lowPrice: existing.lowPrice, currentPrice: price,
    totalEntries: existing.totalEntries, wins24h: existing.wins24h, losses24h: existing.losses24h, badExits24h: existing.badExits24h,
  });

  memory.set(addr, existing);
  updatePoolLiquidity(addr, pool);
  return existing;
}

async function loadPairStats(): Promise<void> {
  const { data: trades } = await supabase
    .from("shadow_trades")
    .select("pair_address, symbol, token_address, entry_price, exit_reason, exited_at, created_at, current_price")
    .gte("timestamp", Date.now() - 24 * 3600_000);

  if (!trades) return;

  for (const t of trades) {
    const addr = t.pair_address?.toLowerCase();
    if (!addr) continue;

    if (!memory.has(addr)) {
      const ep = Number(t.entry_price);
      const cp = Number(t.current_price || t.entry_price);
      memory.set(addr, {
        pairAddress: addr, symbol: t.symbol?.trim() ?? "?",
        tokenAddress: t.token_address ?? "",
        firstSeen: new Date(t.created_at).getTime(),
        lastSeen:  new Date(t.created_at).getTime(),
        seenCount: 0, priceAtFirstSeen: ep,
        highPrice: cp, lowPrice: ep, currentPrice: cp,
        totalEntries: 0, lastEntryTime: 0, lastEntryPrice: ep,
        wins24h: 0, losses24h: 0, badExits24h: 0, consecutiveLosses: 0,
        lastExitReason: null, lastExitTime: null, phase: "TRENDING",
      });
    }

    const mem = memory.get(addr)!;
    mem.totalEntries  += 1;
    mem.lastEntryTime  = Math.max(mem.lastEntryTime, new Date(t.created_at).getTime());
    mem.lastEntryPrice = Number(t.entry_price);

    if (t.exit_reason === "TP1 hit") {
      mem.wins24h += 1; mem.consecutiveLosses = 0;
      mem.lastExitReason = "TP1 hit"; mem.lastExitTime = t.exited_at;
    } else if (t.exit_reason === "SL hit") {
      mem.losses24h += 1; mem.consecutiveLosses += 1;
      mem.lastExitReason = "SL hit"; mem.lastExitTime = t.exited_at;
    } else if (
      t.exit_reason === "MAX HOLD" ||
      t.exit_reason === "SELL PRESSURE" ||
      t.exit_reason === "LP REMOVED" ||
      t.exit_reason === "RUGPULL"
    ) {
      mem.badExits24h += 1;
      mem.lastExitReason = t.exit_reason;
      mem.lastExitTime   = t.exited_at;
    }
  }

  console.log(`[MEMORY] Loaded ${memory.size} pairs from last 24h`);
}

async function saveMemoryToRedis(): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;

    const memoryObj: Record<string, PairMemoryEntry> = {};
    for (const [addr, mem] of memory.entries()) memoryObj[addr] = mem;

    const reserveObj: Record<string, number> = {};
    for (const [addr, liqCtx] of poolLiquidity.entries()) reserveObj[addr] = liqCtx.reserveEth;

    await r.set(
      `supreme:worker_snapshot:latest`,
      JSON.stringify({
        version:       WORKER_VERSION,
        savedAt:       Date.now(),
        memory:        memoryObj,
        poolReserveEth: reserveObj,
      }),
      "EX", 24 * 60 * 60
    );
    console.log(`[REDIS] Worker snapshot saved: ${memory.size} pairs, ${poolLiquidity.size} reserves`);
  } catch {
    console.log(`[REDIS] Snapshot save failed`);
  }
}

async function loadMemoryFromRedis(): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = getRedis();
      if (!r) return;

      const raw = await r.get("supreme:worker_snapshot:latest");
      if (!raw) return;

      const snap = JSON.parse(raw) as {
        version?:        string;
        savedAt?:        number;
        memory?:         Record<string, PairMemoryEntry>;
        poolReserveEth?: Record<string, number>;
      };

      let count = 0;
      for (const [addr, mem] of Object.entries(snap.memory ?? {})) {
        memory.set(addr, mem);
        count++;
        const chainPrefix = mem.tokenAddress.split("_")[0] ?? "";
        const rawToken    = mem.tokenAddress.includes("_")
          ? mem.tokenAddress.split("_")[1]
          : mem.tokenAddress;
        const tokenKey1 = `${chainPrefix}:${mem.tokenAddress.toLowerCase()}`;
        const tokenKey2 = `${chainPrefix}:${rawToken.toLowerCase()}`;
        if (!tokenPools.has(tokenKey1)) tokenPools.set(tokenKey1, new Set());
        tokenPools.get(tokenKey1)!.add(addr);
        if (!tokenPools.has(tokenKey2)) tokenPools.set(tokenKey2, new Set());
        tokenPools.get(tokenKey2)!.add(addr);
      }

      for (const [addr, eth] of Object.entries(snap.poolReserveEth ?? {})) {
        const val = Number(eth);
        if (Number.isFinite(val) && val > 0) {
          poolLiquidity.set(addr, {
            reserveUsd: val * 2 * ethPriceCached,
            reserveEth: val,
            updatedAt:  snap.savedAt ?? Date.now(),
          });
        }
      }

      console.log(`[REDIS] Worker snapshot loaded: ${count} pairs, ${poolLiquidity.size} reserves`);
      return;

    } catch (e) {
      console.log(`[REDIS] Snapshot load attempt ${attempt}/5 failed: ${e}`);
      if (attempt < 5) await new Promise(res => setTimeout(res, attempt * 1000));
    }
  }
  console.log(`[REDIS] Snapshot load gave up after 5 attempts`);
}

// ── Anti-FOMO ─────────────────────────────────────────────────────────────────

function checkFOMO(pool: GeckoPool): { blocked: boolean; reason: string | null } {
  const h24 = Number(pool.attributes.price_change_percentage?.h24 ?? 0);
  const m5  = Number(pool.attributes.price_change_percentage?.m5  ?? 0);

  if (m5  > 30)  return { blocked: true, reason: `+${m5.toFixed(0)}% in 5m — vertical candle` };
  if (h24 > 500) return { blocked: true, reason: `+${h24.toFixed(0)}% in 24h — extremely late` };
  if (h24 > 200) return { blocked: true, reason: `+${h24.toFixed(0)}% in 24h — likely pumped` };

  return { blocked: false, reason: null };
}

// ── Edge Score ────────────────────────────────────────────────────────────────

function quickEdgeScore(
  pool: GeckoPool,
  mem:  PairMemoryEntry,
  flow: FlowSignal,
  lp:   LiquiditySignal,
): number {
  let score = 50;

  const reserveUsd = Number(pool.attributes.reserve_in_usd ?? 0);
  const vol24h     = Number(pool.attributes.volume_usd?.h24 ?? 0);
  const h24        = Number(pool.attributes.price_change_percentage?.h24 ?? 0);
  const m5         = Number(pool.attributes.price_change_percentage?.m5  ?? 0);
  const h1         = Number(pool.attributes.price_change_percentage?.h1  ?? 0);

 // Liquidity
  if      (reserveUsd > 100_000) score += 15;
  else if (reserveUsd >  50_000) score += 10;
  else if (reserveUsd >  25_000) score +=  5;
  else                           score -= 15;

  // Volume
  if      (vol24h > 500_000) score += 10;
  else if (vol24h > 100_000) score +=  5;
  else if (vol24h <  20_000) score -= 10;

  // h24 sweet spot
  if      (h24 > 10 && h24 < 80)   score += 15;
  else if (h24 >= 80 && h24 < 150) score +=  5;
  else if (h24 >= 150)             score -= 15;
  else if (h24 < 0)                score -= 10;

  // 5m momentum
  if      (m5 > 3 && m5 < 15) score += 10;
  else if (m5 >= 15)           score -= 10;
  else if (m5 < -5)            score -=  5;

  // 1h confirmare
  if      (h1 > 5 && h1 < 30) score += 10;
  else if (h1 >= 30)           score -=  5;
  else if (h1 < -10)           score -= 10;

  // Flow WS
  if (flow.hasData) {
    if (flow.pressure === "BUYING")  score += 15;
    if (flow.pressure === "SELLING") score -= 20;
  }

  // LP event (schimbare recentă)
  if (lp.hasData) {
    if (lp.status === "ADDED")   score += 12;
    if (lp.status === "REMOVED") score -= 25;
 }

  // Liquidity context (sănătate curentă)
  const liq = getLiquidityContext(mem.pairAddress);
  if      (liq.status === "CONFIRMED") score += 5;
  else if (liq.status === "WEAK")      score -= 10;
  else if (liq.status === "MISSING")   score -= 30;

  // Phase memory
  if (mem.phase === "SECOND_WAVE") score += 20;
  if (mem.phase === "RECOVERING")  score -= 30;
  if (mem.wins24h >= 2)            score += 10;
  if (mem.losses24h > mem.wins24h && mem.losses24h > 2) score -= 15;
  if (mem.consecutiveLosses >= 3)  score -= 20;
  if (mem.seenCount > 100) score -= 15;
  if      (mem.seenCount > 50 && mem.totalEntries === 0) score -= 35;
  else if (mem.seenCount > 25 && mem.totalEntries === 0) score -= 25;
  else if (mem.seenCount > 15 && mem.wins24h === 0)      score -= 20;

  // History penalty — include badExits24h (MAX HOLD / SELL PRESSURE / LP REMOVED)
  const exitedCount = mem.wins24h + mem.losses24h + mem.badExits24h;
  const winRate     = exitedCount > 0 ? mem.wins24h / exitedCount : 0.5;
  if      (exitedCount >= 5 && mem.wins24h === 0)  score -= 40;
  else if (exitedCount >= 5 && winRate < 0.20)      score -= 25;
  else if (exitedCount >= 8 && winRate < 0.30)      score -= 15;
  if (mem.badExits24h >= 3 && mem.wins24h === 0)    score -= 20;

  // Second wave bonus
  const sw = detectSecondWave(mem, flow, m5, h1);
  if (sw.isSecondWave) {
    score += Math.round(sw.score * 0.15); // max +15 bonus
  }

  return Math.max(0, Math.min(100, score));
}

// ── Evidence Score ────────────────────────────────────────────────────────────

function computeEvidenceScore(mem: PairMemoryEntry, flow: FlowSignal, lp: LiquiditySignal): number {
  let score = 0;

  // Apariții în scan-uri
  if (mem.seenCount >= 5) score += 3;
  else if (mem.seenCount >= 3) score += 2;
  else if (mem.seenCount >= 2) score += 1;

  // Flow WS real
  if (flow.hasData) {
    if (flow.pressure === "BUYING")  score += 3;
    if (flow.pressure === "NEUTRAL") score += 1;
    if (flow.pressure === "SELLING") score -= 3;
    if (flow.buys5m >= 8)  score += 1;
    if (flow.sells5m > flow.buys5m) score -= 1;
  }

  // LP signal
  if (lp.hasData) {
    if (lp.status === "ADDED")   score += 2;
    if (lp.status === "STABLE")  score += 1;
    if (lp.status === "REMOVED") score -= 5;
  }

  // Phase
  if (mem.phase === "SECOND_WAVE") score += 2;
  if (mem.phase === "RECOVERING" && mem.seenCount <= 25) score += 1;
  if (mem.phase === "RECOVERING" && mem.seenCount > 50)  score -= 1;
  if (mem.phase === "PUMPING")     score -= 1;
  if (mem.phase === "DEAD")        score -= 5;
  if (mem.phase === "ZOMBIE")      score -= 3;

  // History
  if (mem.wins24h >= 2)            score += 1;
  if (mem.consecutiveLosses >= 2)  score -= 2;

  return score;
}

// ── Should enter? ─────────────────────────────────────────────────────────────

function getEntryGate(mem: PairMemoryEntry, flow: FlowSignal, lp: LiquiditySignal, score: number) {
  const liq = getLiquidityContext(mem.pairAddress);
  if (liq.status === "MISSING") {
    return { allowed: false, reason: "missing liquidity context — skip" };
  }

  const isV4 = mem.pairAddress.length === 66;
  const isV3 = !isV4 && v3PoolMap.has(mem.pairAddress);
  const sw   = detectSecondWave(mem, flow);

  if ((isV3 || isV4) && liq.status !== "CONFIRMED") {
    return { allowed: false, reason: `V3/V4 liq not confirmed (${liq.status}, $${Math.round(liq.reserveUsd/1000)}K)` };
  }

  if (lp.hasData && lp.status === "REMOVED") {
    return { allowed: false, reason: `LP removed (${lp.lpRemoved5m.toFixed(3)} ETH in 5m)` };
  }

  const buyVol  = (flow as any).buyVol5m ?? 0;
  const netVol  = (flow as any).netVol5m ?? 0;
  if (flow.pressure === "BUYING" && buyVol < 0.05) {
    return { allowed: false, reason: `buy volume too low (${buyVol.toFixed(3)} ETH)` };
  }
  if ((isV3 || isV4) && flow.pressure === "BUYING" && netVol < 0.05) {
    return { allowed: false, reason: `V3/V4 net buy volume too low (${netVol.toFixed(3)} ETH)` };
  }

  // Un singur whale nu e trend
  if (flow.pressure === "BUYING" && flow.buys5m < 3) {
    return { allowed: false, reason: `single buyer pattern (${flow.buys5m} buys/5m, need 3)` };
  }

  // Piață unilaterală — zero sell-uri = spike fără rezistență reală
  const sellVol   = (flow as any).sellVol5m ?? 0;
  const sellRatio = buyVol > 0 ? sellVol / buyVol : 0;
  const isLargeConfirmedPool = liq.status === "CONFIRMED" && liq.reserveUsd >= 100_000;
	if (!isLargeConfirmedPool && flow.pressure === "BUYING" && (sellVol < 0.01 || sellRatio < 0.03)) {
		return { allowed: false, reason: `one-sided spike — sell ratio ${(sellRatio * 100).toFixed(1)}% (min 3%)` };
	}

  // RECOVERING hard block — excepție doar pentru second wave confirmat
  if (mem.phase === "RECOVERING" && !(sw.isSecondWave && sw.confidence !== "LOW")) {
    return { allowed: false, reason: `RECOVERING phase blocked (historically negative, not confirmed 2W)` };
  }

  // Token cu history pur de bad exits — niciodată un winner
  if (mem.badExits24h >= 2 && mem.wins24h === 0 && mem.losses24h === 0) {
    return { allowed: false, reason: `bad exits only (${mem.badExits24h} bad, 0 wins/losses)` };
  }

  // RECOVERING pe V3/V4 cere participare mai puternică
  if ((isV3 || isV4) && mem.phase === "RECOVERING" && flow.buys5m < 5) {
    return { allowed: false, reason: `RECOVERING needs stronger participation (${flow.buys5m}/5 buys)` };
  }

  const chainPrefix = mem.tokenAddress.split("_")[0] ?? "";
  const rawToken    = mem.tokenAddress.includes("_")
    ? mem.tokenAddress.split("_").slice(1).join("_")
    : mem.tokenAddress;
  const poolCount =
    tokenPools.get(`${chainPrefix}:${mem.tokenAddress.toLowerCase()}`)?.size ??
    tokenPools.get(`${chainPrefix}:${rawToken.toLowerCase()}`)?.size ??
    1;
  if (poolCount >= 5) {
    return { allowed: false, reason: `too many pools for token (${poolCount}) — clone/fragmentation risk` };
  }

 if (mem.seenCount > 40 && mem.totalEntries === 0) {
    return { allowed: false, reason: `stale with no history (seen ${mem.seenCount}x, never entered)` };
  }

  const evidence = computeEvidenceScore(mem, flow, lp);
  
  if (hotCandidates.has(mem.pairAddress.toLowerCase())) {
    if (mem.seenCount < 2)          return { allowed: false, reason: `HOT but too new (seen ${mem.seenCount}x, need 2)` };
    if (evidence < 7)               return { allowed: false, reason: `HOT but evidence too low (${evidence}/7)` };
    if (flow.pressure !== "BUYING") return { allowed: false, reason: `HOT but flow not BUYING` };
    return checkEntryGate(mem, flow, 2, SECOND_WAVE_COOLDOWN_MS);
  }

  if (sw.isSecondWave && sw.confidence !== "LOW") {
    if (mem.seenCount < 3)  return { allowed: false, reason: `2W but too new (seen ${mem.seenCount}x, need 3)` };
    if (evidence < 9)       return { allowed: false, reason: `2W but evidence too low (${evidence}/9)` };
    return checkEntryGate(mem, flow, 3, SECOND_WAVE_COOLDOWN_MS);
  }

  const requiredEvidence = 6;

  if (mem.seenCount < 3)           return { allowed: false, reason: `too new (seen ${mem.seenCount}x, need 3)` };
  if (evidence < requiredEvidence) return { allowed: false, reason: `evidence too low (${evidence}/${requiredEvidence})` };

  if (isV4 && score < 90)      return { allowed: false, reason: `V4 score too low (${score}/90)` };
  if (isV4 && flow.buys5m < 5) return { allowed: false, reason: `V4 flow weak (${flow.buys5m} buys/5m)` };

  return checkEntryGate(mem, flow, 3, COOLDOWN_MS);
}

// ── Fetch trending + new pools ────────────────────────────────────────────────

async function fetchTrending(chain: ChainConfig): Promise<GeckoPool[]> {
  try {
    const res1   = await fetch(`${GECKO_BASE}/networks/${chain.gecko}/trending_pools?page=1`);
    await new Promise(r => setTimeout(r, 600));
    const res2   = await fetch(`${GECKO_BASE}/networks/${chain.gecko}/trending_pools?page=2`);
    await new Promise(r => setTimeout(r, 600));
    const resNew = await fetch(`${GECKO_BASE}/networks/${chain.gecko}/new_pools?page=1`);

    const d1   = res1.ok   ? await res1.json()   : { data: [] };
    const d2   = res2.ok   ? await res2.json()   : { data: [] };
    const dNew = resNew.ok ? await resNew.json() : { data: [] };

    const seen = new Set<string>();
    const allRaw = [...(d1.data ?? []), ...(d2.data ?? []), ...(dNew.data ?? [])];
    const deduped = allRaw.filter((p: any) => {
      const addr = p.attributes?.address?.toLowerCase();
      if (!addr || seen.has(addr)) return false;
      seen.add(addr);
      return true;
    });

    const pools: GeckoPool[] = deduped.map((p: any) => ({ ...p, _chain: chain }));
  
    console.log(`[FETCH] ${chain.id}: ${pools.length} pools (trend p1+p2 + new)`);
    return pools;
  } catch {
    return [];
  }
}
 
async function fetchDexScreener(chain: ChainConfig): Promise<GeckoPool[]> {
  try {
    const chainName = chain.id === "base" ? "base" : "arbitrum";
    const res = await fetch(
      `https://api.dexscreener.com/token-profiles/latest/v1`,
      { headers: { "Accept": "application/json" } }
    );
    if (!res.ok) return [];
    const data = await res.json();

    const filtered = (Array.isArray(data) ? data : [])
      .filter((p: any) => p.chainId === chainName && p.url)
      .slice(0, 20);

    if (!filtered.length) return [];

    const pairAddresses = filtered
      .map((p: any) => p.tokenAddress)
      .filter(Boolean)
      .join(",");

    const res2 = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${pairAddresses}`
    );
    if (!res2.ok) return [];
    const data2 = await res2.json();

    const pairs = (data2.pairs ?? []).filter((p: any) => p.chainId === chainName);

    return pairs.map((p: any): GeckoPool => ({
      id: p.pairAddress,
      attributes: {
        name:                    `${p.baseToken?.symbol ?? "?"}/${p.quoteToken?.symbol ?? "?"}`,
        base_token_price_usd:    p.priceUsd ?? "0",
        price_change_percentage: {
          m5:  String(p.priceChange?.m5  ?? 0),
          h1:  String(p.priceChange?.h1  ?? 0),
          h24: String(p.priceChange?.h24 ?? 0),
        },
        reserve_in_usd: String(p.liquidity?.usd ?? 0),
        volume_usd:     { h24: String(p.volume?.h24 ?? 0) },
        address:        p.pairAddress,
        transactions: {
          m5: { buys: p.txns?.m5?.buys ?? 0, sells: p.txns?.m5?.sells ?? 0 },
          h1: { buys: p.txns?.h1?.buys ?? 0, sells: p.txns?.h1?.sells ?? 0 },
        },
      },
      relationships: {
        base_token:  { data: { id: `${chainName}_${p.baseToken?.address ?? ""}` } },
        quote_token: { data: { id: `${chainName}_${p.quoteToken?.address ?? ""}` } },
        dex:         { data: { id: p.dexId ?? "" } },
      },
      _chain: chain,
    }));
  } catch {
    return [];
  }
}

async function fetchPoolByAddress(chain: ChainConfig, pairAddress: string): Promise<GeckoPool | null> {
  try {
    const res = await fetch(`${GECKO_BASE}/networks/${chain.gecko}/pools/${pairAddress}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.data) return null;
    return { ...json.data, _chain: chain };
  } catch { return null; }
}

// ── Save FOMO block ───────────────────────────────────────────────────────────

async function saveFOMOBlock(pool: GeckoPool, reason: string): Promise<void> {
  const symbol = pool.attributes.name.split("/")[0]?.trim() ?? "?";

  const { data: existing } = await supabase
    .from("fomo_blocks").select("id")
    .eq("pair_address", pool.attributes.address)
    .gte("timestamp", Date.now() - 60 * 60_000)
    .limit(1);

  if (existing && existing.length > 0) return;

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  await supabase.from("fomo_blocks").insert({
    id, timestamp: Date.now(), symbol,
    worker_version:            WORKER_VERSION,
    chain:                     pool._chain.id,
    pair_address:              pool.attributes.address,
    price_at_block:            Number(pool.attributes.base_token_price_usd),
    price_change_24h_at_block: Number(pool.attributes.price_change_percentage?.h24 ?? 0),
    reason,
  });

  console.log(`[FOMO] ${symbol} (${pool._chain.id}) — ${reason}`);
}

// ── Save shadow trade ─────────────────────────────────────────────────────────

async function saveShadowTrade(
  pool:  GeckoPool,
  score: number,
  mem:   PairMemoryEntry,
  flow:  FlowSignal,
  lp:    LiquiditySignal,
): Promise<void> {
  const pairAddr = cleanEvmAddress(pool.attributes.address) ?? pool.attributes.address.toLowerCase();

  const { data: existing } = await supabase
    .from("shadow_trades")
    .select("id")
    .eq("pair_address", pairAddr)
    .is("exited_at", null)
    .limit(1);

  if (existing?.length) {
    console.log(`[DUPLICATE BLOCK] ${mem.symbol} already has open shadow trade`);
    return;
  }
  const isV4note = pairAddr.length === 66;
  const isV3note = !isV4note && v3PoolMap.has(pairAddr.toLowerCase());
  const dexType  = isV4note ? "V4" : isV3note ? "V3" : "V2";
  const price    = mem.currentPrice;
  const id       = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const sw       = detectSecondWave(mem, flow);

  const liq = getLiquidityContext(pairAddr);

  const note = [
    `WORKER ${WORKER_VERSION}`,
    `dex:${dexType}`,
    `Edge ${score}`,
    `seen:${mem.seenCount}x`,
    `phase:${mem.phase}`,
    `flow:${flow.pressure}`,
    `buyVol:${((flow as any).buyVol5m ?? 0).toFixed(3)}ETH`,
    `sellVol:${((flow as any).sellVol5m ?? 0).toFixed(3)}ETH`,
    `netVol:${((flow as any).netVol5m ?? 0).toFixed(3)}ETH`,
	`sellRatio:${(((flow as any).sellVol5m ?? 0) / Math.max((flow as any).buyVol5m ?? 0.001, 0.001) * 100).toFixed(1)}%`,
    `lpEvent:${lp.hasData ? lp.status : "NONE"}`,
    `liq:${liq.status}`,
    `reserve:$${Math.round(liq.reserveUsd / 1000)}K`,
    sw.isSecondWave ? `2W:${sw.score}` : null,
    `W${mem.wins24h}/L${mem.losses24h}`,
  ].filter(Boolean).join(" | ");

  await supabase.from("shadow_trades").insert({
    id, timestamp: Date.now(),
    symbol:         mem.symbol,
    worker_version: WORKER_VERSION,
    chain:          pool._chain.id,
    pair_address:  pairAddr,
    token_address: mem.tokenAddress,
    entry_price:   price, current_price: price,
    edge_score:    score, flag_count: 0, note,
    sl:  price * (1 - (score >= 80 ? 0.15 : 0.18)),
    tp1: price * (!flow.hasData ? 1.10 : flow.pressure === "BUYING" ? 1.25 : flow.pressure === "NEUTRAL" ? 1.12 : flow.pressure === "SELLING" ? 1.08 : 1.15),
    tp2: price * (score >= 80 ? 2.00 : 1.75),
    tp3: price * (score >= 80 ? 4.00 : 3.00),
  });

  mem.totalEntries += 1; mem.lastEntryTime = Date.now(); mem.lastEntryPrice = price;
  memory.set(pairAddr, mem);

  const emoji = mem.phase === "SECOND_WAVE" ? "🌊" : mem.phase === "RECOVERING" ? "⚡" : "👁";
  const msg = `${emoji} <b>SHADOW</b> ${mem.symbol} [${pool._chain.id.toUpperCase()}]\n`
    + `Edge ${score} | ${mem.phase} | flow:${flow.pressure}\n`
    + `LP: ${lp.hasData ? lp.status : "unknown"} | W${mem.wins24h}/L${mem.losses24h}\n`
    + (sw.isSecondWave ? `🌊 Second Wave ${sw.score}/100 (${sw.confidence})\n` : "")
    + `seen:${mem.seenCount}x`;

  console.log(`[SHADOW] ${mem.symbol} (${pool._chain.id}) Edge ${score} | ${mem.phase} | flow:${flow.pressure} | lp:${lp.status}`);
  await sendTelegram(msg);
}

// ── Update outcomes ───────────────────────────────────────────────────────────

async function updateOutcomes(pools: GeckoPool[]): Promise<void> {
 const priceMap = new Map<string, number>();
  pools.forEach(p => {
    const key = cleanEvmAddress(p.attributes.address) ?? p.attributes.address.toLowerCase();
    priceMap.set(key, Number(p.attributes.base_token_price_usd));
  });

  // FOMO blocks
  const { data: blocks } = await supabase
    .from("fomo_blocks").select("*")
    .is("outcome_1h_price", null)
    .gte("timestamp", Date.now() - 24 * 3600_000);

  if (blocks) {
    for (const b of blocks) {
      const price = priceMap.get(b.pair_address?.toLowerCase());
      if (!price || Date.now() - b.timestamp < 60 * 60_000) continue;
      const pct = (price - b.price_at_block) / b.price_at_block * 100;
      await supabase.from("fomo_blocks").update({
        outcome_1h_price: price, outcome_1h_pct: pct, outcome_1h_ts: Date.now(),
      }).eq("id", b.id);
    }
  }

  // Shadow trades
  const { data: trades } = await supabase
    .from("shadow_trades").select("*").is("exited_at", null);

  if (!trades) return;

  for (const trade of trades) {
    const price = priceMap.get(trade.pair_address?.toLowerCase());
    if (!price) continue;

    const ageMs                           = Date.now() - trade.timestamp;
    const flow                            = getWsFlow(trade.pair_address);
    const lp                              = getLpSignal(trade.pair_address);
    const update: Record<string, unknown> = { current_price: price };
    const mem                             = memory.get(trade.pair_address?.toLowerCase());
	const entry                           = Number(trade.entry_price);
    const priceDrop                       = (entry - price) / entry;

    // 1. LP removed — WS a prins event-ul, exit imediat fără age limit
    if (lp.hasData && lp.status === "REMOVED" && lp.lpRemoved5m > 0.5) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "LP REMOVED";
      if (mem) { mem.badExits24h += 1; mem.consecutiveLosses += 1; mem.lastExitReason = "LP REMOVED"; mem.lastExitTime = Date.now(); }
      console.log(`[LP EXIT] ${trade.symbol} — LP removed ${lp.lpRemoved5m.toFixed(3)} ETH`);
      await sendTelegram(`⚠️ <b>LP REMOVED</b> ${trade.symbol} [${trade.chain?.toUpperCase()}]\n`
        + `LP removed ${lp.lpRemoved5m.toFixed(3)} ETH in 5m\n`
        + `P&L: ${((price - entry) / entry * 100).toFixed(1)}%`);

    // 2. Rugpull — preț -90%+ fără LP event
    } else if (priceDrop > 0.90) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "RUGPULL";
      if (mem) { mem.badExits24h += 1; mem.consecutiveLosses += 1; mem.lastExitReason = "RUGPULL"; mem.lastExitTime = Date.now(); }
      console.log(`[RUGPULL] ${trade.symbol} — price dropped ${(priceDrop * 100).toFixed(0)}%`);
      await sendTelegram(`☠️ <b>RUGPULL</b> ${trade.symbol} [${trade.chain?.toUpperCase()}]\n`
        + `Price dropped ${(priceDrop * 100).toFixed(0)}%\n`
        + `Entry: ${entry.toExponential(3)} → Exit: ${price.toExponential(3)}`);

    // 3. TP1
    } else if (price >= trade.tp1) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "TP1 hit";
      if (mem) { mem.wins24h += 1; mem.consecutiveLosses = 0; mem.lastExitReason = "TP1 hit"; mem.lastExitTime = Date.now(); }
      await sendTelegram(`🟢 <b>TP1 HIT</b> ${trade.symbol} [${trade.chain?.toUpperCase()}]\n`
        + `Entry: ${entry.toExponential(3)} → Exit: ${price.toExponential(3)}\n`
        + `P&L: +${((price - entry) / entry * 100).toFixed(1)}%`);

    // 4. SL normal
    } else if (price <= trade.sl) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "SL hit";
      if (mem) { mem.losses24h += 1; mem.consecutiveLosses += 1; mem.lastExitReason = "SL hit"; mem.lastExitTime = Date.now(); }
      await sendTelegram(`🔴 <b>SL HIT</b> ${trade.symbol} [${trade.chain?.toUpperCase()}]\n`
        + `Entry: ${entry.toExponential(3)} → Exit: ${price.toExponential(3)}\n`
        + `P&L: ${((price - entry) / entry * 100).toFixed(1)}%`);

    // 5. Sell pressure
    } else if (flow.hasData && flow.pressure === "SELLING" && ((flow as any).sellVol5m ?? 0) >= 0.05 && ((flow as any).netVol5m ?? 0) <= -0.05 && ageMs > 15 * 60_000 && price <= entry) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "SELL PRESSURE";
      if (mem) { mem.badExits24h += 1; mem.lastExitReason = "SELL PRESSURE"; mem.lastExitTime = Date.now(); }
      console.log(`[FLOW EXIT] ${trade.symbol} — sellVol:${((flow as any).sellVol5m ?? 0).toFixed(3)} netVol:${((flow as any).netVol5m ?? 0).toFixed(3)}`);

    // 6. Max hold
    } else if (ageMs > MAX_HOLD_MS) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "MAX HOLD";
      if (mem) { mem.badExits24h += 1; mem.lastExitReason = "MAX HOLD"; mem.lastExitTime = Date.now(); }
      console.log(`[ZOMBIE KILL] ${trade.symbol} held 4h with no exit`);
      await sendTelegram(`💀 <b>ZOMBIE KILL</b> ${trade.symbol} — held 4h, no exit`);
    }

    await supabase.from("shadow_trades").update(update).eq("id", trade.id);
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scan(): Promise<void> {
  const ts = new Date().toISOString();
  cleanupActiveWatch();
  clearExpiredArmedEntries();

  // Fetch toate chain-urile în paralel
  const allPoolsPerChain = await Promise.all(CHAINS.map(c => fetchTrending(c)));
  const dexPools         = await Promise.all(CHAINS.map(c => fetchDexScreener(c)));

  const seenInScan = new Set<string>();
  const allPools = [...allPoolsPerChain.flat(), ...dexPools.flat()].filter(p => {
    const addr = `${p._chain.id}:${p.attributes.address?.toLowerCase()}`;
    if (!addr || seenInScan.has(addr)) return false;
    seenInScan.add(addr);
    return true;
  });

  if (!allPools.length) { console.log("No pools fetched"); return; }
  rebuildPoolMaps(allPools);

  console.log(`[${ts}] Scanning ${CHAINS.map(c => c.id).join("+")} — ${allPools.length} pools total`);

  await updateOutcomes(allPools);

  let shadowCount = 0;
  let fomoBlockCount = 0;
  let fomoWatchAddedCount = 0;
  let fomoNoSlotCount = 0;
  let fomoLowScoreCount = 0;
  let fomoNoDexCount = 0;
  const chainCounts: Record<string, number> = {};

  for (const pool of allPools) {
    const price = Number(pool.attributes.base_token_price_usd);
    if (!price || isNaN(price)) continue;

   const mem  = updateMemory(pool, price);
  const pairAddr = cleanEvmAddress(pool.attributes.address) ?? pool.attributes.address.toLowerCase();

    if (isBlockedAsset(mem.symbol)) continue;

	// New pool detection
	const tokenAddr  = pool.relationships.base_token.data.id?.toLowerCase() ?? "";
	const isNewPool  = tokenAddr ? trackPool(tokenAddr, pool.attributes.address, pool._chain.id) : false;

	if (isNewPool) {
	  const knownPools: KnownPool[] = [...(tokenPools.get(`${pool._chain.id}:${tokenAddr}`) ?? [])]
		.filter(pa => pa !== pool.attributes.address.toLowerCase())
		.map(pa => ({ pairAddress: pa, liquidityUsd: 0 }));

	  const sig = classifyNewPool(
		tokenAddr, mem.symbol, pool._chain.id,
		pool.attributes.address,
		Number(pool.attributes.reserve_in_usd ?? 0),
		knownPools,
	  );

	  if (sig.classification !== "LOW_LIQ_NOISE" && sig.classification !== "CLONE_RISK") {
		console.log(`[NEW POOL] ${mem.symbol} (${pool._chain.id}) — ${sig.classification} | $${(sig.newLiquidityUsd/1000).toFixed(1)}K liq | score:${sig.score}`);
		await sendTelegram(
		  `🆕 <b>NEW POOL</b> ${mem.symbol} [${pool._chain.id.toUpperCase()}]\n`
		  + `${sig.classification}\n`
		  + `Lichiditate: $${(sig.newLiquidityUsd/1000).toFixed(1)}K\n`
		  + sig.reasons.join("\n")
		);
	  }
}
    const wsFlowReal = getWsFlow(pairAddr);
	const flow       = getFlow(pool);
	const lp         = getLpSignal(pairAddr);
	const isV3pool   = v3PoolMap.has(pairAddr);
	const isV4pool   = v4PoolMap.has(pairAddr);
    const fomo       = checkFOMO(pool);
	
	const prelScore = quickEdgeScore(pool, mem, flow, lp);
    if (fomo.blocked && fomo.reason) {
      await saveFOMOBlock(pool, fomo.reason);
	  fomoBlockCount++;

      const sw2      = detectSecondWave(mem, wsFlowReal);
      const m5f      = Number(pool.attributes.price_change_percentage?.m5  ?? 0);
      const h1f      = Number(pool.attributes.price_change_percentage?.h1  ?? 0);
      const buyVolF  = (wsFlowReal as any).buyVol5m  ?? 0;
      const netVolF  = (wsFlowReal as any).netVol5m  ?? 0;
      const sellVolF = (wsFlowReal as any).sellVol5m ?? 0;

      const currentFomoWatch = [...activeWatch.values()].filter(w => w.kind === "FOMO").length;
	  const h24f = Number(pool.attributes.price_change_percentage?.h24 ?? 0);
   	  const reserveUsdF = Number(pool.attributes.reserve_in_usd ?? 0);
	  if (!wsFlowReal.hasData && !activeWatch.has(pairAddr)) {
	  if (currentFomoWatch >= MAX_FOMO_WATCH) fomoNoSlotCount++;
	  else if (prelScore < 75) fomoLowScoreCount++;
	  else if (!(isV3pool || isV4pool)) fomoNoDexCount++;
	}
	  const fomoWatchable =
		!wsFlowReal.hasData &&
		!activeWatch.has(pairAddr) &&
		currentFomoWatch < MAX_FOMO_WATCH &&
		prelScore >= 60 &&
		reserveUsdF >= 8_000 &&
		(isV3pool || isV4pool) &&
		(
		(m5f > 30 && m5f < 150 && h24f < 500) ||
		(h24f > 200 && h24f < 800 && m5f < 30)
		);
		if (fomoWatchable) {
		  activeWatch.set(pairAddr, { chain: pool._chain.id, addedAt: Date.now(), kind: "FOMO" });
		  fomoWatchAddedCount++;
		  console.log(`[FOMO WATCH] ${mem.symbol} (${pool._chain.id}) — tracking after block: ${fomo.reason}`);
		}	  

      const lateSecondWave =
        wsFlowReal.hasData &&
        wsFlowReal.pressure === "BUYING" &&
        sw2.isSecondWave &&
        sw2.confidence !== "LOW" &&
        m5f  >  3 &&
        h1f  > 10 &&
        buyVolF  >= 0.20 &&
        netVolF  >= 0.15 &&
        sellVolF >= 0.01;

      if (!lateSecondWave) continue;

      console.log(
        `[LATE 2W] ${mem.symbol} (${pool._chain.id}) — FOMO exception: ${fomo.reason}`
        + ` | m5:${m5f.toFixed(1)} h1:${h1f.toFixed(1)}`
        + ` | buyVol:${buyVolF.toFixed(3)} netVol:${netVolF.toFixed(3)} sellVol:${sellVolF.toFixed(3)}`
      );
    }
		
	if (
	  prelScore >= WATCH_MIN_SCORE &&
	  !wsFlowReal.hasData &&
	  !activeWatch.has(pairAddr) &&
	  activeWatch.size < MAX_ACTIVE_WATCH &&
	  (isV3pool || isV4pool)
	) {
	  activeWatch.set(pairAddr, {
		chain:   pool._chain.id,
		addedAt: Date.now(),
		kind:    "NORMAL",
	  });
	  console.log(`[WATCH] ${mem.symbol} (${pool._chain.id}) — added, prelScore ${prelScore}`);
	}

	if (!wsFlowReal.hasData) {
	  console.log(`[WATCH WAIT] ${mem.symbol} (${pool._chain.id}) — waiting for scoped WS flow`);
	  continue;
	}

    if (shadowCount >= MAX_SHADOW_PER_SCAN) continue;

    const score = quickEdgeScore(pool, mem, wsFlowReal, lp);
    if (score < 80) {
      console.log(`[LOW SCORE] ${mem.symbol} (${pool._chain.id}) score=${score} flow=${wsFlowReal.pressure} liq=${getLiquidityContext(pairAddr).status}`);
      continue;
    }

	const gate = getEntryGate(mem, wsFlowReal, lp, score);
	if (!gate.allowed) {
	  console.log(`[SKIP] ${mem.symbol} (${pool._chain.id}) — ${gate.reason}`);
	  armedEntries.delete(pairAddr);
	  continue;
	}

	const armed = armedEntries.get(pairAddr);

	if (!armed) {
	  armedEntries.set(pairAddr, {
		armedAt:      Date.now(),
		price,
		score,
		flowPressure: wsFlowReal.pressure,
	  });
	  console.log(
		`[ARMED] ${mem.symbol} (${pool._chain.id}) — waiting confirmation`
		+ ` price:${price.toExponential(4)} score:${score}`
		+ ` flow:${wsFlowReal.pressure} net:${((wsFlowReal as any).netVol5m ?? 0).toFixed(3)}ETH`
	  );
	  continue;
	}

	if (Date.now() - armed.armedAt < ARM_CONFIRM_MS) {
	  console.log(`[ARM WAIT] ${mem.symbol} (${pool._chain.id}) — confirmation pending`);
	  continue;
	}

	if (price < armed.price * ARM_MIN_PRICE_CONFIRM) {
	  console.log(`[ARM SKIP] ${mem.symbol} (${pool._chain.id}) — price failed confirmation ${price.toExponential(4)} < ${armed.price.toExponential(4)}`);
	  armedEntries.delete(pairAddr);
	  continue;
	}

	if (!wsFlowReal.hasData || wsFlowReal.pressure !== "BUYING") {
	  console.log(`[ARM SKIP] ${mem.symbol} (${pool._chain.id}) — flow faded (${wsFlowReal.pressure})`);
	  armedEntries.delete(pairAddr);
	  continue;
	}

	const currentNetVol = (wsFlowReal as any).netVol5m ?? 0;
	if (currentNetVol < 0.05) {
	  console.log(`[ARM SKIP] ${mem.symbol} (${pool._chain.id}) — netVol faded ${currentNetVol.toFixed(3)}ETH`);
	  armedEntries.delete(pairAddr);
	  continue;
	}

	console.log(
	  `[ARM CONFIRMED] ${mem.symbol} (${pool._chain.id}) — entering`
	  + ` armed:${armed.price.toExponential(4)} now:${price.toExponential(4)}`
	  + ` net:${currentNetVol.toFixed(3)}ETH`
	);
	armedEntries.delete(pairAddr);

	await saveShadowTrade(pool, score, mem, wsFlowReal, lp);
    shadowCount++;
    chainCounts[pool._chain.id] = (chainCounts[pool._chain.id] ?? 0) + 1;
    }

  const vals = [...memory.values()];
  const chainStr = Object.entries(chainCounts).map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(
    `[${ts}] Done — shadows:${shadowCount} [${chainStr || "none"}]`
    + ` | mem:${memory.size} | ws:${wsFlow.size}`
    + ` | zombies:${vals.filter(m => m.phase === "ZOMBIE").length}`
    + ` | dead:${vals.filter(m => m.phase === "DEAD").length}`
    + ` | 2wave:${vals.filter(m => m.phase === "SECOND_WAVE").length}`
    + ` | recovering:${vals.filter(m => m.phase === "RECOVERING").length}`
  );   

  // Redis snapshot — pair states pentru UI instant
  try {
    const r = getRedis();
    if (r) {
      const states: Record<string, object> = {};
      for (const [addr, mem] of memory.entries()) {
        const flow = getWsFlow(addr);
        const lp   = getLpSignal(addr);
        states[addr] = {
          symbol:            mem.symbol,
          phase:             mem.phase,
          seenCount:         mem.seenCount,
          totalEntries:      mem.totalEntries,
          wins24h:           mem.wins24h,
          losses24h:         mem.losses24h,
          badExits24h:       mem.badExits24h,
          consecutiveLosses: mem.consecutiveLosses,
          currentPrice:      mem.currentPrice,
          lastEntryTime:     mem.lastEntryTime,
          flow: {
            pressure:  flow.pressure,
            buys5m:    flow.buys5m,
            sells5m:   flow.sells5m,
            hasData:   flow.hasData,
            buyVol5m:  (flow as any).buyVol5m  ?? 0,
            sellVol5m: (flow as any).sellVol5m ?? 0,
            netVol5m:  (flow as any).netVol5m  ?? 0,
          },
          lp: {
            status:  lp.status,
            lpNet5m: lp.lpNet5m,
            hasData: lp.hasData,
          },
          updatedAt: Date.now(),
        };
      }
      await r.set("supreme:pair_states", JSON.stringify(states), "EX", 120);
      console.log(`[REDIS] Wrote ${Object.keys(states).length} pair states`);
    }
  } catch { /* Redis optional — workerul merge fără */ }
//  CHAINS.forEach(c => updateScopedSwap(c));
  CHAINS.forEach(c => subscribeV4Scoped(c));
  CHAINS.forEach(c => subscribeV3Scoped(c));
  console.log(
	  `[FOMO SUMMARY] blocked:${fomoBlockCount} watched:${fomoWatchAddedCount}`
	  + ` noSlot:${fomoNoSlotCount} lowScore:${fomoLowScoreCount} noDex:${fomoNoDexCount}`
	);
  console.log(`[WATCH] Active: ${activeWatch.size} pairs`);
  await saveMemoryToRedis();
}

// ── Hot candidates loop ───────────────────────────────────────────────────────

let processingHotCandidates = false;

async function hotCandidatesLoop(): Promise<void> {
  if (processingHotCandidates || !hotCandidates.size) return;
  processingHotCandidates = true;

  try {
    for (const [pairAddress, { chain: chainId, promotedAt }] of hotCandidates.entries()) {
      if (Date.now() - promotedAt > 5 * 60_000) {
        hotCandidates.delete(pairAddress); continue;
      }

      const chainCfg = CHAINS.find(c => c.id === chainId);
      if (!chainCfg) { hotCandidates.delete(pairAddress); continue; }

      const mem = memory.get(pairAddress);
      if (!mem) { hotCandidates.delete(pairAddress); continue; }
      if (isBlockedAsset(mem.symbol)) { hotCandidates.delete(pairAddress); continue; }

      const flow = getWsFlow(pairAddress);
      const lp   = getLpSignal(pairAddress);

      // Dacă pressure s-a stins între timp, nu mai intra
      if (!flow.hasData || flow.pressure !== "BUYING" || flow.buys5m < 5) {
        hotCandidates.delete(pairAddress); continue;
      }
	  
	  // HOT trebuie să fie deja armat de scan
      const armed = armedEntries.get(pairAddress);
      if (!armed) { hotCandidates.delete(pairAddress); continue; }
      if (mem.currentPrice < armed.price * ARM_MIN_PRICE_CONFIRM) {
        console.log(`[HOT SKIP] ${mem.symbol} — price dropped vs armed`);
        hotCandidates.delete(pairAddress); continue;
      }

      // Nu duplica dacă există deja trade deschis
      const { data: existing } = await supabase
		.from("shadow_trades")
		.select("id")
		.eq("pair_address", pairAddress)
		.is("exited_at", null)
		.limit(1);

      if (existing?.length) { hotCandidates.delete(pairAddress); continue; }

      // Date reale înainte de orice decizie
      const pool = v4PoolMap.get(pairAddress) ?? v3PoolMap.get(pairAddress) ?? await fetchPoolByAddress(chainCfg, pairAddress);
      if (!pool) { hotCandidates.delete(pairAddress); continue; }

      const fomo = checkFOMO(pool);
      if (fomo.blocked) { hotCandidates.delete(pairAddress); continue; }

      const score = quickEdgeScore(pool, mem, flow, lp);
      if (score < 80) { hotCandidates.delete(pairAddress); continue; }

      const gate = getEntryGate(mem, flow, lp, score);
      if (!gate.allowed) { hotCandidates.delete(pairAddress); continue; }

      console.log(`[HOT] ${mem.symbol} (${chainId}) — promoted by WS, Edge ${score}`);
      await saveShadowTrade(pool, score, mem, flow, lp);
      hotCandidates.delete(pairAddress);
    }
  } finally {
    processingHotCandidates = false;
  }
}

// ── Monitor open trades ───────────────────────────────────────────────────────

let monitoringOpenTrades = false;

async function monitorOpenTrades(): Promise<void> {
  if (monitoringOpenTrades) return;
  monitoringOpenTrades = true;

  try {
    const { data: trades } = await supabase
      .from("shadow_trades")
      .select("id, chain, pair_address")
      .is("exited_at", null);

    if (!trades?.length) return;

    const pools: GeckoPool[] = [];

    for (const trade of trades) {
      if (!trade.chain || !trade.pair_address) continue;
      const chainCfg = CHAINS.find(c => c.id === trade.chain || c.gecko === trade.chain);
      if (!chainCfg) continue;
      const pool = v4PoolMap.get(trade.pair_address.toLowerCase())
        ?? v3PoolMap.get(trade.pair_address.toLowerCase())
        ?? await fetchPoolByAddress(chainCfg, trade.pair_address);
      if (pool) pools.push(pool);
    }

    if (pools.length) {
      await updateOutcomes(pools);
      console.log(`[MONITOR] Checked ${pools.length} open trades`);
    }
  } finally {
    monitoringOpenTrades = false;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

console.log(`Supreme Trader Worker ${WORKER_VERSION} starting...`);
console.log(`Chains: ${CHAINS.map(c => c.id).join(", ")}`);

// Conectează WS pentru fiecare chain
CHAINS.forEach(c => connectChainWebSocket(c));

loadPairStats().then(async () => {
  await refreshEthPrice();
  await loadMemoryFromRedis();
  setInterval(refreshEthPrice, 60 * 60_000);
  setInterval(saveMemoryToRedis, 60_000);    // ← save la fiecare minut
  scan();
  setInterval(scan, SCAN_INTERVAL);
  setInterval(monitorOpenTrades, 10_000);
  setInterval(hotCandidatesLoop, 3_000);
});