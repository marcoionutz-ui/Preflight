/**
 * lib/reports/market-overview-report.ts
 *
 * Structured, per-chain market snapshot for the /demo market overview page.
 *
 * Reuses the exact same Redis reads and regime/coverage math as
 * tp_market_overview.ts and tp_chain_report.ts (same buying/selling%%
 * thresholds, same coverage%% thresholds, same Solana readers). Those two
 * MCP tools return prose text blocks for LLM readability and are already
 * validated in production — they are NOT touched here. This is a parallel
 * structured view over the same underlying data, built for card-style UI
 * rendering instead of text.
 *
 * Cache-only: readAllRedis / readTrendingMovers / readSolanaIndexerStats /
 * readSolanaMovers are all plain Redis reads. No live RPC, no GoPlus, no
 * force refresh. Safe for a public, unauthenticated demo page.
 */

import {
  readAllRedis, readTrendingMovers, freshnessLabel,
  readSolanaIndexerStats, readSolanaMovers,
} from "../mcp/redis-reader";
import { safeAgeSec } from "../mcp/freshness";
import { sanitizeToolError } from "../mcp/errors";
import { pairKey, reserveEstimatedFlag, type ReserveSource } from "@preflight/schema";

export type ChainCoverageTier = "IMPLEMENTED" | "SHADOW" | "SAMPLED";

// Architectural deployment status per chain — this is NOT derived from live
// data, nor does it claim a running production service (services are parked
// pre-launch). It reflects the INDEXER_PRIMARY gate status documented in the
// project roadmap: IMPLEMENTED = primary indexer path built for that chain,
// SHADOW = shadow-worker path ahead of promotion, SAMPLED = sampled coverage.
// Update when a chain's worker gets promoted (e.g. Ethereum shadow → primary
// after the 7.0f soak period).
//
// Keyed by the EXTERNAL short code ("eth"), matching the chain enum used
// everywhere else in the MCP surface (tp_pair_context, tp_preflight_safety,
// pair-context-report's ALLOWED_CHAINS). Redis itself stores pair_states with
// chain:"ethereum" (see toRedisChainId below) — that's an internal-only detail.
const CHAIN_COVERAGE: Record<string, ChainCoverageTier> = {
  base:     "IMPLEMENTED",
  arbitrum: "IMPLEMENTED",
  bsc:      "IMPLEMENTED",
  eth:      "SHADOW",  // shadow worker, promotion gate soak (7.0f)
  solana:   "SAMPLED", // swap-vault-delta sampling, not full firehose
};

// Worker stores pair_states with chain:"ethereum", but the external chain
// code used everywhere else (URLs, MCP tool schemas, ALLOWED_CHAINS) is
// "eth" — same normalization tp_chain_report.ts / tp_market_overview.ts do.
function toRedisChainId(externalChain: string): string {
  return externalChain === "eth" ? "ethereum" : externalChain;
}

export interface MoverSummary {
  symbol:         string;
  pairAddress:    string;
  priceChange5m:  number | null;
  priceChange1h:  number | null;
  priceChange24h: number | null;
  reserveUsd:     number | null;
  // NF/U5: proveniența rezervei — reserveUsd V4 (V4_STATE_LIQUIDITY) e estimat (virtual reserves, poate supraestima).
  reserveSource?:    ReserveSource | null;
  reserveEstimated?: boolean | null; // tri-stare: true/false/null(necunoscut, ex. fără pair_state)
  direction?:     "UP" | "DOWN" | "FLAT";
}

export interface ChainRegime {
  label:         "RISK_ON" | "RISK_OFF" | "MIXED" | "DEAD";
  buyingPct:     number;
  sellingPct:    number;
  wsCoveragePct: number;
}

export interface ChainOverview {
  chain:          string;
  coverage:       ChainCoverageTier;
  online:         boolean;
  trackedPairs:   number;
  pipeline:       { watching: number; hot: number; armed: number };
  regime:         ChainRegime | null;
  freshnessSec:   number | null;
  freshnessLabel: "fresh" | "aging" | "stale" | "unknown";
  confidence:     "HIGH" | "MEDIUM" | "LOW";
  movers:         MoverSummary[];
  note?:          string;
}

export interface MarketOverviewReport {
  ok:            boolean;
  generatedAt:   number;
  chains:        ChainOverview[];
  errorCode?:    string;
  errorMessage?: string;
}

const EVM_CHAINS = ["base", "arbitrum", "bsc", "eth"];

