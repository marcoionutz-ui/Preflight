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
export type PipelineState  = "NONE" | "WATCHING" | "HOT" | "ARMED" | "QUALIFIED" | "DROPPED" | "REJECTED";
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
  // E34: counts reale buy/sell (fereastra 5m), propagate din call-site-uri (preflight-redis / snapshots).
  // TIPIZAT — înlocuiește vechiul acces untyped (cast) la un `ctx.flow` care NU exista pe ObservationContext și
  // pe care niciun call-site nu-l trimitea → ramura one-sided primea mereu 0/0 și pica pe fallback-ul „stale".
  flowCounts?:      { buys5m: number; sells5m: number };
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
  } else if (ctx.flowStatus === "WEAK") {
    parts.push("Flow weak or fading.");
  }
  // E34: `ONE_SIDED` NU mai emite aici o propoziție separată — direcția one-sided e produsă O SINGURĂ DATĂ,
  // counts-driven, în blocul dedicat de mai jos (altfel buy-only ieșea dublat: aici + în secțiunea de risk).

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
  // ── One-sided flow — O SINGURĂ propoziție, counts-driven ──────────────────────
  // E34: sursă UNICĂ pentru mesajul one-sided. Se declanșează fie din `flowStatus === "ONE_SIDED"`
  // (buy-dominant, prin definiția lui `deriveFlowStatus`: pressure BUYING + sells5m===0 + buys5m>3),
  // fie din riskFlag-ul `ONE_SIDED_FLOW` (setat de `deriveRiskFlags` când o parte e 0 + liq confirmată →
  // acoperă și cazul sell-only, pe care flowStatus nu-l marchează). Direcția vine din `flowCounts` TIPIZAT
  // (fără cast untyped). `DISTRIBUTION_RISK` are prioritate (emite deja propoziția lui mai sus) → nu dublăm.
  // Fără counts → „counts unavailable", NU „stale": freshness-ul flow-ului nu e cunoscut la nivelul ăsta.
  const oneSided =
    (ctx.flowStatus === "ONE_SIDED" || ctx.riskFlags.includes("ONE_SIDED_FLOW"))
    && !ctx.riskFlags.includes("DISTRIBUTION_RISK");
  if (oneSided) {
    const c = ctx.flowCounts;
    if (c && c.buys5m >= 3 && c.sells5m === 0) {
      parts.push("No sell pressure observed — buying-only flow in current window.");
    } else if (c && c.sells5m >= 3 && c.buys5m === 0) {
      parts.push("Sell-only flow observed — buying support absent in current window.");
    } else {
      parts.push("One-sided flow observed; current buy/sell counts unavailable.");
    }
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
  if (ctx.pipelineState === "HOT" || ctx.pipelineState === "ARMED") {
    parts.push("Awaiting 30s price confirmation.");
  } else if (ctx.pipelineState === "QUALIFIED") {
    parts.push("All configured qualification checks were observed.");
  } else if (ctx.pipelineState === "DROPPED") {
    parts.push("Removed from pipeline.");
  }

  // ── Confidence ────────────────────────────────────────────────────────────
  if (ctx.confidence === "LOW") {
    parts.push("Low confidence — limited data.");
  } else if (ctx.confidence === "HIGH" && ctx.flowStatus === "STRONG") {
    parts.push("High data confidence for the observed state.");
  }

  return parts.length > 0
    ? parts.join(" ")
    : "Insufficient data for observation.";
}