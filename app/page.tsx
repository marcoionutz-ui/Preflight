"use client";

import { useState, useEffect, useRef } from "react";
import type { ChainId, AIAnalysis, Position, PaperTrade, OHLCVCandle } from "@/types";
import { CHAINS, DEFAULT_CHAIN } from "@/lib/chains";
import { computeRedFlags } from "@/lib/engines/redFlags";
import { getTrendingPools, getNewPools, getOHLCV } from "@/lib/apis/geckoterminal";
import { getTokenSecurity } from "@/lib/apis/goplus";
import type { GoPlusResult } from "@/lib/apis/goplus";
import { computeEdgeScore } from "@/lib/engines/edgeScore";
import type { EdgeScore } from "@/lib/engines/edgeScore";
import { addMemoryEntry, updateOutcome, getAllMemory } from "@/lib/engines/patternMemory";
import { checkAntiFOMO } from "@/lib/engines/antiFomo";
import { classify } from "@/lib/engines/decision";
import { useMarketData } from "@/hooks/useMarketData";
import { useAlerts } from "@/hooks/useAlerts";
import Header from "@/components/layout/Header";
import AlertBar from "@/components/layout/AlertBar";
import Sidebar from "@/components/layout/Sidebar";
import LogTerminal from "@/components/ui/LogTerminal";
import OraclePanel from "@/components/panels/OraclePanel";
import ChartPanel from "@/components/panels/ChartPanel";
import RadarPanel from "@/components/panels/RadarPanel";
import PaperPanel from "@/components/panels/PaperPanel";
import PortfolioPanel from "@/components/panels/PortfolioPanel";
import MarketPanel from "@/components/panels/MarketPanel";
import TradePanel from "@/components/panels/TradePanel";
import MemoryPanel from "@/components/panels/MemoryPanel";

type Tab = "oracle" | "chart" | "radar" | "trade" | "paper" | "portfolio" | "market" | "memory";

const TABS: Array<[Tab, string]> = [
  ["oracle",    "◈ ORACLE"],
  ["chart",     "▦ CHART"],
  ["radar",     "◉ RADAR"],
  ["trade",     "⟁ TRADE"],
  ["paper",     "◐ PAPER"],
  ["portfolio", "◑ PORTFOLIO"],
  ["market",    "◑ MARKET"],
  ["memory",    "◈ MEMORY"],
];

