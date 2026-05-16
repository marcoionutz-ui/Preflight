"use client";

import type { Pair, AIAnalysis, BuyerVelocity, RedFlag } from "@/types";
import { computeSmartScore } from "@/lib/engines/smartScore";
import { fmtPrice, fmtPct } from "@/lib/utils";
import RiskGauge from "@/components/ui/RiskGauge";
import ScoreBar from "@/components/ui/ScoreBar";
import RedFlagsList from "@/components/ui/RedFlagsList";
import Pill from "@/components/ui/Pill";
import SecurityCard from "@/components/ui/SecurityCard";
import { CHAINS } from "@/lib/chains";
import type { GoPlusResult } from "@/lib/apis/goplus";
import type { EdgeScore } from "@/lib/engines/edgeScore";
import { checkAntiFOMO } from "@/lib/engines/antiFomo";
import type { FOMOCheck } from "@/lib/engines/antiFomo";
import OnChainBadge from "@/components/ui/OnChainBadge";
import type { OnChainData } from "@/lib/apis/alchemy";
import FOMOReplayBadge from "@/components/ui/FOMOReplayBadge";
import SetupDNABadge from "@/components/ui/SetupDNABadge";
import { computeSetupDNA } from "@/lib/engines/setupDna";
import type { SetupDNA } from "@/lib/engines/setupDna";
import MarketRegimeBadge from "@/components/ui/MarketRegimeBadge";
import type { MarketRegime } from "@/lib/engines/marketRegime";

interface Props {
  pair: Pair | null;
  analysis: AIAnalysis | null;
  analyzing: boolean;
  flags: RedFlag[];
  velocity: BuyerVelocity | null;
  onAnalyze: () => void;
  goPlus?: GoPlusResult | null;
  goPlusLoading?: boolean;
  edgeScore?: EdgeScore | null;
  ohlcv?: import("@/types").OHLCVCandle[];
  onChain?: OnChainData | null;
  onChainLoading?: boolean;
  regime?: MarketRegime | null;
}

const VERDICT_COLOR: Record<string, string> = {
  BUY: "#39ff14", SELL: "#ff3b3b", HOLD: "#ffb347", AVOID: "#ff3b3b", HONEYPOT: "#ff0000",
};

