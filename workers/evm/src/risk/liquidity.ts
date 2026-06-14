/**
 * risk/liquidity.ts
 * Liquidity context helpers — citește din poolLiquidity store.
 */

import { poolLiquidity } from "../state/stores";

export function getLiquidityContext(pairAddress: string): {
  reserveUsd:    number;
  reserveEth:    number;
  reserveNative: number;
  nativeSymbol:  "ETH" | "BNB" | null;
  freshnessMs:   number | null;
  status:        "CONFIRMED" | "WEAK" | "MISSING";
} {
  const ctx = poolLiquidity.get(pairAddress.toLowerCase());
  if (!ctx) return { reserveUsd: 0, reserveEth: 0, reserveNative: 0, nativeSymbol: null, freshnessMs: null, status: "MISSING" };

  const freshnessMs = Date.now() - ctx.updatedAt;

  if (ctx.reserveUsd >= 25_000 && freshnessMs < 5 * 60_000)
    return { ...ctx, freshnessMs, status: "CONFIRMED" };

  if (ctx.reserveUsd >= 5_000 && freshnessMs < 10 * 60_000)
    return { ...ctx, freshnessMs, status: "WEAK" };

  return { ...ctx, freshnessMs, status: "MISSING" };
}
