import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis } from "../redis-reader";
import { getTokenSafety, cleanTokenAddress, deriveChainFromTokenAddress } from "../goplus";
import { mcpOk, mcpErr, ERR } from "../errors";

export function registerPreflightSafety(server: McpServer) {
  server.registerTool(
    "tp_preflight_safety",
    {
      title: "Preflight Token Safety",
      description: `Run a GoPlus security check on a token before acting on a HOT or ARMED signal.

Checks: honeypot detection, buy/sell tax, owner permissions, owner renounced status, token age.

Returns agentVerdict: BLOCK | HIGH_CAUTION | OK_TO_INVESTIGATE | UNKNOWN_CHECK_MANUALLY

Results are cached in Redis for 30 minutes.

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

        if (!resolvedChain && rawTokenAddress) resolvedChain = deriveChainFromTokenAddress(rawTokenAddress);
        if (!resolvedChain && ctx) {
          resolvedChain = ctx.hot[addr]?.chain ?? ctx.watch[addr]?.chain ?? ctx.armed[addr]?.chain ?? null;
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
            `agentVerdict: UNKNOWN_CHECK_MANUALLY`,
          ].join("\n"));
        }

        const safety    = await getTokenSafety(rawTokenAddress, resolvedChain);
        const tokenAddr = cleanTokenAddress(rawTokenAddress);

        const verdictEmoji =
          safety.agentVerdict === "BLOCK"             ? "🚫" :
          safety.agentVerdict === "HIGH_CAUTION"      ? "⚠️" :
          safety.agentVerdict === "OK_TO_INVESTIGATE" ? "🟢" : "❓";

        const lines: string[] = [];
        lines.push(`PREFLIGHT SAFETY: ${symbol} / ${resolvedChain.toUpperCase()}`);
        lines.push(`Token: ${tokenAddr}`);
        lines.push(`Source: ${safety.source === "cache" ? "cached (GoPlus)" : safety.source === "goplus" ? "GoPlus live" : "unavailable"}`);
        lines.push(``);
        lines.push(`${verdictEmoji} Agent Verdict: ${safety.agentVerdict}`);
        lines.push(``);

        const sellEmoji = safety.sellability === "PASS" ? "✅" : safety.sellability === "FAIL" ? "🚫" : "❓";
        lines.push(`SELLABILITY: ${sellEmoji} ${safety.sellability}`);
        if (safety.isHoneypot === true)  lines.push(`  • Honeypot detected — cannot sell`);
        if (safety.isHoneypot === false) lines.push(`  • No honeypot detected`);
        if (safety.buyTaxPct  !== null)  lines.push(`  • Buy tax:  ${safety.buyTaxPct}%`);
        if (safety.sellTaxPct !== null)  lines.push(`  • Sell tax: ${safety.sellTaxPct}%`);
        lines.push(``);

        const ownerEmoji = safety.ownerRisk === "LOW" ? "✅" : safety.ownerRisk === "HIGH" ? "🚫" : safety.ownerRisk === "MEDIUM" ? "⚠️" : "❓";
        lines.push(`OWNER CONTROLS: ${ownerEmoji} ${safety.ownerRisk}`);
        if (safety.ownerRenounced === true)  lines.push(`  • Owner renounced ✅`);
        if (safety.ownerRenounced === false) lines.push(`  • Owner NOT renounced ⚠️`);
        if (safety.canChangeTax)             lines.push(`  • Can change tax ⚠️`);
        if (safety.canMint)                  lines.push(`  • Can mint new tokens 🚫`);
        if (safety.canBlacklist)             lines.push(`  • Can blacklist wallets ⚠️`);
        if (safety.canPauseTrading)          lines.push(`  • Can pause trading 🚫`);
        if (safety.canChangeBalance)         lines.push(`  • Owner can change balances 🚫`);
        if (safety.canTakeBackOwnership)     lines.push(`  • Can take back ownership 🚫`);
        lines.push(``);

        if (safety.tokenAgeMinutes !== null) {
          const ageStr =
            safety.tokenAgeMinutes < 60   ? `${safety.tokenAgeMinutes}m` :
            safety.tokenAgeMinutes < 1440 ? `${Math.round(safety.tokenAgeMinutes / 60)}h` :
            `${Math.round(safety.tokenAgeMinutes / 1440)}d`;
          const ageWarn = safety.tokenAgeMinutes < 60 ? " ⚠️ very new" : safety.tokenAgeMinutes < 360 ? " ⚠️ new" : "";
          lines.push(`TOKEN AGE: ${ageStr}${ageWarn}`);
          lines.push(``);
        }

        if (safety.missingData.length > 0) {
          lines.push(`MISSING DATA:`);
          safety.missingData.forEach(m => lines.push(`  • ${m}`));
          lines.push(``);
        }

        lines.push(`VERDICT EXPLANATION:`);
        if (safety.agentVerdict === "BLOCK") {
          lines.push(`  Cannot safely exit this position. Do not act on HOT/ARMED signal.`);
        } else if (safety.agentVerdict === "HIGH_CAUTION") {
          lines.push(`  Structural risk detected. Owner controls or high tax may impact profitability.`);
        } else if (safety.agentVerdict === "OK_TO_INVESTIGATE") {
          lines.push(`  No critical contract risks detected. Flow signal can be treated as structurally valid.`);
        } else {
          lines.push(`  Safety data incomplete. Treat HOT signal with caution until verified manually.`);
        }

        return mcpOk(lines.join("\n"));
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
