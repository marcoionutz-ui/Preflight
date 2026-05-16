"use client";

import { useState } from "react";
import type { Pair, ChainId } from "@/types";
import { CHAINS, CHAIN_IDS } from "@/lib/chains";
import SideRow from "@/components/ui/SideRow";
import { searchToken } from "@/lib/apis/dexscreener";

interface Props {
  chain: ChainId;
  onChainChange: (c: ChainId) => void;
  trending: Pair[];
  selectedPair: Pair | null;
  onSelectPair: (pair: Pair) => void;
  log: (msg: string, t?: "info" | "ok" | "warn" | "err") => void;
}

export default function Sidebar({ chain, onChainChange, trending, selectedPair, onSelectPair, log }: Props) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState<Pair | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    log(`Scanning: ${query}`);
    try {
      const pair = await searchToken(query.trim());
      if (!pair) { log("Token not found", "err"); setLoading(false); return; }
      setScanned(pair);
      onSelectPair(pair);
      log(`Found: ${pair.baseToken?.symbol} (${pair.chainId?.toUpperCase()})`, "ok");
    } catch (e) {
      log(`Scan error: ${e instanceof Error ? e.message : "unknown"}`, "err");
    }
    setLoading(false);
  };

  const chainColor = CHAINS[chain].color;

  return (
    <aside style={{ borderRight: "1px solid #0a0a0a", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Chain Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid #0a0a0a" }}>
        {CHAIN_IDS.map((k) => (
          <button
            key={k}
            onClick={() => onChainChange(k)}
            style={{
              flex: 1,
              background: chain === k ? CHAINS[k].color + "18" : "transparent",
              border: "none",
              borderBottom: chain === k ? `2px solid ${CHAINS[k].color}` : "2px solid transparent",
              color: chain === k ? CHAINS[k].color : "#2a2a2a",
              fontSize: 9,
              fontFamily: "monospace",
              padding: "7px 2px",
              fontWeight: "bold",
              letterSpacing: 1,
              transition: "all 0.15s",
            }}
          >
            {CHAINS[k].short}
          </button>
        ))}
      </div>

      {/* Scanner */}
      <div style={{ padding: "8px 10px", borderBottom: "1px solid #0a0a0a", background: "#050505" }}>
        <div style={{ display: "flex", gap: 5 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="0x… or symbol"
            style={{ flex: 1, padding: "5px 8px", fontSize: 11 }}
          />
          <button
            onClick={handleSearch}
            disabled={loading}
            style={{
              background: loading ? "transparent" : chainColor + "18",
              border: `1px solid ${loading ? "#1a1a1a" : chainColor}`,
              color: loading ? "#333" : chainColor,
              borderRadius: 3,
              padding: "5px 9px",
              fontSize: 11,
            }}
          >
            {loading ? "…" : "SCAN"}
          </button>
        </div>
      </div>

      {/* Column Headers */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 68px 58px", gap: 4, padding: "4px 10px", borderBottom: "1px solid #090909" }}>
        {["TOKEN", "PRICE", "24H"].map((h) => (
          <div key={h} style={{ color: "#181818", fontSize: 8, letterSpacing: 1, fontFamily: "monospace" }}>{h}</div>
        ))}
      </div>

      {/* Token List */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {scanned && !trending.find((t) => t.pairAddress === scanned.pairAddress) && (
          <>
            <div style={{ padding: "3px 10px", color: "#181818", fontSize: 8, letterSpacing: 1, fontFamily: "monospace", borderBottom: "1px solid #080808" }}>SCANNED</div>
            <SideRow pair={scanned} selected={selectedPair?.pairAddress === scanned.pairAddress} onSelect={onSelectPair} chainColor={chainColor} />
          </>
        )}
        <div style={{ padding: "3px 10px", color: "#181818", fontSize: 8, letterSpacing: 1, fontFamily: "monospace", borderBottom: "1px solid #080808" }}>
          TRENDING · {CHAINS[chain].name}
        </div>
        {trending.length === 0
          ? <div style={{ padding: 12, color: "#1a1a1a", fontSize: 11, fontFamily: "monospace" }}>Loading…</div>
          : trending.map((p) => (
            <SideRow
              key={p.pairAddress}
              pair={p}
              selected={selectedPair?.pairAddress === p.pairAddress}
              onSelect={onSelectPair}
              chainColor={chainColor}
            />
          ))
        }
      </div>
    </aside>
  );
}
