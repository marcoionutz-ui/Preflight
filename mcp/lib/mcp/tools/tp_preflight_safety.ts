import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis } from "../redis-reader";
import { getRedis } from "@/lib/db/redis";
import { checkTokenRisk } from "@preflight/risk-layer";
import type { RiskResult } from "@preflight/risk-layer";
import { mcpOk, mcpErr, ERR } from "../errors";

// fix ChatGPT: cache comun cu workerul — același key ca riskChecker.ts
const RISK_CACHE_TTL_SEC       = 6 * 60 * 60;
const RISK_UNAVAILABLE_TTL_SEC = 10 * 60;

function riskCacheKey(chain: string, tokenAddress: string): string {
  return `preflight:risk:${chain.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

async function getTokenRiskForSafety(
  tokenAddress: string,
  chain:        string,
): Promise<RiskResult> {
  const r        = getRedis();
  const chainKey = chain.toLowerCase();
  const token    = tokenAddress.toLowerCase();
  const key      = riskCacheKey(chainKey, token);

  if (r) {
    try {
      const cached = await r.get(key);
      if (cached) return JSON.parse(cached) as RiskResult;
    } catch { /* cache miss */ }
  }

  const result = await checkTokenRisk(token, chainKey, process.env.GOPLUS_API_KEY);

  if (r) {
    try {
      const ttl = result.source === "goplus"
        ? RISK_CACHE_TTL_SEC
        : RISK_UNAVAILABLE_TTL_SEC;
      await r.set(key, JSON.stringify(result), "EX", ttl);
    } catch { /* non-fatal */ }
  }

  return result;
}

function deriveChainFromTokenAddress(raw: string): string | null {
  const match = raw.match(/^([a-z]+)_0x/i);
  return match ? match[1].toLowerCase() : null;
}

function cleanTokenAddress(raw: string): string {
  return raw.replace(/^[a-z]+_/i, "").toLowerCase().trim();
}

// fix ChatGPT: neutral language, nu advisor
function getSafetyStatus(risk: RiskResult): string {
  if (risk.source === "unavailable") return "UNKNOWN_RISK";
  if (risk.riskLevel === "CRITICAL") return "CRITICAL_RISK";
  if (risk.riskLevel === "HIGH")     return "HIGH_RISK";
  if (risk.riskLevel === "MEDIUM")   return "MEDIUM_RISK";
  if (risk.riskLevel === "LOW")      return "LOW_DETECTED_RISK";
  return "UNKNOWN_RISK";
}

// fix ChatGPT: null != PASS
function getSellability(risk: RiskResult): "PASS" | "FAIL" | "UNKNOWN" {
  if (risk.isHoneypot === true || risk.cannotSell === true)         return "FAIL";
  if (risk.isHoneypot === false && risk.cannotSell === false)       return "PASS";
  return "UNKNOWN";
}

// fix ChatGPT: LOW cere === false pe toate câmpurile
function getOwnerRisk(risk: RiskResult): "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN" {
  if (
    risk.canMint              === true ||
    risk.canPauseTrading      === true ||
    risk.canChangeBalance     === true ||
    risk.canTakeBackOwnership === true
  ) return "HIGH";

  if (
    risk.canChangeTax  === true ||
    risk.canBlacklist  === true ||
    risk.ownerRenounced === false
  ) return "MEDIUM";

  if (
    risk.ownerRenounced       === true &&
    risk.canMint              === false &&
    risk.canBlacklist         === false &&
    risk.canPauseTrading      === false &&
    risk.canChangeTax         === false &&
    risk.canChangeBalance     === false &&
    risk.canTakeBackOwnership === false
  ) return "LOW";

  return "UNKNOWN";
}

export function registerPreflightSafety(server: McpServer) {
  server.registerTool(
    "tp_preflight_safety",
    {
      title: "Preflight Token Safety",
      description: `Run a GoPlus security check on a token or pair observed by Preflight.

Checks: honeypot detection, buy/sell tax, owner permissions, owner renounced status, token age.

Returns safetyStatus: CRITICAL_RISK | HIGH_RISK | MEDIUM_RISK | LOW_DETECTED_RISK | UNKNOWN_RISK

Results are cached in Redis for 6 hours (shared with worker risk cache).

Args:
  pair_address   — EVM pair address (used to look up token address from worker context)
  token_address  — optional: pass directly if worker snapshot cannot resolve it
  chain          — optional: 'base' or 'arbitrum'`,
      inputSchema: {
        pair_address:  z.string().min(10).describe("EVM pair address (0x...) or V4 pool ID"),
        token_address: z.string().optional().describe("Optional token contract address"),
        chain:         z.string().optional().describe("Chain: 'base' or 'arbitrum'"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pair_address, token_address, chain }: { pair_address: string; token_address?: string; chain?: string }) => {
      try {
        const ctx  = await readAllRedis();
        const addr = pair_address.toLowerCase().trim();

        let rawTokenAddress: string | null = token_address ?? null;
        let resolvedChain = chain ?? null;

        if (!rawTokenAddress && ctx) {
          rawTokenAddress = ctx.snapshot?.memory?.[addr]?.tokenAddress ?? null;
        }

        if (!rawTokenAddress && ctx?.states?.[addr]) {
          rawTokenAddress = (ctx.states[addr] as any).tokenAddress ?? null;
        }

        if (!resolvedChain && rawTokenAddress) resolvedChain = deriveChainFromTokenAddress(rawTokenAddress);
        if (!resolvedChain && ctx) {
          resolvedChain = ctx.hot[addr]?.chain ?? ctx.watch[addr]?.chain ?? ctx.armed[addr]?.chain ?? null;
        }
        if (!resolvedChain && ctx?.states?.[addr]?.chain) {
          resolvedChain = (ctx.states[addr] as any).chain;
        }
        if (resolvedChain) resolvedChain = resolvedChain.toLowerCase().trim();

        const symbol = ctx?.snapshot?.memory?.[addr]?.symbol ?? ctx?.hot[addr]?.symbol ?? ctx?.watch[addr]?.symbol ?? addr.slice(0, 10);

        if (!rawTokenAddress || !resolvedChain) {
          const missing: string[] = [];
          if (!rawTokenAddress) missing.push("token address not found — pass token_address explicitly");
          if (!resolvedChain)   missing.push("chain could not be determined — pass chain: 'base' or 'arbitrum'");
          return mcpOk([
            `PREFLIGHT SAFETY: ${symbol}`,
            ``,
            `⚠️ Cannot run safety check:`,
            ...missing.map(m => `  • ${m}`),
            ``,
            `safetyStatus: UNKNOWN_RISK`,
          ].join("\n"));
        }

        const tokenAddr    = cleanTokenAddress(rawTokenAddress);
        const risk         = await getTokenRiskForSafety(tokenAddr, resolvedChain);
        const safetyStatus = getSafetyStatus(risk);
        const sellability  = getSellability(risk);
        const ownerRisk    = getOwnerRisk(risk);

        const statusEmoji =
          safetyStatus === "CRITICAL_RISK"      ? "🚫" :
          safetyStatus === "HIGH_RISK"           ? "⚠️" :
          safetyStatus === "MEDIUM_RISK"         ? "⚠️" :
          safetyStatus === "LOW_DETECTED_RISK"   ? "🟢" : "❓";

        const lines: string[] = [];
        lines.push(`PREFLIGHT SAFETY: ${symbol} / ${resolvedChain.toUpperCase()}`);
        lines.push(`Token: ${tokenAddr}`);
        lines.push(`Source: ${risk.source === "goplus" ? "GoPlus / shared risk cache" : "unavailable"}`);
        lines.push(`checkedAgeSec: ${Math.round((Date.now() - risk.checkedAt) / 1000)}`);
        lines.push(`riskLevel: ${risk.riskLevel} | confidence: ${risk.confidence}`);
        lines.push(``);
        lines.push(`${statusEmoji} safetyStatus: ${safetyStatus}`);
        lines.push(``);

        const sellEmoji = sellability === "PASS" ? "✅" : sellability === "FAIL" ? "🚫" : "❓";
        lines.push(`SELLABILITY: ${sellEmoji} ${sellability}`);
        if (risk.isHoneypot === true)   lines.push(`  • Honeypot detected`);
        if (risk.isHoneypot === false)  lines.push(`  • No honeypot detected`);
        if (risk.cannotSell === true)   lines.push(`  • Cannot sell all tokens`);
        if (risk.buyTaxPct  !== null)   lines.push(`  • Buy tax:  ${risk.buyTaxPct}%`);
        if (risk.sellTaxPct !== null)   lines.push(`  • Sell tax: ${risk.sellTaxPct}%`);
        lines.push(``);

        const ownerEmoji = ownerRisk === "LOW" ? "✅" : ownerRisk === "HIGH" ? "🚫" : ownerRisk === "MEDIUM" ? "⚠️" : "❓";
        lines.push(`OWNER CONTROLS: ${ownerEmoji} ${ownerRisk}`);
        if (risk.ownerRenounced === true)       lines.push(`  • Owner renounced`);
        if (risk.ownerRenounced === false)      lines.push(`  • Owner NOT renounced`);
        if (risk.canChangeTax === true)         lines.push(`  • Can change tax`);
        if (risk.canMint === true)              lines.push(`  • Can mint new tokens`);
        if (risk.canBlacklist === true)         lines.push(`  • Can blacklist wallets`);
        if (risk.canPauseTrading === true)      lines.push(`  • Can pause trading`);
        if (risk.canChangeBalance === true)     lines.push(`  • Owner can change balances`);
        if (risk.canTakeBackOwnership === true) lines.push(`  • Can take back ownership`);
        lines.push(``);

        if (risk.tokenAgeMinutes !== null) {
          const ageStr =
            risk.tokenAgeMinutes < 60   ? `${risk.tokenAgeMinutes}m` :
            risk.tokenAgeMinutes < 1440 ? `${Math.round(risk.tokenAgeMinutes / 60)}h` :
            `${Math.round(risk.tokenAgeMinutes / 1440)}d`;
          const ageWarn = risk.tokenAgeMinutes < 60 ? " ⚠️ very new" : risk.tokenAgeMinutes < 360 ? " ⚠️ new" : "";
          lines.push(`TOKEN AGE: ${ageStr}${ageWarn}`);
          lines.push(``);
        }

        if (risk.flags.length > 0) {
          lines.push(`FLAGS: ${risk.flags.join(", ")}`);
          lines.push(``);
        }

        if (risk.missingData.length > 0) {
          lines.push(`MISSING DATA:`);
          risk.missingData.forEach(m => lines.push(`  • ${m}`));
          lines.push(``);
        }

        lines.push(`RISK INTERPRETATION:`);
        if (safetyStatus === "CRITICAL_RISK") {
          lines.push(`  Critical contract-level risk signals detected: ${risk.summary}`);
        } else if (safetyStatus === "HIGH_RISK") {
          lines.push(`  Elevated risk signals present: ${risk.summary}`);
        } else if (safetyStatus === "MEDIUM_RISK") {
          lines.push(`  Moderate risk signals present: ${risk.summary}`);
        } else if (safetyStatus === "LOW_DETECTED_RISK") {
          lines.push(`  No critical contract risk signals detected.`);
        } else {
          lines.push(`  Safety data incomplete — ${risk.missingData.length} data points unavailable.`);
        }

        return mcpOk(lines.join("\n"));
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}