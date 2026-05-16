"use client";

import { useState, useEffect } from "react";
import type { X402PaymentRecord } from "@/lib/trading/x402client";

interface OracleEndpoint {
  path: string;
  price: string;
  description: string;
  method: string;
}

const ORACLE_ENDPOINTS: OracleEndpoint[] = [
  { path: "/api/oracle/analyze", price: "$0.001", description: "AI token analysis — risk, verdict, signals", method: "POST" },
  { path: "/api/oracle/score",   price: "$0.0005", description: "Smart score + red flags — instant, no AI", method: "POST" },
  { path: "/api/oracle/briefing", price: "$0.005", description: "AI market briefing for a chain",          method: "POST" },
];

const EXAMPLE_AGENT_CODE = `// Any AI agent can call your oracle with x402:
import { wrapFetchWithPayment } from "x402-fetch";

const paidFetch = wrapFetchWithPayment(fetch, agentWallet);

const res = await paidFetch("https://your-domain.com/api/oracle/analyze", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ pair: tokenPairData }),
});
// Agent automatically pays $0.001 USDC on Base
const { aiAnalysis, smartScore, redFlags } = await res.json();`;

export default function X402Panel() {
  const [receiverAddress, setReceiverAddress] = useState("");
  const [payments, setPayments] = useState<X402PaymentRecord[]>([]);
  const [checking, setChecking] = useState(false);
  const [endpointStatuses, setEndpointStatuses] = useState<Record<string, boolean>>({});

  useEffect(() => {
    // Load receiver address display (not the real key, just the address)
    const checkEndpoints = async () => {
      setChecking(true);
      const statuses: Record<string, boolean> = {};
      for (const ep of ORACLE_ENDPOINTS) {
        try {
          const res = await fetch(ep.path);
          statuses[ep.path] = res.status === 200 || res.status === 402;
        } catch {
          statuses[ep.path] = false;
        }
      }
      setEndpointStatuses(statuses);
      setChecking(false);
    };
    checkEndpoints();
  }, []);

  const totalEarned = payments.reduce((s, p) => {
    const val = parseFloat(p.amount.replace("$", "").replace("USDC", "").trim());
    return s + (isNaN(val) ? 0 : val);
  }, 0);

  const copyCode = () => {
    navigator.clipboard.writeText(EXAMPLE_AGENT_CODE);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }} className="fade-in">
      {/* Header */}
      <div>
        <div style={{ color: "#e0e0e0", fontSize: 14, fontFamily: "monospace", fontWeight: "bold", marginBottom: 4 }}>
          x402 <span style={{ color: "#0052ff" }}>PAYMENT PROTOCOL</span>
        </div>
        <div style={{ color: "#333", fontSize: 11, fontFamily: "monospace" }}>
          Your oracle is a paid API. Any AI agent or developer pays per call in USDC on Base.
        </div>
      </div>

      {/* Config status */}
      <div style={{ background: "#070707", border: "1px solid #141414", borderRadius: 6, padding: 14 }}>
        <div style={{ color: "#282828", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 10 }}>CONFIGURATION</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#0052ff", boxShadow: "0 0 6px #0052ff" }} />
            <span style={{ color: "#555", fontSize: 11, fontFamily: "monospace" }}>Network:</span>
            <span style={{ color: "#c0c0c0", fontSize: 11, fontFamily: "monospace" }}>Base (USDC)</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: process.env.NEXT_PUBLIC_HAS_RECEIVER ? "#39ff14" : "#ff3b3b" }} />
            <span style={{ color: "#555", fontSize: 11, fontFamily: "monospace" }}>Receiver wallet:</span>
            <span style={{ color: "#888", fontSize: 11, fontFamily: "monospace" }}>
              Set PAYMENT_RECEIVER_ADDRESS in .env.local
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#ffb347" }} />
            <span style={{ color: "#555", fontSize: 11, fontFamily: "monospace" }}>Payer wallet:</span>
            <span style={{ color: "#888", fontSize: 11, fontFamily: "monospace" }}>
              Set X402_PAYER_PRIVATE_KEY in .env.local (optional)
            </span>
          </div>
        </div>
      </div>

      {/* Oracle endpoints */}
      <div>
        <div style={{ color: "#282828", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 8 }}>ORACLE ENDPOINTS (x402-PROTECTED)</div>
        <div style={{ border: "1px solid #0d0d0d", borderRadius: 4, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 50px 40px", gap: 8, padding: "5px 12px", background: "#060606", borderBottom: "1px solid #0d0d0d" }}>
            {["ENDPOINT", "PRICE", "METHOD", ""].map((h) => (
              <div key={h} style={{ color: "#1e1e1e", fontSize: 9, fontFamily: "monospace" }}>{h}</div>
            ))}
          </div>
          {ORACLE_ENDPOINTS.map((ep) => (
            <div key={ep.path} style={{ display: "grid", gridTemplateColumns: "1fr 70px 50px 40px", gap: 8, padding: "8px 12px", borderBottom: "1px solid #090909", alignItems: "center" }}>
              <div>
                <div style={{ color: "#c0c0c0", fontSize: 11, fontFamily: "monospace" }}>{ep.path}</div>
                <div style={{ color: "#333", fontSize: 9, fontFamily: "monospace", marginTop: 2 }}>{ep.description}</div>
              </div>
              <div style={{ color: "#0052ff", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>{ep.price}</div>
              <div style={{ color: "#555", fontSize: 10, fontFamily: "monospace" }}>{ep.method}</div>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: checking ? "#333" : endpointStatuses[ep.path] ? "#39ff14" : "#ff3b3b", boxShadow: endpointStatuses[ep.path] ? "0 0 5px #39ff14" : "none" }} />
            </div>
          ))}
        </div>
      </div>

      {/* Earnings */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {[
          ["PAYMENTS", payments.length, "#888"],
          ["EARNED", "$" + totalEarned.toFixed(4), "#0052ff"],
          ["NETWORK", "Base", "#39ff14"],
        ].map(([l, v, c]) => (
          <div key={l as string} style={{ background: "#070707", border: "1px solid #111", borderRadius: 4, padding: "8px 10px" }}>
            <div style={{ color: "#252525", fontSize: 9, fontFamily: "monospace", marginBottom: 3 }}>{l as string}</div>
            <div style={{ color: c as string, fontSize: 16, fontFamily: "monospace", fontWeight: "bold" }}>{v as string | number}</div>
          </div>
        ))}
      </div>

      {/* Payment log */}
      {payments.length > 0 && (
        <div>
          <div style={{ color: "#282828", fontSize: 9, fontFamily: "monospace", letterSpacing: 2, marginBottom: 6 }}>PAYMENT LOG</div>
          <div style={{ border: "1px solid #0d0d0d", borderRadius: 4, overflow: "hidden" }}>
            {payments.slice(-8).reverse().map((p, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px", borderBottom: "1px solid #090909" }}>
                <div>
                  <div style={{ color: "#888", fontSize: 10, fontFamily: "monospace" }}>{p.url.replace("https://", "").slice(0, 40)}</div>
                  <div style={{ color: "#333", fontSize: 9, fontFamily: "monospace" }}>{new Date(p.timestamp).toLocaleTimeString()}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ color: "#0052ff", fontSize: 11, fontFamily: "monospace", fontWeight: "bold" }}>{p.amount}</div>
                  <div style={{ color: "#2a2a2a", fontSize: 9, fontFamily: "monospace" }}>{p.txHash.slice(0, 10)}…</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent integration code */}
      <div style={{ background: "#050505", border: "1px solid #141414", borderRadius: 6, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ color: "#282828", fontSize: 9, fontFamily: "monospace", letterSpacing: 2 }}>AGENT INTEGRATION</div>
          <button
            onClick={copyCode}
            style={{ background: "rgba(0,82,255,0.08)", border: "1px solid #0052ff44", color: "#0052ff", borderRadius: 3, padding: "3px 10px", fontSize: 9 }}
          >
            COPY
          </button>
        </div>
        <pre style={{ color: "#555", fontSize: 10, fontFamily: "monospace", lineHeight: 1.7, overflowX: "auto", whiteSpace: "pre-wrap", margin: 0 }}>
          {EXAMPLE_AGENT_CODE}
        </pre>
      </div>

      {/* Info */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {[
          ["NO ACCOUNTS", "Callers pay directly on Base. No API keys, no sign-ups, no billing."],
          ["INSTANT SETTLEMENT", "USDC lands in your wallet after each verified call."],
          ["AI AGENT READY", "Any x402-compatible AI agent can call your oracle autonomously."],
          ["DOCS", "x402.org · github.com/coinbase/x402"],
        ].map(([title, desc]) => (
          <div key={title as string} style={{ background: "#070707", border: "1px solid #0d0d0d", borderRadius: 4, padding: "10px 12px" }}>
            <div style={{ color: "#0052ff", fontSize: 9, fontFamily: "monospace", fontWeight: "bold", marginBottom: 4 }}>{title as string}</div>
            <div style={{ color: "#444", fontSize: 10, fontFamily: "monospace", lineHeight: 1.5 }}>{desc as string}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
