import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis } from "../redis-reader";
import { mcpOk, mcpErr, ERR } from "../errors";

export function registerDoNotChase(server: McpServer) {
  server.registerTool(
    "tp_do_not_chase",
    {
      title: "Preflight Do Not Chase",
      description: `Anti-FOMO list: pairs that look active but the worker dropped or rejected.

Returns pairs recently dropped from HOT/ARMED/WATCHING with reasons.
Use this to avoid chasing tokens that already failed worker's quality check.

Args: limit (default 10, max 30), minutes_back (default 10, max 10)`,
      inputSchema: {
        limit:        z.number().int().min(1).max(30).default(10),
        minutes_back: z.number().int().min(1).max(10).default(10),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, minutes_back }: { limit: number; minutes_back: number }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, drops, states } = ctx;
        const cutoff = now - minutes_back * 60_000;
        const recent = drops.filter(d => d.droppedAt >= cutoff).slice(0, limit);

        if (!recent.length) return mcpOk(`No drops in the last ${minutes_back} minutes. Pipeline has been stable.`);

        const lines: string[] = [];
        lines.push(`DO NOT CHASE — dropped in last ${minutes_back}m (${recent.length} total):`);
        lines.push("");

        for (const d of recent) {
          const ageSec   = Math.round((now - d.droppedAt) / 1000);
          const pairData = states[d.pairAddress];
          const phase    = pairData?.phase ?? "?";

          const fromState = (d as any).wasIn ?? d.previousState ?? "UNKNOWN";
          const reason    = (d as any).dropReason ?? d.reason ?? "unknown";
          const symbol    = d.symbol ?? d.pairAddress?.slice(0, 8) ?? "UNKNOWN";
          const chain     = d.chain ?? "unknown";

          let line = `${symbol} [${chain}] — dropped from ${fromState} ${ageSec}s ago`;
          line += `\n  Reason: ${reason}`;
          if (phase !== "?") line += ` | phase: ${phase}`;
          if (pairData?.flow?.hasData) line += ` | flow now: ${pairData.flow.pressure}`;

          const r = reason.toLowerCase();
          if (r.includes("flow faded") || r.includes("flow turned") || r.includes("no buying flow")) {
            line += "\n  → Buying interest evaporated. Do not re-enter without fresh WS confirmation.";
          } else if (r.includes("too late") || r.includes("vertical")) {
            line += "\n  → Price already moved significantly. Entry now = buying the top.";
          } else if (r.includes("dump") || r.includes("-")) {
            line += "\n  → Price dumped after signal. Avoid until structure rebuilds.";
          } else if (r.includes("gate") || r.includes("score") || r.includes("evidence")) {
            line += "\n  → Failed quality check. Worker's criteria not met.";
          } else if (r.includes("no ws") || r.includes("no confirmation")) {
            line += "\n  → Never confirmed with live flow data. Signal was unverified.";
          } else if (r.includes("expired") || r.includes("5m")) {
            line += "\n  → Timed out without confirmation. Move may be over.";
          }

          lines.push(line);
          lines.push("");
        }

        return mcpOk(lines.join("\n").trim());
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}
