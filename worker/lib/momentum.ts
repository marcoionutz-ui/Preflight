/**
 * worker/lib/momentum.ts
 * Preflight Scanner v5.32
 *
 * classifyMomentumEvent() — înlocuiește checkFOMO()
 *
 * Nu mai returnează blocked: true/false.
 * Returnează un verdict descriptiv + context complet.
 *
 * Principiu: workerul descrie. Agentul decide.
 */

import type { MomentumLevel, EntryRisk, MoveType } from "./observation";

export type MomentumVerdict =
  | "VERTICAL_WATCH"       // +30-100% 5m, V3/V4, reserve ok → urmărește
  | "CONFIRMED_MOMENTUM"   // vertical + WS flow deja activ → priority watch
  | "LATE_WATCH"           // +200-800% 24h, flow activ → urmărește
  | "UNCONFIRMED_VERTICAL" // vertical dar fără WS / fără reserve suficient
  | "LOW_LIQ_NOISE"        // reserve prea mică → probabil noise
  | "EXTREME_LATE"         // +500%+ 24h → prea târziu
  | "NO_MOMENTUM"          // sub threshold-uri → nu e momentum event
  | "NO_CHASE";            // momentum real dar criterii Preflight neîndeplinite

export interface MomentumEvent {
  verdict:        MomentumVerdict;
  moveType:       MoveType;
  momentumLevel:  MomentumLevel;
  entryRisk:      EntryRisk;
  reason:         string;
  m5Pct:          number;
  h1Pct:          number;
  h24Pct:         number;
  reserveUsd:     number;
  isV3orV4:       boolean;
  hasWsFlow:      boolean;
  riskFlags:      string[];
}

interface PoolSnapshot {
  m5:         number;
  h1:         number;
  h24:        number;
  reserveUsd: number;
  isV3orV4:   boolean;
  hasWsFlow:  boolean;
}

function getMomentumLevel(m5: number, h24: number): MomentumLevel {
  if (m5 > 100 || h24 > 1000) return "EXTREME";
  if (m5 > 50  || h24 > 500)  return "HIGH";
  if (m5 > 30  || h24 > 200)  return "MEDIUM";
  if (m5 > 10  || h24 > 50)   return "LOW";
  return "NONE";
}

function getEntryRisk(verdict: MomentumVerdict, m5: number, h24: number, reserveUsd: number): EntryRisk {
  if (verdict === "EXTREME_LATE" || verdict === "LOW_LIQ_NOISE") return "EXTREME";
  if (m5 > 100 || h24 > 500)  return "EXTREME";
  if (m5 > 50  || h24 > 200)  return "HIGH";
  if (reserveUsd < 20_000)     return "HIGH";
  if (m5 > 30  || h24 > 100)  return "MEDIUM";
  return "LOW";
}

