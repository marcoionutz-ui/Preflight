/**
 * lib/mcp/tools/tp_position_context.ts
 * Primește pozițiile agentului și returnează context live din worker.
 *
 * Agentul aduce datele lui (entry, SL, TP).
 * Preflight adaugă: flow live, LP status, priceChange, pipeline state, flags.
 *
 * Stateless față de Supabase/shadow trades.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAllRedis, formatEth, formatVol, getPipelineState } from "../redis-reader";
import { mcpOk, mcpErr, ERR } from "../errors";

// Normalizează timestamp: seconds → ms dacă e sub 10B
const normalizeTs = (v: unknown): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 10_000_000_000 ? n * 1000 : n;
};

const positionSchema = z.object({
  chain:         z.enum(["base", "arbitrum", "bsc", "eth", "solana"]),
  pair_address:  z.string().optional(),
  token_address: z.string().optional(),
  symbol:        z.string().optional(),
  entry_price:   z.union([z.string(), z.number()]),
  entry_time:    z.union([z.string(), z.number()]).optional(),
  sl:            z.union([z.string(), z.number()]).optional(),
  tp1:           z.union([z.string(), z.number()]).optional(),
  size_usd:      z.union([z.string(), z.number()]).optional(),
});

type Position = z.infer<typeof positionSchema>;

function getLpCoverage(dexType: string | null | undefined, hasData: boolean): string {
  const d = (dexType ?? "").toUpperCase();

  if (d === "V4") return "V4_INVESTIGATING";

  if (hasData) {
    if (d === "V3") return "V3_FULL";
    if (d === "V2") return "V2_FULL";
    return "LP_EVENTS_OBSERVED";
  }

  if (d === "V3") return "V3_NO_EVENTS_5M";
  if (d === "V2") return "V2_NO_EVENTS_5M";

  return "NO_LP_COVERAGE";
}

export function registerPositionContext(server: McpServer) {
  server.registerTool(
    "tp_position_context",
    {
      title: "Preflight Position Context",
      description: `Enriches agent-supplied positions with live market context from the worker.

Supply your open positions — Preflight adds live flow, LP status, priceChange, pipeline state, and monitoring flags.

Does NOT read internal state — the agent owns the position data, Preflight owns the market data.

Args:
  positions[] — list of open positions (max 20)
  Each position requires: chain, entry_price
  Optional: pair_address (preferred for EVM — used for live lookup), token_address (fallback; may not resolve if worker indexes by pair), symbol, entry_time, sl, tp1, size_usd

Returns per position:
  - Current price + P&L %
  - Flow (pressure, buys/sells 5m, net volume)
  - LP status
  - Pipeline state (WATCHING / HOT / ARMED / NONE)
  - priceChange (m5/h1/h24)
  - Monitoring flags: NEAR_SL, NEAR_TP1, SELL_FLOW_OBSERVED, BUY_FLOW_PRESENT, LP_REMOVAL_OBSERVED, LONG_HOLD_3H
  - Data age`,
      inputSchema: {
        positions: z.array(positionSchema).min(1).max(20),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ positions }: { positions: Position[] }) => {
      try {
        const ctx = await readAllRedis();
        if (!ctx) return mcpErr(ERR.REDIS_DOWN, "Redis not connected");

        const { now, states, watch, hot, armed } = ctx;
        const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

        const lines: string[] = [];
        lines.push(`POSITION CONTEXT: ${positions.length} supplied`);
        lines.push("");

        for (const pos of positions) {
          const addr      = (pos.pair_address ?? pos.token_address ?? "").toLowerCase().trim();
          const pairState = addr ? (states[addr] ?? null) : null;
          const symbol    = pos.symbol ?? pairState?.symbol ?? (addr ? addr.slice(0, 8) : "?");
          const chain     = pos.chain;

          const entryPrice = num(pos.entry_price);
          const sl         = pos.sl       !== undefined ? num(pos.sl)       : null;
          const tp1        = pos.tp1      !== undefined ? num(pos.tp1)      : null;
          const sizeUsd    = pos.size_usd !== undefined ? num(pos.size_usd) : null;
          // fix ChatGPT #2: normalizeTs pentru seconds vs ms
          const entryTime  = pos.entry_time !== undefined ? normalizeTs(pos.entry_time) : null;

          // ── Price + P&L ──────────────────────────────────────────────────
          // fix ChatGPT #3: num() pentru currentPrice
          const currentPrice = num(pairState?.currentPrice ?? 0);
          const pnlPct = entryPrice > 0 && currentPrice > 0
            ? ((currentPrice - entryPrice) / entryPrice * 100)
            : null;
          const pnlStr = pnlPct !== null
            ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`
            : "N/A";

          // ── Age ──────────────────────────────────────────────────────────
          const ageMs  = entryTime ? now - entryTime : null;
          const ageStr = ageMs !== null
            ? ageMs < 3_600_000
              ? `${Math.round(ageMs / 60_000)}m`
              : `${Math.round(ageMs / 3_600_000)}h`
            : null;

          // ── Flow ─────────────────────────────────────────────────────────
          const flow    = pairState?.flow ?? null;
          const hasFlow = flow?.hasData ?? false;

          // ── Pipeline state ────────────────────────────────────────────────
          const pipeState = addr ? getPipelineState(addr, watch, hot, armed) : "UNKNOWN";

          // ── Price change ──────────────────────────────────────────────────
          const pc = pairState?.priceChange ?? null;

          // ── LP status — fix ChatGPT #4: fallback lp.status → lpSignal ────
          const lpData   = (pairState as any)?.lp ?? null;
          const lpStatus = lpData?.status ?? (pairState as any)?.lpSignal ?? null;

          // ── Data age ──────────────────────────────────────────────────────
          const dataAgeMs  = pairState ? now - pairState.updatedAt : null;
          const dataAgeSec = dataAgeMs !== null ? Math.round(dataAgeMs / 1000) : null;

          // ── Monitoring flags ──────────────────────────────────────────────
          const flags: string[] = [];

          if (hasFlow && flow!.pressure === "SELLING") flags.push("SELL_FLOW_OBSERVED");
          if (hasFlow && flow!.pressure === "BUYING")  flags.push("BUY_FLOW_PRESENT");

          if (sl !== null && currentPrice > 0) {
            const distToSl = Math.abs((currentPrice - sl) / sl);
            if (distToSl < 0.05) flags.push("NEAR_SL");
          }
          if (tp1 !== null && currentPrice > 0) {
            const distToTp1 = Math.abs((currentPrice - tp1) / tp1);
            if (distToTp1 < 0.05) flags.push("NEAR_TP1");
          }

          // fix ChatGPT #4: LP_REMOVAL din lp.status
          if (lpData?.status === "REMOVED" || (pairState as any)?.lpRemovalDetected) {
            flags.push("LP_REMOVAL_OBSERVED");
          }

          // fix ChatGPT #2: LONG_HOLD cu timestamp normalizat
          if (ageMs !== null && ageMs > 3 * 3_600_000) flags.push("LONG_HOLD_3H");

          // ── Build output block ────────────────────────────────────────────
          lines.push(`${symbol} [${chain.toUpperCase()}]`);
          if (addr) lines.push(`pair:${addr}`);

          lines.push(
            currentPrice > 0
              ? `entry:${entryPrice} → now:${currentPrice.toPrecision(6)} | P&L:${pnlStr}`
              : `entry:${entryPrice} | P&L:N/A (not tracked)`
          );

          if (ageStr)  lines.push(`age:${ageStr}`);
          if (sizeUsd) lines.push(`size:$${sizeUsd}`);

          if (hasFlow && flow) {
            lines.push(`flow:${flow.pressure} | buys:${flow.buys5m} sells:${flow.sells5m} | netVol:${formatVol((flow as any).netVol5mUsd, flow.netVol5m)}`);
          } else {
            lines.push(`flow:NO_WS_DATA`);
          }

          if (lpStatus) lines.push(`lp:${lpStatus}(${getLpCoverage((pairState as any)?.dexType, lpData?.hasData ?? false)})`);
          lines.push(`pipeline:${pipeState}`);

          if (pc) {
            const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
            lines.push(`priceChange: m5:${fmt(pc.m5)} h1:${fmt(pc.h1)} h24:${fmt(pc.h24)}`);
          }

          lines.push(flags.length ? `flags: ${flags.join(" | ")}` : `flags: NONE`);
          if (dataAgeSec !== null) lines.push(`dataAge:${dataAgeSec}s`);
          else                     lines.push(`dataAge:NOT_TRACKED`);

          lines.push("");
        }

        return mcpOk(lines.join("\n").trim());
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}