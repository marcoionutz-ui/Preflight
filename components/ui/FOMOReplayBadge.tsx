"use client";

import { getFOMOStats } from "@/lib/engines/fomoReplay";

export default function FOMOReplayBadge() {
  const stats = getFOMOStats();

  if (stats.total === 0) {
    return (
      <div style={{ background: "#070707", border: "1px solid #0d0d0d", borderRadius: 4, padding: "10px 14px" }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 4 }}>FOMO REPLAY</div>
        <div style={{ color: "#1a1a1a", fontSize: 10, fontFamily: "monospace" }}>No FOMO blocks recorded yet</div>
      </div>
    );
  }

  const accColor = stats.accuracy >= 0.65 ? "#39ff14" : stats.accuracy >= 0.45 ? "#ffb347" : "#ff3b3b";
  const dumpColor = stats.medianMove1h <= -5 ? "#39ff14" : stats.medianMove1h <= 0 ? "#ffb347" : "#ff3b3b";

  return (
    <div style={{ background: "#070707", border: "1px solid #ff8c0022", borderRadius: 4, padding: "10px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2 }}>FOMO REPLAY</div>
        <div style={{ color: accColor, fontSize: 9, fontFamily: "monospace", border: `1px solid ${accColor}44`, borderRadius: 2, padding: "1px 6px" }}>
          {stats.withOutcomes > 0 ? `${Math.round(stats.accuracy * 100)}% accuracy` : "pending"}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {[
          ["BLOCKED", stats.total, "#888"],
          ["GOOD ✓", stats.goodBlocks, "#39ff14"],
          ["MISS ✗",  stats.badBlocks,  "#ff3b3b"],
        ].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#0a0a0a", borderRadius: 3, padding: "5px 7px" }}>
            <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>{l as string}</div>
            <div style={{ color: c as string, fontSize: 15, fontFamily: "monospace", fontWeight: "bold" }}>{v as number}</div>
          </div>
        ))}
      </div>

      {stats.withOutcomes > 0 && (
        <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "#252525", fontSize: 9, fontFamily: "monospace" }}>AVG MOVE AFTER BLOCK (1H)</span>
          <span style={{ color: dumpColor, fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
            {stats.medianMove1h >= 0 ? "+" : ""}{stats.medianMove1h.toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  );
}