import type { FearGreedEntry } from "@/types";

export async function getFearGreed(): Promise<FearGreedEntry[]> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=7");
    const data = await res.json();
    return data.data ?? [];
  } catch {
    return [];
  }
}
