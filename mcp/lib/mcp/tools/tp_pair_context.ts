import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildPairContextReport } from "../../reports/pair-context-report";
import { mcpResponse, mcpErr, PREFLIGHT_OUTPUT_SCHEMA } from "../errors";

export function registerPairContext(server: McpServer) {
  server.registerTool(
    "tp_pair_context",
    {
      title: "Preflight Pair Context",
      description: `Get everything the worker knows about a specific pair.

Combines pair_states (live, TTL 120s) + worker_snapshot (24h) + all pipeline maps.

pipelineState: WATCHING = subscribed via WS, accumulating flow
               HOT      = confirmed buying flow observed
			   ARMED    = qualification criteria observed, awaiting 30s price confirmation
               NONE     = not currently tracked in pipeline

contextQuality: fresh (<45s), aging (<90s), stale (>90s), snapshot_only, unknown

For Solana pools, returns registry + price snapshot + activity + history + observed candidate.

Args: pair_address (0x... EVM address, V4 pool ID, or Solana pool address), chain (optional: base/arbitrum/bsc/eth/solana)`,
      inputSchema: {
        pair_address: z.string().min(10).max(120).describe("EVM pair address (0x...), V4 pool ID, or Solana pool address (base58)"),
        chain:        z.enum(["base", "arbitrum", "bsc", "eth", "solana"]).optional().describe("Chain hint: 'base', 'arbitrum', 'bsc', 'eth', or 'solana'"),
      },
      outputSchema: PREFLIGHT_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pair_address, chain }: { pair_address: string; chain?: string }) => {
      const report = await buildPairContextReport({
        pairAddress: pair_address,
        chain,

      });

      if (!report.ok) {
        return mcpErr(report.errorCode ?? "INTERNAL", report.errorMessage ?? "Unknown error");
      }

      return mcpResponse({
        text:         JSON.stringify(report.payload, null, 2),
        data:         report.payload,
        freshnessSec: report.freshnessSec,
        confidence:   report.confidence,
        warnings:     report.warnings,
        dataQuality:  report.dataQuality,
      });
    },
  );
}
