import type { RedFlag } from "@/types";
import { sevColor } from "@/lib/utils";

export default function RedFlagsList({ flags }: { flags: RedFlag[] }) {
  if (!flags.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#2a4a2a", fontSize: 11, fontFamily: "monospace", padding: "8px 10px", background: "#040a04", border: "1px solid #0a1a0a", borderRadius: 4 }}>
        <span style={{ color: "#1a3a1a", fontSize: 14 }}>✓</span> No red flags detected
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {flags.map((f, i) => {
        const c = sevColor(f.sev);
        return (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 10px", background: c + "08", border: `1px solid ${c}22`, borderRadius: 4 }}>
            <span style={{ color: c, fontSize: 9, fontFamily: "monospace", fontWeight: "bold", flexShrink: 0, marginTop: 1, letterSpacing: 1 }}>
              {f.sev.toUpperCase()}
            </span>
            <div>
              <div style={{ color: c, fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>{f.code}</div>
              <div style={{ color: "#666", fontSize: 10, fontFamily: "monospace" }}>{f.msg}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
