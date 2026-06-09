import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readAllRedis, formatEth } from "../redis-reader";
import { mcpOk, mcpErr, ERR } from "../errors";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const fmtPrice = (n: number) =>
  Number.isFinite(n) && n > 0 ? n.toExponential(3) : "n/a";

export function registerOpenPositions(server: McpServer) {
  server.registerTool(
    "tp_open_positions",
    {
      title: "Preflight Open Positions",
      description: `Monitor currently open tracked positions.

Returns for each open position:
- Symbol, chain, pair address
- Entry price, current price, P&L %
- Time in trade, source, edge score at entry
- Current WS flow (BUYING / SELLING / NEUTRAL)
- LP status
- TP1/SL levels and proximity
- Position monitoring flags:
  - SELL_FLOW_OBSERVED
  - LP_REMOVAL_OBSERVED
  - NEAR_CONFIGURED_SL
  - NEAR_CONFIGURED_TP1
  - LONG_HOLD_3H

No arguments needed.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      try {
        // ── Fetch open trades from Supabase ───────────────────────────────
        const { data: trades, error } = await supabase
          .from("shadow_trades")
          .select("id, symbol, chain, pair_address, entry_price, current_price, edge_score, sl, tp1, tp2, note, timestamp")
          .is("exited_at", null)
          .order("timestamp", { ascending: false });

        if (error) return mcpErr(ERR.INTERNAL, error.message);

        if (!trades || trades.length === 0) {
          return mcpOk("OPEN POSITIONS: none");
        }

        // ── Get Redis context for live flow/LP data ───────────────────────
        const ctx    = await readAllRedis();
        const states = ctx?.states ?? {};
        const now    = ctx?.now ?? Date.now();

        const lines: string[] = [];
        lines.push(`OPEN POSITIONS: ${trades.length}`);
        lines.push("");

        for (const trade of trades) {
          const addr  = trade.pair_address?.toLowerCase() ?? "";
          const note  = trade.note ?? "";
          const pairState = states[addr] ?? null;

          // ── Safe numeric parsing ────────────────────────────────────────
          const num = (v: unknown) => {
		  const n = Number(v);
		    return Number.isFinite(n) ? n : 0;
		  };

		  const entryPrice   = num(trade.entry_price);
		  const redisPrice   = num(pairState?.currentPrice);
		  const dbPrice      = num(trade.current_price);
		  const currentPrice = redisPrice > 0 ? redisPrice : dbPrice;
		  const slPrice      = num(trade.sl);
		  const tp1Price     = num(trade.tp1);

          // ── Age ─────────────────────────────────────────────────────────
          const openedAtMs =
            typeof trade.timestamp === "number"
              ? trade.timestamp
              : trade.timestamp
                ? new Date(trade.timestamp).getTime()
                : now;
          const ageMs  = Number.isFinite(openedAtMs) ? now - openedAtMs : 0;
          const ageMin = Math.round(ageMs / 60_000);

          // ── P&L ─────────────────────────────────────────────────────────
          const pnlPct = entryPrice > 0
            ? ((currentPrice - entryPrice) / entryPrice * 100)
            : 0;

          // ── Distance to SL / TP1 ────────────────────────────────────────
          const distToSL  = entryPrice > 0 && slPrice  > 0 ? ((currentPrice - slPrice)  / entryPrice * 100) : null;
          const distToTP1 = entryPrice > 0 && tp1Price > 0 ? ((tp1Price - currentPrice)  / entryPrice * 100) : null;

          // ── Flow + LP from Redis ─────────────────────────────────────────
          const flow = pairState?.flow;
          const lp   = pairState?.lp;

          // ── Source from note ─────────────────────────────────────────────
          const source =
            /source:VERTICAL/i.test(note) ? "VERTICAL" :
            /source:LATE/i.test(note)     ? "LATE"     :
            /source:FOMO/i.test(note)     ? "FOMO"     :
            /source:WS/i.test(note)       ? "WS"       :
            "UNKNOWN";

          // ── Position flags ───────────────────────────────────────────────
          const positionFlags: string[] = [];
          if (flow?.pressure === "SELLING" && flow?.hasData)  positionFlags.push("SELL_FLOW_OBSERVED");
          if (lp?.status === "REMOVED" && lp?.hasData)        positionFlags.push("LP_REMOVAL_OBSERVED");
          if (distToSL  !== null && distToSL  < 3)            positionFlags.push("NEAR_CONFIGURED_SL");
          if (distToTP1 !== null && distToTP1 < 2)            positionFlags.push("NEAR_CONFIGURED_TP1");
          if (ageMs > 3 * 60 * 60_000)                        positionFlags.push("LONG_HOLD_3H");

          const pnlStr   = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`;
          const pnlEmoji = pnlPct > 5 ? "🟢" : pnlPct < -5 ? "🔴" : "🟡";

          lines.push(`${pnlEmoji} ${trade.symbol ?? "?"} [${trade.chain ?? "?"}]`);
          lines.push(`  pair:${addr}`);
          lines.push(`  entry:${fmtPrice(entryPrice)} → now:${fmtPrice(currentPrice)} | P&L: ${pnlStr}`);
          lines.push(`  age:${ageMin}m | source:${source} | edge:${trade.edge_score ?? "?"}`);
          lines.push(`  SL:${fmtPrice(slPrice)} (${distToSL !== null ? `${distToSL.toFixed(1)}% away` : "?"}) | TP1:${fmtPrice(tp1Price)} (${distToTP1 !== null ? `${distToTP1.toFixed(1)}% away` : "?"})`);

          if (flow?.hasData) {
            lines.push(`  flow:${flow.pressure} | buys:${flow.buys5m} sells:${flow.sells5m} | buyVol:${formatEth(flow.buyVol5m ?? 0)} netVol:${formatEth(flow.netVol5m ?? 0)}`);
          } else {
            lines.push(`  flow: no WS data`);
          }

          if (lp?.hasData) {
            lines.push(`  lp:${lp.status}${lp.status === "REMOVED" ? ` 🚨 -${formatEth(lp.lpRemoved5m ?? 0)} in 5m` : ""}`);
          }

          if (positionFlags.length > 0) {
            lines.push(`  flags: ${positionFlags.join(" | ")}`);
          }

          lines.push("");
        }

        return mcpOk(lines.join("\n").trimEnd());
      } catch (e) { return mcpErr(ERR.INTERNAL, e instanceof Error ? e.message : String(e)); }
    },
  );
}