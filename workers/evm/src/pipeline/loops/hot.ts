/**
 * pipeline/loops/hot.ts
 * HOT candidates loop — decide intrarea finală în shadow trade.
 * Monitor open trades — verifică exit conditions.
 */

import { hotCandidates, v4PoolMap, v3PoolMap, memory, qualifiedSignalsBuffer } from "../../state/stores";
import { dropHotCandidate, deleteHotCandidate, recordPipelineEvent } from "../transitions";
import { recordLifecycleOutcome } from "../../state/lifecycle";
import { getWsFlow, getLpSignal } from "../../risk/flow";
import { getLiquidityContext } from "../../risk/liquidity";
import { quickEdgeScore } from "../../risk/scoring";
import { getEntryGate } from "../../risk/gates";
import { fetchPoolByAddress } from "../../sources/gecko";
import { supabase } from "../../infra/supabase";
import { CHAINS } from "../../config/chains";
import { WORKER_VERSION, MAX_QUALIFIED_BUFFER } from "../../config/constants";
import { isBlockedSymbol } from "../../sources/normalize";
import { buildQualifiedSignalEntry } from "../../lib/preflight-redis";
import type { FlowSignal } from "../../lib/engines/flowTypes";
import type { SourcePool } from "../../sources/normalize";
import { updateOutcomes } from "../../shadow/trades";

let processingHot     = false;
let monitoringTrades  = false;

export async function hotCandidatesLoop(): Promise<void> {
  if (processingHot || !hotCandidates.size) return;
  processingHot = true;

  try {
    for (const [{ chain: chainId, address: pairAddress }, { promotedAt, source }] of hotCandidates.entries()) {
      if (Date.now() - promotedAt > 5 * 60_000) {
        dropHotCandidate(pairAddress, chainId, "hot expired after 5m"); continue;
      }

      const chainCfg = CHAINS.find(c => c.id === chainId);
      if (!chainCfg) { dropHotCandidate(pairAddress, chainId, "chain config missing"); continue; }

      const mem = memory.get(chainId, pairAddress);
      if (!mem)                  { dropHotCandidate(pairAddress, chainId, "memory missing"); continue; }
      if (isBlockedSymbol(mem.symbol)) { dropHotCandidate(pairAddress, chainId, "blocked asset"); continue; }

      const flow = getWsFlow(chainId, pairAddress);
      const lp   = getLpSignal(chainId, pairAddress);

      const minHotBuys =
        source === "VERTICAL" ? 2 :
        source === "FOMO" || source === "LATE" ? 3 : 5;

      const hotFlowPressure = (source === "VERTICAL" && (flow as any).pressure1m)
        ? (flow as any).pressure1m
        : flow.pressure;

      const effectiveFlow: FlowSignal =
        source === "VERTICAL" && (flow as any).pressure1m
          ? { ...flow, pressure: (flow as any).pressure1m as "BUYING" | "SELLING" | "NEUTRAL" }
          : flow;

      if (!flow.hasData || hotFlowPressure !== "BUYING" || flow.buys5m < minHotBuys) {
        console.log(`[HOT SKIP] ${mem.symbol} — no buying flow...`);
        dropHotCandidate(pairAddress, chainId, `flow faded: ${hotFlowPressure} buys:${flow.buys5m}/${minHotBuys}`);
        continue;
      }

      if (Date.now() - promotedAt < 30_000) {
        console.log(`[HOT WAIT] ${mem.symbol} — too fresh (${Math.round((Date.now() - promotedAt) / 1000)}s)`);
        continue;
      }

      // Do not gate HOT candidates on shadow_trades.
      // Preflight is a data layer; shadow trades are telemetry only.
      // saveShadowTrade() still dedupes persistence after the signal is emitted.

      const pool = v4PoolMap.get(chainId, pairAddress) ?? v3PoolMap.get(chainId, pairAddress) ?? await fetchPoolByAddress(chainCfg, pairAddress);
      if (!pool) { dropHotCandidate(pairAddress, chainId, "pool unavailable"); continue; }

      const score = quickEdgeScore(pool, mem, effectiveFlow, lp);
      const minHotScore =
        source === "VERTICAL" ? 70 :
        source === "FOMO" || source === "LATE" ? 75 : 80;

      if (score < minHotScore) {
        console.log(`[HOT LOW SCORE] ${mem.symbol} — score:${score}/${minHotScore}...`);
        dropHotCandidate(pairAddress, chainId, `low score: ${score}/${minHotScore}`);
        continue;
      }

      const gate = getEntryGate(mem, effectiveFlow, lp, score, source ?? "WS");
      if (!gate.allowed) {
        console.log(`[HOT GATE] ${mem.symbol} — ${gate.reason}...`);
        dropHotCandidate(pairAddress, chainId, `gate: ${gate.reason}`);
        continue;
      }

      console.log(`[HOT] ${mem.symbol} (${chainId}) — source:${source ?? "WS"} Edge ${score}`);
      recordPipelineEvent("ARM_CONFIRMED", mem.symbol, chainId, pairAddress, "HOT", "CONFIRMED");
      recordLifecycleOutcome(chainId, pairAddress, "QUALIFIED_EMITTED", "HOT", "HOT_CONFIRMED: gate + flow held");

      const liqCtx = getLiquidityContext(chainId, pairAddress);
      const qsHot  = buildQualifiedSignalEntry({
        symbol:        mem.symbol,
        chain:         chainId,
        pairAddress,
        qualifiedAt:   Date.now(),
        flow: {
          pressure: effectiveFlow.pressure,
          hasData:  effectiveFlow.hasData,
          buyVol5m: (effectiveFlow as any).buyVol5m ?? 0,
          netVol5m: (effectiveFlow as any).netVol5m ?? 0,
          buys5m:   effectiveFlow.buys5m ?? 0,
          sells5m:  effectiveFlow.sells5m ?? 0,
        },
        reserveUsd:    liqCtx.reserveUsd,
        liqStatus:     liqCtx.status,
        riskFlags:     [],
        phase:         mem.phase,
        workerVersion: WORKER_VERSION,
      });
      qualifiedSignalsBuffer.unshift(qsHot);
      if (qualifiedSignalsBuffer.length > MAX_QUALIFIED_BUFFER) qualifiedSignalsBuffer.pop();

      deleteHotCandidate(pairAddress, chainId);
    }
  } finally {
    processingHot = false;
  }
}

export async function monitorOpenTrades(): Promise<void> {
  if (monitoringTrades) return;
  monitoringTrades = true;

  try {
    const { data: trades } = await supabase
      .from("shadow_trades").select("id, chain, pair_address")
      .is("exited_at", null);

    if (!trades?.length) return;

    const pools: SourcePool[] = [];

    for (const trade of trades) {
      if (!trade.chain || !trade.pair_address) continue;
      const chainCfg = CHAINS.find(c => c.id === trade.chain || c.gecko === trade.chain);
      if (!chainCfg) continue;
      const pool =
        v4PoolMap.get(chainCfg.id, trade.pair_address) ??
        v3PoolMap.get(chainCfg.id, trade.pair_address) ??
        await fetchPoolByAddress(chainCfg, trade.pair_address);
      if (pool) pools.push(pool);
    }

    // updateOutcomes disabled — shadow trades are telemetry only.
  } finally {
    monitoringTrades = false;
  }
}
