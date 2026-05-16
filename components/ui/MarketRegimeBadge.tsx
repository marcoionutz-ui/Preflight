"use client";

import type { MarketRegime } from "@/lib/engines/marketRegime";

interface Props {
  regime: MarketRegime | null;
}

export default function MarketRegimeBadge({ regime }: Props) {
  if (!regime) return null;

  return (
    <div style={{
      background: "#070707",
      border: `1px solid ${regime.color}33`,
      borderRadius: 4,
      padding: "10px 14px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2 }}>MARKET REGIME</div>
        <div style={{
          color: regime.color,
          fontSize: 10,
          fontFamily: "monospace",
          fontWeight: "bold",
          border: `1px solid ${regime.color}44`,
          borderRadius: 2,
          padding: "1px 8px",
          letterSpacing: 1,
        }}>
          {regime.emoji} {regime.label}
        </div>
      </div>

      {/* Adjustments */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 8 }}>
        {[
          [
            "MIN EDGE",
            `${75 + regime.minEdgeScoreAdj}`,
            regime.minEdgeScoreAdj > 0 ? "#ff3b3b" : regime.minEdgeScoreAdj < 0 ? "#39ff14" : "#555",
          ],
          [
            "FOMO",
            regime.fomoMultiplier > 1 ? `${regime.fomoMultiplier}× strict` : regime.fomoMultiplier < 1 ? `${regime.fomoMultiplier}× relaxed` : "normal",
            regime.fomoMultiplier > 1 ? "#ff3b3b" : regime.fomoMultiplier < 1 ? "#39ff14" : "#555",
          ],
          [
            "AUTO PAPER",
            regime.autoPaperEnabled ? "ON" : "PAUSED",
            regime.autoPaperEnabled ? "#39ff14" : "#ff3b3b",
          ],
        ].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#0a0a0a", borderRadius: 3, padding: "5px 7px" }}>
            <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>{l as string}</div>
            <div style={{ color: c as string, fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>{v as string}</div>
          </div>
        ))}
      </div>

      {/* Reasoning */}
      {regime.reasoning.map((r, i) => (
        <div key={i} style={{ color: "#333", fontSize: 9, fontFamily: "monospace", marginBottom: 2 }}>
          ▸ {r}
        </div>
      ))}
    </div>
  );
}