import { NextRequest, NextResponse } from "next/server";
import { getOnChainData } from "@/lib/apis/alchemy";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const chain = searchParams.get("chain") ?? "base";
  const token = searchParams.get("token") ?? "";
  const pair  = searchParams.get("pair")  ?? "";

  if (!token || token.length < 10) {
    return NextResponse.json({ available: false, error: "No token address" });
  }

  try {
    const data = await getOnChainData(chain, token, pair);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ available: false, error: String(err) });
  }
}