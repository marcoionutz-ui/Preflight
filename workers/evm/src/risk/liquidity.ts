/**
 * risk/liquidity.ts
 * Liquidity context helpers — citește din poolLiquidity store.
 */

import { poolLiquidity } from "../state/stores";
import { classifyLiquidity } from "./liquidityClassify";
import type { ReserveSource } from "@preflight/schema";

export function getLiquidityContext(chain: string | undefined, pairAddress: string): {
  reserveUsd:    number;
  reserveEth:    number;
  reserveNative: number;
  nativeSymbol:  "ETH" | "BNB" | null;
  freshnessMs:   number | null;
  status:        "CONFIRMED" | "WEAK" | "MISSING";
  // NF/U5: proveniența rezervei — `V4_STATE_LIQUIDITY` = estimat (poate supraestima). Propagat în pair_states
  // pentru caveat MCP. `status` de mai sus e deja clasificat CONSERVATOR pt. estimatele V4 (classifyLiquidity).
  reserveSource: ReserveSource | null;
} {
  // chain opțional (unii calleri au `mem.chain?`): fără chain nu putem forma
  // cheia chain-scoped → tratăm ca lipsă de lichiditate (MISSING), nu fabricăm.
  const ctx = chain ? poolLiquidity.get(chain, pairAddress) : undefined;
  if (!ctx) return { reserveUsd: 0, reserveEth: 0, reserveNative: 0, nativeSymbol: null, freshnessMs: null, status: "MISSING", reserveSource: null };

  const freshnessMs = Date.now() - ctx.updatedAt;
  // NF/U5: clasificare source-aware — un estimat V4 (V4_STATE_LIQUIDITY) folosește praguri USD mai mari,
  // deci un pool V4 marginal NU mai citește CONFIRMED (→ blocat de gate-ul V3/V4 din gates.ts).
  const status = classifyLiquidity(ctx.reserveUsd, freshnessMs, ctx.reserveSource);
  return { ...ctx, freshnessMs, status, reserveSource: ctx.reserveSource ?? null };
}
