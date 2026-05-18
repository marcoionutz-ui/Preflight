import { NextRequest, NextResponse } from "next/server";

// Cache server-side — 60 secunde per pool
const cache = new Map<string, { data: unknown; ts: number }>();
const TTL = 60 * 1000;

export async function GET(req: NextRequest) {
  const network = req.nextUrl.searchParams.get("network") ?? "";
  const pool    = req.nextUrl.searchParams.get("pool") ?? "";

  if (!network || !pool) {
    return NextResponse.json({ data: null });
  }

  const cacheKey = `${network}:${pool}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/hour?limit=48`;
    const res = await fetch(url, {
      headers: { Accept: "application/json;version=20230302" },
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json();
    cache.set(cacheKey, { data, ts: Date.now() });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ data: null, error: String(err) });
  }
}