export default function Page() {
  const [chain, setChain] = useState<ChainId>(DEFAULT_CHAIN);
  const [tab, setTab] = useState<Tab>("oracle");

  const {
    trending, newPools, fg, coins, logs, countdown,
    selectedPair, velocity, setSelectedPair, loadData, log,
  } = useMarketData(chain);

  const { alerts, checkVolumeSpikeAlerts, addRiskAlert, addFlagAlert } = useAlerts();
  useEffect(() => { checkVolumeSpikeAlerts(trending); }, [trending, checkVolumeSpikeAlerts]);

  const [analysis, setAnalysis]           = useState<AIAnalysis | null>(null);
  const [analyzing, setAnalyzing]         = useState(false);
  const [ohlcv, setOhlcv]                 = useState<OHLCVCandle[]>([]);
  const [loadingChart, setLoadingChart]   = useState(false);
  const [positions, setPositions]         = useState<Position[]>([]);
  const [papers, setPapers]               = useState<PaperTrade[]>([]);
  const [briefing, setBriefing]           = useState("");
  const [briefingLoading, setBriefingLoading] = useState(false);

  // Auto-paper trading
  const [autoPaper, setAutoPaper]         = useState(false);
  const [autoChains, setAutoChains] = useState<ChainId[]>(["base"]);
  const [allTrending, setAllTrending] = useState<Pair[]>([]);
  const goPlusCache = useRef<Map<string, GoPlusResult>>(new Map());
  // Load with 24h cooldown — forget tokens older than 24h
	const paperedPairs = useRef<Set<string>>(new Set((() => {
	  if (typeof window === "undefined") return [];
	  try {
		const raw = JSON.parse(localStorage.getItem("paperedPairs") ?? "[]");
		const records: Array<{ key: string; ts: number }> = Array.isArray(raw)
		  ? raw.map((k: string | { key: string; ts: number }) =>
			  typeof k === "string" ? { key: k, ts: 0 } : k
			)
		  : [];
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		return records.filter(r => r.ts > cutoff).map(r => r.key);
	  } catch { return []; }
	})()));
  

  // GoPlus + Edge Score
  const [goPlus, setGoPlus]               = useState<GoPlusResult | null>(null);
  const [goPlusLoading, setGoPlusLoading] = useState(false);
  const [edgeScore, setEdgeScore]         = useState<EdgeScore | null>(null);

  // Load OHLCV chart when pair changes
  useEffect(() => {
    if (!selectedPair?.pairAddress) return;
    setLoadingChart(true);
    setOhlcv([]);
    const geckoNet =
      selectedPair.dexId?.startsWith("gecko:")
        ? selectedPair.dexId.replace("gecko:", "")
        : CHAINS[selectedPair.chainId as ChainId]?.gecko ?? CHAINS[chain].gecko;
    getOHLCV(geckoNet, selectedPair.pairAddress).then((data) => {
      setOhlcv(data);
      setLoadingChart(false);
      log(`Chart: ${data.length} candles`, data.length > 0 ? "ok" : "warn");
    });
  }, [selectedPair?.pairAddress]); // eslint-disable-line

  // Fetch GoPlus security when pair changes
  useEffect(() => {
    const addr = selectedPair?.baseToken?.address;
    if (!addr || addr.length < 10) {
      setGoPlus(null);
      setEdgeScore(null);
      return;
    }
    setGoPlusLoading(true);
    setGoPlus(null);
    log(`GoPlus scanning ${selectedPair!.baseToken?.symbol}…`, "info");
    getTokenSecurity(selectedPair!.chainId, addr).then((gp) => {
      setGoPlus(gp);
      const flags = computeRedFlags(selectedPair!);
      const es = computeEdgeScore(selectedPair!, flags, gp);
      setEdgeScore(es);
      setGoPlusLoading(false);
      if (gp.dataAvailable) {
        log(
          `GoPlus: ${gp.isHoneypot ? "🚨 HONEYPOT" : "safe"} | tax ${(gp.sellTax * 100).toFixed(0)}% sell | ${gp.holderCount} holders`,
          gp.isHoneypot ? "err" : "ok"
        );
      } else {
        log(`GoPlus: ${gp.error || "no data"}`, "warn");
      }
    });
  }, [selectedPair?.pairAddress]); // eslint-disable-line

  // Memory outcome auto-updater — runs on every trending refresh
  useEffect(() => {
    if (!trending.length) return;
    const entries = getAllMemory();
    const now = Date.now();
    entries.forEach(e => {
      const found = trending.find(p => p.pairAddress === e.pairAddress);
      if (!found) return;
      const cp = Number(found.priceUsd);
      if (!cp || isNaN(cp)) return;
      const age = now - e.timestamp;
      if (age >= 30 * 60_000  && !e.outcomes.m30) updateOutcome(e.id, "m30",  cp, e.entryPrice);
      if (age >= 60 * 60_000  && !e.outcomes.h1)  updateOutcome(e.id, "h1",   cp, e.entryPrice);
      if (age >= 6 * 3600_000 && !e.outcomes.h6)  updateOutcome(e.id, "h6",   cp, e.entryPrice);
      if (age >= 24* 3600_000 && !e.outcomes.h24) updateOutcome(e.id, "h24",  cp, e.entryPrice);
    });
  }, [trending]); // eslint-disable-line

	// Pre-fetch GoPlus for trending tokens in background
	useEffect(() => {
	  trending.slice(0, 10).forEach(async (p) => {
		const addr = p.baseToken?.address?.toLowerCase();
		if (!addr || addr.length < 10) return;
		if (goPlusCache.current.has(addr)) return;
		// Mark as pending to avoid duplicate requests
		goPlusCache.current.set(addr, { dataAvailable: false } as GoPlusResult);
		const gp = await getTokenSecurity(p.chainId, addr);
		goPlusCache.current.set(addr, gp);
	  });
	}, [trending]); // eslint-disable-line

  // Multi-chain fetch for auto-paper
	useEffect(() => {
	  if (!autoPaper || autoChains.length === 0) return;
	  const fetchAll = async () => {
		const results = await Promise.allSettled(
		  autoChains.map(c => getTrendingPools(CHAINS[c].gecko))
		);
		const all = results
		  .filter(r => r.status === "fulfilled")
		  .flatMap(r => (r as PromiseFulfilledResult<Pair[]>).value);
		setAllTrending(all);
		log(`Multi-chain: ${all.length} pairs on ${autoChains.join(", ")}`, "info");
	  };
	  fetchAll();
	  const iv = setInterval(fetchAll, 60000);
	  return () => clearInterval(iv);
	}, [autoPaper, autoChains]); // eslint-disable-line

  // Auto-paper loop — scans trending every refresh
  useEffect(() => {
    if (!autoPaper || !allTrending.length) return;
	  allTrending.forEach(p => {
      const key = p.pairAddress;
      const tokenKey = p.baseToken?.address?.toLowerCase() ?? key;
	  if (!key || paperedPairs.current.has(key) || paperedPairs.current.has(tokenKey)) return;
      const flags = computeRedFlags(p);
      // market-only — GoPlus per-token cache is future work
	  const addr = p.baseToken?.address?.toLowerCase();
   	  const gp = (addr && goPlusCache.current.get(addr)?.dataAvailable)
	  ? goPlusCache.current.get(addr)!
	  : null;
	  const es = computeEdgeScore(p, flags, gp);
      const fomo = checkAntiFOMO(p, []);
      const decision = classify(p, es, fomo, flags);
      if (decision.decision === "TRADE_CANDIDATE" || decision.decision === "PAPER_CANDIDATE") {
		  paperedPairs.current.add(key);
		  paperedPairs.current.add(tokenKey);
		  const records = [...paperedPairs.current].map(key => ({ key, ts: Date.now() }));
		  localStorage.setItem("paperedPairs", JSON.stringify(records));
		  setPapers(prev => [...prev, {
          id: Date.now() + Math.random(),
          symbol: p.baseToken?.symbol ?? "?",
          chain: p.chainId ?? "?",
          address: p.baseToken?.address ?? "",
          pairAddress: key,
          entryPrice: Number(p.priceUsd),
          currentPrice: Number(p.priceUsd),
          entryTime: Date.now(),
          score: es.total,
          flagCount: flags.filter(f => f.sev === "high").length,
          note: `AUTO | Edge ${es.total} | ${decision.reasons.slice(0,2).join(", ")}`,
          checkpoints: [],
		  sl:   Number(p.priceUsd) * (1 - (es.total >= 75 ? 0.22 : es.total >= 55 ? 0.18 : 0.15)),
		  tp1:  Number(p.priceUsd) * (1 + (es.total >= 75 ? 0.35 : es.total >= 55 ? 0.28 : 0.22)),
		  tp2:  Number(p.priceUsd) * (1 + (es.total >= 75 ? 0.90 : es.total >= 55 ? 0.70 : 0.50)),
		  tp3:  Number(p.priceUsd) * (1 + (es.total >= 75 ? 2.00 : es.total >= 55 ? 1.50 : 1.00)),
	    } as PaperTrade]);
        log(`AUTO PAPER: ${p.baseToken?.symbol} Edge ${es.total} — ${decision.reasons[0]}`, "ok");
      }
    });
  }, [trending, autoPaper]); // eslint-disable-line

  const handleSelectPair = (pair: typeof selectedPair) => {
    if (!pair) return;
    setSelectedPair(pair);
    setAnalysis(null);
    setTab("oracle");
    const flags = computeRedFlags(pair);
    addFlagAlert(pair.baseToken?.symbol ?? "?", flags.filter((f) => f.sev === "high").length);
  };

  const handleAnalyze = async () => {
    if (!selectedPair || analyzing) return;
    setAnalyzing(true);
    setAnalysis(null);
    const flags = computeRedFlags(selectedPair);
    log(`AI Oracle: ${selectedPair.baseToken?.symbol} (${flags.length} flags)…`, "warn");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair: selectedPair, flags }),
      });
      const data = await res.json();
      if (data.error) { log("AI error: " + data.error, "err"); setAnalyzing(false); return; }
      setAnalysis(data);

      // Save to Pattern Memory
      const es = edgeScore ?? computeEdgeScore(selectedPair, flags, goPlus ?? undefined);
      addMemoryEntry({
        timestamp:       Date.now(),
        symbol:          selectedPair.baseToken?.symbol ?? "?",
        chain:           selectedPair.chainId ?? "?",
        pairAddress:     selectedPair.pairAddress ?? "",
        entryPrice:      Number(selectedPair.priceUsd),
        smartScore:      es.total,
        edgeScore:       es.total,
        edgeSafety:      es.safety,
        edgeCanEnter:    es.canEnterTrade,
        aiVerdict:       data.verdict,
        aiRiskScore:     data.riskScore,
        aiConfidence:    data.confidence,
        isHoneypot:      goPlus?.isHoneypot  ?? false,
        buyTax:          goPlus?.buyTax      ?? 0,
        sellTax:         goPlus?.sellTax     ?? 0,
        holderCount:     goPlus?.holderCount ?? 0,
        goplusAvailable: goPlus?.dataAvailable ?? false,
        highFlags:       flags.filter((f) => f.sev === "high").length,
      });

      log(
        `Oracle: ${data.verdict} | Risk ${data.riskScore}/100 | Confidence ${data.confidence}%`,
        data.verdict === "BUY" ? "ok" : ["AVOID", "HONEYPOT"].includes(data.verdict) ? "err" : "warn"
      );
      addRiskAlert(selectedPair.baseToken?.symbol ?? "?", data.riskScore, data.verdict);
    } catch (e) {
      log(`Error: ${e instanceof Error ? e.message : "unknown"}`, "err");
    }
    setAnalyzing(false);
  };

  const handleBriefing = async () => {
    setBriefingLoading(true);
    log("Generating AI market briefing…", "info");
    try {
      const res = await fetch("/api/briefing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chain, trending, fg, coinPrices: coins }),
      });
      const data = await res.json();
      if (data.error) { log("Briefing error: " + data.error, "err"); setBriefingLoading(false); return; }
      setBriefing(data.briefing);
      log("Briefing ready", "ok");
    } catch (e) {
      log(`Error: ${e instanceof Error ? e.message : "unknown"}`, "err");
    }
    setBriefingLoading(false);
  };

  const chainColor    = CHAINS[chain].color;
  const currentFlags  = selectedPair ? computeRedFlags(selectedPair) : [];

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Header chainColor={chainColor} chainName={CHAINS[chain].name} countdown={countdown} coins={coins} fg={fg} onRefresh={loadData} />
      <AlertBar alerts={alerts} />

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "260px 1fr", overflow: "hidden" }}>
        <Sidebar
          chain={chain}
          onChainChange={(c) => { setChain(c); setAnalysis(null); setBriefing(""); setGoPlus(null); setEdgeScore(null); }}
          trending={trending}
          selectedPair={selectedPair}
          onSelectPair={handleSelectPair}
          log={log}
        />

        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Tabs */}
          <div style={{ padding: "5px 16px", borderBottom: "1px solid #0a0a0a", display: "flex", gap: 4, background: "#050505", flexShrink: 0 }}>
            {TABS.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{
                  background: tab === key ? chainColor + "12" : "transparent",
                  border:     `1px solid ${tab === key ? chainColor : "#111"}`,
                  color:      tab === key ? chainColor : "#2e2e2e",
                  borderRadius: 3, padding: "4px 11px", fontSize: 9, letterSpacing: 1,
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Panel content */}
          <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
            {tab === "oracle" && (
              <OraclePanel
                pair={selectedPair}
                analysis={analysis}
                analyzing={analyzing}
                flags={currentFlags}
                velocity={velocity}
                onAnalyze={handleAnalyze}
                goPlus={goPlus}
                goPlusLoading={goPlusLoading}
                edgeScore={edgeScore}
                ohlcv={ohlcv}
              />
            )}
            {tab === "chart"     && <ChartPanel pair={selectedPair} ohlcv={ohlcv} loading={loadingChart} />}
            {tab === "radar"     && <RadarPanel newPools={newPools} trending={trending} onSelectPair={(p) => { handleSelectPair(p); setTab("oracle"); }} />}
            {tab === "trade"     && <TradePanel pair={selectedPair} chain={chain} log={log} edgeScore={edgeScore} ohlcv={ohlcv} />}
            {tab === "paper" && <PaperPanel papers={papers} setPapers={setPapers} selectedPair={selectedPair} trending={trending} autoPaper={autoPaper} setAutoPaper={setAutoPaper} autoChains={autoChains} setAutoChains={setAutoChains} />}
            {tab === "portfolio" && <PortfolioPanel positions={positions} setPositions={setPositions} trending={trending} />}
            {tab === "market"    && <MarketPanel fg={fg} coins={coins} chain={chain} trending={trending} briefing={briefing} briefingLoading={briefingLoading} onBriefing={handleBriefing} />}
            {tab === "memory"    && <MemoryPanel />}
          </div>

          {/* System Log */}
          <div style={{ padding: "0 16px 10px", borderTop: "1px solid #0a0a0a", paddingTop: 8, flexShrink: 0 }}>
            <div style={{ color: "#181818", fontSize: 8, letterSpacing: 2, fontFamily: "monospace", marginBottom: 3 }}>SYSTEM LOG</div>
            <LogTerminal logs={logs} />
          </div>
        </div>
      </div>
    </div>
  );
}
