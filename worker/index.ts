/**
 * Supreme Trader Worker v2 — cu Pair Memory
 * Rezolvă: overtrading, zombie trades, stale trending, re-entry prost
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const GECKO_BASE    = "https://api.geckoterminal.com/api/v2";
const SCAN_INTERVAL = 30_000;
const MAX_SHADOW_PER_SCAN = 5;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws },
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
  relationships: {
    base_token: { data: { id: string } };
  };
}

type Phase = "NEW" | "TRENDING" | "PUMPING" | "DUMPING" | "RECOVERING" | "ZOMBIE" | "DEAD";

interface PairMemory {
  pairAddress:       string;
  symbol:            string;
  firstSeen:         number;
  lastSeen:          number;
  seenCount:         number;
  priceAtFirstSeen:  number;
  highPrice:         number;
  lowPrice:          number;
  currentPrice:      number;
  // Entry history
  totalEntries:      number;
  lastEntryTime:     number;
  lastEntryPrice:    number;
  // Exit history (loaded from DB)
  wins24h:           number;
  losses24h:         number;
  consecutiveLosses: number;
  lastExitReason:    string | null;
  lastExitTime:      number | null;
  // Phase
  phase:             Phase;
}

// ── In-memory Pair Memory store ───────────────────────────────────────────────

const memory = new Map<string, PairMemory>();

function detectPhase(mem: PairMemory, m5: number, h24: number): Phase {
  if (mem.seenCount <= 2) return "NEW";

  // Zombie: văzut de multe ori, fără exits, preț stabil
  if (mem.seenCount > 8 && mem.totalEntries > 0 && mem.wins24h === 0 && mem.losses24h === 0) {
    const priceRange = mem.highPrice > 0
      ? (mem.highPrice - mem.lowPrice) / mem.highPrice * 100
      : 0;
    if (priceRange < 15) return "ZOMBIE";
  }

  // Dead: prea multe pierderi consecutive
  if (mem.consecutiveLosses >= 4) return "DEAD";

  // Pumping: pump vertical
  if (m5 > 15 || h24 > 150) return "PUMPING";

  // Dumping: prețul a scăzut semnificativ față de high
  if (mem.highPrice > 0 && mem.currentPrice < mem.highPrice * 0.7) return "DUMPING";

  // Recovering: a dumpuit dar a revenit de la low
  if (mem.lowPrice > 0 && mem.currentPrice > mem.lowPrice * 1.12) return "RECOVERING";

  return "TRENDING";
}

function updateMemory(pool: GeckoPool, price: number): PairMemory {
  const addr   = pool.attributes.address;
  const symbol = pool.attributes.name.split("/")[0]?.trim() ?? "?";
  const now    = Date.now();

  const existing = memory.get(addr);

  if (!existing) {
    const mem: PairMemory = {
      pairAddress: addr, symbol,
      firstSeen: now, lastSeen: now, seenCount: 1,
      priceAtFirstSeen: price, highPrice: price, lowPrice: price, currentPrice: price,
      totalEntries: 0, lastEntryTime: 0, lastEntryPrice: 0,
      wins24h: 0, losses24h: 0, consecutiveLosses: 0,
      lastExitReason: null, lastExitTime: null,
      phase: "NEW",
    };
    memory.set(addr, mem);
    return mem;
  }

  existing.lastSeen     = now;
  existing.seenCount   += 1;
  existing.currentPrice = price;
  if (price > existing.highPrice) existing.highPrice = price;
  if (price < existing.lowPrice)  existing.lowPrice  = price;

  const m5  = Number(pool.attributes.price_change_percentage?.m5  ?? 0);
  const h24 = Number(pool.attributes.price_change_percentage?.h24 ?? 0);
  existing.phase = detectPhase(existing, m5, h24);

  memory.set(addr, existing);
  return existing;
}

// ── Load pair stats from Supabase on startup ──────────────────────────────────

async function loadPairStats(): Promise<void> {
  const cutoff = Date.now() - 24 * 3600_000;

  const { data: trades } = await supabase
    .from("shadow_trades")
    .select("pair_address, symbol, entry_price, exit_reason, exited_at, created_at, current_price")
    .gte("timestamp", cutoff);

  if (!trades) return;

  for (const t of trades) {
    const addr = t.pair_address;
    if (!memory.has(addr)) {
      memory.set(addr, {
        pairAddress: addr, symbol: t.symbol?.trim() ?? "?",
        firstSeen: new Date(t.created_at).getTime(),
        lastSeen: new Date(t.created_at).getTime(),
        seenCount: 0, priceAtFirstSeen: Number(t.entry_price),
        highPrice: Number(t.current_price || t.entry_price),
        lowPrice: Number(t.entry_price),
        currentPrice: Number(t.current_price || t.entry_price),
        totalEntries: 0, lastEntryTime: 0, lastEntryPrice: Number(t.entry_price),
        wins24h: 0, losses24h: 0, consecutiveLosses: 0,
        lastExitReason: null, lastExitTime: null, phase: "TRENDING",
      });
    }

    const mem = memory.get(addr)!;
    mem.totalEntries += 1;
    mem.lastEntryTime  = Math.max(mem.lastEntryTime, new Date(t.created_at).getTime());
    mem.lastEntryPrice = Number(t.entry_price);

    if (t.exit_reason === "TP1 hit") {
      mem.wins24h += 1;
      mem.consecutiveLosses = 0;
      mem.lastExitReason = "TP1 hit";
      mem.lastExitTime   = t.exited_at;
    } else if (t.exit_reason === "SL hit") {
      mem.losses24h += 1;
      mem.consecutiveLosses += 1;
      mem.lastExitReason = "SL hit";
      mem.lastExitTime   = t.exited_at;
    }
  }

  console.log(`[MEMORY] Loaded ${memory.size} pairs from last 24h`);
}

// ── Anti-FOMO ─────────────────────────────────────────────────────────────────

function checkFOMO(pool: GeckoPool): { blocked: boolean; reason: string | null } {
  const h24 = Number(pool.attributes.price_change_percentage?.h24 ?? 0);
  const m5  = Number(pool.attributes.price_change_percentage?.m5  ?? 0);

  if (m5 > 30)   return { blocked: true, reason: `+${m5.toFixed(0)}% in 5m — vertical candle` };
  if (h24 > 500) return { blocked: true, reason: `+${h24.toFixed(0)}% in 24h — extremely late` };
  if (h24 > 200) return { blocked: true, reason: `+${h24.toFixed(0)}% in 24h — likely pumped` };

  return { blocked: false, reason: null };
}

// ── Edge Score ────────────────────────────────────────────────────────────────

function quickEdgeScore(pool: GeckoPool): number {
  let score = 50;
  const liq    = Number(pool.attributes.reserve_in_usd ?? 0);
  const vol24h = Number(pool.attributes.volume_usd?.h24 ?? 0);
  const h24    = Number(pool.attributes.price_change_percentage?.h24 ?? 0);
  const m5     = Number(pool.attributes.price_change_percentage?.m5  ?? 0);

  if (liq > 100_000) score += 15;
  else if (liq > 50_000) score += 10;
  else if (liq > 25_000) score += 5;
  else score -= 10;

  if (vol24h > 500_000) score += 10;
  else if (vol24h > 100_000) score += 5;

  if (h24 > 10 && h24 < 100) score += 10;
  else if (h24 > 100) score -= 10;

  if (m5 > 5 && m5 < 20) score += 5;

  return Math.max(0, Math.min(100, score));
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
    .from("fomo_blocks")
    .select("id")
    .eq("pair_address", pool.attributes.address)
    .gte("timestamp", Date.now() - 60 * 60_000)
    .limit(1);

  if (existing && existing.length > 0) return;

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  await supabase.from("fomo_blocks").insert({
    id,
    timestamp:                 Date.now(),
    symbol,
    chain:                     "base",
    pair_address:              pool.attributes.address,
    price_at_block:            Number(pool.attributes.base_token_price_usd),
    price_change_24h_at_block: Number(pool.attributes.price_change_percentage?.h24 ?? 0),
    reason,
  });

  console.log(`[FOMO] ${symbol} — ${reason}`);
}

// ── Should enter shadow? ──────────────────────────────────────────────────────

function shouldEnterShadow(mem: PairMemory): { allowed: boolean; reason: string } {
  // Prea nou — nu validat încă
  if (mem.seenCount < 5) {
    return { allowed: false, reason: `too new (seen ${mem.seenCount}x)` };
  }

  // Zombie — nu produce niciun outcome
  if (mem.phase === "ZOMBIE") {
    return { allowed: false, reason: "zombie pair" };
  }

  // Dead — prea multe SL consecutive
  if (mem.phase === "DEAD" || mem.consecutiveLosses >= 4) {
    return { allowed: false, reason: `dead (${mem.consecutiveLosses} consecutive SL)` };
  }

  // Cooldown 2h după ultima intrare
  if (mem.lastEntryTime > 0 && Date.now() - mem.lastEntryTime < 2 * 60 * 60_000) {
    const minsLeft = Math.ceil((mem.lastEntryTime + 2 * 3600_000 - Date.now()) / 60_000);
    return { allowed: false, reason: `cooldown ${minsLeft}m left` };
  }

  // Phase check — nu intra în pump vertical
  if (mem.phase === "PUMPING") {
    return { allowed: false, reason: "vertical pump phase" };
  }

  return { allowed: true, reason: `phase:${mem.phase} seen:${mem.seenCount}x` };
}

// ── Save shadow trade ─────────────────────────────────────────────────────────

async function saveShadowTrade(pool: GeckoPool, score: number, mem: PairMemory): Promise<void> {
  const symbol = mem.symbol;
  const price  = mem.currentPrice;
  const id     = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  await supabase.from("shadow_trades").insert({
    id,
    timestamp:     Date.now(),
    symbol,
    chain:         "base",
    pair_address:  pool.attributes.address,
    token_address: pool.relationships.base_token.data.id,
    entry_price:   price,
    current_price: price,
    edge_score:    score,
    flag_count:    0,
    note: `WORKER v2 | Edge ${score} | seen:${mem.seenCount}x | phase:${mem.phase} | W${mem.wins24h}/L${mem.losses24h}`,
    sl:  price * (1 - (score >= 80 ? 0.15 : 0.18)),
    tp1: price * (1 + (score >= 80 ? 0.25 : 0.20)),
    tp2: price * (1 + (score >= 80 ? 0.60 : 0.50)),
    tp3: price * (1 + (score >= 80 ? 1.50 : 1.00)),
  });

  // Update memory
  mem.totalEntries  += 1;
  mem.lastEntryTime  = Date.now();
  mem.lastEntryPrice = price;
  memory.set(pool.attributes.address, mem);

  console.log(`[SHADOW] ${symbol} Edge ${score} | seen:${mem.seenCount}x | phase:${mem.phase}`);
}

// ── Update outcomes ───────────────────────────────────────────────────────────

async function updateOutcomes(pools: GeckoPool[]): Promise<void> {
  const priceMap = new Map<string, number>();
  pools.forEach(p => priceMap.set(p.attributes.address, Number(p.attributes.base_token_price_usd)));

  // FOMO blocks
  const { data: blocks } = await supabase
    .from("fomo_blocks")
    .select("*")
    .is("outcome_1h_price", null)
    .gte("timestamp", Date.now() - 24 * 3600_000);

  if (blocks) {
    for (const block of blocks) {
      const price = priceMap.get(block.pair_address);
      if (!price) continue;
      const age = Date.now() - block.timestamp;
      if (age >= 60 * 60_000) {
        const pct = (price - block.price_at_block) / block.price_at_block * 100;
        await supabase.from("fomo_blocks").update({
          outcome_1h_price: price,
          outcome_1h_pct:   pct,
          outcome_1h_ts:    Date.now(),
        }).eq("id", block.id);
      }
    }
  }

  // Shadow trades
  const { data: trades } = await supabase
    .from("shadow_trades")
    .select("*")
    .is("exited_at", null);

  if (trades) {
    for (const trade of trades) {
      const price = priceMap.get(trade.pair_address);
      if (!price) continue;

      // Max hold time 4h — zombie killer
      const ageMs = Date.now() - trade.timestamp;
      const update: Record<string, unknown> = { current_price: price };

      if (price <= trade.sl) {
        update.exited_at   = Date.now();
        update.exit_price  = price;
        update.exit_reason = "SL hit";
        // Update memory
        const mem = memory.get(trade.pair_address);
        if (mem) {
          mem.losses24h += 1;
          mem.consecutiveLosses += 1;
          mem.lastExitReason = "SL hit";
          mem.lastExitTime   = Date.now();
        }
      } else if (price >= trade.tp1) {
        update.exited_at   = Date.now();
        update.exit_price  = price;
        update.exit_reason = "TP1 hit";
        const mem = memory.get(trade.pair_address);
        if (mem) {
          mem.wins24h += 1;
          mem.consecutiveLosses = 0;
          mem.lastExitReason = "TP1 hit";
          mem.lastExitTime   = Date.now();
        }
      } else if (ageMs > 4 * 3600_000) {
        // Zombie killer — închide după 4h fără exit
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

    // Update pair memory
    const mem = updateMemory(pool, price);

    // Anti-FOMO
    const fomo = checkFOMO(pool);
    if (fomo.blocked && fomo.reason) {
      await saveFOMOBlock(pool, fomo.reason);
      continue;
    }

    // Max per scan
    if (shadowCount >= MAX_SHADOW_PER_SCAN) continue;

    // Edge score
    const score = quickEdgeScore(pool);
    if (score < 75) continue;

    // Pair memory gate
    const gate = shouldEnterShadow(mem);
    if (!gate.allowed) {
      console.log(`[SKIP] ${mem.symbol} — ${gate.reason}`);
      continue;
    }

    await saveShadowTrade(pool, score, mem);
    shadowCount++;
  }

  const memStats = {
    total: memory.size,
    zombies: [...memory.values()].filter(m => m.phase === "ZOMBIE").length,
    dead:    [...memory.values()].filter(m => m.phase === "DEAD").length,
    recovering: [...memory.values()].filter(m => m.phase === "RECOVERING").length,
  };

  console.log(`[${ts}] Done — shadows:${shadowCount} | mem:${memStats.total} pairs | zombies:${memStats.zombies} | dead:${memStats.dead} | recovering:${memStats.recovering}`);
}

// ── Start ─────────────────────────────────────────────────────────────────────

console.log("Supreme Trader Worker v2 starting...");
loadPairStats().then(() => {
  scan();
  setInterval(scan, SCAN_INTERVAL);
});