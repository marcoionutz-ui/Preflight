import type { PreflightNativePriceObservation } from "@preflight/schema";
/** Snapshot observation, not a live quote. Bad leaf never invalidates WS liveness. */
export function normalizeNativePriceObservation(raw: unknown, chain: string, updatedAt: number): PreflightNativePriceObservation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  if (!["base", "arbitrum", "ethereum", "bsc"].includes(chain)) return null;
  const p = raw as Record<string, unknown>;
  const symbol = chain === "bsc" ? "BNB" : "ETH";
  const age = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
  if (p.symbol !== symbol || typeof p.observedAt !== "number" || !Number.isFinite(p.observedAt)
      || p.observedAt !== updatedAt || !Number.isFinite(updatedAt)) return null;
  if (p.value !== null && (typeof p.value !== "number" || !Number.isFinite(p.value) || p.value <= 0)) return null;
  if (!age(p.ageSec) || !age(p.sourceAgeSec)) return null;
  if (typeof p.droppedNoPrice !== "number" || !Number.isSafeInteger(p.droppedNoPrice) || p.droppedNoPrice < 0) return null;
  return { symbol, value: p.value, ageSec: p.ageSec, sourceAgeSec: p.sourceAgeSec,
    observedAt: p.observedAt, droppedNoPrice: p.droppedNoPrice };
}
