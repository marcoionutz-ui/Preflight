"use client";

import type { SetupDNA } from "@/lib/engines/setupDna";

interface Props {
  dna: SetupDNA | null;
}

export default function SetupDNABadge({ dna }: Props) {
  if (!dna || dna.confidence === "INSUFFICIENT") {
    return (
      <div style={{ background: "#070707", border: "1px solid #0d0d0d", borderRadius: 4, padding: "10px 14px" }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 4 }}>SETUP DNA</div>
        <div style={{ color: "#1a1a1a", fontSize: 10, fontFamily: "monospace" }}>
          {dna ? `Only ${dna.similarCount} similar setups — need more data` : "No data"}
        </div>
      </div>
    );
  }

  const confColor: Record<string, string> = { HIGH: "#39ff14", MEDIUM: "#ffb347", LOW: "#ff3b3b" };
  const c = confColor[dna.confidence] ?? "#555";
  const med1hColor = dna.median1h >= 5 ? "#39ff14" : dna.median1h >= 0 ? "#ffb347" : "#ff3b3b";
  const med6hColor = dna.median6h >= 5 ? "#39ff14" : dna.median6h >= 0 ? "#ffb347" : "#ff3b3b";

  return (
    <div style={{ background: "#070707", border: "1px solid #9945ff22", borderRadius: 4, padding: "10px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2 }}>SETUP DNA</div>
        <div style={{ color: c, fontSize: 9, fontFamily: "monospace", border: `1px solid ${c}44`, borderRadius: 2, padding: "1px 6px" }}>
          {dna.similarCount} similar · {dna.confidence}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
        {[
          ["1H MEDIAN", dna.median1h, med1hColor],
          ["6H MEDIAN", dna.median6h, med6hColor],
          ["WIN RATE",  dna.winRate1h * 100, dna.winRate1h >= 0.55 ? "#39ff14" : "#ffb347"],
        ].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#0a0a0a", borderRadius: 3, padding: "5px 7px" }}>
            <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>{l as string}</div>
            <div style={{ color: c as string, fontSize: 14, fontFamily: "monospace", fontWeight: "bold" }}>
              {(v as number) >= 0 ? "+" : ""}{(v as number).toFixed(1)}{l === "WIN RATE" ? "%" : "%"}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: "#252525", fontSize: 9, fontFamily: "monospace" }}>BEST EXIT WINDOW</span>
        <span style={{ color: "#9945ff", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>{dna.bestExitWindow}</span>
      </div>
    </div>
  );
}