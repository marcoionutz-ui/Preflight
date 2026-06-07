import type { Pair, BuyerVelocity } from "@/types";

/**
 * Proxy for holder growth — tracks delta in buy/sell txns between
 * two snapshots of the same pair (one refresh cycle apart).
 *
 * Real holder growth requires BSCScan/Etherscan Transfer event indexing.
 * This is a reasonable proxy until that's implemented.
 */
export function computeBuyerVelocity(
  prev: Pair,
  current: Pair
): BuyerVelocity {
  const pb = prev.txns?.m5?.buys ?? 0;
  const cb = current.txns?.m5?.buys ?? 0;
  const ps = prev.txns?.m5?.sells ?? 0;
  const cs = current.txns?.m5?.sells ?? 0;

  const delta = (cb - pb) - (cs - ps);

  const trend: BuyerVelocity["trend"] =
    delta > 2 ? "GROWING" :
    delta < -2 ? "SHRINKING" : "STABLE";

  return { delta, trend };
}
