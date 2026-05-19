"use client";

import { useState, useEffect, useCallback } from "react";
import type { Pair, GeckoPool } from "@/types";
import { fmtUSD, ageHours } from "@/lib/utils";
import { computeRedFlags } from "@/lib/engines/redFlags";
import { geckoToDisplay } from "@/lib/apis/geckoterminal";
import Pill from "@/components/ui/Pill";
import { classify } from "@/lib/engines/decision";
import { computeEdgeScore } from "@/lib/engines/edgeScore";
import { checkAntiFOMO } from "@/lib/engines/antiFomo";
import { detectPhase, phaseColor } from "@/lib/engines/phaseDetector";
import type { Phase } from "@/lib/engines/phaseDetector";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ── Types ─────────────────────────────────────────────────────────────────────

interface RadarEntry {
  pairAddress:       string;
  symbol:            string;
  phase:             Phase;
  totalEntries:      number;
  wins:              number;
  losses:            number;
  openTrades:        number;
  winRate:           number;
  consecutiveLosses: number;
  lastEntryTime:     number;
  lastExitReason:    string | null;
  currentPrice:      number;
  lastEntryPrice:    number;
  highPrice:         number;
  lowPrice:          number;
  openPnlPct:        number | null;
  note:              string;
}

const PHASE_ORDER: Phase[] = ["RECOVERING", "TRENDING", "NEW", "PUMPING", "DUMPING", "ZOMBIE", "DEAD"];

const PHASE_LABEL: Record<Phase, string> = {
  RECOVERING: "RECOVERING",
  TRENDING:   "TRENDING",
  NEW:        "NEW",
  PUMPING:    "PUMPING",
  DUMPING:    "DUMPING",
  ZOMBIE:     "ZOMBIE",
  DEAD:       "DEAD",
};

// ── Data loader ───────────────────────────────────────────────────────────────

async function loadRadarData(): Promise<RadarEntry[]> {
  const { data: trades } = await supabase
    .from("shadow_trades")
    .select("*")
    .gte("timestamp", Date.now() - 24 * 3600_000)
    .order("created_at", { ascending: true });

  if (!trades || !trades.length) return [];

  // Aggregate by pair
  const map = new Map<string, {
    symbol: string; trades: typeof trades;
  }>();

  for (const t of trades) {
    const addr = t.pair_address;
    if (!map.has(addr)) map.set(addr, { symbol: t.symbol?.trim() ?? "?", trades: [] });
    map.get(addr)!.trades.push(t);
  }

  const entries: RadarEntry[] = [];

  for (const [addr, { symbol, trades: pt }] of map.entries()) {
    const totalEntries = pt.length;
    const closed = pt.filter(t => t.exited_at != null);
    const open   = pt.filter(t => t.exited_at == null);
    const wins   = closed.filter(t => t.exit_reason === "TP1 hit").length;
    const losses = closed.filter(t => t.exit_reason === "SL hit").length;
    const winRate = closed.length > 0 ? wins / closed.length * 100 : 0;

    // Consecutive losses from most recent closed
    let consecutiveLosses = 0;
    const sortedClosed = [...closed].sort((a, b) => (b.exited_at ?? 0) - (a.exited_at ?? 0));
    for (const t of sortedClosed) {
      if (t.exit_reason === "SL hit") consecutiveLosses++;
      else break;
    }

    const lastEntryTime  = Math.max(...pt.map(t => new Date(t.created_at).getTime()));
    const lastExitReason = sortedClosed[0]?.exit_reason ?? null;
    const currentPrice   = Math.max(...pt.map(t => Number(t.current_price || t.entry_price)));
    const highPrice      = Math.max(...pt.map(t => Number(t.current_price || t.entry_price)));
    const lowPrice       = Math.min(...pt.map(t => Number(t.entry_price)));
    const lastEntryPt    = pt[pt.length - 1];
    const lastEntryPrice = Number(lastEntryPt?.entry_price ?? 0);

    // Open P&L from most recent open trade
    const latestOpen  = open[open.length - 1];
    const openPnlPct  = latestOpen
      ? (Number(latestOpen.current_price) - Number(latestOpen.entry_price)) / Number(latestOpen.entry_price) * 100
      : null;

    // Note from latest trade
    const note = lastEntryPt?.note ?? "";

    // Phase detection
    const phase = detectPhase({
      seenCount:         totalEntries * 2, // aproximare seenCount
      consecutiveLosses,
      m5:   0,
      h24:  0,
      highPrice,
      lowPrice,
      currentPrice,
      totalEntries,
      wins24h:  wins,
      losses24h: losses,
    });

    entries.push({
      pairAddress: addr, symbol, phase,
      totalEntries, wins, losses, openTrades: open.length,
      winRate, consecutiveLosses, lastEntryTime, lastExitReason,
      currentPrice, lastEntryPrice, highPrice, lowPrice,
      openPnlPct, note,
    });
  }

  // Sort by phase priority
  return entries.sort((a, b) =>
    PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase)
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  newPools:     GeckoPool[];
  trending:     Pair[];
  onSelectPair: (pair: Pair) => void;
}