export default function OraclePanel({ pair, analysis, analyzing, flags, velocity, onAnalyze, goPlus, goPlusLoading, edgeScore, ohlcv = [], onChain, onChainLoading, regime }: Props) {
  if (!pair) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60%", gap: 10 }}>
        <div style={{ color: "#111", fontSize: 48 }}>◈</div>
        <div style={{ color: "#222", fontSize: 13, fontFamily: "monospace", letterSpacing: 3 }}>SELECT TOKEN</div>
        <div style={{ color: "#1a1a1a", fontSize: 11, fontFamily: "monospace" }}>Scan or select from trending to begin</div>
      </div>
    );
  }

  const score = edgeScore ?? computeSmartScore(pair) as any;
  const chainColor = CHAINS[pair.chainId as keyof typeof CHAINS]?.color ?? "#39ff14";
  const buys1h = pair.txns?.h1?.buys ?? 0;
  const sells1h = pair.txns?.h1?.sells ?? 0;
  const t1h = buys1h + sells1h || 1;
  const whalePressure = Math.round((buys1h / t1h) * 100);
  const isEdgeScore = !!edgeScore;
  const fomoCheck: FOMOCheck = pair ? checkAntiFOMO(pair, ohlcv) : { blocked: false, reason: null, warnings: [] };
  const setupDna: SetupDNA | null = (edgeScore && flags)
    ? computeSetupDNA(edgeScore, flags, pair.chainId ?? "base")
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} className="fade-in">
	
	  {/* Market Regime */}
      <MarketRegimeBadge regime={regime ?? null} />

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ color: "#e8e8e8", fontSize: 15, fontFamily: "monospace", fontWeight: "bold" }}>
            {pair.baseToken?.name ?? pair.baseToken?.symbol}{" "}
            <span style={{ color: chainColor }}>{pair.baseToken?.symbol}</span>
          </div>
          <div style={{ color: "#2a2a2a", fontSize: 10, fontFamily: "monospace", marginTop: 2 }}>
            {pair.baseToken?.address && pair.baseToken.address.length > 10
              ? pair.baseToken.address.slice(0, 18) + "…" + pair.baseToken.address.slice(-6)
              : "No contract address"}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
            <Pill label={pair.chainId?.toUpperCase()} color={chainColor} small />
          </div>
        </div>
        <button
          onClick={onAnalyze}
          disabled={analyzing}
          style={{
            background: analyzing ? "transparent" : "rgba(57,255,20,0.1)",
            border: `1px solid ${analyzing ? "#1a2a1a" : "#39ff14"}`,
            color: analyzing ? "#2a4a2a" : "#39ff14",
            borderRadius: 4, padding: "8px 18px", fontSize: 12,
            fontWeight: "bold", letterSpacing: 2,
            boxShadow: analyzing ? "none" : "0 0 12px rgba(57,255,20,0.15)",
            cursor: analyzing ? "default" : "pointer",
          }}
        >
          {analyzing ? "ANALYZING…" : "▶ AI ANALYZE"}
        </button>
      </div>

      {/* Price changes */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
        {[
          ["PRICE", "$" + fmtPrice(pair.priceUsd), "#b8b8b8"],
          ["5M",  fmtPct(pair.priceChange?.m5),  (pair.priceChange?.m5  ?? 0) >= 0 ? "#39ff14" : "#ff3b3b"],
          ["1H",  fmtPct(pair.priceChange?.h1),  (pair.priceChange?.h1  ?? 0) >= 0 ? "#39ff14" : "#ff3b3b"],
          ["6H",  fmtPct(pair.priceChange?.h6),  (pair.priceChange?.h6  ?? 0) >= 0 ? "#39ff14" : "#ff3b3b"],
          ["24H", fmtPct(pair.priceChange?.h24), (pair.priceChange?.h24 ?? 0) >= 0 ? "#39ff14" : "#ff3b3b"],
        ].map(([l, v, c]) => (
          <div key={l} style={{ background: "#080808", border: "1px solid #111", borderRadius: 3, padding: "5px 8px", textAlign: "center" }}>
            <div style={{ color: "#282828", fontSize: 9, fontFamily: "monospace" }}>{l}</div>
            <div style={{ color: c, fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Red Flags */}
      <div>
        <div style={{ color: "#2a2a2a", fontSize: 9, letterSpacing: 2, fontFamily: "monospace", marginBottom: 6 }}>RED FLAG ENGINE</div>
        <RedFlagsList flags={flags} />
      </div>

      {/* Smart / Edge Score */}
      <div style={{ background: "#070707", border: "1px solid #111", borderRadius: 6, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "#2a2a2a", fontSize: 9, letterSpacing: 2, fontFamily: "monospace" }}>
              {isEdgeScore ? "EDGE SCORE" : "SMART SCORE v2"}
            </span>
            {isEdgeScore && edgeScore?.dataSource === "goplus+market" && (
              <span style={{ color: "#0052ff", fontSize: 8, fontFamily: "monospace", border: "1px solid #0052ff44", borderRadius: 2, padding: "1px 5px" }}>+ GOPLUS</span>
            )}
          </div>
          {score.hardReject
            ? <span style={{ color: "#ff3b3b", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>0/100 ⛔ {score.hardReject}</span>
            : <span style={{ color: score.total >= 70 ? "#39ff14" : score.total >= 45 ? "#ffb347" : "#ff3b3b", fontSize: 20, fontFamily: "monospace", fontWeight: "bold" }}>
                {score.total}<span style={{ fontSize: 11, color: "#333" }}>/100</span>
              </span>
          }
        </div>
        {!score.hardReject && <>
          <ScoreBar label={isEdgeScore ? "SAFETY (GoPlus)" : "LIQUIDITY"} value={isEdgeScore ? (edgeScore?.safety ?? 0) : (score as any).liqScore} max={isEdgeScore ? 30 : 25} />
          <ScoreBar label={isEdgeScore ? "LIQUIDITY" : "MOMENTUM"}      value={isEdgeScore ? (edgeScore?.liquidity ?? 0) : (score as any).momentumScore} max={isEdgeScore ? 20 : 25} />
          <ScoreBar label={isEdgeScore ? "MOMENTUM" : "SAFETY"}         value={isEdgeScore ? (edgeScore?.momentum ?? 0) : (score as any).safetyScore}   max={isEdgeScore ? 20 : 25} />
          <ScoreBar label={isEdgeScore ? "FLOW" : "BUY PRESSURE"}       value={isEdgeScore ? (edgeScore?.flow ?? 0)     : (score as any).buyPressure}    max={isEdgeScore ? 20 : 25} />
          {isEdgeScore && <ScoreBar label="TIMING" value={edgeScore?.timing ?? 0} max={10} />}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
            <div style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
              <div style={{ color: "#222", fontSize: 9, fontFamily: "monospace" }}>BUY RATIO 1H</div>
              <div style={{ color: (isEdgeScore ? score.flow : (score as any).buyRatio1h ?? 0) >= 60 ? "#39ff14" : "#ffb347", fontSize: 14, fontFamily: "monospace", fontWeight: "bold" }}>
                {isEdgeScore ? `${Math.round((edgeScore?.flow ?? 0) / 20 * 100)}%` : `${(score as any).buyRatio1h ?? 0}%`}
              </div>
            </div>
            {velocity ? (
              <div style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
                <div style={{ color: "#222", fontSize: 9, fontFamily: "monospace" }}>BUYER VELOCITY</div>
                <div style={{ color: velocity.trend === "GROWING" ? "#39ff14" : velocity.trend === "SHRINKING" ? "#ff3b3b" : "#555", fontSize: 13, fontFamily: "monospace", fontWeight: "bold" }}>
                  {velocity.trend === "GROWING" ? "▲" : velocity.trend === "SHRINKING" ? "▼" : "—"} {velocity.trend}
                </div>
                <div style={{ color: "#333", fontSize: 9, fontFamily: "monospace" }}>Δ {velocity.delta > 0 ? "+" : ""}{velocity.delta} buys/cycle</div>
              </div>
            ) : (
              <div style={{ background: "#0a0a0a", borderRadius: 3, padding: "6px 8px" }}>
                <div style={{ color: "#222", fontSize: 9, fontFamily: "monospace" }}>WHALE PRESSURE</div>
                <div style={{ color: whalePressure >= 60 ? "#39ff14" : "#ffb347", fontSize: 14, fontFamily: "monospace", fontWeight: "bold" }}>{whalePressure}%</div>
              </div>
            )}
          </div>
        </>}
      </div>

      {/* GoPlus Security */}
      <SecurityCard data={goPlus ?? null} loading={goPlusLoading ?? false} tokenAddress={pair.baseToken?.address} />

	  {/* On-chain Data */}
      <OnChainBadge data={onChain ?? null} loading={onChainLoading ?? false} />
	  
	  {/* Setup DNA */}
      <SetupDNABadge dna={setupDna} />

      {/* FOMO Replay */}
      <FOMOReplayBadge />

      {/* Trade Gate */}
      {edgeScore && (
        <div style={{
          padding: "10px 12px",
          background: edgeScore.canEnterTrade ? "rgba(57,255,20,0.05)" : "rgba(255,59,59,0.05)",
          border: `1px solid ${edgeScore.canEnterTrade ? "#39ff1433" : "#ff3b3b33"}`,
          borderRadius: 4,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: edgeScore.blockers.length + edgeScore.warnings.length > 0 ? 6 : 0 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: edgeScore.canEnterTrade ? "#39ff14" : "#ff3b3b", boxShadow: `0 0 6px ${edgeScore.canEnterTrade ? "#39ff14" : "#ff3b3b"}` }} />
            <span style={{ color: edgeScore.canEnterTrade ? "#39ff14" : "#ff3b3b", fontSize: 12, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>
              TRADE GATE:{" "}
            {edgeScore.canEnterTrade && !fomoCheck.blocked
              ? "OPEN ✓"
              : fomoCheck.blocked
              ? "FOMO BLOCKED ⛔"
              : "BLOCKED ⛔"}
            </span>
            {edgeScore.sellTax > 0 && (
              <span style={{ color: "#555", fontSize: 10, fontFamily: "monospace", marginLeft: "auto" }}>
                sell tax {(edgeScore.sellTax * 100).toFixed(0)}%
              </span>
            )}
          </div>
          {edgeScore.blockers.map((b, i) => (
            <div key={i} style={{ color: "#ff3b3b", fontSize: 10, fontFamily: "monospace", marginBottom: 2 }}>⛔ {b}</div>
          ))}
          {edgeScore.warnings.slice(0, 3).map((w, i) => (
            <div key={i} style={{ color: "#ffb347", fontSize: 10, fontFamily: "monospace", marginBottom: 2 }}>⚠ {w}</div>
          ))}
          {fomoCheck.blocked && (
            <div style={{ color: "#ff8c00", fontSize: 10, fontFamily: "monospace", marginBottom: 2 }}>🚫 ANTI-FOMO: {fomoCheck.reason}</div>
          )}
          {fomoCheck.warnings.map((w, i) => (
            <div key={i} style={{ color: "#ff8c00", fontSize: 10, fontFamily: "monospace", marginBottom: 2 }}>⚡ {w}</div>
          ))}
        </div>
      )}

      {/* AI Analysis placeholder */}
      {!analysis && !analyzing && (
        <div style={{ background: "#070707", border: "1px dashed #1a1a1a", borderRadius: 6, padding: 20, textAlign: "center" }}>
          <div style={{ color: "#2a2a2a", fontSize: 12, fontFamily: "monospace" }}>Press ▶ AI ANALYZE to run Oracle scan</div>
        </div>
      )}

      {/* AI Analysis results */}
      {analysis && (() => {
        const c = VERDICT_COLOR[analysis.verdict] ?? "#888";
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }} className="fade-in">
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ padding: "8px 18px", border: `2px solid ${c}`, borderRadius: 4, color: c, fontSize: 18, fontFamily: "monospace", fontWeight: "bold", boxShadow: `0 0 18px ${c}33`, background: c + "11", letterSpacing: 3 }}>
                {analysis.verdict}
              </div>
              <RiskGauge score={analysis.riskScore ?? 0} />
              <div style={{ fontSize: 9, fontFamily: "monospace", color: "#333", textAlign: "center" }}>
                CONFIDENCE<br /><span style={{ color: "#b0b0b0", fontSize: 18, fontWeight: "bold" }}>{analysis.confidence}%</span>
              </div>
              <Pill label={analysis.momentum} color={["BULLISH","PUMP"].includes(analysis.momentum) ? "#39ff14" : ["BEARISH","DUMP"].includes(analysis.momentum) ? "#ff3b3b" : "#ffb347"} />
            </div>

            <div style={{ background: "#080808", border: "1px solid #111", borderRadius: 4, padding: "10px 14px" }}>
              <div style={{ color: "#2a2a2a", fontSize: 8, fontFamily: "monospace", marginBottom: 4, letterSpacing: 1 }}>ORACLE SUMMARY</div>
              <div style={{ color: "#b0b0b0", fontSize: 12, fontFamily: "monospace", lineHeight: 1.7 }}>{analysis.summary}</div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {[
                ["✓ OBSERVED", analysis.observedSignals ?? [], "#39ff14"],
                ["~ INFERRED", analysis.inferredSignals ?? [], "#ffb347"],
                ["? UNKNOWN",  analysis.unknowns ?? [],        "#444"],
              ].map(([title, items, col]) => (
                <div key={title as string} style={{ background: "#080808", border: `1px solid ${col as string}18`, borderRadius: 4, padding: "8px 10px" }}>
                  <div style={{ color: col as string, fontSize: 8, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1, marginBottom: 5 }}>{title as string}</div>
                  {(items as string[]).map((s, i) => (
                    <div key={i} style={{ color: "#666", fontSize: 10, fontFamily: "monospace", marginBottom: 3, lineHeight: 1.4 }}>▸ {s}</div>
                  ))}
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {[["ENTRY ZONE","#39ff14",analysis.entryZone],["STOP LOSS","#ff3b3b",analysis.stopLoss],["TAKE PROFIT","#ffb347",analysis.takeProfit]].map(([l,c,v]) => (
                <div key={l as string} style={{ background: "#070707", border: `1px solid ${c as string}18`, borderRadius: 4, padding: "8px 10px" }}>
                  <div style={{ color: "#252525", fontSize: 8, fontFamily: "monospace", marginBottom: 4 }}>{l as string}</div>
                  <div style={{ color: c as string, fontSize: 11, fontFamily: "monospace" }}>{v ?? "—"}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
