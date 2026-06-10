/**
 * @preflight/risk-layer — classify.ts
 * Transformă raw RiskResult în verdict final:
 * riskLevel, confidence, flags[], summary.
 *
 * Toată inteligența de clasificare stă aici.
 * Stateless — input/output pur, fără side effects.
 */

import type { RiskResult, RiskFlag, RiskLevel, RiskConfidence } from "./types";

export function classifyRisk(raw: RiskResult): RiskResult {
  if (raw.source === "unavailable") return raw;

  const flags: RiskFlag[] = [];

  // ── Honeypot / sellability ────────────────────────────────────────────────
  if (raw.isHoneypot === true) flags.push("HONEYPOT");
  if (raw.cannotSell === true) flags.push("CANNOT_SELL");

  // ── Tax flags ─────────────────────────────────────────────────────────────
  const sellTax = raw.sellTaxPct ?? 0;
  const buyTax  = raw.buyTaxPct  ?? 0;

  if (sellTax >= 20)     flags.push("HIGH_SELL_TAX");
  else if (sellTax > 10) flags.push("MODERATE_SELL_TAX");

  if (buyTax >= 20)      flags.push("HIGH_BUY_TAX");
  else if (buyTax > 10)  flags.push("MODERATE_BUY_TAX");

  // ── Owner controls ────────────────────────────────────────────────────────
  if (raw.canMint              === true) flags.push("CAN_MINT");
  if (raw.canBlacklist         === true) flags.push("CAN_BLACKLIST");
  if (raw.canPauseTrading      === true) flags.push("CAN_PAUSE_TRADING");
  if (raw.canChangeTax         === true) flags.push("CAN_CHANGE_TAX");
  if (raw.canChangeBalance     === true) flags.push("CAN_CHANGE_BALANCE");
  if (raw.canTakeBackOwnership === true) flags.push("CAN_TAKE_BACK_OWNERSHIP");
  if (raw.ownerRenounced       === false) flags.push("OWNER_NOT_RENOUNCED");

  // ── Token age ─────────────────────────────────────────────────────────────
  if (raw.tokenAgeMinutes !== null && raw.tokenAgeMinutes < 60) {
    flags.push("VERY_NEW_TOKEN");
  }

  // ── riskLevel ─────────────────────────────────────────────────────────────
  const isCritical =
    raw.isHoneypot           === true ||
    raw.cannotSell           === true ||
    sellTax                  >= 20    ||
    raw.canMint              === true ||
    raw.canPauseTrading      === true ||
    raw.canChangeBalance     === true ||
    raw.canTakeBackOwnership === true;

  const isHigh =
    sellTax              > 10   ||
    buyTax               > 10   ||
    raw.canBlacklist     === true ||
    raw.canChangeTax     === true ||
    raw.ownerRenounced   === false;

  // fix ChatGPT: === false pe toate câmpurile — LOW = verificat safe, nu necunoscut
  const isLow =
    raw.isHoneypot           === false &&
    raw.cannotSell           === false &&
    raw.sellTaxPct           !== null  &&
    raw.buyTaxPct            !== null  &&
    sellTax                  <= 5      &&
    buyTax                   <= 5      &&
    raw.canMint              === false &&
    raw.canBlacklist         === false &&
    raw.canPauseTrading      === false &&
    raw.canChangeTax         === false &&
    raw.canChangeBalance     === false &&
    raw.canTakeBackOwnership === false &&
    raw.ownerRenounced       === true;

  let riskLevel: RiskLevel;
  if (isCritical)            riskLevel = "CRITICAL";
  else if (isHigh)           riskLevel = "HIGH";
  else if (isLow)            riskLevel = "LOW";
  else if (flags.length > 0) riskLevel = "MEDIUM";
  else                       riskLevel = "UNKNOWN";

  // ── confidence ────────────────────────────────────────────────────────────
  const missingCount = raw.missingData.length;
  let confidence: RiskConfidence;
  if (missingCount === 0)     confidence = "HIGH";
  else if (missingCount <= 2) confidence = "MEDIUM";
  else                        confidence = "LOW";

  // ── summary ───────────────────────────────────────────────────────────────
  let summary: string;
  if (riskLevel === "CRITICAL") {
    const reasons: string[] = [];
    if (raw.isHoneypot           === true) reasons.push("honeypot");
    if (raw.cannotSell           === true) reasons.push("cannot sell");
    if (sellTax                  >= 20)    reasons.push(`sell tax ${sellTax}%`);
    if (raw.canMint              === true) reasons.push("mintable");
    if (raw.canPauseTrading      === true) reasons.push("pausable");
    if (raw.canChangeBalance     === true) reasons.push("balance modifiable");
    if (raw.canTakeBackOwnership === true) reasons.push("ownership reclaimable");
    summary = `CRITICAL: ${reasons.join(", ")}`;
  } else if (riskLevel === "HIGH") {
    const reasons: string[] = [];
    if (sellTax              > 10)    reasons.push(`sell tax ${sellTax}%`);
    if (buyTax               > 10)    reasons.push(`buy tax ${buyTax}%`);
    if (raw.canBlacklist     === true) reasons.push("blacklist enabled");
    if (raw.canChangeTax     === true) reasons.push("tax modifiable");
    if (raw.ownerRenounced   === false) reasons.push("owner not renounced");
    summary = `HIGH RISK: ${reasons.join(", ")}`;
  } else if (riskLevel === "MEDIUM") {
    summary = `MEDIUM RISK: ${flags.join(", ")}`;
  } else if (riskLevel === "LOW") {
    summary = "LOW RISK: no critical flags detected";
  } else {
    summary = `UNKNOWN: ${missingCount} data points missing`;
  }

  return { ...raw, riskLevel, confidence, flags, summary };
}

export function buildRiskResult(raw: RiskResult): RiskResult {
  return classifyRisk(raw);
}