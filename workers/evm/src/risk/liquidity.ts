/**
 * risk/liquidity.ts
 * Liquidity context helpers — citește din poolLiquidity store.
 */

import { poolLiquidity } from "../state/stores";

export function getLiquidityContext(chain: string | undefined, pairAddress: string): {
  reserveUsd:    number;
  reserveEth:    number;
  reserveNative: number;
  nativeSymbol:  "ETH" | "BNB" | null;
  freshnessMs:   number | null;
  status:        "CONFIRMED" | "WEAK" | "MISSING";
} {
  // chain opțional (unii calleri au `mem.chain?`): fără chain nu putem forma
  // cheia chain-scoped → tratăm ca lipsă de lichiditate (MISSING), nu fabricăm.
  const ctx = chain ? poolLiquidity.get(chain, pairAddress) : undefined;
  if (!ctx) return { reserveUsd: 0, reserveEth: 0, reserveNative: 0, nativeSymbol: null, freshnessMs: null, status: "MISSING" };

  const freshnessMs = Date.now() - ctx.updatedAt;

  if (ctx.reserveUsd >= 25_000 && freshnessMs < 5 * 60_000)
    return { ...ctx, freshnessMs, status: "CONFIRMED" };

  if (ctx.reserveUsd >= 5_000 && freshnessMs < 10 * 60_000)
    return { ...ctx, freshnessMs, status: "WEAK" };

  return { ...ctx, freshnessMs, status: "MISSING" };
}
