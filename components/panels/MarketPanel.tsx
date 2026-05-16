"use client";

import type { Pair, FearGreedEntry, CoinPrices } from "@/types";
import { fmtUSD, fmtPct } from "@/lib/utils";

interface Props {
  fg: FearGreedEntry[];
  coins: CoinPrices;
  chain: string;
  trending: Pair[];
  briefing: string;
  briefingLoading: boolean;
  onBriefing: () => void;
}

export default function MarketPanel({ fg, coins, chain, trending, briefing, briefingLoading, onBriefing }: Props) {
  const latest = fg?.[0];
  const val = Number(latest?.value ?? 50);
  const fgColor = val >= 70 ? "#39ff14" : val >= 50 ? "#a8ff3e" : val >= 30 ? "#ffb347" : "#ff3b3b";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }} className="fade-in">
      {/* Coin prices */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {[
          ["BTC", coins?.bitcoin, "#f7931a"],
          ["ETH", coins?.ethereum, "#627eea"],
          ["SOL", coins?.solana, "#9945ff"],
          ["BNB", coins?.binancecoin, "#f0b90b"],
        ].map(([sym, data, c]) => (
          <div key={sym as string} style={{ background: "#070707", border: `1px solid ${c as string}18`, borderRadius: 4, padding: "8px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 4 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: c as string }} />
              <span style={{ color: "#555", fontSize: 9, fontFamily: "monospace" }}>{sym as string}</span>
            </div>
            {data ? (
              <>
                <div style={{ color: "#b8b8b8", fontSize: 14, fontFamily: "monospace", fontWeight: "bold" }}>
                  ${(data as { usd: number }).usd?.toLocaleString()}
                </div>
                <div style={{ color: (data as { usd_24h_change: number }).usd_24h_change >= 0 ? "#39ff14" : "#ff3b3b", fontSize: 10, fontFamily: "monospace" }}>
                  {fmtPct((data as { usd_24h_change: number }).usd_24h_change)}
                </div>
              </>
            ) : (
              <div style={{ color: "#2a2a2a", fontSize: 12, fontFamily: "monospace" }}>Loading…</div>
            )}
          </div>
        ))}
      </div>

      {/* Fear & Greed */}
      {latest && (
        <div style={{ background: "#070707", border: "1px solid #111", borderRadius: 6, padding: 14 }}>
          <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 12 }}>FEAR & GREED INDEX — 7D</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {/* Circle gauge */}
            <div style={{ position: "relative", width: 70, height: 70, flexShrink: 0 }}>
              <svg width="70" height="70" viewBox="0 0 70 70">
                <circle cx="35" cy="35" r="26" fill="none" stroke="#111" strokeWidth="7" />
                <circle cx="35" cy="35" r="26" fill="none" stroke={fgColor} strokeWidth="7"
                  strokeDasharray={`${(val / 100) * 163.4} 163.4`}
                  strokeLinecap="round" transform="rotate(-90 35 35)"
                  style={{ filter: `drop-shadow(0 0 4px ${fgColor})` }}
                />
              </svg>
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <span style={{ color: fgColor, fontSize: 18, fontFamily: "monospace", fontWeight: "bold" }}>{val}</span>
              </div>
            </div>
            <div>
              <div style={{ color: fgColor, fontSize: 16, fontFamily: "monospace", fontWeight: "bold" }}>{latest.value_classification?.toUpperCase()}</div>
              <div style={{ color: "#333", fontSize: 10, fontFamily: "monospace", marginTop: 4 }}>
                {new Date(Number(latest.timestamp) * 1000).toLocaleDateString()}
              </div>
            </div>
            {/* 7d bars */}
            <div style={{ flex: 1, display: "flex", gap: 3 }}>
              {fg.slice(0, 7).reverse().map((d, i) => {
                const v = Number(d.value);
                const dc = v >= 60 ? "#39ff14" : v >= 40 ? "#ffb347" : "#ff3b3b";
                return (
                  <div key={i} title={`${d.value_classification}: ${d.value}`} style={{ flex: 1, background: "#0a0a0a", borderRadius: 2, padding: "3px 2px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: 36 }}>
                    <div style={{ width: "60%", background: dc, borderRadius: 1, height: (v / 100) * 28 + "px", opacity: i === 6 ? 1 : 0.5 }} />
                    <div style={{ color: "#1a1a1a", fontSize: 7, fontFamily: "monospace", marginTop: 2 }}>{v}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Trending overview */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {trending.slice(0, 6).map((p, i) => {
          const pct = p.priceChange?.h24;
          return (
            <div key={i} style={{ background: "#070707", border: "1px solid #111", borderRadius: 4, padding: "8px 10px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ color: "#c8c8c8", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>{p.baseToken?.symbol}</div>
                <div style={{ color: "#333", fontSize: 9, fontFamily: "monospace" }}>{fmtUSD(p.liquidity?.usd)} liq</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#666", fontSize: 10, fontFamily: "monospace" }}>{fmtUSD(p.volume?.h24)} vol</div>
                <div style={{ color: (pct ?? 0) >= 0 ? "#39ff14" : "#ff3b3b", fontSize: 11, fontFamily: "monospace" }}>{fmtPct(pct)}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* AI Briefing */}
      <div style={{ background: "#070707", border: "1px solid #111", borderRadius: 6, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ color: "#252525", fontSize: 9, fontFamily: "monospace", letterSpacing: 2 }}>AI BRIEFING — {chain.toUpperCase()}</div>
          <button
            onClick={onBriefing}
            disabled={briefingLoading}
            style={{ background: briefingLoading ? "transparent" : "rgba(57,255,20,0.08)", border: `1px solid ${briefingLoading ? "#1a1a1a" : "#39ff14"}`, color: briefingLoading ? "#222" : "#39ff14", borderRadius: 3, padding: "4px 14px", fontSize: 10 }}
          >
            {briefingLoading ? "GENERATING…" : "▶ GENERATE"}
          </button>
        </div>
        {briefing ? (
          <div style={{ color: "#888", fontSize: 12, fontFamily: "monospace", lineHeight: 1.8, whiteSpace: "pre-wrap" }}>{briefing}</div>
        ) : (
          <div style={{ color: "#1a1a1a", fontFamily: "monospace", fontSize: 12, textAlign: "center", padding: 18 }}>
            Click Generate for AI market briefing
          </div>
        )}
      </div>
    </div>
  );
}
