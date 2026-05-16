import type { CoinPrices, FearGreedEntry } from "@/types";

interface Props {
  chainColor: string;
  chainName: string;
  countdown: number;
  coins: CoinPrices;
  fg: FearGreedEntry[];
  onRefresh: () => void;
}

export default function Header({ chainColor, chainName, countdown, coins, fg, onRefresh }: Props) {
  const btc = coins?.bitcoin;
  const eth = coins?.ethereum;
  const sol = coins?.solana;
  const fgVal = fg?.[0];

  return (
    <header style={{
      borderBottom: "1px solid #0d0d0d",
      padding: "9px 16px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      background: "#040404",
      position: "sticky",
      top: 0,
      zIndex: 100,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          className="blink"
          style={{ width: 7, height: 7, borderRadius: "50%", background: chainColor, boxShadow: `0 0 8px ${chainColor}` }}
        />
        <span style={{ color: chainColor, fontSize: 13, fontWeight: "bold", letterSpacing: 3 }}>
          SUPREME TRADER
        </span>
        <span style={{ color: "#1a1a1a" }}>|</span>
        <span style={{ color: "#2a2a2a", fontSize: 10 }}>v3.0 · {chainName}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10 }}>
        {btc && (
          <span style={{ color: "#f7931a" }}>
            BTC ${btc.usd?.toLocaleString()}
            <span style={{ color: btc.usd_24h_change >= 0 ? "#39ff14" : "#ff3b3b", marginLeft: 4 }}>
              {btc.usd_24h_change?.toFixed(1)}%
            </span>
          </span>
        )}
        {eth && (
          <span style={{ color: "#627eea" }}>
            ETH ${eth.usd?.toLocaleString()}
          </span>
        )}
        {sol && (
          <span style={{ color: "#9945ff" }}>
            SOL ${sol.usd?.toFixed(2)}
          </span>
        )}
        {fgVal && (
          <>
            <span style={{ color: "#1a1a1a" }}>|</span>
            <span style={{ color: "#555" }}>
              F&G{" "}
              <span style={{ color: Number(fgVal.value) >= 50 ? "#39ff14" : "#ff3b3b" }}>
                {fgVal.value}
              </span>
            </span>
          </>
        )}
        <span style={{ color: "#1a1a1a" }}>|</span>
        <span style={{ color: "#333" }}>
          ↺ <span style={{ color: chainColor }}>{countdown}s</span>
        </span>
        <button
          onClick={onRefresh}
          style={{
            background: "transparent",
            border: "1px solid #1a1a1a",
            color: "#333",
            borderRadius: 3,
            padding: "2px 7px",
            fontSize: 9,
          }}
        >
          NOW
        </button>
      </div>
    </header>
  );
}
