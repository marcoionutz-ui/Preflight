"use client";

import type { GoPlusResult } from "@/lib/apis/goplus";
import { goPlusSummary } from "@/lib/apis/goplus";

interface Props {
  data: GoPlusResult | null;
  loading: boolean;
  tokenAddress?: string;
}

export default function SecurityCard({ data, loading, tokenAddress }: Props) {
  // Always render the frame so we can debug
  const hasAddress = tokenAddress && tokenAddress.length >= 10;

  if (loading) {
    return (
      <div style={{ background: "#070707", border: "1px solid #0052ff33", borderRadius: 4, padding: "10px 14px" }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 6 }}>GOPLUS SECURITY</div>
        <div style={{ color: "#0052ff", fontSize: 11, fontFamily: "monospace" }}>⟳ Scanning contract on-chain…</div>
        {tokenAddress && (
          <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", marginTop: 4 }}>
            {tokenAddress.slice(0, 16)}…
          </div>
        )}
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 4, padding: "10px 14px" }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 6 }}>GOPLUS SECURITY</div>
        {hasAddress
          ? <div style={{ color: "#333", fontSize: 10, fontFamily: "monospace" }}>Waiting for scan… ({tokenAddress!.slice(0, 10)}…)</div>
          : <div style={{ color: "#ff3b3b", fontSize: 10, fontFamily: "monospace" }}>⚠ No contract address — GeckoTerminal token may not expose CA</div>
        }
      </div>
    );
  }

  if (!data.dataAvailable) {
    return (
      <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 4, padding: "10px 14px" }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 4 }}>GOPLUS SECURITY</div>
        <div style={{ color: "#444", fontSize: 10, fontFamily: "monospace" }}>
          {data.error || "Not indexed by GoPlus yet"}
        </div>
        {tokenAddress && (
          <div style={{ color: "#222", fontSize: 9, fontFamily: "monospace", marginTop: 3 }}>
            CA: {tokenAddress.slice(0, 16)}…
          </div>
        )}
      </div>
    );
  }

  const { level, color, issues } = goPlusSummary(data);

  const Row = ({ label, value, highlight }: { label: string; value: string; highlight?: string }) => (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
      <span style={{ color: "#383838", fontSize: 10, fontFamily: "monospace" }}>{label}</span>
      <span style={{ color: highlight || "#888", fontSize: 10, fontFamily: "monospace", fontWeight: "bold" }}>{value}</span>
    </div>
  );

  const taxColor  = (t: number) => t > 0.15 ? "#ff3b3b" : t > 0.05 ? "#ffb347" : "#39ff14";
  const boolDanger = (v: boolean) => v ? "#ff3b3b" : "#39ff14";
  const boolSafe   = (v: boolean) => v ? "#39ff14" : "#555";

  return (
    <div style={{ background: "#070707", border: `1px solid ${color}22`, borderRadius: 4, padding: "10px 14px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace", letterSpacing: 2 }}>GOPLUS SECURITY</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }} />
          <span style={{ color, fontSize: 10, fontFamily: "monospace", fontWeight: "bold", letterSpacing: 1 }}>{level}</span>
        </div>
      </div>

      {/* Metrics grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
        <div>
          <Row label="HONEYPOT"     value={data.isHoneypot ? "YES 🚨" : "NO ✓"}       highlight={data.isHoneypot ? "#ff3b3b" : "#39ff14"} />
          <Row label="BUY TAX"      value={`${(data.buyTax  * 100).toFixed(1)}%`}      highlight={taxColor(data.buyTax)} />
          <Row label="SELL TAX"     value={`${(data.sellTax * 100).toFixed(1)}%`}      highlight={taxColor(data.sellTax)} />
          <Row label="OPEN SOURCE"  value={data.isOpenSource ? "YES" : "NO"}           highlight={boolSafe(data.isOpenSource)} />
          <Row label="MINTABLE"     value={data.isMintable ? "YES ⚠" : "NO"}           highlight={data.isMintable ? "#ffb347" : "#39ff14"} />
        </div>
        <div>
          <Row label="HOLDERS"      value={data.holderCount.toLocaleString()}          highlight={data.holderCount > 500 ? "#39ff14" : data.holderCount > 100 ? "#ffb347" : "#ff3b3b"} />
          <Row label="HIDDEN OWNER" value={data.hiddenOwner ? "YES ⚠" : "NO"}          highlight={boolDanger(data.hiddenOwner)} />
          <Row label="CAN RECLAIM"  value={data.canTakeBackOwnership ? "YES ⚠" : "NO"} highlight={boolDanger(data.canTakeBackOwnership)} />
          <Row label="SELF DESTRUCT" value={data.selfDestruct ? "YES 🚨" : "NO"}        highlight={boolDanger(data.selfDestruct)} />
          <Row label="OWNER %"      value={`${(data.ownerPercent * 100).toFixed(1)}%`} highlight={data.ownerPercent > 0.1 ? "#ff3b3b" : data.ownerPercent > 0.05 ? "#ffb347" : "#39ff14"} />
        </div>
      </div>

      {/* Issues */}
      {issues.length > 0 && (
        <div style={{ borderTop: "1px solid #111", paddingTop: 8 }}>
          {issues.map((issue, i) => (
            <div key={i} style={{ color: issue.startsWith("🚨") ? "#ff3b3b" : issue.startsWith("⚠") ? "#ffb347" : "#444", fontSize: 10, fontFamily: "monospace", marginBottom: 2 }}>
              {issue}
            </div>
          ))}
        </div>
      )}

      {data.isTrustList && (
        <div style={{ color: "#39ff14", fontSize: 10, fontFamily: "monospace", marginTop: 6 }}>✓ On GoPlus trust list</div>
      )}
    </div>
  );
}
