interface ScoreBarProps {
  label: string;
  value: number;
  max?: number;
}

export default function ScoreBar({ label, value, max = 25 }: ScoreBarProps) {
  const pct = (value / max) * 100;
  const c = pct >= 70 ? "#39ff14" : pct >= 40 ? "#ffb347" : "#ff3b3b";
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
        <span style={{ color: "#383838", fontSize: 9, fontFamily: "monospace" }}>{label}</span>
        <span style={{ color: c, fontSize: 9, fontFamily: "monospace" }}>{value}/{max}</span>
      </div>
      <div style={{ height: 3, background: "#111", borderRadius: 2 }}>
        <div
          style={{
            height: "100%", width: pct + "%",
            background: c, borderRadius: 2,
            boxShadow: `0 0 5px ${c}66`,
            transition: "width 0.5s ease",
          }}
        />
      </div>
    </div>
  );
}
