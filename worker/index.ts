/**
 * Supreme Trader Worker v3 — Shared Engines + WebSocket Flow
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient }         from "@supabase/supabase-js";
import WebSocket                from "ws";
import { detectPhase }          from "../lib/engines/phaseDetector";
import type { Phase }           from "../lib/engines/phaseDetector";
import { checkEntryGate }       from "../lib/engines/pairMemory";
import type { PairMemoryEntry } from "../lib/engines/pairMemory";
import { computeFlowFromTxns, NEUTRAL_FLOW } from "../lib/engines/flowTypes";
import type { FlowSignal }      from "../lib/engines/flowTypes";

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL        = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY        = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const ALCHEMY_BASE_WS     = process.env.ALCHEMY_BASE_WS ?? "";
const GECKO_BASE          = "https://api.geckoterminal.com/api/v2";
const SCAN_INTERVAL       = 30_000;
const MAX_SHADOW_PER_SCAN = 5;
const MIN_SEEN_COUNT      = 5;
const COOLDOWN_MS         = 2 * 60 * 60_000; // 2h
const MAX_HOLD_MS         = 4 * 60 * 60_000; // 4h

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: WebSocket },
});

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
      m5?:  { buys: number; sells: number };
      h1?:  { buys: number; sells: number };
    };
  };
  relationships: { base_token: { data: { id: string } } };
}

interface SwapEvent {
  ts:        number;
  isBuy:     boolean;
  ethAmount: number;
}

// ── In-memory stores ──────────────────────────────────────────────────────────

const memory   = new Map<string, PairMemoryEntry>();
const wsFlow   = new Map<string, SwapEvent[]>(); // WS swap events per pair

// ── WS Flow helpers ───────────────────────────────────────────────────────────

function recordSwap(pairAddress: string, isBuy: boolean, ethAmount: number): void {
  const addr   = pairAddress.toLowerCase();
  const now    = Date.now();
  const events = (wsFlow.get(addr) ?? []).filter(e => now - e.ts < 5 * 60_000);
  events.push({ ts: now, isBuy, ethAmount });
  wsFlow.set(addr, events);
}

function getWsFlow(pairAddress: string): FlowSignal {
  const addr   = pairAddress.toLowerCase();
  const events = wsFlow.get(addr) ?? [];
  if (!events.length) return NEUTRAL_FLOW;

  const now    = Date.now();
  const e1m    = events.filter(e => now - e.ts < 60_000);
  const e5m    = events.filter(e => now - e.ts < 5 * 60_000);

  return computeFlowFromTxns(
    e5m.filter(e =>  e.isBuy).length,
    e5m.filter(e => !e.isBuy).length,
    e1m.filter(e =>  e.isBuy).length,
    e1m.filter(e => !e.isBuy).length,
  );
}

// Merge WS flow cu txns data din Gecko (WS are prioritate)
function getFlow(pool: GeckoPool): FlowSignal {
  const ws = getWsFlow(pool.attributes.address);
  if (ws.hasData) return ws;

  // Fallback: txns din Gecko API dacă WS nu are date încă
  const buys5m  = pool.attributes.transactions?.m5?.buys  ?? 0;
  const sells5m = pool.attributes.transactions?.m5?.sells ?? 0;
  const buys1h  = pool.attributes.transactions?.h1?.buys  ?? 0;
  const sells1h = pool.attributes.transactions?.h1?.sells ?? 0;

  if (buys5m + sells5m === 0 && buys1h + sells1h === 0) return NEUTRAL_FLOW;

  return computeFlowFromTxns(buys5m, sells5m);
}

// ── WebSocket — Alchemy BASE ──────────────────────────────────────────────────

const SWAP_V2_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const WETH_BASE     = "0x4200000000000000000000000000000000000006";

function connectWebSocket(): void {
  if (!ALCHEMY_BASE_WS) {
    console.log("[WS] ALCHEMY_BASE_WS not set — flow layer disabled");
    return;
  }

  const wsClient = new WebSocket(ALCHEMY_BASE_WS);

  wsClient.on("open", () => {
    console.log("[WS] Connected to Alchemy BASE");
    wsClient.send(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method:  "eth_subscribe",
      params:  ["logs", { topics: [SWAP_V2_TOPIC] }],
    }));
  });

  wsClient.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.params?.result) return;

      const log         = msg.params.result;
      const pairAddress = log.address?.toLowerCase();
      if (!pairAddress || !memory.has(pairAddress)) return;

      const raw = log.data?.slice(2);
      if (!raw || raw.length < 256) return;

      const amount0In  = BigInt("0x" + raw.slice(0,   64));
      const amount1In  = BigInt("0x" + raw.slice(64,  128));
      const amount0Out = BigInt("0x" + raw.slice(128, 192));
      const amount1Out = BigInt("0x" + raw.slice(192, 256));

      if (amount0In === 0n && amount1In === 0n) return;

      const mem       = memory.get(pairAddress)!;
      const tokenAddr = mem.tokenAddress.replace("base_", "").toLowerCase();
      // WETH < tokenAddr → WETH este token0
      const wethIsToken0 = WETH_BASE.toLowerCase() < tokenAddr;

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
    } catch { /* silent */ }
  });

  wsClient.on("error", (err: Error) => console.log(`[WS] Error: ${err.message}`));

  wsClient.on("close", () => {
    console.log("[WS] Disconnected — reconnecting in 5s...");
    setTimeout(connectWebSocket, 5_000);
  });
}

