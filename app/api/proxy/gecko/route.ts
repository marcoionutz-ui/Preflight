import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "No path" }, { status: 400 });

  // Reconstruct full URL — path may contain its own query params
  const fullUrl = `https://api.geckoterminal.com/api/v2/${path}`;

  try {
    const res = await fetch(fullUrl, {
      headers: { Accept: "application/json;version=20230302" },
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: "Upstream fetch failed" }, { status: 502 });
  }
}