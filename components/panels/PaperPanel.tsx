"use client";

import { useState, useEffect } from "react";
import type { Pair, PaperTrade } from "@/types";
import { fmtUSD, fmtPrice, fmtPct } from "@/lib/utils";
import { computeSmartScore } from "@/lib/engines/smartScore";
import { computeRedFlags } from "@/lib/engines/redFlags";
import { computeTargets, checkExit } from "@/lib/engines/exitIntelligence";
import { CHAINS, CHAIN_IDS } from "@/lib/chains";
import type { ChainId } from "@/types";

interface Props {
  papers: PaperTrade[];
  setPapers: React.Dispatch<React.SetStateAction<PaperTrade[]>>;
  selectedPair: Pair | null;
  trending: Pair[];
  autoPaper?: boolean;
  setAutoPaper?: (v: boolean) => void;
  autoChains?: ChainId[];
  setAutoChains?: (chains: ChainId[]) => void;
}

export default function PaperPanel({ papers, setPapers, selectedPair, trending, autoPaper, setAutoPaper, autoChains = ["base"], setAutoChains }: Props) {
  const [note, setNote] = useState("");

  // Update current prices + check exit signals
  useEffect(() => {
    if (!trending.length) return;
    setPapers((ps) =>
      ps.map((p) => {
        const found = trending.find((t) => {
          if (t.pairAddress && p.pairAddress && t.pairAddress === p.pairAddress) return true;
          if (p.address && t.baseToken?.address && t.baseToken.address.toLowerCase() === p.address.toLowerCase()) return true;
          return false;
        });
        if (!found) return p;
        const cp = Number(found.priceUsd);
        if (!cp || isNaN(cp)) return p;
        // Skip if already exited
		if (p.exitedAt) return p;

		const updated = {
		  ...p,
		  currentPrice: cp,
		  checkpoints: [...(p.checkpoints ?? []).slice(-23), { t: Date.now(), price: cp }],
		};

		// Auto-exit check — folosește targets salvate la entry dacă există
		const targets = p.sl
		  ? { sl: p.sl, tp1: p.tp1!, tp2: p.tp2!, tp3: p.tp3!, trailingStopPct: 0.2 }
		  : computeTargets(p.entryPrice, p.score);
		const signal = checkExit(updated, cp, targets);
		if (signal && (signal.urgency === "high" || signal.action === "sell_all")) {
		  return {
			...updated,
			exitedAt: Date.now(),
			exitPrice: cp,
			exitReason: signal.reason,
		  };
		}

		return updated;
      })
    );
  }, [trending, setPapers]);

  const addEntry = () => {
    if (!selectedPair) return;
    const score  = computeSmartScore(selectedPair);
    const flags  = computeRedFlags(selectedPair);
    const entry  = Number(selectedPair.priceUsd);
    const targets = computeTargets(entry, score.total);
    setPapers((ps) => [
      ...ps,
      {
        id:           Date.now(),
        symbol:       selectedPair.baseToken?.symbol ?? "?",
        chain:        selectedPair.chainId ?? "?",
        address:      selectedPair.baseToken?.address ?? "",
        pairAddress:  selectedPair.pairAddress ?? "",
        entryPrice:   entry,
        currentPrice: entry,
        entryTime:    Date.now(),
        score:        score.total,
        flagCount:    flags.filter((f) => f.sev === "high").length,
        note:         note.trim(),
        checkpoints:  [],
        // Exit intelligence targets
        sl:   targets.sl,
        tp1:  targets.tp1,
        tp2:  targets.tp2,
        tp3:  targets.tp3,
      },
    ]);
    setNote("");
  };

  const stats = papers.reduce(
    (s, p) => {
      const pct = ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100;
      return { wins: s.wins + (pct > 0 ? 1 : 0), total: s.total + 1, sumPct: s.sumPct + pct };
    },
    { wins: 0, total: 0, sumPct: 0 }
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} className="fade-in">
      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {[
          ["ENTRIES",   papers.length, "#888"],
          ["WIN RATE",  papers.length ? Math.round((stats.wins / stats.total) * 100) + "%" : "—", stats.wins / stats.total >= 0.5 ? "#39ff14" : "#ff3b3b"],
          ["AVG P&L",   papers.length ? (stats.sumPct / stats.total).toFixed(1) + "%" : "—", (stats.sumPct / stats.total || 0) >= 0 ? "#39ff14" : "#ff3b3b"],
          ["OPEN",      papers.filter(p => !p.exitedAt).length, "#888"],
        ].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#070707", border: "1px solid #111", borderRadius: 4, padding: "8px 10px" }}>
            <div style={{ color: "#252525", fontSize: 9, fontFamily: "monospace", marginBottom: 3 }}>{l as string}</div>
            <div style={{ color: c as string, fontSize: 16, fontFamily: "monospace", fontWeight: "bold" }}>{String(v)}</div>
          </div>
        ))}
      </div>

      {/* Auto-paper toggle */}
      {setAutoPaper && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: autoPaper ? "rgba(57,255,20,0.05)" : "#070707", border: `1px solid ${autoPaper ? "#39ff14" : "#141414"}`, borderRadius: 4 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: autoPaper ? "#39ff14" : "#444", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
              AUTO PAPER {autoPaper ? "ON ●" : "OFF ○"}
            </div>
            <div style={{ color: "#333", fontSize: 9, fontFamily: "monospace" }}>
              {autoPaper ? "Auto-papering PAPER_CANDIDATE / TRADE_CANDIDATE setups. Live trades require GoPlus." : "Manual entries only"}
            </div>
          </div>
          <button
            onClick={() => setAutoPaper(!autoPaper)}
            style={{ background: autoPaper ? "rgba(57,255,20,0.1)" : "transparent", border: `1px solid ${autoPaper ? "#39ff14" : "#333"}`, color: autoPaper ? "#39ff14" : "#555", borderRadius: 3, padding: "5px 14px", fontSize: 11, cursor: "pointer" }}
          >
            {autoPaper ? "DISABLE" : "ENABLE"}
          </button>
		  {setAutoChains && (
			  <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 8 }}>
				<span style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", alignSelf: "center" }}>CHAINS:</span>
				{CHAIN_IDS.map(c => {
				  const active = autoChains.includes(c);
				  return (
					<button
					  key={c}
					  onClick={() => {
						if (active) setAutoChains(autoChains.filter(x => x !== c));
						else setAutoChains([...autoChains, c]);
					  }}
					  style={{
						background: active ? CHAINS[c].color + "18" : "transparent",
						border: `1px solid ${active ? CHAINS[c].color : "#222"}`,
						color: active ? CHAINS[c].color : "#333",
						borderRadius: 3, padding: "2px 8px",
						fontSize: 9, cursor: "pointer", fontFamily: "monospace",
					  }}
					>
					  {CHAINS[c].short}
					</button>
				  );
				})}
			  </div>
			)}
		  <button
		  onClick={() => {
			localStorage.removeItem("paperedPairs");
			window.location.reload();
		  }}
		  style={{ background: "transparent", border: "1px solid #333", color: "#444", borderRadius: 3, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}
		>
		  RESET
		</button>
        </div>
      )}

      {/* Add entry */}
      <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 4, padding: 12 }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", marginBottom: 8, letterSpacing: 1 }}>NEW PAPER ENTRY</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, color: "#888", fontSize: 12, fontFamily: "monospace", minWidth: 120 }}>
            {selectedPair ? (
              <><span style={{ color: "#c0c0c0", fontWeight: "bold" }}>{selectedPair.baseToken?.symbol}</span>{" @ "}<span style={{ color: "#39ff14" }}>${fmtPrice(selectedPair.priceUsd)}</span></>
            ) : (
              <span style={{ color: "#333" }}>Select a token first</span>
            )}
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)"
            style={{ width: 160, padding: "5px 8px", fontSize: 11, borderRadius: 3 }} />
          <button onClick={addEntry} disabled={!selectedPair} style={{
            background: selectedPair ? "rgba(57,255,20,0.1)" : "transparent",
            border: `1px solid ${selectedPair ? "#39ff14" : "#1a1a1a"}`,
            color: selectedPair ? "#39ff14" : "#333",
            borderRadius: 3, padding: "6px 16px", fontSize: 11, cursor: selectedPair ? "pointer" : "default",
          }}>+ ENTRY</button>
        </div>
      </div>

      {/* Table */}
      {papers.length === 0 ? (
        <div style={{ color: "#1a1a1a", fontFamily: "monospace", fontSize: 12, textAlign: "center", padding: 28 }}>
          No paper entries yet — select a token and press + ENTRY
        </div>
      ) : (
        <div style={{ border: "1px solid #0d0d0d", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "80px 80px 80px 80px 1fr 100px 24px", gap: 4, padding: "5px 10px", background: "#060606", borderBottom: "1px solid #0d0d0d" }}>
            {["TOKEN", "ENTRY", "NOW", "RETURN", "NOTE", "EXIT SIGNAL", ""].map((h) => (
              <div key={h} style={{ color: "#1e1e1e", fontSize: 9, fontFamily: "monospace" }}>{h}</div>
            ))}
          </div>
          {papers.map((p) => {
            const pnlPct  = ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100;
            const c       = pnlPct >= 0 ? "#39ff14" : "#ff3b3b";
            const elapsed = Date.now() - p.entryTime;
            const elStr   = elapsed < 3600000 ? Math.round(elapsed / 60000) + "m" : Math.round(elapsed / 3600000) + "h";

            // Exit intelligence
            const targets = p.sl && p.tp1 && p.tp2 && p.tp3
              ? { sl: p.sl, tp1: p.tp1, tp2: p.tp2, tp3: p.tp3, trailingStopPct: 0.2 }
              : computeTargets(p.entryPrice, p.score);

            const exitSignal = checkExit(p, p.currentPrice, targets);

            return (
              <div key={p.id} style={{ display: "grid", gridTemplateColumns: "80px 80px 80px 80px 1fr 100px 24px", gap: 4, padding: "7px 10px", borderBottom: "1px solid #090909", alignItems: "center" }}>
                <div>
                  <div style={{ color: p.exitedAt ? "#555" : "#c0c0c0", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>
				  {p.symbol} {p.exitedAt ? "✓" : ""}
				</div>
				<div style={{ display: "flex", gap: 4, alignItems: "center" }}>
				  <span style={{ color: CHAINS[p.chain as ChainId]?.color ?? "#555", fontSize: 9, fontFamily: "monospace" }}>
					{CHAINS[p.chain as ChainId]?.short ?? p.chain?.toUpperCase()}
				  </span>
				  <span style={{ color: "#252525", fontSize: 9, fontFamily: "monospace" }}>
					{p.exitedAt ? "EXITED" : elStr + " ago"}
				  </span>
				</div>
                </div>
                <div style={{ color: "#555", fontSize: 10, fontFamily: "monospace" }}>${fmtPrice(p.entryPrice)}</div>
                <div style={{ color: "#888", fontSize: 10, fontFamily: "monospace" }}>${fmtPrice(p.currentPrice)}</div>
                <div style={{ color: c, fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>{fmtPct(pnlPct)}</div>
                <div style={{ color: "#333", fontSize: 9, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.note || "—"}</div>
                <div style={{ fontSize: 9, fontFamily: "monospace" }}>
                  {exitSignal ? (
                    <span style={{ color: exitSignal.urgency === "high" ? "#ff3b3b" : exitSignal.urgency === "medium" ? "#ff8c00" : "#ffb347" }}>
                      {exitSignal.action === "sell_all" ? "⛔ EXIT" : exitSignal.action === "sell_partial" ? `↓ SELL ${exitSignal.sellPct}%` : "MOVE STOP"}
                    </span>
                  ) : (
                    <span style={{ color: "#2a2a2a" }}>
                      {pnlPct > 0
                        ? `TP1: +${(((targets.tp1 - p.entryPrice) / p.entryPrice) * 100).toFixed(0)}%`
                        : `SL: -${(((p.entryPrice - targets.sl) / p.entryPrice) * 100).toFixed(0)}%`}
                    </span>
                  )}
                </div>
                <button onClick={() => setPapers((ps) => ps.filter((x) => x.id !== p.id))}
                  style={{ background: "transparent", border: "none", color: "#222", fontSize: 11, padding: 0, cursor: "pointer" }}>✕</button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ color: "#1a1a1a", fontSize: 9, fontFamily: "monospace", textAlign: "center" }}>
        Exit Intelligence: SL / TP1 / TP2 / TP3 auto-calculated from Edge Score at entry
      </div>
    </div>
  );
}
