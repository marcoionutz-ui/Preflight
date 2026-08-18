/**
 * lib/db/watchQueue.ts — PH-10 (enqueue FAIR per-client al cererilor de watch, Redis-bound).
 *
 * Primitiva atomică (`enqueueWatchQueue` + `WATCH_ENQUEUE_LUA`) trăiește în `@preflight/schema` (aceeași folosită de
 * worker la drain și de testul de integrare — un singur contract). Aici doar legăm `getRedis()` și traducem verdictul
 * `unexpected` (rezultat Lua necunoscut) în `unavailable` FAIL-CLOSED — nu raportăm succes fără dovadă.
 */
import { getRedis } from "./redis";
import { enqueueWatchQueue, type WatchEnqueueStatus } from "@preflight/schema";

export type WatchEnqueueResult = Exclude<WatchEnqueueStatus, "unexpected"> | "unavailable";

/**
 * Mapare PURĂ (testabilă izolat) status Lua → rezultat expus caller-ului. `unexpected` (rezultat Lua necunoscut/
 * null/NaN) devine `unavailable` — fail-closed, nu raportăm succes fără dovadă. Restul verdictelor trec neschimbate.
 */
export function resolveEnqueueResult(status: WatchEnqueueStatus): WatchEnqueueResult {
  return status === "unexpected" ? "unavailable" : status;
}

export async function enqueueWatchRequest(
  chain:       string,
  pair:        string,
  requestJson: string,
  clientId:    string,
): Promise<WatchEnqueueResult> {
  const r = getRedis();
  if (!r) return "unavailable";
  try {
    return resolveEnqueueResult(await enqueueWatchQueue(r, chain, pair, requestJson, clientId));
  } catch {
    return "unavailable";
  }
}