// ── Pair Memory ───────────────────────────────────────────────────────────────

function updateMemory(pool: GeckoPool, price: number): PairMemoryEntry {
  const addr         = pool.attributes.address.toLowerCase();
  const symbol       = pool.attributes.name.split("/")[0]?.trim() ?? "?";
  const tokenAddress = pool.relationships.base_token.data.id ?? "";
  const now          = Date.now();

  const m5  = Number(pool.attributes.price_change_percentage?.m5  ?? 0);
  const h24 = Number(pool.attributes.price_change_percentage?.h24 ?? 0);

  const existing = memory.get(addr);

  if (!existing) {
    const mem: PairMemoryEntry = {
      pairAddress: addr, symbol, tokenAddress,
      firstSeen: now, lastSeen: now, seenCount: 1,
      priceAtFirstSeen: price, highPrice: price, lowPrice: price, currentPrice: price,
      totalEntries: 0, lastEntryTime: 0, lastEntryPrice: 0,
      wins24h: 0, losses24h: 0, consecutiveLosses: 0,
      lastExitReason: null, lastExitTime: null,
      phase: detectPhase({
        seenCount: 1, consecutiveLosses: 0, m5, h24,
        highPrice: price, lowPrice: price, currentPrice: price,
        totalEntries: 0, wins24h: 0, losses24h: 0,
      }),
    };
    memory.set(addr, mem);
    return mem;
  }

  existing.lastSeen      = now;
  existing.seenCount    += 1;
  existing.currentPrice  = price;
  existing.tokenAddress  = tokenAddress;
  if (price > existing.highPrice) existing.highPrice = price;
  if (price < existing.lowPrice)  existing.lowPrice  = price;

  existing.phase = detectPhase({
    seenCount:         existing.seenCount,
    consecutiveLosses: existing.consecutiveLosses,
    m5, h24,
    highPrice:    existing.highPrice,
    lowPrice:     existing.lowPrice,
    currentPrice: price,
    totalEntries: existing.totalEntries,
    wins24h:      existing.wins24h,
    losses24h:    existing.losses24h,
  });

  memory.set(addr, existing);
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
        wins24h: 0, losses24h: 0, consecutiveLosses: 0,
        lastExitReason: null, lastExitTime: null, phase: "TRENDING",
      });
    }

    const mem = memory.get(addr)!;
    mem.totalEntries  += 1;
    mem.lastEntryTime  = Math.max(mem.lastEntryTime, new Date(t.created_at).getTime());
    mem.lastEntryPrice = Number(t.entry_price);

    if (t.exit_reason === "TP1 hit") {
      mem.wins24h += 1;
      mem.consecutiveLosses = 0;
      mem.lastExitReason    = "TP1 hit";
      mem.lastExitTime      = t.exited_at;
    } else if (t.exit_reason === "SL hit") {
      mem.losses24h         += 1;
      mem.consecutiveLosses += 1;
      mem.lastExitReason     = "SL hit";
      mem.lastExitTime       = t.exited_at;
    }
  }

  console.log(`[MEMORY] Loaded ${memory.size} pairs from last 24h`);
}

