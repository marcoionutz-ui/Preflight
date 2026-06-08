/**
 * worker/lib/observation.ts
 * Preflight Scanner v5.32
 *
 * buildWorkerObservation() — generează o observație scurtă, factuală,
 * din combinații de semnale. Template strings deterministice, nu LLM.
 *
 * Principiu: workerul descrie. Agentul decide.
 */

export type MomentumLevel  = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
export type FlowStatus     = "NO_DATA" | "WEAK" | "BUYING" | "STRONG" | "ONE_SIDED";
export type LiquidityStatus = "THIN" | "OK" | "CONFIRMED" | "DEEP";
export type EntryRisk      = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
export type MoveType       = "ORGANIC" | "VERTICAL" | "LATE" | "SECOND_WAVE" | "NEW_POOL" | "UNKNOWN";
export type PipelineState  = "NONE" | "WATCHING" | "CONFIRMING" | "QUALIFIED" | "DROPPED" | "REJECTED";
export type Confidence     = "LOW" | "MEDIUM" | "HIGH";

export interface ObservationContext {
  moveType:         MoveType;
  momentumLevel:    MomentumLevel;
  flowStatus:       FlowStatus;
  liquidityStatus:  LiquidityStatus;
  entryRisk:        EntryRisk;
  riskFlags:        string[];
  opportunitySignals: string[];
  pipelineState:    PipelineState;
  confidence:       Confidence;
  priceVsEntryPct?: number | null;
  seenCount?:       number;
  m5Pct?:           number;
  h24Pct?:          number;
}

export function buildWorkerObservation(ctx: ObservationContext): string {
  const parts: string[] = [];

  // ── Momentum / move type ──────────────────────────────────────────────────
  if (ctx.moveType === "VERTICAL" && ctx.momentumLevel === "EXTREME") {
    parts.push(`Extreme vertical move${ctx.m5Pct ? ` (+${Math.round(ctx.m5Pct)}% 5m)` : ""}.`);
  } else if (ctx.moveType === "VERTICAL" && ctx.momentumLevel === "HIGH") {
    parts.push(`Sharp vertical move detected${ctx.m5Pct ? ` (+${Math.round(ctx.m5Pct)}% 5m)` : ""}.`);
  } else if (ctx.moveType === "LATE") {
    parts.push(`Late-stage momentum${ctx.h24Pct ? ` (+${Math.round(ctx.h24Pct)}% 24h)` : ""}.`);
  } else if (ctx.moveType === "SECOND_WAVE") {
    parts.push("Second wave pattern detected after pullback.");
  } else if (ctx.moveType === "NEW_POOL") {
    parts.push("New pool — first activity window.");
  } else if (ctx.momentumLevel === "HIGH" || ctx.momentumLevel === "MEDIUM") {
    parts.push("Active momentum detected.");
  }

  // ── Flow ──────────────────────────────────────────────────────────────────
  if (ctx.flowStatus === "NO_DATA") {
    parts.push("No WS flow data available.");
  } else if (ctx.flowStatus === "STRONG") {
    parts.push("Strong sustained buying flow.");
  } else if (ctx.flowStatus === "BUYING") {
    parts.push("Buying flow active.");
  } else if (ctx.flowStatus === "ONE_SIDED") {
    parts.push("One-sided buy flow — sell side absent.");
  } else if (ctx.flowStatus === "WEAK") {
    parts.push("Flow weak or fading.");
  }

  // ── Liquidity ─────────────────────────────────────────────────────────────
  if (ctx.liquidityStatus === "THIN") {
    parts.push("Liquidity thin — manipulation risk elevated.");
  } else if (ctx.liquidityStatus === "CONFIRMED") {
    parts.push("Liquidity confirmed.");
  } else if (ctx.liquidityStatus === "DEEP") {
    parts.push("Deep liquidity pool.");
  }

  // ── Risk flags ────────────────────────────────────────────────────────────
  if (ctx.riskFlags.includes("DISTRIBUTION_RISK")) {
    parts.push("Distribution pattern possible — elevated sell ratio during buying.");
  }
  if (ctx.riskFlags.includes("CLONE_FRAGMENTATION")) {
    parts.push("Multiple pools for same token — fragmentation risk.");
  }
  if (ctx.riskFlags.includes("BAD_HISTORY")) {
    parts.push("Poor historical performance on this pair.");
  }
  if (ctx.riskFlags.includes("LP_RISK")) {
    parts.push("LP activity detected — monitor for removal.");
  }
  if (ctx.riskFlags.includes("ONE_SIDED_FLOW") && !ctx.riskFlags.includes("DISTRIBUTION_RISK")) {
    parts.push("No sell pressure observed — may indicate very early stage or low activity.");
  }
  if (ctx.riskFlags.includes("STALE_RUNNER")) {
    parts.push("Pair seen many times without clean entry — stale runner pattern.");
  }

  // ── Entry risk summary ────────────────────────────────────────────────────
  if (ctx.entryRisk === "EXTREME") {
    parts.push("Entry risk extreme.");
  } else if (ctx.entryRisk === "HIGH") {
    parts.push("Entry risk high.");
  }

  // ── Price vs entry ────────────────────────────────────────────────────────
  if (ctx.priceVsEntryPct !== null && ctx.priceVsEntryPct !== undefined) {
    if (ctx.priceVsEntryPct > 20) {
      parts.push(`Price extended ${ctx.priceVsEntryPct.toFixed(1)}% from watch entry.`);
    } else if (ctx.priceVsEntryPct < -10) {
      parts.push(`Price down ${Math.abs(ctx.priceVsEntryPct).toFixed(1)}% from watch entry.`);
    }
  }

  // ── Pipeline state context ────────────────────────────────────────────────
  if (ctx.pipelineState === "CONFIRMING") {
    parts.push("Awaiting 30s price confirmation.");
  } else if (ctx.pipelineState === "QUALIFIED") {
    parts.push("Passed all filters.");
  } else if (ctx.pipelineState === "DROPPED") {
    parts.push("Removed from pipeline.");
  }

  // ── Confidence ────────────────────────────────────────────────────────────
  if (ctx.confidence === "LOW") {
    parts.push("Low confidence — limited data.");
  } else if (ctx.confidence === "HIGH" && ctx.flowStatus === "STRONG") {
    parts.push("High confidence signal.");
  }

  return parts.length > 0
    ? parts.join(" ")
    : "Insufficient data for observation.";
}