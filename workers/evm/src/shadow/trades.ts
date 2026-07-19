/**
 * shadow/trades.ts
 * Shadow trade lifecycle — save la intrare, update outcomes la fiecare scan.
 */

import type { SourcePool } from "../sources/normalize";
import type { PairMemoryEntry } from "../lib/engines/pairMemory";
import type { FlowSignal, LiquiditySignal } from "../lib/engines/flowTypes";
import { detectSecondWave } from "../lib/engines/secondWave";
import { getLiquidityContext } from "../risk/liquidity";
import { getWsFlow, getLpSignal } from "../risk/flow";
import { supabase } from "../infra/supabase";
import { sendTelegram } from "../infra/telegram";
import { fetchPoolByAddress } from "../sources/gecko";
import { memory, v3PoolMap } from "../state/stores";
import { CHAINS } from "../config/chains";
import { WORKER_VERSION, MAX_HOLD_MS } from "../config/constants";
import type { EntrySource } from "../state/stores";

export async function saveShadowTrade(
  pool:        SourcePool,
  score:       number,
  mem:         PairMemoryEntry,
  flow:        FlowSignal,
  lp:          LiquiditySignal,
  entrySource: EntrySource = "SCAN",
): Promise<void> {
  const pairAddr = pool.pairAddress;

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
  const isV3note = !isV4note && v3PoolMap.has(pool.chain, pairAddr);
  const dexType  = isV4note ? "V4" : isV3note ? "V3" : "V2";
  const price    = pool.priceUsd > 0 ? pool.priceUsd : mem.currentPrice;
  if (pool.priceUsd > 0) mem.currentPrice = pool.priceUsd;

  const id  = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const sw  = detectSecondWave(mem, flow);
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
    `source:${entrySource}`,
    `W${mem.wins24h}/L${mem.losses24h}`,
  ].filter(Boolean).join(" | ");

  const slPrice =
    entrySource === "VERTICAL" ? price * 0.88 :
    entrySource === "LATE"     ? price * 0.90 :
    price * (1 - (score >= 80 ? 0.15 : 0.18));

  const reserveAtEntry = liq.reserveUsd;
  const tp1Multiplier =
    entrySource === "VERTICAL" ? 1.15 :
    entrySource === "LATE"     ? 1.12 :
    reserveAtEntry >= 1_000_000 ? 1.08 :
    reserveAtEntry >= 300_000   ? 1.10 :
    !flow.hasData               ? 1.10 :
    flow.pressure === "BUYING"  ? 1.18 :
    flow.pressure === "NEUTRAL" ? 1.12 :
    flow.pressure === "SELLING" ? 1.08 :
    1.15;

  const { error: insertError } = await supabase.from("shadow_trades").insert({
    id, timestamp: Date.now(),
    symbol:         mem.symbol,
    worker_version: WORKER_VERSION,
    chain:          pool.chain,
    pair_address:   pairAddr,
    token_address:  mem.tokenAddress,
    entry_price:    price, current_price: price,
    edge_score:     score, flag_count: 0, note,
    sl:  slPrice,
    tp1: price * tp1Multiplier,
    tp2: price * (score >= 80 ? 2.00 : 1.75),
    tp3: price * (score >= 80 ? 4.00 : 3.00),
  });

  if (insertError) {
    console.error(`[DB INSERT ERROR] ${mem.symbol} — ${insertError.message}`);
    return;
  }

  mem.totalEntries += 1; mem.lastEntryTime = Date.now(); mem.lastEntryPrice = price;
  memory.set(pairAddr, mem);

  const emoji =
    entrySource === "VERTICAL" ? "🚀" :
    entrySource === "LATE"     ? "🔄" :
    mem.phase === "SECOND_WAVE" ? "🌊" :
    mem.phase === "RECOVERING"  ? "⚡" : "👁";

  console.log(`[SHADOW] ${mem.symbol} (${pool.chain}) Edge ${score} | ${mem.phase} | flow:${flow.pressure} | lp:${lp.status}`);
  await sendTelegram(
    `${emoji} <b>SHADOW</b> ${mem.symbol} [${pool.chain.toUpperCase()}]\n`
    + `Edge ${score} | ${mem.phase} | flow:${flow.pressure}\n`
    + `Source: ${entrySource} | LP: ${lp.hasData ? lp.status : "unknown"} | W${mem.wins24h}/L${mem.losses24h}\n`
    + (sw.isSecondWave ? `🌊 Second Wave ${sw.score}/100 (${sw.confidence})\n` : "")
    + `seen:${mem.seenCount}x`,
  );
}

