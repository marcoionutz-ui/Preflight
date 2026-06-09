/**
 * Candidate Decision Classifier
 *
 * Takes all available signals and returns a single decision:
 * TRADE_CANDIDATE | WATCH | NO_CHASE | REJECT
 *
 * This is the "final output" layer — it synthesizes
 * EdgeScore + Anti-FOMO + Red Flags into one actionable verdict.
 */

import type { Pair, RedFlag } from "@/types";
import type { EdgeScore } from "./edgeScore";
import type { FOMOCheck } from "./antiFomo";

export type CandidateDecision =
  | "TRADE_CANDIDATE"   // GoPlus verified + all gates passed
  | "PAPER_CANDIDATE"   // market-only, paper trading only
  | "WATCH"
  | "NO_CHASE"
  | "REJECT";

export interface DecisionResult {
  decision:  CandidateDecision;
  color:     string;
  label:     string;
  reasons:   string[];   // why this decision
}

const COLORS: Record<CandidateDecision, string> = {
  TRADE_CANDIDATE: "#39ff14",
  PAPER_CANDIDATE: "#ffb347",
  WATCH:           "#ffb347",
  NO_CHASE:        "#ff8c00",
  REJECT:          "#ff3b3b",
};

const LABELS: Record<CandidateDecision, string> = {
  TRADE_CANDIDATE: "CANDIDATE ✓",
  PAPER_CANDIDATE: "PAPER CANDIDATE 📋",
  WATCH:           "WATCH 👀",
  NO_CHASE:        "NO CHASE 🚫",
  REJECT:          "REJECT ⛔",
};

export function classify(
  pair: Pair,
  edgeScore: EdgeScore,
  fomoCheck: FOMOCheck,
  flags: RedFlag[]
): DecisionResult {
  const reasons: string[] = [];

  // ── REJECT: hard blockers ──────────────────────────────────────────────────
  if (edgeScore.isHoneypot) {
    return { decision: "REJECT", color: COLORS.REJECT, label: LABELS.REJECT, reasons: ["HONEYPOT"] };
  }

  if (edgeScore.blockers.length > 0) {
    return {
      decision: "REJECT",
      color: COLORS.REJECT,
      label: LABELS.REJECT,
      reasons: edgeScore.blockers,
    };
  }

  const highFlags = flags.filter(f => f.sev === "high").length;
  if (highFlags >= 2) {
    return {
      decision: "REJECT",
      color: COLORS.REJECT,
      label: LABELS.REJECT,
      reasons: [`${highFlags} HIGH risk flags`],
    };
  }

  // ── NO_CHASE: FOMO blocked ─────────────────────────────────────────────────
  if (fomoCheck.blocked) {
    return {
      decision: "NO_CHASE",
      color: COLORS.NO_CHASE,
      label: LABELS.NO_CHASE,
      reasons: [fomoCheck.reason ?? "Anti-FOMO triggered"],
    };
  }

  // Market-only candidate (no GoPlus) — paper trading only
  if (
    edgeScore.dataSource === "market-only" &&
    edgeScore.total >= 65 &&
    edgeScore.liquidity >= 10 &&
    highFlags === 0 &&
    !fomoCheck.blocked
  ) {
    return {
	  decision: "PAPER_CANDIDATE",
	  color: "#ffb347",
	  label: "PAPER CANDIDATE 📋",
	  reasons: [`Edge ${edgeScore.total} | market-only, no GoPlus`],
	};
  }

  // ── TRADE_CANDIDATE: passes all gates ─────────────────────────────────────
  if (
    edgeScore.canEnterTrade &&
    edgeScore.total >= 70 &&
    edgeScore.safety >= 18 &&
    edgeScore.liquidity >= 10 &&
    highFlags === 0
  ) {
    reasons.push(`Edge ${edgeScore.total}/100`);
    if (edgeScore.dataSource === "goplus+market") reasons.push("GoPlus verified");
    if (edgeScore.sellTax === 0) reasons.push("0% tax");
    if (edgeScore.holderCount > 500) reasons.push(`${edgeScore.holderCount.toLocaleString()} holders`);

    return {
      decision: "TRADE_CANDIDATE",
      color: COLORS.TRADE_CANDIDATE,
      label: LABELS.TRADE_CANDIDATE,
      reasons,
    };
  }

  // ── WATCH: decent but not ready ───────────────────────────────────────────
  if (edgeScore.total >= 55) {
    if (edgeScore.total < 70)   reasons.push(`Edge ${edgeScore.total} < 70`);
    if (edgeScore.safety < 18)  reasons.push(`Safety ${edgeScore.safety} < 18`);
    if (edgeScore.liquidity < 10) reasons.push("Low liquidity score");
    if (highFlags > 0)           reasons.push(`${highFlags} high flag`);
    fomoCheck.warnings.forEach(w => reasons.push(w));

    return {
      decision: "WATCH",
      color: COLORS.WATCH,
      label: LABELS.WATCH,
      reasons,
    };
  }

  // ── Default REJECT ────────────────────────────────────────────────────────
  reasons.push(`Edge ${edgeScore.total} < 55`);
  return {
    decision: "REJECT",
    color: COLORS.REJECT,
    label: LABELS.REJECT,
    reasons,
  };
}
