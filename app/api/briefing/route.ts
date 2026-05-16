import { NextRequest, NextResponse } from "next/server";
import type { Pair, FearGreedEntry, CoinPrices } from "@/types";
import { fmtUSD, fmtPct } from "@/lib/utils";

const MODEL = "claude-sonnet-4-20250514";

export async function POST(req: NextRequest) {
  try {
    const { chain, trending, fg, coinPrices } = await req.json() as {
      chain: string;
      trending: Pair[];
      fg: FearGreedEntry[];
      coinPrices: CoinPrices;
    };

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const fgLatest = fg?.[0];
    const btc = coinPrices?.bitcoin;
    const eth = coinPrices?.ethereum;
    const sol = coinPrices?.solana;

    const topTokens = trending
      .slice(0, 6)
      .map((p) => `${p.baseToken?.symbol}: ${fmtPct(p.priceChange?.h24)} liq=${fmtUSD(p.liquidity?.usd)}`)
      .join(" | ");

    const prompt = `You are a sharp DeFi alpha analyst. Write a concise market briefing for a DeFi trader.

Chain focus: ${chain.toUpperCase()}
Fear & Greed: ${fgLatest?.value ?? "?"}/100 (${fgLatest?.value_classification ?? "?"})
BTC: $${btc?.usd?.toLocaleString() ?? "?"} (${btc?.usd_24h_change?.toFixed(2) ?? "?"}% 24h)
ETH: $${eth?.usd?.toLocaleString() ?? "?"}
SOL: $${sol?.usd?.toFixed(2) ?? "?"}
Top trending on ${chain}: ${topTokens || "loading..."}

Write 4 paragraphs:
1. Macro sentiment + what BTC/ETH signals for alts
2. ${chain.toUpperCase()} chain specific activity & notable moves
3. Key red flags & risks to watch right now
4. Specific actionable opportunities (with reasoning)

Be direct, use real numbers, no generic fluff.`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await resp.json();
    const text: string = data.content?.[0]?.text ?? "Briefing unavailable.";
    return NextResponse.json({ briefing: text });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
