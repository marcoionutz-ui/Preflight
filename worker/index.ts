/**
 * Supreme Trader Worker v3 — Pair Memory + WebSocket Flow Layer
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const SUPABASE_URL        = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY        = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const ALCHEMY_BASE_WS     = process.env.ALCHEMY_BASE_WS!;
const GECKO_BASE          = "https://api.geckoterminal.com/api/v2";
const SCAN_INTERVAL       = 30_000;
const MAX_SHADOW_PER_SCAN = 5;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: WebSocket },
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface GeckoPool {
  id: string;
  attributes: {
    name: string;
    base_token_price_usd: string;
    price_change_percentage: { m5?: string; h1?: string; h24?: string };
    reserve_in_usd: string;
    volume_usd: { h24: string };
    address: string;
  };
  relationships: { base_token: { data: { id: string } } };
}

type Phase    = "NEW" | "TRENDING" | "PUMPING" | "DUMPING" | "RECOVERING" | "ZOMBIE" | "DEAD";
type Pressure = "BUYING" | "SELLING" | "NEUTRAL";

interface PairMemory {
  pairAddress:       string;
  symbol:            string;
  tokenAddress:      string;
  firstSeen:         number;
  lastSeen:          number;
  seenCount:         number;
  priceAtFirstSeen:  number;
  highPrice:         number;
  lowPrice:          number;
  currentPrice:      number;
  totalEntries:      number;
  lastEntryTime:     number;
  lastEntryPrice:    number;
  wins24h:           number;
  losses24h:         number;
  consecutiveLosses: number;
  lastExitReason:    string | null;
  lastExitTime:      number | null;
  phase:             Phase;
}

interface SwapEvent {
  ts:        number;
  isBuy:     boolean;
  ethAmount: number;
}

// ── In-memory stores ──────────────────────────────────────────────────────────

const memory   = new Map<string, PairMemory>();
const flowData = new Map<string, SwapEvent[]>(); // pairAddress → swap events (5m window)

// ── Flow helpers ──────────────────────────────────────────────────────────────

function recordSwap(pairAddress: string, isBuy: boolean, ethAmount: number): void {
  const addr   = pairAddress.toLowerCase();
  const now    = Date.now();
  const events = (flowData.get(addr) ?? []).filter(e => now - e.ts < 5 * 60_000);
  events.push({ ts: now, isBuy, ethAmount });
  flowData.set(addr, events);
}

function getFlow(pairAddress: string): {
  buys1m: number; sells1m: number;
  buys5m: number; sells5m: number;
  pressure: Pressure;
} {
  const addr   = pairAddress.toLowerCase();
  const events = flowData.get(addr) ?? [];
  const now    = Date.now();

  const e1m = events.filter(e => now - e.ts < 60_000);
  const e5m = events.filter(e => now - e.ts < 5 * 60_000);

  const buys1m  = e1m.filter(e =>  e.isBuy).length;
  const sells1m = e1m.filter(e => !e.isBuy).length;
  const buys5m  = e5m.filter(e =>  e.isBuy).length;
  const sells5m = e5m.filter(e => !e.isBuy).length;

  let pressure: Pressure = "NEUTRAL";
  const total = buys5m + sells5m;
  if (total >= 5) {
    if (buys5m > sells5m * 1.5)  pressure = "BUYING";
    if (sells5m > buys5m * 1.5)  pressure = "SELLING";
  }

  return { buys1m, sells1m, buys5m, sells5m, pressure };
}

// ── WebSocket — Alchemy BASE ──────────────────────────────────────────────────

// Uniswap V2 Swap event topic
const SWAP_V2_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
// WETH pe BASE
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
      if (!pairAddress) return;

      // Procesăm doar pairs pe care le urmărim
      if (!memory.has(pairAddress)) return;

      // Decode Swap V2: data = amount0In|amount1In|amount0Out|amount1Out (4×32 bytes)
      const raw = log.data?.slice(2);
      if (!raw || raw.length < 256) return;

      const amount0In  = BigInt("0x" + raw.slice(0, 64));
      const amount1In  = BigInt("0x" + raw.slice(64, 128));
      const amount0Out = BigInt("0x" + raw.slice(128, 192));
      const amount1Out = BigInt("0x" + raw.slice(192, 256));

      // Determinăm buy vs sell folosind poziția WETH în pair
      // WETH = 0x4200...0006 — de obicei token0 pe BASE (adresă mică)
      // amount0In > 0 = cineva a trimis WETH → a cumpărat token1 (base token) = BUY
      // amount1In > 0 = cineva a trimis token1 (base token) → a primit WETH = SELL
      const mem = memory.get(pairAddress);
      if (!mem) return;

      const tokenAddr = mem.tokenAddress.replace("base_", "").toLowerCase();
      const wethIsToken0 = WETH_BASE.toLowerCase() < tokenAddr;

      let isBuy: boolean;
      let ethAmount: number;

      if (wethIsToken0) {
        // token0 = WETH, token1 = base token
        isBuy     = amount0In > 0n && amount1Out > 0n;
        ethAmount = Number(isBuy ? amount0In : amount1In) / 1e18;
      } else {
        // token0 = base token, token1 = WETH
        isBuy     = amount1In > 0n && amount0Out > 0n;
        ethAmount = Number(isBuy ? amount1In : amount0In) / 1e18;
      }

      if (amount0In === 0n && amount1In === 0n) return;

      recordSwap(pairAddress, isBuy, ethAmount);

    } catch { /* silent */ }
  });

  wsClient.on("error", (err: Error) => {
    console.log(`[WS] Error: ${err.message}`);
  });

  wsClient.on("close", () => {
    console.log("[WS] Disconnected — reconnecting in 5s...");
    setTimeout(connectWebSocket, 5_000);
  });
}

