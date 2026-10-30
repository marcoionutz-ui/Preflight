import { REDIS_KEYS, type PreflightWorkerRuntime, type PreflightNativePriceObservation } from "@preflight/schema";
import { getNativePriceStatus, getNativeSymbolForChain } from "../infra/nativePrice";
import { getDroppedNoPrice } from "../infra/noPrice";

export interface RuntimeSink { set(key: string, value: string, mode: "EX", ttl: number): unknown; }
/** Real publisher used by snapshots.ts. One clock anchors both status ages and wire timestamp. */
export function queueWorkerRuntime(sink: RuntimeSink, runtime: Omit<PreflightWorkerRuntime, "nativePrice">, ttl: number): PreflightWorkerRuntime {
  const symbol = getNativeSymbolForChain(runtime.chain);
  const nativePrice: PreflightNativePriceObservation = {
    symbol, ...getNativePriceStatus(symbol, runtime.updatedAt),
    observedAt: runtime.updatedAt, droppedNoPrice: getDroppedNoPrice(runtime.chain),
  };
  const payload: PreflightWorkerRuntime = { ...runtime, nativePrice };
  sink.set(REDIS_KEYS.workerRuntime(runtime.chain), JSON.stringify(payload), "EX", ttl);
  return payload;
}