export async function buildMarketOverviewReport(topN = 5): Promise<MarketOverviewReport> {
  const generatedAt = Date.now();

  try {
    const solanaOverview = await buildSolanaOverview(generatedAt, topN);
    const ctx = await readAllRedis();

    if (!ctx) {
      return {
        ok: false, generatedAt, chains: [solanaOverview],
        errorCode: "REDIS_DOWN", errorMessage: "Redis not connected",
      };
    }

    const { now, states, watch, hot, armed } = ctx;
    const stateEntries = Object.entries(states);

    const evmChains: ChainOverview[] = [];
    for (const externalChainId of EVM_CHAINS) {
      const chainId = toRedisChainId(externalChainId); // "eth" → "ethereum" for Redis lookups only

      const chainStates = stateEntries.filter(([, s]) => (s.chain ?? "").toLowerCase() === chainId);
      const stateVals   = chainStates.map(([, s]) => s);

      const chainWatch = Object.values(watch).filter(w => w.chain?.toLowerCase() === chainId).length;
      const chainHot   = Object.values(hot).filter(h => h.chain?.toLowerCase() === chainId).length;
      const chainArmed = Object.values(armed).filter(a => (a.chain ?? "").toLowerCase() === chainId).length;

      const newestStateAt = stateVals.length ? Math.max(...stateVals.map(s => s.updatedAt)) : null;
      // E13: clamp la ≥0 — un updatedAt din viitor (clock skew) nu mai dă freshnessSec negativ, care fiind
      // `< prag` producea fals HIGH confidence + „online".
      const freshnessSec  = safeAgeSec(now, newestStateAt);

      let regime: ChainRegime | null = null;
      if (stateVals.length > 0) {
        const withFlow  = stateVals.filter(s => s.flow?.hasData);
        const buying    = withFlow.filter(s => s.flow?.pressure === "BUYING").length;
        const selling   = withFlow.filter(s => s.flow?.pressure === "SELLING").length;
        const total     = stateVals.length;
        const buyingPct     = total ? Math.round((buying / total) * 100) : 0;
        const sellingPct    = total ? Math.round((selling / total) * 100) : 0;
        const wsCoveragePct = total ? Math.round((withFlow.length / total) * 100) : 0;

        // Same thresholds as tp_chain_report.ts — keep in sync if those change.
        const label: ChainRegime["label"] =
          buyingPct  >= 35 ? "RISK_ON"  :
          sellingPct >= 40 ? "RISK_OFF" :
          wsCoveragePct < 20 ? "DEAD"   : "MIXED";

        regime = { label, buyingPct, sellingPct, wsCoveragePct };
      }

      const moversRaw = await readTrendingMovers(chainId);
      const movers: MoverSummary[] = moversRaw.slice(0, topN).map(m => {
        // NF/U5: movers nu poartă reserveSource → asociem cu pair_states înainte de output.
        const ps = states[pairKey(chainId, m.pairAddress)];
        return {
          symbol:         m.symbol,
          pairAddress:    m.pairAddress,
          priceChange5m:  m.priceChange5m,
          priceChange1h:  m.priceChange1h,
          priceChange24h: m.priceChange24h,
          reserveUsd:     m.reserveUsd,
          reserveSource:    ps?.reserveSource ?? null,
          reserveEstimated: reserveEstimatedFlag(ps?.reserveSource), // tri-stare: null când lipsește pair_state
          direction:      m.direction,
        };
      });

      // Same thresholds as tp_market_overview.ts's confidence calc.
      const confidence: ChainOverview["confidence"] =
        freshnessSec !== null && freshnessSec < 60  ? "HIGH" :
        freshnessSec !== null && freshnessSec < 180 ? "MEDIUM" :
        "LOW";

      evmChains.push({
        chain:          externalChainId,
        coverage:       CHAIN_COVERAGE[externalChainId] ?? "SHADOW",
        online:         freshnessSec !== null && freshnessSec < 300,
        trackedPairs:   stateVals.length,
        pipeline:       { watching: chainWatch, hot: chainHot, armed: chainArmed },
        regime,
        freshnessSec,
        freshnessLabel: freshnessLabel(freshnessSec !== null ? freshnessSec * 1000 : null),
        confidence,
        movers,
      });
    }

    return { ok: true, generatedAt, chains: [...evmChains, solanaOverview] };
  } catch (e) {
    return {
      // PH-7: NU stoca `e.message` brut — acest report alimentează demo-ul PUBLIC (app/demo/page.tsx redă
      // `report.errorMessage` direct în HTML). `sanitizeToolError` logează eroarea reală server-side și întoarce
      // un mesaj generic stabil, deci nici demo-ul nici un consumator MCP nu văd internals (host Redis, stack).
      ok: false, generatedAt, chains: [],
      errorCode: "INTERNAL", errorMessage: sanitizeToolError(e),
    };
  }
}

async function buildSolanaOverview(now: number, topN: number): Promise<ChainOverview> {
  const [stats, movers] = await Promise.all([
    readSolanaIndexerStats(now),
    readSolanaMovers(now, topN),
  ]);

  const { health } = stats;

  const moverSummaries: MoverSummary[] = (movers?.items ?? []).map(m => ({
    symbol:         `${m.baseSymbol}/${m.quoteSymbol}`,
    pairAddress:    m.poolAddress,
    priceChange5m:  m.priceChange5mPct,
    priceChange1h:  m.priceChange1hPct,
    priceChange24h: null,
    reserveUsd:     null,
  }));

  // Same thresholds as tp_chain_report.ts's Solana branch confidence calc.
  const confidence: ChainOverview["confidence"] =
    health.ageSec !== null && health.ageSec < 60  ? "HIGH" :
    health.ageSec !== null && health.ageSec < 180 ? "MEDIUM" :
    "LOW";

  return {
    chain:          "solana",
    coverage:       "SAMPLED",
    online:         health.workerOnline,
    trackedPairs:   stats.indexedPools,
    pipeline:       { watching: 0, hot: 0, armed: 0 }, // Solana has no EVM-style pipeline
    regime:         null, // no buying/selling regime on Solana — movers only
    freshnessSec:   health.ageSec,
    freshnessLabel: freshnessLabel(health.ageSec !== null ? health.ageSec * 1000 : null),
    confidence,
    movers:         moverSummaries,
    note:           "Sampled from observed swap vault deltas, not full firehose.",
  };
}
