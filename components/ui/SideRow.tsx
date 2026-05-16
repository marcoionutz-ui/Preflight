import type { Pair } from "@/types";
import { CHAINS } from "@/lib/chains";
import { fmtPrice, fmtPct, fmtUSD } from "@/lib/utils";

interface Props {
  pair: Pair;
  selected: boolean;
  onSelect: (pair: Pair) => void;
  chainColor?: string;
}

export default function SideRow({ pair, selected, onSelect, chainColor = "#39ff14" }: Props) {
  const pct = pair.priceChange?.h24;
  const c = CHAINS[pair.chainId as keyof typeof CHAINS]?.color ?? chainColor;

  return (
    <div
      onClick={() => onSelect(pair)}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 68px 58px",
        gap: 4,
        padding: "7px 10px",
        borderBottom: "1px solid #080808",
        cursor: "pointer",
        borderLeft: selected ? `2px solid ${c}` : "2px solid transparent",
        background: selected ? c + "0a" : "transparent",
        transition: "all 0.1s",
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = c + "06"; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = "transparent"; }}
    >
      <div>
        <div style={{ color: "#c0c0c0", fontSize: 12, fontWeight: "bold", fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {pair.baseToken?.symbol}
        </div>
        <div style={{ color: "#252525", fontSize: 9, fontFamily: "monospace" }}>
          {fmtUSD(pair.liquidity?.usd)}
        </div>
      </div>
      <div style={{ color: "#666", fontSize: 10, textAlign: "right", fontFamily: "monospace" }}>
        ${fmtPrice(pair.priceUsd)}
      </div>
      <div style={{ color: (pct ?? 0) >= 0 ? "#39ff14" : "#ff3b3b", fontSize: 10, textAlign: "right", fontFamily: "monospace" }}>
        {fmtPct(pct)}
      </div>
    </div>
  );
}
