"use client";

import { useState, useEffect, useCallback } from "react";
import type { MemoryEntry } from "@/lib/engines/patternMemory";
import { getAllMemory, computeStats, updateOutcome, clearMemory } from "@/lib/engines/patternMemory";
import { fmtPct } from "@/lib/utils";

export default function MemoryPanel() {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [stats, setStats] = useState(computeStats());
  const [filter, setFilter] = useState<"all" | "with-outcomes" | "pending">("all");

  const refresh = useCallback(() => {
    setEntries(getAllMemory());
    setStats(computeStats());
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30000);
    return () => clearInterval(iv);
  }, [refresh]);

  const filtered = entries.filter(e => {
    if (filter === "with-outcomes") return Object.keys(e.outcomes).length > 0;
    if (filter === "pending")       return Object.keys(e.outcomes).length === 0;
    return true;
  });

  const pctColor = (p: number) => p > 10 ? "#39ff14" : p > 0 ? "#a8ff3e" : p > -10 ? "#ffb347" : "#ff3b3b";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} className="fade-in">
      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {[
          ["TOTAL LOGGED", stats.total, "#888"],
          ["WITH OUTCOMES", stats.withOutcomes, "#888"],
          ["AI ACCURACY", stats.total ? `${Math.round(stats.aiAccuracy.rate * 100)}%` : "—", stats.aiAccuracy.rate >= 0.6 ? "#39ff14" : "#ffb347"],
          ["AVG RETURN 1H", stats.withOutcomes ? fmtPct(stats.avgReturn1h) : "—", stats.avgReturn1h >= 0 ? "#39ff14" : "#ff3b3b"],
        ].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#070707", border: "1px solid #111", borderRadius: 4, padding: "8px 10px" }}>
            <div style={{ color: "#252525", fontSize: 9, fontFamily: "monospace", marginBottom: 3 }}>{l as string}</div>
            <div style={{ color: c as string, fontSize: 16, fontFamily: "monospace", fontWeight: "bold" }}>{String(v)}</div>
          </div>
        ))}
      </div>

      {/* Edge Score tier stats */}
      {stats.withOutcomes > 0 && (
        <div style={{ background: "#070707", border: "1px solid #111", borderRadius: 4, padding: 12 }}>
          <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 8 }}>EDGE SCORE WIN RATES (based on 1h outcome)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              ["HIGH ≥75", stats.edgeScoreStats.high,   "#39ff14"],
              ["MED 55-74", stats.edgeScoreStats.medium, "#ffb347"],
              ["LOW <55",  stats.edgeScoreStats.low,    "#ff3b3b"],
            ].map(([label, s, c]) => {
              const st = s as { count: number; winRate: number; avgReturn: number };
              return (
                <div key={label as string} style={{ background: "#0a0a0a", borderRadius: 3, padding: "8px 10px" }}>
                  <div style={{ color: c as string, fontSize: 10, fontFamily: "monospace", marginBottom: 4 }}>{label as string}</div>
                  <div style={{ color: "#888", fontSize: 11, fontFamily: "monospace" }}>{st.count} trades</div>
                  <div style={{ color: st.winRate >= 0.5 ? "#39ff14" : "#ff3b3b", fontSize: 13, fontFamily: "monospace", fontWeight: "bold" }}>
                    {st.count ? Math.round(st.winRate * 100) + "% win" : "—"}
                  </div>
                  <div style={{ color: st.avgReturn >= 0 ? "#39ff14" : "#ff3b3b", fontSize: 10, fontFamily: "monospace" }}>
                    {st.count ? fmtPct(st.avgReturn) + " avg" : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Best/Worst */}
      {(stats.bestTrade || stats.worstTrade) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {stats.bestTrade && (
            <div style={{ background: "rgba(57,255,20,0.05)", border: "1px solid #39ff1422", borderRadius: 4, padding: "8px 12px" }}>
              <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", marginBottom: 3 }}>BEST TRADE</div>
              <div style={{ color: "#39ff14", fontSize: 13, fontFamily: "monospace", fontWeight: "bold" }}>{stats.bestTrade.symbol}</div>
              <div style={{ color: "#39ff14", fontSize: 12, fontFamily: "monospace" }}>{fmtPct(stats.bestTrade.pct)}</div>
            </div>
          )}
          {stats.worstTrade && (
            <div style={{ background: "rgba(255,59,59,0.05)", border: "1px solid #ff3b3b22", borderRadius: 4, padding: "8px 12px" }}>
              <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", marginBottom: 3 }}>WORST TRADE</div>
              <div style={{ color: "#ff3b3b", fontSize: 13, fontFamily: "monospace", fontWeight: "bold" }}>{stats.worstTrade.symbol}</div>
              <div style={{ color: "#ff3b3b", fontSize: 12, fontFamily: "monospace" }}>{fmtPct(stats.worstTrade.pct)}</div>
            </div>
          )}
        </div>
      )}

      {/* Filter + Clear */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {(["all", "with-outcomes", "pending"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{ background: filter === f ? "rgba(57,255,20,0.08)" : "transparent", border: `1px solid ${filter === f ? "#39ff14" : "#1a1a1a"}`, color: filter === f ? "#39ff14" : "#333", borderRadius: 3, padding: "3px 10px", fontSize: 9, letterSpacing: 1 }}>
            {f.toUpperCase()}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => { if (confirm("Clear all memory?")) { clearMemory(); refresh(); } }} style={{ background: "transparent", border: "1px solid #1a1a1a", color: "#333", borderRadius: 3, padding: "3px 10px", fontSize: 9 }}>
          CLEAR
        </button>
      </div>

      {/* Entries table */}
      {filtered.length === 0 ? (
        <div style={{ color: "#1a1a1a", fontFamily: "monospace", fontSize: 12, textAlign: "center", padding: 28 }}>
          {entries.length === 0
            ? "No analyses logged yet — run AI Analyze to start building memory"
            : "No entries match filter"}
        </div>
      ) : (
        <div style={{ border: "1px solid #0d0d0d", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "70px 45px 55px 55px 55px 55px 55px 55px", gap: 4, padding: "5px 10px", background: "#060606", borderBottom: "1px solid #0d0d0d" }}>
            {["TOKEN", "NET", "EDGE", "VERDICT", "SAFE?", "30M", "1H", "24H"].map(h => (
              <div key={h} style={{ color: "#1e1e1e", fontSize: 9, fontFamily: "monospace" }}>{h}</div>
            ))}
          </div>
          {filtered.slice(0, 50).map(e => {
            const o = e.outcomes;
            const safe = e.goplusAvailable ? (!e.isHoneypot && e.sellTax < 0.15) : null;
            return (
              <div key={e.id} style={{ display: "grid", gridTemplateColumns: "70px 45px 55px 55px 55px 55px 55px 55px", gap: 4, padding: "6px 10px", borderBottom: "1px solid #090909", alignItems: "center" }}>
                <div>
                  <div style={{ color: "#c0c0c0", fontSize: 11, fontFamily: "monospace", fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.symbol}</div>
                  <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>{new Date(e.timestamp).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}</div>
                </div>
                <div style={{ color: "#555", fontSize: 9, fontFamily: "monospace" }}>{e.chain?.slice(0, 4).toUpperCase()}</div>
                <div style={{ color: e.edgeScore >= 75 ? "#39ff14" : e.edgeScore >= 55 ? "#ffb347" : "#ff3b3b", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>{e.edgeScore}</div>
                <div style={{ color: e.aiVerdict === "BUY" ? "#39ff14" : e.aiVerdict === "AVOID" || e.aiVerdict === "HONEYPOT" ? "#ff3b3b" : "#ffb347", fontSize: 9, fontFamily: "monospace" }}>{e.aiVerdict || "—"}</div>
                <div style={{ color: safe === null ? "#444" : safe ? "#39ff14" : "#ff3b3b", fontSize: 9, fontFamily: "monospace" }}>
                  {safe === null ? "?" : safe ? "✓" : "✗"}
                </div>
                {[o.m30, o.h1, o.h24].map((out, i) => (
                  <div key={i} style={{ color: out ? pctColor(out.pct) : "#1e1e1e", fontSize: 10, fontFamily: "monospace" }}>
                    {out ? (out.pct > 0 ? "+" : "") + out.pct.toFixed(1) + "%" : "—"}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ color: "#1a1a1a", fontSize: 9, fontFamily: "monospace", textAlign: "center" }}>
        Outcomes auto-update when token is in trending feed · Manual update coming in v0.2
      </div>
    </div>
  );
}
