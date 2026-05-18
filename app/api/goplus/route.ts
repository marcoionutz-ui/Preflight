import { NextRequest, NextResponse } from "next/server";

const cache = new Map<string, { data: unknown; ts: number }>();
const TTL = 5 * 60 * 1000;

const GOPLUS_CHAIN_ID: Record<string, string> = {
  ethereum: "1", bsc: "56", base: "8453", arbitrum: "42161",
};

async function fetchWithRetry(url: string, retries = 3): Promise<unknown> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    // Rate limited — wait și retry
    if (data.message?.toLowerCase().includes("too many") || res.status === 429) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1200 * (i + 1)));
      continue;
    }
    return data;
  }
  throw new Error("GoPlus rate limit — toate retry-urile au eșuat");
}

export async function GET(req: NextRequest) {
  const chain = req.nextUrl.searchParams.get("chain") ?? "";
  const token = req.nextUrl.searchParams.get("token") ?? "";

  if (!token || token.length < 10) {
    return NextResponse.json({ error: "No token address" });
  }

  const cacheKey = `${chain}:${token.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const addr = token.toLowerCase();
    let url: string;

    if (chain === "solana") {
      url = `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${addr}`;
    } else {
      const chainId = GOPLUS_CHAIN_ID[chain];
      if (!chainId) return NextResponse.json({ error: `Chain not supported: ${chain}` });
      url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${addr}`;
    }

    const data = await fetchWithRetry(url);
    cache.set(cacheKey, { data, ts: Date.now() });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Fetch error" });
  }
}