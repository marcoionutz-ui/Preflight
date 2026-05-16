import { riskColor } from "@/lib/utils";

export default function RiskGauge({ score }: { score: number }) {
  const c = riskColor(score);
  const r = 34, cx = 50, cy = 44;
  const arc = (a: number): [number, number] => {
    const rad = (a - 90) * (Math.PI / 180);
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x1, y1] = arc(-90);
  const [x2, y2] = arc(90);
  const angle = (score / 100) * 180 - 90;
  const [nx, ny] = arc(angle);
  const label = score >= 70 ? "HIGH RISK" : score >= 40 ? "MEDIUM" : "SAFE";

  return (
    <div style={{ textAlign: "center" }}>
      <svg width="100" height="55" viewBox="0 0 100 55">
        <path d={`M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}`} fill="none" stroke="#111" strokeWidth="6" />
        <path d={`M${x1} ${y1} A${r} ${r} 0 0 1 ${nx} ${ny}`} fill="none" stroke={c} strokeWidth="6" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={c} strokeWidth="2" strokeLinecap="round" />
        <circle cx={cx} cy={cy} r="3.5" fill={c} />
        <text x={cx} y={cy - 7} textAnchor="middle" fill={c} fontSize="14" fontFamily="monospace" fontWeight="bold">{score}</text>
      </svg>
      <div style={{ color: c, fontSize: 8, fontFamily: "monospace", marginTop: -4 }}>{label}</div>
    </div>
  );
}
