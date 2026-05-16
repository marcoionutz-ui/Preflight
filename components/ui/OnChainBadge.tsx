"use client";

import type { OnChainData } from "@/lib/apis/alchemy";

interface Props {
  data: OnChainData | null;
  loading: boolean;
}

export default function OnChainBadge({ data, loading }: Props) {
  if (loading) {
    return (
      <div style={{ background: "#070707", border: "1px solid #0052ff22", borderRadius: 4, padding: "10px 14px" }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 6 }}>ON-CHAIN (ALCHEMY)</div>
        <div style={{ color: "#0052ff", fontSize: 11, fontFamily: "monospace" }}>⟳ Reading chain…</div>
      </div>
    );
  }

  if (!data || !data.available) {
    return (
      <div style={{ background: "#070707", border: "1px solid #0d0d0d", borderRadius: 4, padding: "10px 14px" }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 4 }}>ON-CHAIN (ALCHEMY)</div>
        <div style={{ color: "#222", fontSize: 10, fontFamily: "monospace" }}>No on-chain data — chain may not support eth_getLogs</div>
      </div>
    );
  }

  const confColor: Record<string, string> = {
    HIGH:        "#39ff14",
    MEDIUM:      "#ffb347",
    LOW:         "#ff3b3b",
    UNAVAILABLE: "#333",
  };

  const lpColor = data.lpNet > 0 ? "#39ff14" : data.lpNet < 0 ? "#ff3b3b" : "#555";
  const topBuyerColor = data.topBuyerPct > 50 ? "#ff3b3b" : data.topBuyerPct > 30 ? "#ffb347" : "#39ff14";
  const buyersColor   = data.uniqueBuyers >= 20 ? "#39ff14" : data.uniqueBuyers >= 5 ? "#ffb347" : "#ff3b3b";

  return (
    <div style={{ background: "#070707", border: "1px solid #0052ff22", borderRadius: 4, padding: "10px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2 }}>ON-CHAIN (ALCHEMY)</div>
        <div style={{
          color: confColor[data.confidence],
          fontSize: 9,
          fontFamily: "monospace",
          border: `1px solid ${confColor[data.confidence]}44`,
          borderRadius: 2,
          padding: "1px 6px",
          letterSpacing: 1,
        }}>
          {data.confidence}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <div style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
          <div style={{ color: "#252525", fontSize: 9, fontFamily: "monospace", marginBottom: 2 }}>UNIQUE BUYERS (10m)</div>
          <div style={{ color: buyersColor, fontSize: 16, fontFamily: "monospace", fontWeight: "bold" }}>
            {data.uniqueBuyers}
          </div>
          <div style={{ color: "#252525", fontSize: 9, fontFamily: "monospace" }}>
            {data.totalTransfers} transfers
          </div>
        </div>

        <div style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
          <div style={{ color: "#252525", fontSize: 9, fontFamily: "monospace", marginBottom: 2 }}>LP EVENTS (30m)</div>
          <div style={{ color: lpColor, fontSize: 14, fontFamily: "monospace", fontWeight: "bold" }}>
            +{data.lpAdds} / -{data.lpRemoves}
          </div>
          <div style={{ color: data.lpNet >= 0 ? "#39ff14" : "#ff3b3b", fontSize: 9, fontFamily: "monospace" }}>
            net {data.lpNet >= 0 ? "+" : ""}{data.lpNet} {data.lpNet >= 0 ? "add" : "remove"}
          </div>
        </div>
      </div>

      {data.uniqueBuyers > 0 && (
        <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: "#252525", fontSize: 9, fontFamily: "monospace" }}>TOP BUYER CONCENTRATION</span>
          <span style={{ color: topBuyerColor, fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
            {data.topBuyerPct}%
            {data.topBuyerPct > 50 ? " ⚠ CONCENTRATED" : data.topBuyerPct > 30 ? " ● WATCH" : " ✓ OK"}
          </span>
        </div>
      )}

      {data.lpRemoves > 0 && (
        <div style={{ marginTop: 4, color: "#ff3b3b", fontSize: 9, fontFamily: "monospace" }}>
          ⚠ LP REMOVE detected — rug risk elevated
        </div>
      )}
    </div>
  );
}