/**
 * Supreme Trader Worker
 * Scanner permanent — rulează pe Railway, nu în browser
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import ws from "ws";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const GECKO_BASE    = "https://api.geckoterminal.com/api/v2";
const SCAN_INTERVAL = 30_000; // 30s

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

// ── Anti-FOMO ─────────────────────────────────────────────────────────────────

function checkFOMO(pool: GeckoPool): { blocked: boolean; reason: string | null } {
  const h24 = Number(pool.attributes.price_change_percentage?.h24 ?? 0);
  const m5  = Number(pool.attributes.price_change_percentage?.m5  ?? 0);

  if (m5 > 30)   return { blocked: true, reason: `+${m5.toFixed(0)}% in 5m — vertical candle, wait for pullback` };
  if (h24 > 500) return { blocked: true, reason: `+${h24.toFixed(0)}% in 24h — extremely late entry risk` };
  if (h24 > 200) return { blocked: true, reason: `+${h24.toFixed(0)}% in 24h — likely already pumped` };

  return { blocked: false, reason: null };
}

// ── Edge Score simplu ─────────────────────────────────────────────────────────

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
    const res = await fetch(`${GECKO_BASE}/networks/${network}/trending_pools?page=1`);
    const data = await res.json();
    return data.data ?? [];
  } catch { return []; }
}

// ── Save FOMO block ───────────────────────────────────────────────────────────

async function saveFOMOBlock(pool: GeckoPool, reason: string): Promise<void> {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const symbol = pool.attributes.name.split("/")[0] ?? "?";

  // Deduplicare — nu salva același pair în ultima oră
  const { data: existing } = await supabase
    .from("fomo_blocks")
    .select("id")
    .eq("pair_address", pool.attributes.address)
    .gte("timestamp", Date.now() - 60 * 60_000)
    .limit(1);

  if (existing && existing.length > 0) return;

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

  console.log(`[FOMO BLOCK] ${symbol} — ${reason}`);
}

// ── Save shadow trade ─────────────────────────────────────────────────────────

async function saveShadowTrade(pool: GeckoPool, score: number): Promise<void> {
  const id     = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const symbol = pool.attributes.name.split("/")[0] ?? "?";
  const price  = Number(pool.attributes.base_token_price_usd);

  const { data: existing } = await supabase
    .from("shadow_trades")
    .select("id")
    .eq("pair_address", pool.attributes.address)
    .gte("timestamp", Date.now() - 60 * 60_000)
    .limit(1);

  if (existing && existing.length > 0) return;

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
    note:          `WORKER SHADOW | Edge ${score}`,
    sl:  price * (1 - (score >= 80 ? 0.15 : 0.18)),
    tp1: price * (1 + (score >= 80 ? 0.25 : 0.20)),
    tp2: price * (1 + (score >= 80 ? 0.60 : 0.50)),
    tp3: price * (1 + (score >= 80 ? 1.50 : 1.00)),
  });

  console.log(`[SHADOW] WOULD_BUY ${symbol} Edge ${score}`);
}

// ── Update outcomes ───────────────────────────────────────────────────────────

async function updateOutcomes(pools: GeckoPool[]): Promise<void> {
  const priceMap = new Map<string, number>();
  pools.forEach(p => priceMap.set(p.attributes.address, Number(p.attributes.base_token_price_usd)));

  // Update FOMO block outcomes
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

  // Update shadow trade prices
  const { data: trades } = await supabase
    .from("shadow_trades")
    .select("*")
    .is("exited_at", null);

  if (trades) {
    for (const trade of trades) {
      const price = priceMap.get(trade.pair_address);
      if (!price) continue;
      const update: Record<string, unknown> = { current_price: price };
      if (price <= trade.sl) {
        update.exited_at   = Date.now();
        update.exit_price  = price;
        update.exit_reason = "SL hit";
      } else if (price >= trade.tp1) {
        update.exited_at   = Date.now();
        update.exit_price  = price;
        update.exit_reason = "TP1 hit";
      }
      await supabase.from("shadow_trades").update(update).eq("id", trade.id);
    }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function scan(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Scanning BASE...`);

  const pools = await fetchTrending("base");
  if (!pools.length) { console.log("No pools fetched"); return; }

  await updateOutcomes(pools);

  for (const pool of pools) {
    const price = Number(pool.attributes.base_token_price_usd);
    if (!price || isNaN(price)) continue;

    const fomo  = checkFOMO(pool);
    const score = quickEdgeScore(pool);

    if (fomo.blocked && fomo.reason) {
      await saveFOMOBlock(pool, fomo.reason);
      continue;
    }

    if (score >= 75) {
      await saveShadowTrade(pool, score);
    }
  }

  console.log(`[${new Date().toISOString()}] Scan done — ${pools.length} pools processed`);
}

// ── Start ─────────────────────────────────────────────────────────────────────

console.log("Supreme Trader Worker starting...");
scan();
setInterval(scan, SCAN_INTERVAL);