/**
 * @preflight/risk-layer — types.ts
 * Contractul stabil pentru risk assessment.
 * Nicio dependență de Redis, worker sau MCP.
 */

export type RiskLevel      = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "UNKNOWN";
export type RiskConfidence = "LOW" | "MEDIUM" | "HIGH";

export type RiskFlag =
  | "HONEYPOT"
  | "CANNOT_SELL"
  | "HIGH_BUY_TAX"
  | "HIGH_SELL_TAX"
  | "MODERATE_BUY_TAX"
  | "MODERATE_SELL_TAX"
  | "CAN_MINT"
  | "CAN_BLACKLIST"
  | "CAN_PAUSE_TRADING"
  | "CAN_CHANGE_TAX"
  | "CAN_CHANGE_BALANCE"
  | "CAN_TAKE_BACK_OWNERSHIP"
  | "OWNER_NOT_RENOUNCED"
  | "PROXY_CONTRACT"
  | "TRADING_COOLDOWN"
  | "TRANSFER_PAUSABLE"
  | "VERY_NEW_TOKEN"
  | "UNKNOWN_RISK";

export interface RiskResult {
  // Identity
  chain:        string;
  tokenAddress: string;
  checkedAt:    number;
  source:       "goplus" | "unavailable";

  // Verdict
  riskLevel:   RiskLevel;
  confidence:  RiskConfidence;
  flags:       RiskFlag[];
  summary:     string;

  // Raw fields — boolean | null: null = unknown, false = verified safe
  isHoneypot:           boolean | null;
  buyTaxPct:            number  | null;
  sellTaxPct:           number  | null;
  cannotSell:           boolean | null;  // fix ChatGPT: explicit field
  ownerRenounced:       boolean | null;
  canChangeTax:         boolean | null;
  canBlacklist:         boolean | null;
  canMint:              boolean | null;
  canPauseTrading:      boolean | null;
  canChangeBalance:     boolean | null;
  canTakeBackOwnership: boolean | null;
  tokenAgeMinutes:      number  | null;
  missingData:          string[];

  raw?: unknown;
}

// Chain ID map pentru GoPlus API.
// Both "eth" (external short code) and "ethereum" (worker canonical id) map to
// GoPlus mainnet id "1" — callers may pass either. risk-layer nu importă
// @preflight/schema (ar crea ciclu), deci alias-ul e listat explicit aici.
export const GOPLUS_CHAIN_IDS: Record<string, string> = {
  base:     "8453",
  arbitrum: "42161",
  bsc:      "56",
  eth:      "1",
  ethereum: "1",
  polygon:  "137",
};