import { NextRequest, NextResponse } from "next/server";
import type { Pair, RedFlag } from "@/types";
import { ageHours } from "@/lib/utils";

const MODEL = "claude-sonnet-4-20250514";

function buildPrompt(pair: Pair, flags: RedFlag[]): string {
  const ah = ageHours(pair.pairCreatedAt);
  const flagStr = flags.length
    ? flags.map((f) => `${f.code} (${f.sev}): ${f.msg}`).join("\n")
    : "None";

  return `You are a supreme DeFi trading oracle. Analyze this token. 
CRITICAL: Clearly separate OBSERVED signals (from real data) vs INFERRED (your estimates) vs UNKNOWN.
Return ONLY valid JSON — no markdown, no backticks.

=== OBSERVED DATA ===
Symbol: ${pair.baseToken?.symbol} | Chain: ${pair.chainId} | DEX: ${pair.dexId ?? "?"}
Price: $${pair.priceUsd} | MCap: $${pair.marketCap ?? "?"} | FDV: $${pair.fdv ?? "?"}
Changes: 5m=${pair.priceChange?.m5 ?? "?"}% 1h=${pair.priceChange?.h1 ?? "?"}% 6h=${pair.priceChange?.h6 ?? "?"}% 24h=${pair.priceChange?.h24 ?? "?"}%
Volume: 5m=$${pair.volume?.m5} 1h=$${pair.volume?.h1} 24h=$${pair.volume?.h24}
Liquidity: $${pair.liquidity?.usd}
Txns 5m: ${pair.txns?.m5?.buys}B/${pair.txns?.m5?.sells}S | 1h: ${pair.txns?.h1?.buys}B/${pair.txns?.h1?.sells}S | 24h: ${pair.txns?.h24?.buys}B/${pair.txns?.h24?.sells}S
Pair age: ${ah < 9999 ? ah.toFixed(1) + "h" : "unknown"}
Contract: ${pair.baseToken?.address}

=== RED FLAGS (deterministic engine) ===
${flagStr}

=== OUTPUT FORMAT (JSON only) ===
{
  "riskScore": <0-100>,
  "verdict": "<BUY|SELL|HOLD|AVOID|HONEYPOT>",
  "confidence": <0-100>,
  "observedSignals": ["max 4 signals from REAL DATA only"],
  "inferredSignals": ["max 3 AI estimates, each starting with INFERRED:"],
  "unknowns": ["max 3 items like UNKNOWN: LP lock status"],
  "momentum": "<BULLISH|BEARISH|NEUTRAL|PUMP|DUMP>",
  "entryZone": "<price range or NOT RECOMMENDED>",
  "stopLoss": "<price or N/A>",
  "takeProfit": "<price or N/A>",
  "summary": "<2-3 sentences, sharp trader tone, reference actual numbers>"
}`;
}

export async function POST(req: NextRequest) {
  try {
    const { pair, flags } = await req.json();

    if (!pair) {
      return NextResponse.json({ error: "Missing pair data" }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        messages: [{ role: "user", content: buildPrompt(pair, flags ?? []) }],
      }),
    });

    const data = await resp.json();
    const text: string = data.content?.[0]?.text ?? "{}";

    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      return NextResponse.json(parsed);
    } catch {
      return NextResponse.json({ error: "AI response parse error", raw: text }, { status: 500 });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