// ── Edge Score (worker-specific, GeckoPool input) ─────────────────────────────

function quickEdgeScore(pool: GeckoPool, mem: PairMemoryEntry, flow: FlowSignal): number {
  let score = 50;

  const liq    = Number(pool.attributes.reserve_in_usd ?? 0);
  const vol24h = Number(pool.attributes.volume_usd?.h24 ?? 0);
  const h24    = Number(pool.attributes.price_change_percentage?.h24 ?? 0);
  const m5     = Number(pool.attributes.price_change_percentage?.m5  ?? 0);
  const h1     = Number(pool.attributes.price_change_percentage?.h1  ?? 0);

  // Liquidity
  if      (liq > 100_000) score += 15;
  else if (liq >  50_000) score += 10;
  else if (liq >  25_000) score +=  5;
  else                    score -= 15;

  // Volume
  if      (vol24h > 500_000) score += 10;
  else if (vol24h > 100_000) score +=  5;
  else if (vol24h <  20_000) score -= 10;

  // h24 sweet spot 10-80%
  if      (h24 > 10 && h24 < 80)   score += 15;
  else if (h24 >= 80 && h24 < 150) score +=  5;
  else if (h24 >= 150)             score -= 15;
  else if (h24 < 0)                score -= 10;

  // 5m fresh dar nu vertical
  if      (m5 > 3 && m5 < 15) score += 10;
  else if (m5 >= 15)           score -= 10;
  else if (m5 < -5)            score -=  5;

  // 1h confirmare trend
  if      (h1 > 5 && h1 < 30) score += 10;
  else if (h1 >= 30)           score -=  5;
  else if (h1 < -10)           score -= 10;

  // Flow
  if (flow.hasData) {
    if (flow.pressure === "BUYING")  score += 15;
    if (flow.pressure === "SELLING") score -= 20;
  }

  // Phase memory
  if (mem.phase === "RECOVERING")                                   score += 10;
  if (mem.wins24h >= 2)                                             score += 10;
  if (mem.losses24h > mem.wins24h && mem.losses24h > 2)            score -= 15;
  if (mem.consecutiveLosses >= 3)                                   score -= 20;
  if (mem.seenCount > 15 && mem.wins24h === 0)                     score -= 20;

  return Math.max(0, Math.min(100, score));
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

// ── Fetch trending ────────────────────────────────────────────────────────────

async function fetchTrending(network: string): Promise<GeckoPool[]> {
  try {
    const res  = await fetch(`${GECKO_BASE}/networks/${network}/trending_pools?page=1`);
    const data = await res.json();
    return data.data ?? [];
  } catch { return []; }
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
    id, timestamp: Date.now(), symbol, chain: "base",
    pair_address:              pool.attributes.address,
    price_at_block:            Number(pool.attributes.base_token_price_usd),
    price_change_24h_at_block: Number(pool.attributes.price_change_percentage?.h24 ?? 0),
    reason,
  });

  console.log(`[FOMO] ${symbol} — ${reason}`);
}

// ── Save shadow trade ─────────────────────────────────────────────────────────

async function saveShadowTrade(
  pool:  GeckoPool,
  score: number,
  mem:   PairMemoryEntry,
  flow:  FlowSignal,
): Promise<void> {
  const price = mem.currentPrice;
  const id    = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  await supabase.from("shadow_trades").insert({
    id,
    timestamp:     Date.now(),
    symbol:        mem.symbol,
    chain:         "base",
    pair_address:  pool.attributes.address,
    token_address: mem.tokenAddress,
    entry_price:   price,
    current_price: price,
    edge_score:    score,
    flag_count:    0,
    note: `WORKER v3 | Edge ${score} | seen:${mem.seenCount}x | phase:${mem.phase} | flow:${flow.pressure} | W${mem.wins24h}/L${mem.losses24h}`,
    sl:  price * (1 - (score >= 80 ? 0.15 : 0.18)),
    tp1: price * (1 + (score >= 80 ? 0.25 : 0.20)),
    tp2: price * (1 + (score >= 80 ? 0.60 : 0.50)),
    tp3: price * (1 + (score >= 80 ? 1.50 : 1.00)),
  });

  mem.totalEntries  += 1;
  mem.lastEntryTime  = Date.now();
  mem.lastEntryPrice = price;
  memory.set(pool.attributes.address.toLowerCase(), mem);

  console.log(`[SHADOW] ${mem.symbol} Edge ${score} | seen:${mem.seenCount}x | phase:${mem.phase} | flow:${flow.pressure}`);
}

