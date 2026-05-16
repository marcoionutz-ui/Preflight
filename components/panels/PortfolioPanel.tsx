"use client";

import { useState, useEffect } from "react";
import type { Pair, Position, ChainId } from "@/types";
import { CHAINS, CHAIN_IDS } from "@/lib/chains";
import { fmtUSD, fmtPrice, fmtPct } from "@/lib/utils";

interface Props {
  positions: Position[];
  setPositions: React.Dispatch<React.SetStateAction<Position[]>>;
  trending: Pair[];
}

export default function PortfolioPanel({ positions, setPositions, trending }: Props) {
  const [form, setForm] = useState({ symbol: "", address: "", chain: "base" as ChainId, buyPrice: "", amount: "" });
  const [adding, setAdding] = useState(false);

  // Update prices from trending
  useEffect(() => {
    if (!trending.length) return;
    setPositions((ps) =>
      ps.map((p) => {
        const found = trending.find(
          (t) =>
            t.pairAddress === p.pairAddress ||
            t.baseToken?.address?.toLowerCase() === p.address?.toLowerCase()
        );
        return found ? { ...p, currentPrice: Number(found.priceUsd) } : p;
      })
    );
  }, [trending, setPositions]);

  const add = () => {
    if (!form.symbol || !form.buyPrice || !form.amount) return;
    const found = trending.find(
      (t) =>
        t.baseToken?.symbol?.toLowerCase() === form.symbol.toLowerCase() &&
        (!form.address || t.baseToken?.address?.toLowerCase() === form.address.toLowerCase())
    );
    setPositions((ps) => [
      ...ps,
      {
        id: Date.now(),
        symbol: form.symbol.toUpperCase(),
        address: form.address || found?.baseToken?.address || "",
        chain: form.chain,
        pairAddress: found?.pairAddress || "",
        buyPrice: Number(form.buyPrice),
        amount: Number(form.amount),
        currentPrice: found ? Number(found.priceUsd) : Number(form.buyPrice),
      },
    ]);
    setForm({ symbol: "", address: "", chain: "base", buyPrice: "", amount: "" });
    setAdding(false);
  };

  const invested = positions.reduce((s, p) => s + p.buyPrice * p.amount, 0);
  const current = positions.reduce((s, p) => s + p.currentPrice * p.amount, 0);
  const pnl = current - invested;
  const pct = invested > 0 ? (pnl / invested) * 100 : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} className="fade-in">
      {/* Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {[
          ["INVESTED", fmtUSD(invested), "#888"],
          ["CURRENT", fmtUSD(current), "#b0b0b0"],
          ["P&L", fmtUSD(pnl), pnl >= 0 ? "#39ff14" : "#ff3b3b"],
          ["RETURN", fmtPct(pct), pct >= 0 ? "#39ff14" : "#ff3b3b"],
        ].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#070707", border: "1px solid #111", borderRadius: 4, padding: "8px 10px" }}>
            <div style={{ color: "#252525", fontSize: 9, fontFamily: "monospace", marginBottom: 3 }}>{l as string}</div>
            <div style={{ color: c as string, fontSize: 16, fontFamily: "monospace", fontWeight: "bold" }}>{v as string}</div>
          </div>
        ))}
      </div>

      {/* Add */}
      {adding ? (
        <div style={{ background: "#070707", border: "1px solid #1a1a1a", borderRadius: 4, padding: 12 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[["symbol", "SYMBOL", 5], ["address", "CONTRACT (opt.)", 14], ["buyPrice", "BUY PRICE", 8], ["amount", "AMOUNT", 8]].map(([k, ph]) => (
              <input
                key={k as string}
                value={form[k as keyof typeof form]}
                onChange={(e) => setForm((f) => ({ ...f, [k as string]: e.target.value }))}
                placeholder={ph as string}
                style={{ flex: 1, minWidth: 70, padding: "5px 8px", fontSize: 11 }}
              />
            ))}
            <select
              value={form.chain}
              onChange={(e) => setForm((f) => ({ ...f, chain: e.target.value as ChainId }))}
              style={{ padding: "5px 8px", fontSize: 11 }}
            >
              {CHAIN_IDS.map((k) => <option key={k} value={k}>{CHAINS[k].name}</option>)}
            </select>
            <button onClick={add} style={{ background: "rgba(57,255,20,0.08)", border: "1px solid #39ff14", color: "#39ff14", borderRadius: 3, padding: "5px 14px", fontSize: 11 }}>ADD</button>
            <button onClick={() => setAdding(false)} style={{ background: "transparent", border: "1px solid #1a1a1a", color: "#444", borderRadius: 3, padding: "5px 10px", fontSize: 11 }}>✕</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ alignSelf: "flex-start", background: "transparent", border: "1px dashed #1a1a1a", color: "#2a2a2a", borderRadius: 3, padding: "5px 14px", fontSize: 11 }}>
          + ADD POSITION
        </button>
      )}

      {/* Table */}
      {positions.length === 0 ? (
        <div style={{ color: "#1a1a1a", fontFamily: "monospace", fontSize: 12, textAlign: "center", padding: 28 }}>No positions tracked</div>
      ) : (
        <div style={{ border: "1px solid #0d0d0d", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "90px 45px 80px 80px 90px 90px 1fr 24px", gap: 4, padding: "5px 10px", background: "#060606", borderBottom: "1px solid #0d0d0d" }}>
            {["TOKEN", "NET", "BUY", "NOW", "VALUE", "P&L", "RETURN", ""].map((h) => (
              <div key={h} style={{ color: "#1e1e1e", fontSize: 9, fontFamily: "monospace" }}>{h}</div>
            ))}
          </div>
          {positions.map((p) => {
            const inv = p.buyPrice * p.amount;
            const cur = p.currentPrice * p.amount;
            const posPnl = cur - inv;
            const posPct = inv > 0 ? (posPnl / inv) * 100 : 0;
            const c = posPnl >= 0 ? "#39ff14" : "#ff3b3b";
            const chainColor = CHAINS[p.chain as ChainId]?.color ?? "#555";
            return (
              <div key={p.id} style={{ display: "grid", gridTemplateColumns: "90px 45px 80px 80px 90px 90px 1fr 24px", gap: 4, padding: "7px 10px", borderBottom: "1px solid #090909", alignItems: "center" }}>
                <div style={{ color: "#c0c0c0", fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>{p.symbol}</div>
                <div style={{ color: chainColor, fontSize: 9, fontFamily: "monospace" }}>{CHAINS[p.chain as ChainId]?.short ?? p.chain}</div>
                <div style={{ color: "#555", fontSize: 10, fontFamily: "monospace" }}>${fmtPrice(p.buyPrice)}</div>
                <div style={{ color: "#888", fontSize: 10, fontFamily: "monospace" }}>${fmtPrice(p.currentPrice)}</div>
                <div style={{ color: "#777", fontSize: 10, fontFamily: "monospace" }}>{fmtUSD(cur)}</div>
                <div style={{ color: c, fontSize: 10, fontFamily: "monospace" }}>{fmtUSD(posPnl)}</div>
                <div style={{ color: c, fontSize: 12, fontFamily: "monospace", fontWeight: "bold" }}>{fmtPct(posPct)}</div>
                <button onClick={() => setPositions((ps) => ps.filter((x) => x.id !== p.id))} style={{ background: "transparent", border: "none", color: "#222", fontSize: 11, padding: 0 }}>✕</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