export function classifyMomentumEvent(pool: PoolSnapshot): MomentumEvent {
  const { m5, h1, h24, reserveUsd, isV3orV4, hasWsFlow } = pool;
  const riskFlags: string[] = [];

  // ── Sub threshold → nu e momentum event ──────────────────────────────────
  if (m5 <= 30 && h24 <= 200) {
    return {
      verdict: "NO_MOMENTUM",
      moveType: "ORGANIC",
      momentumLevel: getMomentumLevel(m5, h24),
      entryRisk: "LOW",
      reason: "No significant momentum detected",
      m5Pct: m5, h1Pct: h1, h24Pct: h24, reserveUsd, isV3orV4, hasWsFlow,
      riskFlags: [],
    };
  }

  // ── Extreme late — prea târziu oricum ─────────────────────────────────────
  if (h24 > 800 && m5 <= 30) {
    return {
      verdict: "EXTREME_LATE",
      moveType: "LATE",
      momentumLevel: "EXTREME",
      entryRisk: "EXTREME",
      reason: `+${Math.round(h24)}% in 24h — extremely late`,
      m5Pct: m5, h1Pct: h1, h24Pct: h24, reserveUsd, isV3orV4, hasWsFlow,
      riskFlags: ["EXTREME_LATE_ENTRY"],
    };
  }

  // ── Low liquidity noise ───────────────────────────────────────────────────
  if (reserveUsd < 5_000) {
    return {
      verdict: "LOW_LIQ_NOISE",
      moveType: m5 > 30 ? "VERTICAL" : "LATE",
      momentumLevel: getMomentumLevel(m5, h24),
      entryRisk: "EXTREME",
      reason: `Low liquidity ($${Math.round(reserveUsd / 1000)}K) — likely noise`,
      m5Pct: m5, h1Pct: h1, h24Pct: h24, reserveUsd, isV3orV4, hasWsFlow,
      riskFlags: ["THIN_LIQUIDITY"],
    };
  }

  // ── Vertical 5m move ──────────────────────────────────────────────────────
  if (m5 > 30) {
    const moveType: MoveType = "VERTICAL";
    const momentumLevel      = getMomentumLevel(m5, h24);

    if (m5 > 100)    riskFlags.push("EXTREME_MOVE");
    if (h24 > 300)   riskFlags.push("LATE_ENTRY_RISK");
    if (!isV3orV4)   riskFlags.push("NON_STANDARD_DEX");

    // Fără DEX standard → unconfirmed
    if (!isV3orV4) {
      return {
        verdict: "UNCONFIRMED_VERTICAL",
        moveType, momentumLevel,
        entryRisk: getEntryRisk("UNCONFIRMED_VERTICAL" as MomentumVerdict, m5, h24, reserveUsd),
        reason: `+${Math.round(m5)}% in 5m — non-standard DEX`,
        m5Pct: m5, h1Pct: h1, h24Pct: h24, reserveUsd, isV3orV4, hasWsFlow,
        riskFlags,
      };
    }

    // Reserve prea mică pentru V3/V4
    if (reserveUsd < 15_000) {
      riskFlags.push("THIN_LIQUIDITY");
      return {
        verdict: "UNCONFIRMED_VERTICAL",
        moveType, momentumLevel,
        entryRisk: "HIGH",
        reason: `+${Math.round(m5)}% in 5m — reserve too low ($${Math.round(reserveUsd / 1000)}K)`,
        m5Pct: m5, h1Pct: h1, h24Pct: h24, reserveUsd, isV3orV4, hasWsFlow,
        riskFlags,
      };
    }

    // WS flow deja activ → CONFIRMED_MOMENTUM
    if (hasWsFlow) {
      return {
        verdict: "CONFIRMED_MOMENTUM",
        moveType, momentumLevel,
        entryRisk: getEntryRisk("CONFIRMED_MOMENTUM" as MomentumVerdict, m5, h24, reserveUsd),
        reason: `+${Math.round(m5)}% in 5m with active WS buying flow`,
        m5Pct: m5, h1Pct: h1, h24Pct: h24, reserveUsd, isV3orV4, hasWsFlow,
        riskFlags,
      };
    }

    // Standard vertical watch
    return {
      verdict: "VERTICAL_WATCH",
      moveType, momentumLevel,
      entryRisk: getEntryRisk("VERTICAL_WATCH" as MomentumVerdict, m5, h24, reserveUsd),
      reason: `+${Math.round(m5)}% in 5m — vertical candle`,
      m5Pct: m5, h1Pct: h1, h24Pct: h24, reserveUsd, isV3orV4, hasWsFlow,
      riskFlags,
    };
  }

  // ── Late 24h move ─────────────────────────────────────────────────────────
  if (h24 > 200) {
    const moveType: MoveType = "LATE";
    const momentumLevel      = getMomentumLevel(m5, h24);

    if (h24 > 500) riskFlags.push("EXTREME_MOVE");
    if (h24 > 300) riskFlags.push("LATE_ENTRY_RISK");

    const lateOk =
      isV3orV4 &&
      reserveUsd >= 50_000 &&
      m5 > 3 && m5 < 30 &&
      h1 > 10 &&
      h24 < 800;

    if (!lateOk) {
      return {
        verdict: "NO_CHASE",
        moveType, momentumLevel,
        entryRisk: getEntryRisk("NO_CHASE" as MomentumVerdict, m5, h24, reserveUsd),
        reason: `+${Math.round(h24)}% in 24h — criteria not met for watch`,
        m5Pct: m5, h1Pct: h1, h24Pct: h24, reserveUsd, isV3orV4, hasWsFlow,
        riskFlags,
      };
    }

    return {
      verdict: "LATE_WATCH",
      moveType, momentumLevel,
      entryRisk: getEntryRisk("LATE_WATCH" as MomentumVerdict, m5, h24, reserveUsd),
      reason: `+${Math.round(h24)}% in 24h — late but active`,
      m5Pct: m5, h1Pct: h1, h24Pct: h24, reserveUsd, isV3orV4, hasWsFlow,
      riskFlags,
    };
  }

  // Fallback
  return {
    verdict: "NO_MOMENTUM",
    moveType: "ORGANIC",
    momentumLevel: "NONE",
    entryRisk: "LOW",
    reason: "Below momentum thresholds",
    m5Pct: m5, h1Pct: h1, h24Pct: h24, reserveUsd, isV3orV4, hasWsFlow,
    riskFlags: [],
  };
}

// ── Helpers pentru index.ts ───────────────────────────────────────────────────

/** Verdictele care intră în activeWatch ca VERTICAL kind */
export function isVerticalWatch(v: MomentumVerdict): boolean {
  return v === "VERTICAL_WATCH" || v === "CONFIRMED_MOMENTUM";
}

/** Verdictele care intră în activeWatch ca LATE kind */
export function isLateWatch(v: MomentumVerdict): boolean {
  return v === "LATE_WATCH";
}

/** Verdictele care NU intră în watch deloc */
export function isHardReject(v: MomentumVerdict): boolean {
  return v === "LOW_LIQ_NOISE" || v === "EXTREME_LATE" || v === "NO_MOMENTUM";
}

/** Verdictele care se salvează ca momentum event în Supabase */
export function shouldRecordEvent(v: MomentumVerdict): boolean {
  return v !== "NO_MOMENTUM";
}