// ── Update outcomes ───────────────────────────────────────────────────────────

async function updateOutcomes(pools: GeckoPool[]): Promise<void> {
  const priceMap = new Map<string, number>();
  pools.forEach(p => priceMap.set(
    p.attributes.address.toLowerCase(),
    Number(p.attributes.base_token_price_usd),
  ));

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

    const ageMs  = Date.now() - trade.timestamp;
    const flow   = getWsFlow(trade.pair_address);
    const update: Record<string, unknown> = { current_price: price };

    const mem = memory.get(trade.pair_address?.toLowerCase());

    if (price <= trade.sl) {
      update.exited_at   = Date.now();
      update.exit_price  = price;
      update.exit_reason = "SL hit";
      if (mem) { mem.losses24h += 1; mem.consecutiveLosses += 1; mem.lastExitReason = "SL hit"; mem.lastExitTime = Date.now(); }

    } else if (price >= trade.tp1) {
      update.exited_at   = Date.now();
      update.exit_price  = price;
      update.exit_reason = "TP1 hit";
      if (mem) { mem.wins24h += 1; mem.consecutiveLosses = 0; mem.lastExitReason = "TP1 hit"; mem.lastExitTime = Date.now(); }

    } else if (flow.hasData && flow.pressure === "SELLING" && flow.sells5m >= 10 && ageMs > 15 * 60_000) {
      // Exit anticipat pe sell pressure puternic
      update.exited_at   = Date.now();
      update.exit_price  = price;
      update.exit_reason = "SELL PRESSURE";
      console.log(`[FLOW EXIT] ${trade.symbol} — ${flow.sells5m}s vs ${flow.buys5m}b in 5m`);

    } else if (ageMs > MAX_HOLD_MS) {
      update.exited_at   = Date.now();
      update.exit_price  = price;
      update.exit_reason = "MAX HOLD";
      console.log(`[ZOMBIE KILL] ${trade.symbol} held 4h with no exit`);
    }

    await supabase.from("shadow_trades").update(update).eq("id", trade.id);
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function scan(): Promise<void> {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Scanning BASE...`);

  const pools = await fetchTrending("base");
  if (!pools.length) { console.log("No pools fetched"); return; }

  await updateOutcomes(pools);

  let shadowCount = 0;

  for (const pool of pools) {
    const price = Number(pool.attributes.base_token_price_usd);
    if (!price || isNaN(price)) continue;

    const mem  = updateMemory(pool, price);
    const flow = getFlow(pool);
    const fomo = checkFOMO(pool);

    if (fomo.blocked && fomo.reason) {
      await saveFOMOBlock(pool, fomo.reason);
      continue;
    }

    if (shadowCount >= MAX_SHADOW_PER_SCAN) continue;

    const score = quickEdgeScore(pool, mem, flow);
    if (score < 75) continue;

    const gate = checkEntryGate(mem, flow, MIN_SEEN_COUNT, COOLDOWN_MS);
    if (!gate.allowed) {
      console.log(`[SKIP] ${mem.symbol} — ${gate.reason}`);
      continue;
    }

    await saveShadowTrade(pool, score, mem, flow);
    shadowCount++;
  }

  const vals = [...memory.values()];
  console.log(
    `[${ts}] Done — shadows:${shadowCount} | mem:${memory.size} | ws:${wsFlow.size} pairs` +
    ` | zombies:${vals.filter(m => m.phase === "ZOMBIE").length}` +
    ` | dead:${vals.filter(m => m.phase === "DEAD").length}` +
    ` | recovering:${vals.filter(m => m.phase === "RECOVERING").length}`
  );
}

// ── Start ─────────────────────────────────────────────────────────────────────

console.log("Supreme Trader Worker v3 starting...");
connectWebSocket();
loadPairStats().then(() => {
  scan();
  setInterval(scan, SCAN_INTERVAL);
});