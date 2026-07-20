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
import { REDIS_KEYS, type PreflightPipelineCoverage, type PreflightChainCoverage } from "@preflight/schema";
import type { PairStateSnapshot } from "../state/pairStates";

const MOVER_M5_THRESHOLD  = 5;
const MOVER_H1_THRESHOLD  = 15;
const MOVER_H24_THRESHOLD = 40;
const MOVER_LIQ_MIN_USD   = 5_000;
const TOP_UNSUBSCRIBED_N  = 10;

const moverScore = (pc: { m5: number; h1: number; h24: number }) => Math.max(
  Math.abs(pc.m5),
  Math.abs(pc.h1) / 3,
  Math.abs(pc.h24) / 8,
);

// `states` was `Record<string, any>` before — buildPairStates() (the only
// real caller, via snapshots.ts) already returns Record<string,
// PairStateSnapshot>, so this was type laziness, not a genuine
// unknown-shape need.
export async function writeCoverageSnapshot(r: Redis, states: Record<string, PairStateSnapshot>): Promise<void> {
  const now    = Date.now();
  const chains: Record<string, PreflightChainCoverage> = {};

  for (const chain of CHAINS) {
    const chainId = chain.id;

    // ── Toate perechile urmărite pe acest chain — din pair_states (sursa de adevăr) ──
    // B3f-1: `states` e keyed pe pairKey(chain, addr) → cheia NU mai e adresa brută.
    // Lucrăm pe VALORI; identitatea perechii e `s.pairAddress` (adresă brută) + `s.chain`.
    const allPairs = Object.values(states).filter(s =>
      (s.chain ?? "").toLowerCase() === chainId
    );

    // ── Observed movers — aceeași logică ca tp_situation_report ──────────────
    const observedMovers = allPairs.filter(s => {
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
    const watching   = [...activeWatch.entries()].filter(([{ chain }]) => chain === chainId);
    const hot        = [...hotCandidates.entries()].filter(([{ chain }]) => chain === chainId);
    const armed = [...armedEntries.entries()].filter(([{ chain }]) => chain === chainId);
    const qualified = qualifiedSignalsBuffer.filter(q => q.chain === chainId);

    // ── WS flow stats ─────────────────────────────────────────────────────
    const watchingWithFlow = watching.filter(([{ chain, address: addr }]) => getWsFlow(chain, addr).hasData);
    const hotWithFlow      = hot.filter(([{ chain, address: addr }]) => getWsFlow(chain, addr).hasData);
    const armedWithFlow    = armed.filter(([{ chain, address: addr }]) => getWsFlow(chain, addr).hasData);

    // fix #4: watching/hot/armed pot conține aceeași adresă (ex: HOT rămâne
    // și în activeWatch până la cleanup) — watching.length+hot.length+
    // armed.length număra acea pereche de 2-3 ori, umflând artificial
    // coverageOnPipelinePct. Deduplicat pe adresă.
    const pipelineAddresses = new Set<string>([
      ...watching.map(([{ address }]) => address),
      ...hot.map(([{ address }]) => address),
      ...armed.map(([{ address }]) => address),
    ]);
    const pipelineTotal    = pipelineAddresses.size;
    const pipelineWithFlow = [...pipelineAddresses].filter(addr => getWsFlow(chainId, addr).hasData).length;

    // fix #2: redenumit expectedWsSubscriptions — nu e set real de WS subs
    const expectedWsSubscriptions =
      watching.length + hot.filter(([{ chain, address: addr }]) => !activeWatch.has(chain, addr)).length;

    // ── Movers breakdown ──────────────────────────────────────────────────
    const moversInPipeline = observedMovers.filter(s =>
      activeWatch.has(chainId, s.pairAddress) || hotCandidates.has(chainId, s.pairAddress) || armedEntries.has(chainId, s.pairAddress)
    );
    const moversWithFlow      = observedMovers.filter(s => getWsFlow(chainId, s.pairAddress).hasData);
    const moversNotInPipeline = observedMovers.filter(s =>
      !activeWatch.has(chainId, s.pairAddress) && !hotCandidates.has(chainId, s.pairAddress) && !armedEntries.has(chainId, s.pairAddress)
    );

    // ── Top movers NOT in pipeline ─────────────────────────────────────────
    const topMoversNotWatched = moversNotInPipeline
      .sort((a, b) => moverScore(b.priceChange) - moverScore(a.priceChange))
      .slice(0, TOP_UNSUBSCRIBED_N)
      .map(s => {
        const pc = s.priceChange;
        return {
          symbol:      s.symbol,
          pairAddress: s.pairAddress,
          m5:          pc.m5,
          h1:          pc.h1,
          h24:         pc.h24,
          reserveUsd:  s.reserveUsd ?? 0,
          phase:       s.phase,
          reason:      "not_in_pipeline" as const,
        };
      });

    chains[chainId] = {
      trackedPairs:    allPairs.length,
      observedMovers:  observedMovers.length,
      pipeline: {
        watching:  watching.length,
        hot:       hot.length,
        armed:     armed.length,
        qualified: qualified.length,
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

  // B4c: pipeline_coverage chain-scoped — o cheie per-chain, fiecare cu doar
  // sub-obiectul `chains` al ei. `chains` conține deja doar chain-urile runtime-ului
  // (bucla peste CHAINS de mai sus) → ownership curat, un worker scrie doar cheile lui.
  const pipe = r.pipeline();
  for (const { id: chainId } of CHAINS) {
    const snapshot: PreflightPipelineCoverage = {
      workerVersion: WORKER_VERSION,
      savedAt:       now,
      chains:        { [chainId]: chains[chainId] },
    };
    pipe.set(REDIS_KEYS.pipelineCoverage(chainId), JSON.stringify(snapshot), "EX", 120);
  }
  await pipe.exec();
}
