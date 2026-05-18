/**
 * Dual-write sync — localStorage fast, Supabase persistent
 * Fire-and-forget: nu blochează UI dacă Supabase e lent
 */

import { supabase } from "@/lib/db/supabase";
import type { FOMOBlock } from "@/lib/engines/fomoReplay";
import type { ShadowTrade } from "@/lib/engines/shadowTrader";
import type { MemoryEntry } from "@/lib/engines/patternMemory";
import type { PaperTrade } from "@/types";

// ── FOMO Blocks ───────────────────────────────────────────────────────────────

export async function syncFOMOBlock(block: FOMOBlock): Promise<void> {
  try {
    await supabase.from("fomo_blocks").upsert({
      id:                        block.id,
      timestamp:                 block.timestamp,
      symbol:                    block.symbol,
      chain:                     block.chain,
      pair_address:              block.pairAddress,
      price_at_block:            block.priceAtBlock,
      price_change_24h_at_block: block.priceChange24hAtBlock,
      reason:                    block.reason,
      outcome_1h_price:          block.outcome1h?.price,
      outcome_1h_pct:            block.outcome1h?.pct,
      outcome_1h_ts:             block.outcome1h?.timestamp,
      outcome_6h_price:          block.outcome6h?.price,
      outcome_6h_pct:            block.outcome6h?.pct,
      outcome_6h_ts:             block.outcome6h?.timestamp,
      outcome_24h_price:         block.outcome24h?.price,
      outcome_24h_pct:           block.outcome24h?.pct,
      outcome_24h_ts:            block.outcome24h?.timestamp,
    }, { onConflict: "id" });
     } catch { /* silent */ }
}

export async function syncAllFOMOBlocks(blocks: FOMOBlock[]): Promise<void> {
  if (!blocks.length) return;
  try {
    await supabase.from("fomo_blocks").upsert(
      blocks.map(b => ({
        id:                       b.id,
        timestamp:                b.timestamp,
        symbol:                   b.symbol,
        chain:                    b.chain,
        pair_address:             b.pairAddress,
        price_at_block:           b.priceAtBlock,
        price_change_24h_at_block: b.priceChange24hAtBlock,
        reason:                   b.reason,
        outcome_1h_price:         b.outcome1h?.price,
        outcome_1h_pct:           b.outcome1h?.pct,
        outcome_1h_ts:            b.outcome1h?.timestamp,
        outcome_6h_price:         b.outcome6h?.price,
        outcome_6h_pct:           b.outcome6h?.pct,
        outcome_6h_ts:            b.outcome6h?.timestamp,
        outcome_24h_price:        b.outcome24h?.price,
        outcome_24h_pct:          b.outcome24h?.pct,
        outcome_24h_ts:           b.outcome24h?.timestamp,
      })),
      { onConflict: "id" }
    );
  } catch {}
}

// ── Shadow Trades ─────────────────────────────────────────────────────────────

export async function syncShadowTrade(trade: ShadowTrade): Promise<void> {
  try {
    await supabase.from("shadow_trades").upsert({
      id:            trade.id,
      timestamp:     trade.timestamp,
      symbol:        trade.symbol,
      chain:         trade.chain,
      pair_address:  trade.pairAddress,
      token_address: trade.tokenAddress,
      entry_price:   trade.entryPrice,
      current_price: trade.currentPrice,
      edge_score:    trade.edgeScore,
      flag_count:    trade.flagCount,
      note:          trade.note,
      sl:            trade.sl,
      tp1:           trade.tp1,
      tp2:           trade.tp2,
      tp3:           trade.tp3,
      exited_at:     trade.exitedAt,
      exit_price:    trade.exitPrice,
      exit_reason:   trade.exitReason,
    }, { onConflict: "id" });
  } catch {}
}

export async function syncAllShadowTrades(trades: ShadowTrade[]): Promise<void> {
  if (!trades.length) return;
  try {
    await supabase.from("shadow_trades").upsert(
      trades.map(t => ({
        id:            t.id,
        timestamp:     t.timestamp,
        symbol:        t.symbol,
        chain:         t.chain,
        pair_address:  t.pairAddress,
        token_address: t.tokenAddress,
        entry_price:   t.entryPrice,
        current_price: t.currentPrice,
        edge_score:    t.edgeScore,
        flag_count:    t.flagCount,
        note:          t.note,
        sl:            t.sl,
        tp1:           t.tp1,
        tp2:           t.tp2,
        tp3:           t.tp3,
        exited_at:     t.exitedAt,
        exit_price:    t.exitPrice,
        exit_reason:   t.exitReason,
      })),
      { onConflict: "id" }
    );
  } catch {}
}

// ── Memory Entries ────────────────────────────────────────────────────────────
export async function syncMemoryEntry(entry: MemoryEntry): Promise<void> {
  try {
    await supabase.from("memory_entries").upsert({
      id:               entry.id,
      timestamp:        entry.timestamp,
      symbol:           entry.symbol,
      chain:            entry.chain,
      pair_address:     entry.pairAddress,
      entry_price:      entry.entryPrice,
      smart_score:      entry.smartScore,
      edge_score:       entry.edgeScore,
      edge_safety:      entry.edgeSafety,
      edge_can_enter:   entry.edgeCanEnter,
      ai_verdict:       entry.aiVerdict,
      ai_risk_score:    entry.aiRiskScore,
      ai_confidence:    entry.aiConfidence,
      is_honeypot:      entry.isHoneypot,
      buy_tax:          entry.buyTax,
      sell_tax:         entry.sellTax,
      holder_count:     entry.holderCount,
      goplus_available: entry.goplusAvailable,
      high_flags:       entry.highFlags,
      outcome_m30_price: entry.outcomes.m30?.price,
      outcome_m30_pct:   entry.outcomes.m30?.pct,
      outcome_h1_price:  entry.outcomes.h1?.price,
      outcome_h1_pct:    entry.outcomes.h1?.pct,
      outcome_h6_price:  entry.outcomes.h6?.price,
      outcome_h6_pct:    entry.outcomes.h6?.pct,
      outcome_h24_price: entry.outcomes.h24?.price,
      outcome_h24_pct:   entry.outcomes.h24?.pct,
    }, { onConflict: "id" });
  } catch {}
}

export async function syncPaperTrade(trade: PaperTrade): Promise<void> {
  try {
    await supabase.from("paper_trades").upsert({
      id:           String(trade.id),
      timestamp:    trade.entryTime,
      symbol:       trade.symbol,
      chain:        trade.chain,
      address:      trade.address,
      pair_address: trade.pairAddress,
      entry_price:  trade.entryPrice,
      current_price: trade.currentPrice,
      entry_time:   trade.entryTime,
      score:        trade.score,
      flag_count:   trade.flagCount,
      note:         trade.note,
      sl:           trade.sl,
      tp1:          trade.tp1,
      tp2:          trade.tp2,
      tp3:          trade.tp3,
      exited_at:    trade.exitedAt,
      exit_price:   trade.exitPrice,
      exit_reason:  trade.exitReason,
    }, { onConflict: "id" });
  } catch {}
}