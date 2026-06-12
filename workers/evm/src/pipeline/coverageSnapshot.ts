/**
 * pipeline/coverageSnapshot.ts
 * Scrie preflight:pipeline_coverage în Redis.
 * Observability only — nu schimbă nicio logică de watch/pipeline.
 */

import type { Redis } from "ioredis";
import { CHAINS } from "../config/chains";
import {
  memory, activeWatch, hotCandidates, armedEntries,
  qualifiedSignalsBuffer,
} from "../state/stores";
import { getWsFlow } from "../risk/flow";
import { WORKER_VERSION } from "../config/constants";

const MOVER_M5_THRESHOLD  = 5;
const MOVER_H1_THRESHOLD  = 15;
const MOVER_H24_THRESHOLD = 40;
const MOVER_LIQ_MIN_USD   = 5_000;
const TOP_UNSUBSCRIBED_N  = 10;

const moverScore = (pc: any) => Math.max(
  Math.abs(pc?.m5  ?? 0),
  Math.abs(pc?.h1  ?? 0) / 3,
  Math.abs(pc?.h24 ?? 0) / 8,
);

export async function writeCoverageSnapshot(r: Redis, states: Record<string, any>): Promise<void> {
  const now    = Date.now();
  const chains: Record<string, any> = {};

  for (const chain of CHAINS) {
    const chainId = chain.id;

    // ── Toate perechile urmărite pe acest chain — din pair_states (sursa de adevăr) ──
    const allPairs = Object.entries(states).filter(([, s]) =>
      (s.chain ?? "").toLowerCase() === chainId
    );

    // ── Observed movers — aceeași logică ca tp_situation_report ──────────────
    const observedMovers = allPairs.filter(([, s]) => {
      const pc = s.priceChange;
      if (!pc) return false;
      if ((s.reserveUsd ?? 0) < MOVER_LIQ_MIN_USD) return false;
      return (
        Math.abs(pc.m5  ?? 0) >= MOVER_M5_THRESHOLD  ||
        Math.abs(pc.h1  ?? 0) >= MOVER_H1_THRESHOLD  ||
        Math.abs(pc.h24 ?? 0) >= MOVER_H24_THRESHOLD
      );
    });

    // ── Pipeline counts per chain ─────────────────────────────────────────
    const watching   = [...activeWatch.entries()].filter(([, w]) => w.chain === chainId);
    const hot        = [...hotCandidates.entries()].filter(([, h]) => h.chain === chainId);
    const armed = [...armedEntries.entries()].filter(([addr, info]) => {
    const mem = memory.get(addr);
    return (info.chain ?? mem?.chain ?? "") === chainId;
  });
    const gatePassed = qualifiedSignalsBuffer.filter(q => q.chain === chainId);

    // ── WS flow stats ─────────────────────────────────────────────────────
    const watchingWithFlow = watching.filter(([addr]) => getWsFlow(addr).hasData);
    const hotWithFlow      = hot.filter(([addr]) => getWsFlow(addr).hasData);
    // fix #3: coverageOnPipelinePct
    const armedWithFlow    = armed.filter(([addr]) => getWsFlow(addr).hasData);
    const pipelineTotal    = watching.length + hot.length + armed.length;
    const pipelineWithFlow = watchingWithFlow.length + hotWithFlow.length + armedWithFlow.length;

    // fix #2: redenumit expectedWsSubscriptions — nu e set real de WS subs
    const expectedWsSubscriptions =
      watching.length + hot.filter(([addr]) => !activeWatch.has(addr)).length;

    // ── Movers breakdown ──────────────────────────────────────────────────
    const moversInPipeline = observedMovers.filter(([addr]) =>
      activeWatch.has(addr) || hotCandidates.has(addr) || armedEntries.has(addr)
    );
    const moversWithFlow      = observedMovers.filter(([addr]) => getWsFlow(addr).hasData);
    const moversNotInPipeline = observedMovers.filter(([addr]) =>
      !activeWatch.has(addr) && !hotCandidates.has(addr) && !armedEntries.has(addr)
    );

    // ── Top movers NOT in pipeline ─────────────────────────────────────────
    const topMoversNotWatched = moversNotInPipeline
      .sort(([, a], [, b]) => {
        const pcA = (a as any).priceChange;
        const pcB = (b as any).priceChange;
        return moverScore(pcB) - moverScore(pcA);
      })
      .slice(0, TOP_UNSUBSCRIBED_N)
      .map(([addr, s]) => {
        const pc = s.priceChange;
        return {
          symbol:      s.symbol,
          pairAddress: addr,
          m5:          pc?.m5  ?? 0,
          h1:          pc?.h1  ?? 0,
          h24:         pc?.h24 ?? 0,
          reserveUsd:  s.reserveUsd ?? 0,
          phase:       s.phase,
          reason:      "not_in_pipeline",
        };
      });

    chains[chainId] = {
      trackedPairs:    allPairs.length,
      observedMovers:  observedMovers.length,
      pipeline: {
        watching:   watching.length,
        hot:        hot.length,
        armed:      armed.length,
        gatePassed: gatePassed.length,
      },
      ws: {
        // fix #2: chiar e estimare, nu set real
        expectedWsSubscriptions,
        watchingWithFlow:      watchingWithFlow.length,
        hotWithFlow:           hotWithFlow.length,
        armedWithFlow:         armedWithFlow.length,
        coverageOnWatchPct:    watching.length
          ? Math.round(watchingWithFlow.length / watching.length * 100)
          : 0,
        // fix #3: coverage pe întreg pipeline
        coverageOnPipelinePct: pipelineTotal
          ? Math.round(pipelineWithFlow / pipelineTotal * 100)
          : 0,
      },
      observedMoverCoverage: {
        total:         observedMovers.length,
        inPipeline:    moversInPipeline.length,
        withFlow:      moversWithFlow.length,
        notInPipeline: moversNotInPipeline.length,
      },
      topMoversNotWatched,
    };
  }

  await r.set("preflight:pipeline_coverage", JSON.stringify({
    workerVersion: WORKER_VERSION,
    savedAt:       now,
    chains,
  }), "EX", 120);
}