/**
 * events/momentum.ts
 * Înregistrează momentum events în Redis buffer și Supabase.
 */

import type { SourcePool } from "../sources/normalize";
import type { PreflightMomentumEvent } from "@preflight/schema";
import { pushMomentumEvent } from "../state/stores";
import { supabase } from "../infra/supabase";
import { WORKER_VERSION } from "../config/constants";

export async function recordMomentumEvent(
  pool:  SourcePool,
  event: PreflightMomentumEvent,
): Promise<void> {
  const symbol = pool.symbol;

  // Actualizează buffer live pentru preflight:momentum_events
  pushMomentumEvent(event);

  // Supabase dedupe — skip dacă deja înregistrat în ultima oră
  const { data: existing } = await supabase
    .from("fomo_blocks").select("id")
    .eq("pair_address", pool.pairAddress)
    .gte("timestamp", Date.now() - 60 * 60_000)
    .limit(1);

  if (existing && existing.length > 0) return;

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  await supabase.from("fomo_blocks").insert({
    id,
    timestamp:                 Date.now(),
    symbol,
    worker_version:            WORKER_VERSION,
    chain:                     pool.chain,
    pair_address:              pool.pairAddress,
    price_at_block:            pool.priceUsd,
    price_change_24h_at_block: pool.priceChange.h24,
    reason:                    event.reason,
    verdict:                   event.verdict,
    momentum_level:            event.momentumLevel,
    entry_risk:                event.entryRisk,
    worker_observation:        event.workerObservation,
  });

  console.log(`[MOMENTUM] ${symbol} (${pool.chain}) — ${event.verdict}: ${event.reason}`);
}
