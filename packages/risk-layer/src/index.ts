/**
 * @preflight/risk-layer
 * Shared risk assessment layer pentru toți workerii Preflight.
 *
 * Stateless — fără Redis, fără worker logic, fără MCP.
 * Cache-ul și scheduling sunt responsabilitatea workerului.
 *
 * Usage:
 *   import { checkTokenRisk } from "@preflight/risk-layer";
 *   const result = await checkTokenRisk(tokenAddress, chain, apiKey);
 */

export { fetchGoPlusRaw, RISK_UNAVAILABLE } from "./goplus";
export { classifyRisk, buildRiskResult }    from "./classify";
export type { RiskResult, RiskFlag, RiskLevel, RiskConfidence } from "./types";
export { GOPLUS_CHAIN_IDS } from "./types";

/**
 * Convenience function: fetch + classify într-un singur call.
 * Workerul îl folosește; cache-ul e al lui.
 */
import { fetchGoPlusRaw } from "./goplus";
import { buildRiskResult } from "./classify";
import type { RiskResult } from "./types";

export async function checkTokenRisk(
  tokenAddress: string,
  chain:        string,
  apiKey?:      string,
): Promise<RiskResult> {
  const raw = await fetchGoPlusRaw(tokenAddress, chain, apiKey);
  return buildRiskResult(raw);
}