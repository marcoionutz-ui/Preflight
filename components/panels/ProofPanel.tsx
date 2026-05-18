"use client";

import { useState, useEffect, useCallback } from "react";
import type { PaperTrade } from "@/types";
import { getFOMOBlocks, getFOMOStats, clearFOMOReplay } from "@/lib/engines/fomoReplay";
import type { FOMOBlock } from "@/lib/engines/fomoReplay";
import { getAllMemory, computeStats } from "@/lib/engines/patternMemory";
import { fmtPct } from "@/lib/utils";
import { getAllShadowTrades, getShadowStats, clearShadowTrades } from "@/lib/engines/shadowTrader";
import type { ShadowTrade } from "@/lib/engines/shadowTrader";

interface Props {
  papers: PaperTrade[];
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pctColor(p: number) {
  return p > 10 ? "#39ff14" : p > 0 ? "#a8ff3e" : p > -10 ? "#ffb347" : "#ff3b3b";
}

export default function ProofPanel({ papers }: Props) {
  const [fomoBlocks, setFomoBlocks]     = useState<FOMOBlock[]>([]);
  const [fomoStats, setFomoStats]       = useState(getFOMOStats());
  const [memStats, setMemStats]         = useState(computeStats());
  const [fomoTab, setFomoTab]           = useState<"stats" | "blocks">("stats");
  const [shadowTrades, setShadowTrades] = useState(getAllShadowTrades());
  const [shadowStats, setShadowStats]   = useState(getShadowStats());

  const refresh = useCallback(() => {
    setFomoBlocks(getFOMOBlocks());
    setFomoStats(getFOMOStats());
    setMemStats(computeStats());
	setShadowTrades(getAllShadowTrades());
    setShadowStats(getShadowStats());
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30_000);
    return () => clearInterval(iv);
  }, [refresh]);

  // ── Paper stats ─────────────────────────────────────────────────────────────
  const closedPapers = papers.filter(p => p.exitedAt && p.exitPrice);
  const openPapers   = papers.filter(p => !p.exitedAt);

  const closedReturns = closedPapers.map(p => {
    const entry = p.entryPrice || 1;
    return ((p.exitPrice! - entry) / entry) * 100;
  });

  const openReturns = openPapers.map(p => {
    const entry = p.entryPrice || 1;
    return ((p.currentPrice - entry) / entry) * 100;
  });

  const paperWinRate = closedPapers.length > 0
    ? closedPapers.filter((_, i) => closedReturns[i] > 0).length / closedPapers.length
    : null;

  const medianClosed = closedReturns.length > 0 ? median(closedReturns) : null;
  const medianOpen   = openReturns.length > 0   ? median(openReturns)   : null;

  const bestPaper = closedPapers.length > 0
    ? closedPapers[closedReturns.indexOf(Math.max(...closedReturns))]
    : null;
  const worstPaper = closedPapers.length > 0
    ? closedPapers[closedReturns.indexOf(Math.min(...closedReturns))]
    : null;

  // ── Chain breakdown from memory ───────────────────────────────────────────
  const allMemory = getAllMemory();
  const chainMap = new Map<string, { count: number; wins: number; total: number }>();
  allMemory.forEach(e => {
    const ch = e.chain ?? "?";
    const existing = chainMap.get(ch) ?? { count: 0, wins: 0, total: 0 };
    existing.count++;
    if (e.outcomes.h1) {
      existing.total++;
      if (e.outcomes.h1.pct > 0) existing.wins++;
    }
    chainMap.set(ch, existing);
  });

