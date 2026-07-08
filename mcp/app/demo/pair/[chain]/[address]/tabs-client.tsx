"use client";

/**
 * app/demo/pair/[chain]/[address]/tabs-client.tsx
 * Human View / Agent JSON toggle. Agent JSON is copy-paste ready —
 * it's the exact envelope an MCP client receives from tp_pair_context.
 */

import { useState } from "react";

export default function PairContextTabs({
  human,
  agentJson,
}: {
  human:     React.ReactNode;
  agentJson: string;
}) {
  const [tab, setTab]       = useState<"human" | "json">("human");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(agentJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — no-op, user can still select-all manually
    }
  };

  return (
    <div>
      <div style={styles.tabBar}>
        <button
          onClick={() => setTab("human")}
          style={{ ...styles.tabBtn, ...(tab === "human" ? styles.tabBtnActive : {}) }}
        >
          Human View
        </button>
        <button
          onClick={() => setTab("json")}
          style={{ ...styles.tabBtn, ...(tab === "json" ? styles.tabBtnActive : {}) }}
        >
          Agent JSON
        </button>
        {tab === "json" && (
          <button onClick={copy} style={styles.copyBtn}>
            {copied ? "copied ✓" : "copy"}
          </button>
        )}
      </div>

      {tab === "human" ? (
        <div className="fade-in">{human}</div>
      ) : (
        <pre className="fade-in" style={styles.jsonBlock}>
          {agentJson}
        </pre>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  tabBar: {
    display:      "flex",
    alignItems:   "center",
    gap:          "8px",
    marginBottom: "18px",
    borderBottom: "1px solid #1a1a1a",
    paddingBottom: "0",
  },
  tabBtn: {
    background:   "transparent",
    border:       "none",
    borderBottom: "2px solid transparent",
    color:        "#666",
    fontSize:     "13px",
    fontFamily:   "'Courier New', Courier, monospace",
    padding:      "10px 4px",
    marginRight:  "18px",
  },
  tabBtnActive: {
    color:        "#00ff88",
    borderBottom: "2px solid #00ff88",
  },
  copyBtn: {
    marginLeft:   "auto",
    background:   "#0d0d0d",
    border:       "1px solid #222",
    borderRadius: "4px",
    color:        "#888",
    fontSize:     "11px",
    padding:      "5px 10px",
  },
  jsonBlock: {
    background:    "#080808",
    border:        "1px solid #1a1a1a",
    borderRadius:  "6px",
    color:         "#7fe3a3",
    fontSize:      "12.5px",
    lineHeight:    "1.6",
    padding:       "18px",
    overflowX:     "auto",
    whiteSpace:    "pre",
  },
};
