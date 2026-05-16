// RadarPanel.tsx
"use client";

import type { Pair, GeckoPool } from "@/types";
import { fmtUSD, ageHours } from "@/lib/utils";
import { computeRedFlags } from "@/lib/engines/redFlags";
import { geckoToDisplay } from "@/lib/apis/geckoterminal";
import Pill from "@/components/ui/Pill";
import { classify } from "@/lib/engines/decision";
import { computeEdgeScore } from "@/lib/engines/edgeScore";
import { checkAntiFOMO } from "@/lib/engines/antiFomo";

interface Props {
  newPools: GeckoPool[];
  trending: Pair[];
  onSelectPair: (pair: Pair) => void;
}

export default function RadarPanel({ newPools, trending, onSelectPair }: Props) {
  // Volume spike pairs
  const spikes = trending.filter((p) => {
    const avg5m = (p.volume?.h1 ?? 0) / 12;
    return avg5m > 0 && (p.volume?.m5 ?? 0) / avg5m > 2;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }} className="fade-in">
      {/* Volume Spikes */}
      <div>
        <div style={{ color: "#282828", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 8 }}>VOLUME SPIKE DETECTOR</div>
        {spikes.length === 0 ? (
          <div style={{ color: "#1e1e1e", fontFamily: "monospace", fontSize: 12, textAlign: "center", padding: 18 }}>No significant spikes detected</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {spikes.slice(0, 6).map((p, i) => {
              const avg5m = Number(p.volume?.h1 ?? 0) / 12;
              const ratio = Number(p.volume?.m5 ?? 0) / avg5m;
              const m5 = Number(p.priceChange?.m5 ?? 0);
              const c = m5 >= 0 ? "#39ff14" : "#ff3b3b";
              const flags = computeRedFlags(p);
              const highFlag = flags.find((f) => f.sev === "high");
              return (
                <div
                  key={i}
                  onClick={() => onSelectPair(p)}
                  style={{ background: "#070707", border: `1px solid ${c}22`, borderRadius: 4, padding: "10px 12px", cursor: "pointer", transition: "border-color 0.15s" }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = c + "55")}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = c + "22")}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ color: "#c8c8c8", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>{p.baseToken?.symbol}</span>
                    <Pill label={`×${Number(ratio).toFixed(1)}`} color="#ffb347" small />
                  </div>
                  <div style={{ color: c, fontSize: 15, fontFamily: "monospace", fontWeight: "bold" }}>
                    {m5 >= 0 ? "+" : ""}{m5.toFixed(2)}%
                  </div>
                  <div style={{ color: "#333", fontSize: 10, fontFamily: "monospace" }}>{fmtUSD(p.volume?.m5)} / 5m</div>
                  {(() => {
                    const es = computeEdgeScore(p, flags, null);
                    const fomo = checkAntiFOMO(p, []);
                    const dec = classify(p, es, fomo, flags);
                    return <div style={{ color: dec.color, fontSize: 9, fontFamily: "monospace", marginTop: 4, fontWeight: "bold" }}>{dec.decision === "TRADE_CANDIDATE" ? "MARKET CANDIDATE" : dec.label}</div>;
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* New Pairs */}
      <div>
        <div style={{ color: "#282828", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 8 }}>NEW PAIRS RADAR</div>
        <div style={{ border: "1px solid #0d0d0d", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 70px 55px 55px", gap: 4, padding: "5px 10px", background: "#060606", borderBottom: "1px solid #0d0d0d" }}>
            {["TOKEN", "PRICE", "MCAP", "VOL 24H", "AGE", "FLAGS"].map((h) => (
              <div key={h} style={{ color: "#1e1e1e", fontSize: 9, fontFamily: "monospace" }}>{h}</div>
            ))}
          </div>
          {newPools.length === 0 ? (
            <div style={{ padding: 14, color: "#1a1a1a", fontFamily: "monospace", fontSize: 11, textAlign: "center" }}>Loading…</div>
          ) : newPools.slice(0, 15).map((pool, i) => {
            const p = geckoToDisplay(pool);
            const a = pool.attributes ?? {};
            const ah = a.pool_created_at ? ageHours(new Date(a.pool_created_at).getTime()) : 0;
            const isNew = ah < 1;
            const flags = computeRedFlags(p);
            const highCount = flags.filter((f) => f.sev === "high").length;

            return (
              <div
                key={i}
                onClick={() => onSelectPair(p)}
                style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 70px 55px 55px", gap: 4, padding: "6px 10px", borderBottom: "1px solid #090909", alignItems: "center", cursor: "pointer", background: isNew ? "rgba(57,255,20,0.015)" : "transparent", transition: "background 0.1s" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(57,255,20,0.025)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = isNew ? "rgba(57,255,20,0.015)" : "transparent")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#b8b8b8", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
                    {(a.name ?? "?").split(" / ")[0].slice(0, 12)}
                  </span>
                  {isNew && <Pill label="NEW" color="#39ff14" small />}
                </div>
                <div style={{ color: "#666", fontSize: 10, fontFamily: "monospace" }}>
                  {a.base_token_price_usd ? "$" + Number(a.base_token_price_usd).toExponential(2) : "—"}
                </div>
                <div style={{ color: "#555", fontSize: 10, fontFamily: "monospace" }}>{fmtUSD(a.market_cap_usd ?? 0)}</div>
                <div style={{ color: "#555", fontSize: 10, fontFamily: "monospace" }}>{fmtUSD(Number(a.volume_usd?.h24 ?? 0))}</div>
                <div style={{ color: ah < 1 ? "#39ff14" : "#444", fontSize: 10, fontFamily: "monospace" }}>
                  {ah < 1 ? Math.round(ah * 60) + "m" : ah < 24 ? Math.round(ah) + "h" : Math.round(ah / 24) + "d"}
                </div>
                <div style={{ color: highCount > 0 ? "#ff3b3b" : flags.length > 0 ? "#ffb347" : "#2a4a2a", fontSize: 10, fontFamily: "monospace" }}>
                  {highCount > 0 ? "⛔" + highCount : flags.length > 0 ? "⚠" + flags.length : "✓"}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