export async function updateOutcomes(pools: SourcePool[]): Promise<void> {
  const priceMap = new Map<string, number>();
  pools.forEach(p => priceMap.set(p.pairAddress, p.priceUsd));

  // FOMO blocks
  const { data: blocks } = await supabase
    .from("fomo_blocks").select("*")
    .is("outcome_1h_price", null)
    .gte("timestamp", Date.now() - 24 * 3600_000);

  if (blocks) {
    for (const b of blocks) {
      let price = priceMap.get(b.pair_address?.toLowerCase());
      if (!price) {
        const chainCfg = CHAINS.find(c => c.id === b.chain || c.gecko === b.chain);
        if (chainCfg) {
          const fetched = await fetchPoolByAddress(chainCfg, b.pair_address);
          if (fetched) price = fetched.priceUsd;
        }
      }
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
    const lp     = getLpSignal(trade.pair_address);
    const update: Record<string, unknown> = { current_price: price };
    const mem    = memory.get(trade.pair_address?.toLowerCase());
    const entry  = Number(trade.entry_price);
    const priceDrop = (entry - price) / entry;

    if (lp.hasData && lp.status === "REMOVED" && lp.lpRemoved5m > 0.5) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "LP REMOVED";
      if (mem) { mem.badExits24h += 1; mem.consecutiveLosses += 1; mem.lastExitReason = "LP REMOVED"; mem.lastExitTime = Date.now(); }
      console.log(`[LP EXIT] ${trade.symbol} — LP removed ${lp.lpRemoved5m.toFixed(3)} ETH`);
      await sendTelegram(`⚠️ <b>LP REMOVED</b> ${trade.symbol} [${trade.chain?.toUpperCase()}]\nLP removed ${lp.lpRemoved5m.toFixed(3)} ETH in 5m\nP&L: ${((price - entry) / entry * 100).toFixed(1)}%`);

    } else if (priceDrop > 0.90) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "RUGPULL";
      if (mem) { mem.badExits24h += 1; mem.consecutiveLosses += 1; mem.lastExitReason = "RUGPULL"; mem.lastExitTime = Date.now(); }
      console.log(`[RUGPULL] ${trade.symbol} — price dropped ${(priceDrop * 100).toFixed(0)}%`);
      await sendTelegram(`☠️ <b>RUGPULL</b> ${trade.symbol} [${trade.chain?.toUpperCase()}]\nPrice dropped ${(priceDrop * 100).toFixed(0)}%\nEntry: ${entry.toExponential(3)} → Exit: ${price.toExponential(3)}`);

    } else if (price >= trade.tp1) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "TP1 hit";
      if (mem) { mem.wins24h += 1; mem.consecutiveLosses = 0; mem.lastExitReason = "TP1 hit"; mem.lastExitTime = Date.now(); }
      await sendTelegram(`🟢 <b>TP1 HIT</b> ${trade.symbol} [${trade.chain?.toUpperCase()}]\nEntry: ${entry.toExponential(3)} → Exit: ${price.toExponential(3)}\nP&L: +${((price - entry) / entry * 100).toFixed(1)}%`);

    } else if (price <= trade.sl) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "SL hit";
      if (mem) { mem.losses24h += 1; mem.consecutiveLosses += 1; mem.lastExitReason = "SL hit"; mem.lastExitTime = Date.now(); }
      await sendTelegram(`🔴 <b>SL HIT</b> ${trade.symbol} [${trade.chain?.toUpperCase()}]\nEntry: ${entry.toExponential(3)} → Exit: ${price.toExponential(3)}\nP&L: ${((price - entry) / entry * 100).toFixed(1)}%`);

    } else if ((() => {
      const pnlPct  = (price - entry) / entry;
      const liqCtx  = mem ? getLiquidityContext(mem.pairAddress) : { reserveUsd: 0, status: "MISSING" as const };
      const isLarge = liqCtx.reserveUsd >= 500_000;
      return flow.hasData &&
        flow.pressure === "SELLING" &&
        ((flow as any).sellVol5m ?? 0) >= (isLarge ? 0.30 : 0.05) &&
        ((flow as any).netVol5m  ?? 0) <= (isLarge ? -0.25 : -0.05) &&
        ageMs > 15 * 60_000 &&
        pnlPct <= (isLarge ? -0.025 : 0);
    })()) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "SELL PRESSURE";
      if (mem) { mem.badExits24h += 1; mem.lastExitReason = "SELL PRESSURE"; mem.lastExitTime = Date.now(); }
      console.log(`[FLOW EXIT] ${trade.symbol} — sellVol:${((flow as any).sellVol5m ?? 0).toFixed(3)} netVol:${((flow as any).netVol5m ?? 0).toFixed(3)}`);

    } else if (ageMs > (() => {
      const src =
        (trade.note ?? "").includes("source:VERTICAL") ? "VERTICAL" :
        (trade.note ?? "").includes("source:LATE")     ? "LATE" : "NORMAL";
      return src === "VERTICAL" || src === "LATE" ? 60 * 60_000 : MAX_HOLD_MS;
    })()) {
      update.exited_at = Date.now(); update.exit_price = price; update.exit_reason = "MAX HOLD";
      if (mem) { mem.badExits24h += 1; mem.lastExitReason = "MAX HOLD"; mem.lastExitTime = Date.now(); }
      const holdLabel = (trade.note ?? "").includes("source:VERTICAL") || (trade.note ?? "").includes("source:LATE") ? "1h" : "4h";
      console.log(`[ZOMBIE KILL] ${trade.symbol} held ${holdLabel} with no exit`);
      await sendTelegram(`💀 <b>ZOMBIE KILL</b> ${trade.symbol} — held ${holdLabel}, no exit`);
    }

    const { error: updateError } = await supabase
      .from("shadow_trades").update(update).eq("id", trade.id);
    if (updateError) {
      console.error(`[DB UPDATE ERROR] ${trade.symbol} — ${updateError.message}`);
    }
  }
}
