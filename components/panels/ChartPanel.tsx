"use client";

import type { Pair, OHLCVCandle } from "@/types";
import { fmtPrice, fmtPct, fmtUSD } from "@/lib/utils";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";

interface Props {
  pair: Pair | null;
  ohlcv: OHLCVCandle[];
  loading: boolean;
}

export default function ChartPanel({ pair, ohlcv, loading }: Props) {
  if (!pair) {
    return (
      <div style={{ color: "#222", fontSize: 12, fontFamily: "monospace", textAlign: "center", padding: 40 }}>
        Select a token to view chart
      </div>
    );
  }

  const up = ohlcv.length ? ohlcv[ohlcv.length - 1].close >= ohlcv[0].close : true;
  const lineColor = up ? "#39ff14" : "#ff3b3b";
  const last = ohlcv[ohlcv.length - 1];

  const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: Array<{ payload: OHLCVCandle }> }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <div style={{ background: "#080808", border: "1px solid #1a1a1a", borderRadius: 3, padding: "5px 9px", fontSize: 10, fontFamily: "monospace" }}>
        <div style={{ color: "#555" }}>{d.time}</div>
        <div style={{ color: d.close >= d.open ? "#39ff14" : "#ff3b3b" }}>C: ${fmtPrice(d.close)}</div>
        <div style={{ color: "#444" }}>H: ${fmtPrice(d.high)} / L: ${fmtPrice(d.low)}</div>
        <div style={{ color: "#444" }}>V: {fmtUSD(d.volume)}</div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} className="fade-in">
      {/* Token info */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div>
          <div style={{ color: "#e0e0e0", fontSize: 14, fontFamily: "monospace", fontWeight: "bold" }}>
            {pair.baseToken?.symbol} / {pair.quoteToken?.symbol}
          </div>
          <div style={{ color: "#333", fontSize: 10, fontFamily: "monospace" }}>
            {pair.chainId?.toUpperCase()} · {pair.dexId?.toUpperCase()}
          </div>
        </div>
        <div>
          <div style={{ color: "#e0e0e0", fontSize: 18, fontFamily: "monospace", fontWeight: "bold" }}>
            ${fmtPrice(pair.priceUsd)}
          </div>
          <div style={{ color: up ? "#39ff14" : "#ff3b3b", fontSize: 11, fontFamily: "monospace" }}>
            {fmtPct(pair.priceChange?.h24)} (24h)
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ color: "#333", fontFamily: "monospace", fontSize: 12, textAlign: "center", padding: 40 }}>
          Loading chart data…
        </div>
      ) : ohlcv.length < 3 ? (
        <div style={{ color: "#222", fontFamily: "monospace", fontSize: 12, textAlign: "center", padding: 40 }}>
          Chart unavailable — GeckoTerminal may not index this pool yet
          <div style={{ color: "#1a1a1a", marginTop: 8 }}>Try searching for the token directly</div>
        </div>
      ) : (
        <>
          <div>
            <div style={{ color: "#282828", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 6 }}>PRICE — 48H OHLCV</div>
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={ohlcv} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={lineColor} stopOpacity={0.12} />
                    <stop offset="95%" stopColor={lineColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" tick={{ fill: "#282828", fontSize: 9, fontFamily: "monospace" }} tickLine={false} axisLine={false} interval={7} />
                <YAxis tick={{ fill: "#282828", fontSize: 9, fontFamily: "monospace" }} tickLine={false} axisLine={false} width={58} tickFormatter={(v) => "$" + fmtPrice(v)} domain={["auto", "auto"]} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="close" stroke={lineColor} strokeWidth={1.5} fill="url(#areaGrad)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div>
            <div style={{ color: "#282828", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 4 }}>VOLUME</div>
            <ResponsiveContainer width="100%" height={70}>
              <BarChart data={ohlcv} margin={{ top: 0, right: 4, bottom: 0, left: 0 }}>
                <Bar dataKey="volume" fill="#1a1a1a" radius={[1, 1, 0, 0]} />
                <Tooltip content={<CustomTooltip />} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {last && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
              {[["OPEN", last.open], ["HIGH", last.high], ["LOW", last.low], ["CLOSE", last.close]].map(([l, v]) => (
                <div key={l as string} style={{ background: "#080808", border: "1px solid #111", borderRadius: 3, padding: "5px 8px" }}>
                  <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace" }}>{l as string}</div>
                  <div style={{ color: "#777", fontSize: 11, fontFamily: "monospace" }}>${fmtPrice(v as number)}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
