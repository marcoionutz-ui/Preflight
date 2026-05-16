import type { CoinPrices } from "@/types";

export async function getCoinPrices(): Promise<CoinPrices> {
  try {
    const res = await fetch(
      "/api/proxy/coingecko",
      { next: { revalidate: 60 } }
    );
    return await res.json();
  } catch {
    return {};
  }
}