  // ── Total decisions ───────────────────────────────────────────────────────
  const totalDecisions = fomoStats.total + papers.length + memStats.total;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} className="fade-in">

      {/* ── Agent Summary ────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {[
          ["TOTAL DECISIONS", totalDecisions, "#888"],
          ["FOMO BLOCKS", fomoStats.total, "#ff8c00"],
          ["PAPER ENTRIES", papers.length, "#39ff14"],
          ["AI ANALYSES", memStats.total, "#0052ff"],
        ].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#070707", border: "1px solid #111", borderRadius: 4, padding: "8px 10px" }}>
            <div style={{ color: "#252525", fontSize: 9, fontFamily: "monospace", marginBottom: 3 }}>{l as string}</div>
            <div style={{ color: c as string, fontSize: 18, fontFamily: "monospace", fontWeight: "bold" }}>{String(v)}</div>
          </div>
        ))}
      </div>

      {/* ── FOMO Replay ──────────────────────────────────────────────────── */}
      <div style={{ background: "#070707", border: "1px solid #ff8c0022", borderRadius: 6, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2 }}>FOMO REPLAY ENGINE</div>
          <div style={{ display: "flex", gap: 6 }}>
            {(["stats", "blocks"] as const).map(t => (
              <button key={t} onClick={() => setFomoTab(t)} style={{
                background: fomoTab === t ? "rgba(255,140,0,0.12)" : "transparent",
                border: `1px solid ${fomoTab === t ? "#ff8c00" : "#1a1a1a"}`,
                color: fomoTab === t ? "#ff8c00" : "#333",
                borderRadius: 3, padding: "2px 8px", fontSize: 9, cursor: "pointer",
              }}>{t.toUpperCase()}</button>
            ))}
            <button onClick={() => { if (confirm("Clear FOMO replay data?")) { clearFOMOReplay(); refresh(); } }}
              style={{ background: "transparent", border: "1px solid #1a1a1a", color: "#252525", borderRadius: 3, padding: "2px 8px", fontSize: 9, cursor: "pointer" }}>
              CLEAR
            </button>
          </div>
        </div>

        {fomoTab === "stats" ? (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 10 }}>
              {[
                ["BLOCKED",    fomoStats.total,                      "#888"],
                ["GOOD ✓",     fomoStats.goodBlocks,                 "#39ff14"],
				["NEUTRAL ~",  fomoStats.neutralBlocks,              "#ffb347"],
                ["MISS ✗",     fomoStats.badBlocks,                  "#ff3b3b"],
                ["ACCURACY",   fomoStats.withOutcomes > 0 ? `${Math.round(fomoStats.accuracy * 100)}%` : "pending", fomoStats.accuracy >= 0.65 ? "#39ff14" : fomoStats.accuracy > 0 ? "#ffb347" : "#444"],
              ].map(([l, v, c]) => (
                <div key={l as string} style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
                  <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>{l as string}</div>
                  <div style={{ color: c as string, fontSize: 15, fontFamily: "monospace", fontWeight: "bold" }}>{String(v)}</div>
                </div>
              ))}
            </div>
            {fomoStats.withOutcomes > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px", background: "#0a0a0a", borderRadius: 3 }}>
                <span style={{ color: "#252525", fontSize: 9, fontFamily: "monospace" }}>MEDIAN MOVE 1H AFTER BLOCK</span>
                <span style={{ color: pctColor(fomoStats.medianMove1h), fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
                  {fomoStats.medianMove1h >= 0 ? "+" : ""}{fomoStats.medianMove1h.toFixed(1)}%
                  {fomoStats.medianMove1h < -5 ? " ✓ anti-FOMO working" : fomoStats.medianMove1h > 10 ? " ✗ missing moves" : ""}
                </span>
              </div>
            )}
            {fomoStats.total === 0 && (
              <div style={{ color: "#1a1a1a", fontSize: 11, fontFamily: "monospace", textAlign: "center", padding: 16 }}>
                No FOMO blocks recorded yet — data builds as agent scans tokens
              </div>
            )}
          </div>
        ) : (
          <div>
            {fomoBlocks.length === 0 ? (
              <div style={{ color: "#1a1a1a", fontSize: 11, fontFamily: "monospace", textAlign: "center", padding: 16 }}>
                No blocks recorded yet
              </div>
            ) : (
              <div style={{ maxHeight: 280, overflowY: "auto" }}>
                <div style={{ display: "grid", gridTemplateColumns: "60px 40px 80px 70px 70px 70px", gap: 4, padding: "4px 6px", borderBottom: "1px solid #0d0d0d", marginBottom: 4 }}>
                  {["TOKEN", "CHAIN", "REASON", "AT BLOCK", "1H", "6H"].map(h => (
                    <div key={h} style={{ color: "#1e1e1e", fontSize: 8, fontFamily: "monospace" }}>{h}</div>
                  ))}
                </div>
                {fomoBlocks.slice(0, 30).map(b => (
                  <div key={b.id} style={{ display: "grid", gridTemplateColumns: "60px 40px 80px 70px 70px 70px", gap: 4, padding: "5px 6px", borderBottom: "1px solid #090909", alignItems: "center" }}>
                    <div style={{ color: "#c0c0c0", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.symbol}</div>
                    <div style={{ color: "#333", fontSize: 9, fontFamily: "monospace" }}>{b.chain?.slice(0, 4).toUpperCase()}</div>
                    <div style={{ color: "#555", fontSize: 8, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.reason}</div>
                    <div style={{ color: "#444", fontSize: 9, fontFamily: "monospace" }}>
                      {Number(b.priceChange24hAtBlock) >= 0 ? "+" : ""}{Number(b.priceChange24hAtBlock).toFixed(0)}% 24h
                    </div>
                    <div style={{ color: b.outcome1h ? pctColor(b.outcome1h.pct) : "#1e1e1e", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
                      {b.outcome1h ? (b.outcome1h.pct > 0 ? "+" : "") + b.outcome1h.pct.toFixed(1) + "%" : "—"}
                    </div>
                    <div style={{ color: b.outcome6h ? pctColor(b.outcome6h.pct) : "#1e1e1e", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>
                      {b.outcome6h ? (b.outcome6h.pct > 0 ? "+" : "") + b.outcome6h.pct.toFixed(1) + "%" : "—"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Paper Agent Performance ───────────────────────────────────────── */}
      <div style={{ background: "#070707", border: "1px solid #39ff1422", borderRadius: 6, padding: 14 }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 10 }}>PAPER AGENT PERFORMANCE</div>

        {papers.length === 0 ? (
          <div style={{ color: "#1a1a1a", fontSize: 11, fontFamily: "monospace", textAlign: "center", padding: 16 }}>
            No paper trades yet — enable Auto Paper in the Paper tab
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 10 }}>
              {[
                ["TOTAL",   papers.length,          "#888"],
                ["OPEN",    openPapers.length,       "#39ff14"],
                ["CLOSED",  closedPapers.length,     "#888"],
                ["WIN RATE", paperWinRate !== null ? `${Math.round(paperWinRate * 100)}%` : "pending",
                  paperWinRate !== null ? (paperWinRate >= 0.55 ? "#39ff14" : "#ffb347") : "#444"],
              ].map(([l, v, c]) => (
                <div key={l as string} style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
                  <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>{l as string}</div>
                  <div style={{ color: c as string, fontSize: 15, fontFamily: "monospace", fontWeight: "bold" }}>{String(v)}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 10 }}>
              <div style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
                <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace", marginBottom: 2 }}>MEDIAN RETURN (CLOSED)</div>
                <div style={{ color: medianClosed !== null ? pctColor(medianClosed) : "#333", fontSize: 15, fontFamily: "monospace", fontWeight: "bold" }}>
                  {medianClosed !== null ? (medianClosed >= 0 ? "+" : "") + medianClosed.toFixed(1) + "%" : "—"}
                </div>
              </div>
              <div style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
                <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace", marginBottom: 2 }}>MEDIAN RETURN (OPEN)</div>
                <div style={{ color: medianOpen !== null ? pctColor(medianOpen) : "#333", fontSize: 15, fontFamily: "monospace", fontWeight: "bold" }}>
                  {medianOpen !== null ? (medianOpen >= 0 ? "+" : "") + medianOpen.toFixed(1) + "%" : "—"}
                </div>
              </div>
            </div>

            {(bestPaper || worstPaper) && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {bestPaper && (
                  <div style={{ background: "rgba(57,255,20,0.05)", border: "1px solid #39ff1422", borderRadius: 3, padding: "6px 8px" }}>
                    <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>BEST EXIT</div>
                    <div style={{ color: "#39ff14", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>{bestPaper.symbol}</div>
                    <div style={{ color: "#39ff14", fontSize: 11, fontFamily: "monospace" }}>
                      +{(((bestPaper.exitPrice! - bestPaper.entryPrice) / bestPaper.entryPrice) * 100).toFixed(1)}%
                    </div>
                  </div>
                )}
                {worstPaper && (
                  <div style={{ background: "rgba(255,59,59,0.05)", border: "1px solid #ff3b3b22", borderRadius: 3, padding: "6px 8px" }}>
                    <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>WORST EXIT</div>
                    <div style={{ color: "#ff3b3b", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>{worstPaper.symbol}</div>
                    <div style={{ color: "#ff3b3b", fontSize: 11, fontFamily: "monospace" }}>
                      {(((worstPaper.exitPrice! - worstPaper.entryPrice) / worstPaper.entryPrice) * 100).toFixed(1)}%
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

	  {/* ── Shadow Trader ─────────────────────────────────────────────── */}
      <div style={{ background: "#070707", border: "1px solid #0052ff22", borderRadius: 6, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2 }}>SHADOW TRADER — WOULD_BUY PERFORMANCE</div>
          <button onClick={() => { if (confirm("Clear shadow trades?")) { clearShadowTrades(); refresh(); } }}
            style={{ background: "transparent", border: "1px solid #1a1a1a", color: "#252525", borderRadius: 3, padding: "2px 8px", fontSize: 9, cursor: "pointer" }}>
            CLEAR
          </button>
        </div>

        {shadowStats.total === 0 ? (
          <div style={{ color: "#1a1a1a", fontSize: 11, fontFamily: "monospace", textAlign: "center", padding: 16 }}>
            No shadow trades yet — switch to SHADOW mode in Trade tab to start
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 10 }}>
              {[
                ["WOULD_BUY",  shadowStats.total,   "#0052ff"],
                ["OPEN",       shadowStats.open,    "#39ff14"],
                ["CLOSED",     shadowStats.closed,  "#888"],
                ["WIN RATE",   shadowStats.winRate !== null ? `${Math.round(shadowStats.winRate * 100)}%` : "pending",
                  shadowStats.winRate !== null ? (shadowStats.winRate >= 0.55 ? "#39ff14" : "#ffb347") : "#444"],
              ].map(([l, v, c]) => (
                <div key={l as string} style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
                  <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>{l as string}</div>
                  <div style={{ color: c as string, fontSize: 15, fontFamily: "monospace", fontWeight: "bold" }}>{String(v)}</div>
                </div>
              ))}
            </div>

            {shadowStats.medianReturn !== null && (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px", background: "#0a0a0a", borderRadius: 3, marginBottom: 8 }}>
                <span style={{ color: "#252525", fontSize: 9, fontFamily: "monospace" }}>MEDIAN RETURN (CLOSED)</span>
                <span style={{ color: shadowStats.medianReturn >= 0 ? "#39ff14" : "#ff3b3b", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
                  {shadowStats.medianReturn >= 0 ? "+" : ""}{shadowStats.medianReturn.toFixed(1)}%
                  {shadowStats.medianReturn > 5 ? " ✓ edge confirmed" : shadowStats.medianReturn < -5 ? " ✗ no edge" : ""}
                </span>
              </div>
            )}

            {(shadowStats.bestTrade || shadowStats.worstTrade) && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {shadowStats.bestTrade && (
                  <div style={{ background: "rgba(0,82,255,0.05)", border: "1px solid #0052ff22", borderRadius: 3, padding: "6px 8px" }}>
                    <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>BEST SHADOW</div>
                    <div style={{ color: "#0052ff", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>{shadowStats.bestTrade.symbol}</div>
                    <div style={{ color: "#39ff14", fontSize: 11, fontFamily: "monospace" }}>+{shadowStats.bestTrade.pct.toFixed(1)}%</div>
                  </div>
                )}
                {shadowStats.worstTrade && (
                  <div style={{ background: "rgba(255,59,59,0.05)", border: "1px solid #ff3b3b22", borderRadius: 3, padding: "6px 8px" }}>
                    <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>WORST SHADOW</div>
                    <div style={{ color: "#ff3b3b", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>{shadowStats.worstTrade.symbol}</div>
                    <div style={{ color: "#ff3b3b", fontSize: 11, fontFamily: "monospace" }}>{shadowStats.worstTrade.pct.toFixed(1)}%</div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Chain Breakdown ───────────────────────────────────────────────── */}
      {chainMap.size > 0 && (
        <div style={{ background: "#070707", border: "1px solid #111", borderRadius: 6, padding: 14 }}>
          <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 10 }}>CHAIN BREAKDOWN (from AI analyses)</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 6 }}>
            {[...chainMap.entries()].sort((a, b) => b[1].count - a[1].count).map(([ch, s]) => {
              const wr = s.total > 0 ? s.wins / s.total : null;
              return (
                <div key={ch} style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
                  <div style={{ color: "#888", fontSize: 10, fontFamily: "monospace", fontWeight: "bold", marginBottom: 2 }}>{ch.toUpperCase()}</div>
                  <div style={{ color: "#555", fontSize: 9, fontFamily: "monospace" }}>{s.count} analyses</div>
                  <div style={{ color: wr !== null ? (wr >= 0.55 ? "#39ff14" : "#ffb347") : "#333", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
                    {wr !== null ? `${Math.round(wr * 100)}% 1h win` : "no outcomes"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ color: "#1a1a1a", fontSize: 9, fontFamily: "monospace", textAlign: "center" }}>
        Proof data builds automatically as the agent scans, blocks, and tracks outcomes
      </div>
    </div>
  );
}