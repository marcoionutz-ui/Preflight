"use client";

import { useState, useEffect } from "react";
import { getRiskState, setKillSwitch, resetRiskState, getCooldownRemaining } from "@/lib/engines/liveRiskManager";
import type { LiveConfig } from "@/lib/trading/liveConfig";

interface Props {
  config: LiveConfig;
}

export default function RiskManagerBadge({ config }: Props) {
  const [state, setState]       = useState(getRiskState());
  const [cooldown, setCooldown] = useState(getCooldownRemaining());

  useEffect(() => {
    const iv = setInterval(() => {
      setState(getRiskState());
      setCooldown(getCooldownRemaining());
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  // Nu afișa în paper/shadow mode
  if (config.mode === "paper" || config.mode === "shadow") return null;

  const dailyLossPct = Math.abs(config.maxDailyLossEth) > 0
    ? Math.min(100, Math.abs(state.dailyRealizedPnlEth) / config.maxDailyLossEth * 100)
    : 0;
  const dailyLossColor = dailyLossPct >= 80 ? "#ff3b3b" : dailyLossPct >= 50 ? "#ffb347" : "#39ff14";

  return (
    <div style={{ background: "#070707", border: `1px solid ${state.killSwitch ? "#ff3b3b" : "#1a1a1a"}`, borderRadius: 6, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2 }}>LIVE RISK MANAGER</div>
        <button
          onClick={() => { setKillSwitch(!state.killSwitch); setState(getRiskState()); }}
          style={{
            background: state.killSwitch ? "rgba(255,59,59,0.2)" : "transparent",
            border: `1px solid ${state.killSwitch ? "#ff3b3b" : "#333"}`,
            color: state.killSwitch ? "#ff3b3b" : "#555",
            borderRadius: 3, padding: "3px 10px",
            fontSize: 9, fontWeight: "bold", letterSpacing: 1,
            cursor: "pointer",
          }}
        >
          {state.killSwitch ? "🔴 KILL SWITCH ON" : "KILL SWITCH"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 8 }}>
        {[
          ["DAILY P&L",    `${state.dailyRealizedPnlEth >= 0 ? "+" : ""}${state.dailyRealizedPnlEth.toFixed(4)} ETH`, dailyLossColor],
          ["TRADES TODAY", `${state.tradesToday}/${config.maxTradesPerDay ?? 3}`,   state.tradesToday >= (config.maxTradesPerDay ?? 3) ? "#ff3b3b" : "#888"],
          ["OPEN POS",     `${state.openPositions}/${config.maxOpenPositions}`,     state.openPositions >= config.maxOpenPositions ? "#ff3b3b" : "#888"],
          ["LOSS STREAK",  `${state.consecutiveLosses}`,                            state.consecutiveLosses >= 2 ? "#ff3b3b" : state.consecutiveLosses === 1 ? "#ffb347" : "#39ff14"],
        ].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#0a0a0a", borderRadius: 3, padding: "5px 7px" }}>
            <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>{l as string}</div>
            <div style={{ color: c as string, fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>{v as string}</div>
          </div>
        ))}
      </div>

      {cooldown > 0 && (
        <div style={{ padding: "6px 8px", background: "rgba(255,179,71,0.08)", border: "1px solid #ffb34733", borderRadius: 3, marginBottom: 8 }}>
          <span style={{ color: "#ffb347", fontSize: 10, fontFamily: "monospace" }}>
            ⏸ COOLDOWN ACTIVE — {cooldown}m remaining after {state.consecutiveLosses} consecutive losses
          </span>
        </div>
      )}

      {/* Daily loss bar */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
          <span style={{ color: "#252525", fontSize: 8, fontFamily: "monospace" }}>DAILY LOSS LIMIT</span>
          <span style={{ color: dailyLossColor, fontSize: 8, fontFamily: "monospace" }}>
            {dailyLossPct.toFixed(0)}% used (max -{config.maxDailyLossEth} ETH)
          </span>
        </div>
        <div style={{ height: 3, background: "#111", borderRadius: 2 }}>
          <div style={{ height: "100%", width: `${dailyLossPct}%`, background: dailyLossColor, borderRadius: 2, transition: "width 0.3s" }} />
        </div>
      </div>

      <button
        onClick={() => { if (confirm("Reset daily risk counters?")) { resetRiskState(); setState(getRiskState()); } }}
        style={{ background: "transparent", border: "1px solid #1a1a1a", color: "#252525", borderRadius: 3, padding: "3px 10px", fontSize: 9, cursor: "pointer" }}
      >
        RESET DAILY
      </button>
    </div>
  );
}