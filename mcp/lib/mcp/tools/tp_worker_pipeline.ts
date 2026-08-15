import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis } from "../redis-reader";
import { normalizeChainId, pairKey, splitPairKey } from "@preflight/schema";
import type { PreflightSignalPipelineEntry } from "@preflight/schema";
import { mcpResponse, mcpErr, ERR, sanitizeToolError } from "../errors";

export function registerWorkerPipeline(server: McpServer) {
  server.registerTool(
    "tp_worker_pipeline",
    {
      title: "Preflight Worker Pipeline",
      description: `Get the live internal pipeline of the worker.

Shows all pairs moving through the worker's decision flow:
- WATCHING: subscribed via WS, accumulating flow (kind: NORMAL/FOMO/VERTICAL/LATE)
- HOT: promoted candidates with confirmed buying flow
- ARMED: qualification criteria observed, awaiting 30s price confirmation

Args: chain (filter: 'base', 'arbitrum', 'bsc', or 'eth')`,
      inputSchema: {
        // A1 (obs ChatGPT): enum, nu string liber — un chain necunoscut ("banana")
        // era acceptat și întorcea pipeline gol, ceea ce părea un rezultat valid.
        // Codurile publice; normalizeChainId mapează "eth"→"ethereum" intern la filtrare.
        chain: z.enum(["base", "arbitrum", "bsc", "eth"]).optional().describe("Filter by chain: 'base', 'arbitrum', 'bsc', or 'eth'"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ chain }: { chain?: string }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, watch, hot, armed, states, pfPipeline, pfQualified } = ctx;
        // A1: normalize both sides — producer stores "ethereum", user may pass
        // "eth" (or any casing). Without this, chain:"eth" returns an empty pipeline.
        const wantChain    = chain ? normalizeChainId(chain) : null;
        const filterChain  = (c: string | null | undefined) =>
          !wantChain || (c != null && normalizeChainId(c) === wantChain);
        const firstState   = Object.values(states)[0];
        const freshnessSec = firstState ? Math.round((now - firstState.updatedAt) / 1000) : null;

        const activeWatch = Object.entries(watch)
          .filter(([, v]) => filterChain(v.chain))
          .map(([key, v]) => {
            const addr = splitPairKey(key).address; // cheia e pairKey → adresa brută
            return {
            pairAddress: addr, symbol: v.symbol ?? addr.slice(0, 10) + "...",
            chain: v.chain, kind: v.kind,
            ageMin:          Math.round((now - v.addedAt) / 60_000 * 10) / 10,
            entryPrice:      v.entryPrice,
            priceVsEntryPct: v.priceVsEntryPct ?? null,
            reason: v.reason, phase: v.phase,
            buySwapCount5m:  v.buySwapCount5m,
            sellSwapCount5m: v.sellSwapCount5m,
            largestBuyEth:   v.largestBuyEth,
          }; })
          .sort((a, b) => a.ageMin - b.ageMin);

        const hotCandidates = Object.entries(hot)
          .filter(([, v]) => filterChain(v.chain))
          .map(([key, v]) => {
            const addr = splitPairKey(key).address;
            return {
            pairAddress: addr, symbol: v.symbol ?? addr.slice(0, 10) + "...",
            chain: v.chain, source: v.source ?? "WS",
            ageSec:         Math.round((now - v.promotedAt) / 1000),
            phase:          v.phase, flow: v.flow,
            largestBuyEth:  v.largestBuyEth,
            buySwapCount5m: v.buySwapCount5m,
          }; })
          .sort((a, b) => a.ageSec - b.ageSec);

        const armedEntries = Object.entries(armed)
          .filter(([, v]) => filterChain(v.chain ?? ""))
          .map(([key, v]) => {
            const addr = splitPairKey(key).address;
            return {
            pairAddress: addr, symbol: v.symbol ?? addr.slice(0, 10) + "...",
            ageSec:       Math.round((now - v.armedAt) / 1000),
            price: v.price, score: v.score, flowPressure: v.flowPressure,
            phase: v.phase, chain: v.chain,
          }; })
          .sort((a, b) => a.ageSec - b.ageSec);
		  
		  const enrichFlowWithUsd = (chain: string | undefined, pairAddress: string | undefined, flow: PreflightSignalPipelineEntry["flow"] | null | undefined) => {
          const addr = pairAddress?.toLowerCase?.() ?? "";
          // B3f-2: states e keyed pe pairKey → construiește cheia cu chain-ul entry-ului.
          const ps   = (chain && addr) ? states[pairKey(chain, addr)]?.flow ?? null : null;

          return {
            ...(flow ?? {}),
            buyVol5mUsd:  ps?.buyVol5mUsd  ?? null,
            sellVol5mUsd: ps?.sellVol5mUsd ?? null,
            netVol5mUsd:  ps?.netVol5mUsd  ?? null,
          };
        };
		  
		  // Preflight pipeline entries (richer context)
        const pfEntries = pfPipeline && pfPipeline.length > 0
          ? pfPipeline
              .filter(e => filterChain(e.chain))
              .map(e => ({
              symbol:            e.symbol,
              chain:             e.chain,
              pairAddress:       e.pairAddress,
              pipelineState:     e.pipelineState,
              watchKind:         e.watchKind,
              watchAgeMin:       Math.round(e.watchAgeMs / 60_000 * 10) / 10,
              confidence:        e.confidence,
              entryRisk:         e.entryRisk,
              flow:              enrichFlowWithUsd(e.chain, e.pairAddress, e.flow),
              riskFlags:         e.riskFlags,
              opportunitySignals: e.opportunitySignals,
              priceVsEntryPct:   e.priceVsEntryPct,
              workerObservation: e.workerObservation,
            }))
          : null;

		  
		  const armedPipelineEntries = armedEntries.map(a => ({
          symbol:             a.symbol,
          chain:              a.chain,
          pairAddress:        a.pairAddress,
          pipelineState:      "ARMED",
          watchKind:          null,
          watchAgeMin:        null,
          confidence:         null,
          entryRisk:          null,
          flow: (() => {
            const addr = a.pairAddress?.toLowerCase?.() ?? "";
            const ps   = (a.chain && addr) ? states[pairKey(a.chain, addr)]?.flow ?? null : null;

            return {
              status:       ps?.pressure    ?? a.flowPressure ?? null,
              hasData:      ps?.hasData     ?? null,
              buyVol5m:     ps?.buyVol5m    ?? null,
              sellVol5m:    ps?.sellVol5m   ?? null,
              netVol5m:     ps?.netVol5m    ?? null,
              buys5m:       ps?.buys5m      ?? null,
              sells5m:      ps?.sells5m     ?? null,
              buyVol5mUsd:  ps?.buyVol5mUsd  ?? null,
              sellVol5mUsd: ps?.sellVol5mUsd ?? null,
              netVol5mUsd:  ps?.netVol5mUsd  ?? null,
            };
          })(),
          riskFlags:          [],
          opportunitySignals: ["ARMED_STATE_OBSERVED"],
          priceVsEntryPct:    null,
          workerObservation: `ARMED state observed. Confirmation freshness should be checked separately. Score:${a.score ?? "?"}`,
          score:              a.score,
          ageSec:             a.ageSec,
          price:              a.price,
        }));

        const pipelineEntries = pfEntries
          ? [
              ...armedPipelineEntries.filter(a =>
                !pfEntries.some(e =>
                  e.pairAddress?.toLowerCase() === a.pairAddress?.toLowerCase() &&
                  (e.chain ?? "").toLowerCase() === (a.chain ?? "").toLowerCase()
                )
              ),
              ...pfEntries,
            ]
          : null;
				
       const hasFlow = pipelineEntries?.some(e => {
         const f = e.flow as { hasData?: boolean; buys5m?: number | null; buyVol5mUsd?: number | null } | null | undefined;
         return f?.hasData || f?.buys5m || f?.buyVol5mUsd;
       }) ?? false;

        return mcpResponse({
          text: JSON.stringify({
            pipeline: pipelineEntries,
            armed: armedEntries,
            legacy: { activeWatch, hotCandidates, armedEntries },
            summary: pipelineEntries
              ? {
                  watching:   pipelineEntries.filter(e => e.pipelineState === "WATCHING").length,
                  hot:        pipelineEntries.filter(e => e.pipelineState === "HOT").length,
                  armed:      pipelineEntries.filter(e => e.pipelineState === "ARMED").length,
                  qualified:  pfQualified?.filter(q => filterChain(q.chain)).length ?? 0,
                }
              : { watching: activeWatch.length, hot: hotCandidates.length, armed: armedEntries.length },
            freshnessSec,
          }, null, 2),
          freshnessSec,
          confidence:
            freshnessSec !== null && freshnessSec < 30 ? "HIGH" :
            freshnessSec !== null && freshnessSec < 90 ? "MEDIUM" :
            "LOW",
          dataQuality: {
            wsFlow: hasFlow ? "partial" : "absent",
          },
          evidence: {
            watching: activeWatch.length,
            hot:      hotCandidates.length,
            armed:    armedEntries.length,
          },
        });
      } catch (e) { return mcpErr(ERR.INTERNAL, sanitizeToolError(e)); }
    },
  );
}