export default function RadarPanel({ newPools, trending, onSelectPair }: Props) {
  const [radarData, setRadarData]   = useState<RadarEntry[]>([]);
  const [loading, setLoading]       = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [filter, setFilter]         = useState<Phase | "ALL">("ALL");

  const refresh = useCallback(async () => {
    const data = await loadRadarData();
    setRadarData(data);
    setLastUpdate(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 30_000);
    return () => clearInterval(iv);
  }, [refresh]);

  // Phase distribution
  const phaseCounts = PHASE_ORDER.reduce((acc, p) => {
    acc[p] = radarData.filter(e => e.phase === p).length;
    return acc;
  }, {} as Record<Phase, number>);

  const filtered = filter === "ALL" ? radarData : radarData.filter(e => e.phase === filter);
  const recovery = radarData.filter(e => e.phase === "RECOVERING");

  // Volume spike pairs (existing logic)
  const spikes = trending.filter((p) => {
    const avg5m = (p.volume?.h1 ?? 0) / 12;
    return avg5m > 0 && (p.volume?.m5 ?? 0) / avg5m > 2;
  });

  const mono: React.CSSProperties = { fontFamily: "monospace" };
  const sectionLabel: React.CSSProperties = { color: "#282828", fontSize: 9, ...mono, letterSpacing: 2, marginBottom: 8 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }} className="fade-in">

      {/* ── PAIR INTELLIGENCE ─────────────────────────────────────────────── */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={sectionLabel}>PAIR INTELLIGENCE RADAR</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {lastUpdate && (
              <span style={{ color: "#252525", fontSize: 9, ...mono }}>
                {lastUpdate.toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={refresh}
              style={{ background: "transparent", border: "1px solid #1a1a1a", color: "#333", fontSize: 9, ...mono, padding: "2px 8px", borderRadius: 3, cursor: "pointer" }}
            >
              REFRESH
            </button>
          </div>
        </div>

        {/* Phase distribution pills */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          <button
            onClick={() => setFilter("ALL")}
            style={{
              background: filter === "ALL" ? "#ffffff11" : "transparent",
              border: `1px solid ${filter === "ALL" ? "#555" : "#1a1a1a"}`,
              color: filter === "ALL" ? "#888" : "#333",
              fontSize: 9, ...mono, padding: "3px 10px", borderRadius: 3, cursor: "pointer",
            }}
          >
            ALL ({radarData.length})
          </button>
          {PHASE_ORDER.filter(p => phaseCounts[p] > 0).map(p => (
            <button
              key={p}
              onClick={() => setFilter(p)}
              style={{
                background: filter === p ? phaseColor(p) + "22" : "transparent",
                border: `1px solid ${filter === p ? phaseColor(p) : phaseColor(p) + "44"}`,
                color: phaseColor(p),
                fontSize: 9, ...mono, padding: "3px 10px", borderRadius: 3, cursor: "pointer",
              }}
            >
              {PHASE_LABEL[p]} ({phaseCounts[p]})
            </button>
          ))}
        </div>

        {/* Recovery candidates highlight */}
        {recovery.length > 0 && filter === "ALL" && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: "#39ff1466", fontSize: 9, ...mono, letterSpacing: 2, marginBottom: 6 }}>
              ⚡ RECOVERY CANDIDATES
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {recovery.slice(0, 6).map((e, i) => (
                <div key={i} style={{
                  background: "#070707",
                  border: "1px solid #39ff1422",
                  borderRadius: 4,
                  padding: "8px 12px",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ color: "#c8c8c8", fontSize: 12, ...mono, fontWeight: "bold" }}>
                      {e.symbol}
                    </span>
                    <span style={{ color: "#39ff14", fontSize: 9, ...mono }}>RECOVERING</span>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                    <span style={{ color: "#39ff14", fontSize: 10, ...mono }}>
                      W{e.wins}/{e.losses}L
                    </span>
                    <span style={{ color: "#555", fontSize: 10, ...mono }}>
                      {e.winRate.toFixed(0)}% WR
                    </span>
                  </div>
                  {e.openPnlPct !== null && (
                    <div style={{ color: e.openPnlPct >= 0 ? "#39ff14" : "#ff6b6b", fontSize: 10, ...mono }}>
                      {e.openPnlPct >= 0 ? "+" : ""}{e.openPnlPct.toFixed(1)}% open
                    </div>
                  )}
                  <div style={{ color: "#252525", fontSize: 9, ...mono, marginTop: 4 }}>
                    {e.totalEntries} entries
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* All pairs table */}
        {loading ? (
          <div style={{ color: "#1e1e1e", ...mono, fontSize: 12, textAlign: "center", padding: 24 }}>
            Loading pair intelligence...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ color: "#1e1e1e", ...mono, fontSize: 12, textAlign: "center", padding: 24 }}>
            No pairs tracked yet — worker is collecting data
          </div>
        ) : (
          <div style={{ border: "1px solid #0d0d0d", borderRadius: 4, overflow: "hidden" }}>
            {/* Header */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 90px 60px 60px 60px 70px 80px",
              padding: "5px 12px", background: "#060606",
              borderBottom: "1px solid #0d0d0d",
            }}>
              {["SYMBOL", "PHASE", "W/L", "WR%", "OPEN", "P&L", "LAST EXIT"].map(h => (
                <div key={h} style={{ color: "#1e1e1e", fontSize: 9, ...mono }}>{h}</div>
              ))}
            </div>
            {/* Rows */}
            {filtered.map((e, i) => {
              const pc = phaseColor(e.phase);
              return (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 90px 60px 60px 60px 70px 80px",
                    padding: "6px 12px",
                    borderBottom: "1px solid #090909",
                    alignItems: "center",
                    background: i % 2 === 0 ? "transparent" : "#04040411",
                  }}
                >
                  <div style={{ color: "#aaa", fontSize: 11, ...mono, fontWeight: "bold" }}>
                    {e.symbol}
                  </div>
                  <div style={{
                    color: pc, fontSize: 9, ...mono,
                    background: pc + "11", padding: "2px 6px",
                    borderRadius: 3, border: `1px solid ${pc}33`,
                    display: "inline-block", width: "fit-content",
                  }}>
                    {e.phase}
                  </div>
                  <div style={{ color: "#555", fontSize: 10, ...mono }}>
                    <span style={{ color: "#39ff14" }}>{e.wins}</span>
                    <span style={{ color: "#333" }}>/</span>
                    <span style={{ color: "#ff6b6b" }}>{e.losses}</span>
                  </div>
                  <div style={{
                    color: e.winRate >= 50 ? "#39ff14" : e.winRate >= 30 ? "#ffb347" : "#ff6b6b",
                    fontSize: 10, ...mono,
                  }}>
                    {e.wins + e.losses > 0 ? e.winRate.toFixed(0) + "%" : "—"}
                  </div>
                  <div style={{ color: e.openTrades > 0 ? "#4fc3f7" : "#333", fontSize: 10, ...mono }}>
                    {e.openTrades > 0 ? `${e.openTrades} open` : "—"}
                  </div>
                  <div style={{
                    color: e.openPnlPct === null ? "#333"
                      : e.openPnlPct >= 0 ? "#39ff14" : "#ff6b6b",
                    fontSize: 10, ...mono,
                  }}>
                    {e.openPnlPct !== null
                      ? (e.openPnlPct >= 0 ? "+" : "") + e.openPnlPct.toFixed(1) + "%"
                      : "—"}
                  </div>
                  <div style={{
                    color: e.lastExitReason === "TP1 hit" ? "#39ff14"
                      : e.lastExitReason === "SL hit" ? "#ff6b6b"
                      : "#333",
                    fontSize: 9, ...mono,
                  }}>
                    {e.lastExitReason ?? "—"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── VOLUME SPIKE DETECTOR (existing) ─────────────────────────────── */}
      <div>
        <div style={sectionLabel}>VOLUME SPIKE DETECTOR</div>
        {spikes.length === 0 ? (
          <div style={{ color: "#1e1e1e", ...mono, fontSize: 12, textAlign: "center", padding: 18 }}>
            No significant spikes detected
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {spikes.slice(0, 6).map((p, i) => {
              const avg5m = Number(p.volume?.h1 ?? 0) / 12;
              const ratio = Number(p.volume?.m5 ?? 0) / avg5m;
              const m5    = Number(p.priceChange?.m5 ?? 0);
              const c     = m5 >= 0 ? "#39ff14" : "#ff3b3b";
              const flags = computeRedFlags(p);
              return (
                <div
                  key={i}
                  onClick={() => onSelectPair(p)}
                  style={{ background: "#070707", border: `1px solid ${c}22`, borderRadius: 4, padding: "10px 12px", cursor: "pointer" }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = c + "55")}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = c + "22")}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ color: "#c8c8c8", fontSize: 12, ...mono, fontWeight: "bold" }}>
                      {p.baseToken?.symbol}
                    </span>
                    <Pill label={`×${ratio.toFixed(1)}`} color="#ffb347" small />
                  </div>
                  <div style={{ color: c, fontSize: 15, ...mono, fontWeight: "bold" }}>
                    {m5 >= 0 ? "+" : ""}{m5.toFixed(2)}%
                  </div>
                  <div style={{ color: "#333", fontSize: 10, ...mono }}>{fmtUSD(p.volume?.m5)} / 5m</div>
                  {(() => {
                    const es  = computeEdgeScore(p, flags, null);
                    const fomo = checkAntiFOMO(p, []);
                    const dec = classify(p, es, fomo, flags);
                    return (
                      <div style={{ color: dec.color, fontSize: 9, ...mono, marginTop: 4, fontWeight: "bold" }}>
                        {dec.decision === "TRADE_CANDIDATE" ? "MARKET CANDIDATE" : dec.label}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── NEW PAIRS RADAR (existing) ────────────────────────────────────── */}
      <div>
        <div style={sectionLabel}>NEW PAIRS RADAR</div>
        <div style={{ border: "1px solid #0d0d0d", borderRadius: 4, overflow: "hidden" }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 80px 80px 70px 55px 55px",
            gap: 4, padding: "5px 10px",
            background: "#060606", borderBottom: "1px solid #0d0d0d",
          }}>
            {["TOKEN", "PRICE", "MCAP", "VOL 24H", "AGE", "FLAGS"].map(h => (
              <div key={h} style={{ color: "#1e1e1e", fontSize: 9, ...mono }}>{h}</div>
            ))}
          </div>
          {newPools.length === 0 ? (
            <div style={{ padding: 14, color: "#1a1a1a", ...mono, fontSize: 11, textAlign: "center" }}>Loading…</div>
          ) : newPools.slice(0, 15).map((pool, i) => {
            const p    = geckoToDisplay(pool);
            const a    = pool.attributes ?? {};
            const ah   = a.pool_created_at ? ageHours(new Date(a.pool_created_at).getTime()) : 0;
            const isNew = ah < 1;
            const flags = computeRedFlags(p);
            const highCount = flags.filter(f => f.sev === "high").length;
            return (
              <div
                key={i}
                onClick={() => onSelectPair(p)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 80px 80px 70px 55px 55px",
                  gap: 4, padding: "6px 10px",
                  borderBottom: "1px solid #090909",
                  alignItems: "center", cursor: "pointer",
                  background: isNew ? "rgba(57,255,20,0.015)" : "transparent",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(57,255,20,0.025)")}
                onMouseLeave={e => (e.currentTarget.style.background = isNew ? "rgba(57,255,20,0.015)" : "transparent")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#b8b8b8", fontSize: 11, ...mono, fontWeight: "bold" }}>
                    {(a.name ?? "?").split(" / ")[0].slice(0, 12)}
                  </span>
                  {isNew && <Pill label="NEW" color="#39ff14" small />}
                </div>
                <div style={{ color: "#666", fontSize: 10, ...mono }}>
                  {a.base_token_price_usd ? "$" + Number(a.base_token_price_usd).toExponential(2) : "—"}
                </div>
                <div style={{ color: "#555", fontSize: 10, ...mono }}>{fmtUSD(a.market_cap_usd ?? 0)}</div>
                <div style={{ color: "#555", fontSize: 10, ...mono }}>{fmtUSD(Number(a.volume_usd?.h24 ?? 0))}</div>
                <div style={{ color: ah < 1 ? "#39ff14" : "#444", fontSize: 10, ...mono }}>
                  {ah < 1 ? Math.round(ah * 60) + "m" : ah < 24 ? Math.round(ah) + "h" : Math.round(ah / 24) + "d"}
                </div>
                <div style={{ color: highCount > 0 ? "#ff3b3b" : flags.length > 0 ? "#ffb347" : "#2a4a2a", fontSize: 10, ...mono }}>
                  {highCount > 0 ? "⛔" + highCount : flags.length > 0 ? "⚠" + flags.length : "✓"}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}