// ── Pair Memory ───────────────────────────────────────────────────────────────

function detectPhase(mem: PairMemory, m5: number, h24: number): Phase {
  if (mem.seenCount <= 2) return "NEW";

  if (mem.seenCount > 8 && mem.totalEntries > 0 && mem.wins24h === 0 && mem.losses24h === 0) {
    const range = mem.highPrice > 0 ? (mem.highPrice - mem.lowPrice) / mem.highPrice * 100 : 0;
    if (range < 15) return "ZOMBIE";
  }

  if (mem.consecutiveLosses >= 4)                                return "DEAD";
  if (m5 > 15 || h24 > 150)                                     return "PUMPING";
  if (mem.highPrice > 0 && mem.currentPrice < mem.highPrice * 0.7) return "DUMPING";
  if (mem.lowPrice  > 0 && mem.currentPrice > mem.lowPrice  * 1.12) return "RECOVERING";

  return "TRENDING";
}

function updateMemory(pool: GeckoPool, price: number): PairMemory {
  const addr   = pool.attributes.address.toLowerCase();
  const symbol = pool.attributes.name.split("/")[0]?.trim() ?? "?";
  const now    = Date.now();
  const tokenAddress = pool.relationships.base_token.data.id ?? "";

  const existing = memory.get(addr);
  if (!existing) {
    const mem: PairMemory = {
      pairAddress: addr, symbol, tokenAddress,
      firstSeen: now, lastSeen: now, seenCount: 1,
      priceAtFirstSeen: price, highPrice: price, lowPrice: price, currentPrice: price,
      totalEntries: 0, lastEntryTime: 0, lastEntryPrice: 0,
      wins24h: 0, losses24h: 0, consecutiveLosses: 0,
      lastExitReason: null, lastExitTime: null, phase: "NEW",
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

  const m5  = Number(pool.attributes.price_change_percentage?.m5  ?? 0);
  const h24 = Number(pool.attributes.price_change_percentage?.h24 ?? 0);
  existing.phase = detectPhase(existing, m5, h24);

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
      memory.set(addr, {
        pairAddress: addr, symbol: t.symbol?.trim() ?? "?",
        tokenAddress: t.token_address ?? "",
        firstSeen: new Date(t.created_at).getTime(),
        lastSeen:  new Date(t.created_at).getTime(),
        seenCount: 0, priceAtFirstSeen: Number(t.entry_price),
        highPrice: Number(t.current_price || t.entry_price),
        lowPrice:  Number(t.entry_price),
        currentPrice: Number(t.current_price || t.entry_price),
        totalEntries: 0, lastEntryTime: 0, lastEntryPrice: Number(t.entry_price),
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

// ── Anti-FOMO ─────────────────────────────────────────────────────────────────

function checkFOMO(pool: GeckoPool): { blocked: boolean; reason: string | null } {
  const h24 = Number(pool.attributes.price_change_percentage?.h24 ?? 0);
  const m5  = Number(pool.attributes.price_change_percentage?.m5  ?? 0);

  if (m5  > 30)  return { blocked: true, reason: `+${m5.toFixed(0)}% in 5m — vertical candle` };
  if (h24 > 500) return { blocked: true, reason: `+${h24.toFixed(0)}% in 24h — extremely late` };
  if (h24 > 200) return { blocked: true, reason: `+${h24.toFixed(0)}% in 24h — likely pumped` };

  return { blocked: false, reason: null };
}

// ── Edge Score — recalibrat cu flow + memory ──────────────────────────────────

function quickEdgeScore(pool: GeckoPool, mem: PairMemory, flow: ReturnType<typeof getFlow>): number {
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

  // h24 momentum — sweet spot 10-80%
  if      (h24 > 10 && h24 < 80)   score += 15;
  else if (h24 >= 80 && h24 < 150) score +=  5;
  else if (h24 >= 150)             score -= 15;
  else if (h24 < 0)                score -= 10;

  // 5m — fresh dar nu vertical
  if      (m5 > 3 && m5 < 15) score += 10;
  else if (m5 >= 15)           score -= 10;
  else if (m5 < -5)            score -=  5;

  // 1h — confirmare trend
  if      (h1 > 5 && h1 < 30) score += 10;
  else if (h1 >= 30)           score -=  5;
  else if (h1 < -10)           score -= 10;

  // Flow bonus/penalizare
  if (flow.pressure === "BUYING")  score += 15;
  if (flow.pressure === "SELLING") score -= 20;

  // Phase bonus
  if (mem.phase === "RECOVERING") score += 10;

  // Memory penalizare
  if (mem.losses24h > mem.wins24h && mem.losses24h > 2) score -= 15;
  if (mem.wins24h >= 2) score += 10;
  if (mem.seenCount > 15 && mem.wins24h === 0) score -= 20;

  return Math.max(0, Math.min(100, score));
}

// ── Should enter shadow? ──────────────────────────────────────────────────────

function shouldEnterShadow(mem: PairMemory, flow: ReturnType<typeof getFlow>): { allowed: boolean; reason: string } {
  if (mem.seenCount < 5)
    return { allowed: false, reason: `too new (seen ${mem.seenCount}x)` };

  if (mem.phase === "ZOMBIE")
    return { allowed: false, reason: "zombie pair" };

  if (mem.phase === "DEAD" || mem.consecutiveLosses >= 4)
    return { allowed: false, reason: `dead (${mem.consecutiveLosses} consecutive SL)` };

  if (mem.lastEntryTime > 0 && Date.now() - mem.lastEntryTime < 2 * 60 * 60_000) {
    const minsLeft = Math.ceil((mem.lastEntryTime + 2 * 3600_000 - Date.now()) / 60_000);
    return { allowed: false, reason: `cooldown ${minsLeft}m left` };
  }

  if (mem.phase === "PUMPING")
    return { allowed: false, reason: "vertical pump phase" };

  // Flow gate — nu intra dacă sell pressure dominează
  if (flow.pressure === "SELLING")
    return { allowed: false, reason: `sell pressure (${flow.sells5m}s vs ${flow.buys5m}b in 5m)` };

  return { allowed: true, reason: `phase:${mem.phase} seen:${mem.seenCount}x flow:${flow.pressure}` };
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
  pool: GeckoPool, score: number,
  mem: PairMemory, flow: ReturnType<typeof getFlow>
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
    Number(p.attributes.base_token_price_usd)
  ));

  // FOMO blocks
  const { data: blocks } = await supabase
    .from("fomo_blocks").select("*")
    .is("outcome_1h_price", null)
    .gte("timestamp", Date.now() - 24 * 3600_000);

  if (blocks) {
    for (const block of blocks) {
      const price = priceMap.get(block.pair_address?.toLowerCase());
      if (!price) continue;
      if (Date.now() - block.timestamp >= 60 * 60_000) {
        const pct = (price - block.price_at_block) / block.price_at_block * 100;
        await supabase.from("fomo_blocks").update({
          outcome_1h_price: price, outcome_1h_pct: pct, outcome_1h_ts: Date.now(),
        }).eq("id", block.id);
      }
    }
  }

  // Shadow trades
  const { data: trades } = await supabase
    .from("shadow_trades").select("*").is("exited_at", null);

  if (trades) {
    for (const trade of trades) {
      const price = priceMap.get(trade.pair_address?.toLowerCase());
      if (!price) continue;

      const ageMs  = Date.now() - trade.timestamp;
      const flow   = getFlow(trade.pair_address);
      const update: Record<string, unknown> = { current_price: price };

      if (price <= trade.sl) {
        update.exited_at   = Date.now();
        update.exit_price  = price;
        update.exit_reason = "SL hit";
        const mem = memory.get(trade.pair_address?.toLowerCase());
        if (mem) { mem.losses24h += 1; mem.consecutiveLosses += 1; mem.lastExitReason = "SL hit"; mem.lastExitTime = Date.now(); }

      } else if (price >= trade.tp1) {
        update.exited_at   = Date.now();
        update.exit_price  = price;
        update.exit_reason = "TP1 hit";
        const mem = memory.get(trade.pair_address?.toLowerCase());
        if (mem) { mem.wins24h += 1; mem.consecutiveLosses = 0; mem.lastExitReason = "TP1 hit"; mem.lastExitTime = Date.now(); }

      } else if (flow.pressure === "SELLING" && flow.sells5m >= 10 && ageMs > 15 * 60_000) {
        // Exit anticipat pe sell pressure puternic
        update.exited_at   = Date.now();
        update.exit_price  = price;
        update.exit_reason = "SELL PRESSURE";
        console.log(`[FLOW EXIT] ${trade.symbol} — sell pressure ${flow.sells5m}s vs ${flow.buys5m}b`);

      } else if (ageMs > 4 * 3600_000) {
        update.exited_at   = Date.now();
        update.exit_price  = price;
        update.exit_reason = "MAX HOLD";
        console.log(`[ZOMBIE KILL] ${trade.symbol} held 4h with no exit`);
      }

      await supabase.from("shadow_trades").update(update).eq("id", trade.id);
    }
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
    const flow = getFlow(pool.attributes.address);
    const fomo = checkFOMO(pool);

    if (fomo.blocked && fomo.reason) {
      await saveFOMOBlock(pool, fomo.reason);
      continue;
    }

    if (shadowCount >= MAX_SHADOW_PER_SCAN) continue;

    const score = quickEdgeScore(pool, mem, flow);
    if (score < 75) continue;

    const gate = shouldEnterShadow(mem, flow);
    if (!gate.allowed) {
      console.log(`[SKIP] ${mem.symbol} — ${gate.reason}`);
      continue;
    }

    await saveShadowTrade(pool, score, mem, flow);
    shadowCount++;
  }

  const wsFlowPairs = flowData.size;
  const memStats = {
    total:      memory.size,
    zombies:    [...memory.values()].filter(m => m.phase === "ZOMBIE").length,
    dead:       [...memory.values()].filter(m => m.phase === "DEAD").length,
    recovering: [...memory.values()].filter(m => m.phase === "RECOVERING").length,
  };

  console.log(`[${ts}] Done — shadows:${shadowCount} | mem:${memStats.total} | flow:${wsFlowPairs} pairs | zombies:${memStats.zombies} | dead:${memStats.dead} | recovering:${memStats.recovering}`);
}

// ── Start ─────────────────────────────────────────────────────────────────────

console.log("Supreme Trader Worker v3 starting...");
connectWebSocket();
loadPairStats().then(() => {
  scan();
  setInterval(scan, SCAN_INTERVAL);
});