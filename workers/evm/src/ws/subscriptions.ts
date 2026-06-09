/**
 * ws/subscriptions.ts
 * Subscribe/unsubscribe la pool-uri pe WS Alchemy.
 */

import WebSocket from "ws";
import type { ChainConfig } from "../config/chains";
import {
  wsClients, activeWatch, hotCandidates,
  v3PoolMap, v4PoolMap,
  swapSubIds, swapSubSnapshot, pendingSwapSubs, swapSubReqId,
  v3SwapSubIds, v4SwapSubIds, lastImmediateSub,
  incrementSwapSubReqId,
} from "../state/stores";
import { dropWatchCandidate } from "../pipeline/transitions";
import { getWsFlow } from "../risk/flow";
import { memory } from "../state/stores";
import {
  MAX_V3_WATCH, MAX_V4_WATCH,
  WATCH_NO_FLOW_MAX_AGE_MS, WATCH_SELLING_MAX_AGE_MS,
  WATCH_MAX_AGE_MS, FOMO_WATCH_TTL_MS,
  UNISWAP_V4_POOL_MANAGER, SWAP_V4_TOPIC,
} from "../config/constants";
import { cleanEvmAddress } from "../sources/normalize";

const SWAP_V2_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const SWAP_V3_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

export { SWAP_V2_TOPIC, SWAP_V3_TOPIC };
export const MINT_V2_TOPIC = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
export const BURN_V2_TOPIC = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";

export function watchPriority(kind?: string): number {
  if (kind === "CONFIRMED_MOMENTUM") return 0;
  if (kind === "VERTICAL")           return 1;
  if (kind === "FOMO")               return 2;
  if (kind === "LATE")               return 3;
  return 4;
}

export function cleanupActiveWatch(): void {
  const now = Date.now();

  for (const [addr, info] of activeWatch.entries()) {
    const ageMs = now - info.addedAt;

    if (info.kind === "CONFIRMED_MOMENTUM") {
      if (ageMs > 3 * 60_000) {
        console.log(`[WATCH EVICT] ${memory.get(addr)?.symbol ?? addr} — kind:CONFIRMED_MOMENTUM age:${Math.round(ageMs / 1000)}s`);
        dropWatchCandidate(addr, `evict CONFIRMED_MOMENTUM age:${Math.round(ageMs / 1000)}s`);
      }
      continue;
    }

    if (info.kind === "VERTICAL") {
      if (ageMs > 3 * 60_000) {
        console.log(`[WATCH EVICT] ${memory.get(addr)?.symbol ?? addr} — kind:VERTICAL age:${Math.round(ageMs / 1000)}s`);
        dropWatchCandidate(addr, `evict VERTICAL age:${Math.round(ageMs / 1000)}s`);
      }
      continue;
    }

    if (info.kind === "LATE") {
      if (ageMs > 8 * 60_000) {
        console.log(`[WATCH EVICT] ${memory.get(addr)?.symbol ?? addr} — kind:LATE age:${Math.round(ageMs / 60_000)}m`);
        dropWatchCandidate(addr, `evict LATE age:${Math.round(ageMs / 60_000)}m`);
      }
      continue;
    }

    if (info.kind === "FOMO") {
      if (ageMs > FOMO_WATCH_TTL_MS) {
        console.log(`[WATCH EVICT] ${memory.get(addr)?.symbol ?? addr} — kind:FOMO age:${Math.round(ageMs / 1000)}s`);
        dropWatchCandidate(addr, `evict FOMO age:${Math.round(ageMs / 1000)}s`);
      }
      continue;
    }

    const flow = getWsFlow(addr);
    const shouldEvict =
      (!flow.hasData && ageMs > WATCH_NO_FLOW_MAX_AGE_MS) ||
      (flow.hasData && flow.pressure === "SELLING" && ageMs > WATCH_SELLING_MAX_AGE_MS) ||
      (ageMs > WATCH_MAX_AGE_MS);

    if (shouldEvict) {
      console.log(
        `[WATCH EVICT] ${memory.get(addr)?.symbol ?? addr}`
        + ` — kind:NORMAL age:${Math.round(ageMs / 60_000)}m`
        + ` flow:${flow.hasData ? flow.pressure : "NO_WS"}`,
      );
      dropWatchCandidate(addr, `evict NORMAL age:${Math.round(ageMs / 60_000)}m flow:${flow.hasData ? flow.pressure : "NO_WS"}`);
    }
  }
}

export function subscribeV3Scoped(chain: ChainConfig): void {
  const ws = wsClients.get(chain.id) as WebSocket | undefined;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const hotV3Addrs = [...hotCandidates.entries()]
    .filter(([addr, info]) => info.chain === chain.id && v3PoolMap.has(addr))
    .map(([addr]) => addr);

  const addrs = [...new Set([
    ...hotV3Addrs,
    ...[...activeWatch.entries()]
      .filter(([addr, info]) => info.chain === chain.id && v3PoolMap.has(addr))
      .sort((a, b) => {
        const pa = watchPriority(a[1].kind);
        const pb = watchPriority(b[1].kind);
        if (pa !== pb) return pa - pb;
        return b[1].addedAt - a[1].addedAt;
      })
      .map(([addr]) => addr),
  ])].slice(0, MAX_V3_WATCH);

  if (!addrs.length) {
    const oldId = v3SwapSubIds.get(chain.id);
    if (oldId) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 51, method: "eth_unsubscribe", params: [oldId] }));
      v3SwapSubIds.delete(chain.id);
      v3SwapSubIds.delete(chain.id + "_snap");
      console.log(`[V3] Unsubscribed — nothing in watch`);
    }
    return;
  }

  const snapshot = addrs.join(",");
  if (v3SwapSubIds.get(chain.id + "_snap") === snapshot) return;
  v3SwapSubIds.set(chain.id + "_snap", snapshot);

  const oldId = v3SwapSubIds.get(chain.id);
  if (oldId) {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 51, method: "eth_unsubscribe", params: [oldId] }));
  }
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 7,
    method: "eth_subscribe",
    params: ["logs", { address: addrs, topics: [SWAP_V3_TOPIC] }],
  }));
  console.log(`[V3] Scoped subscribe: ${addrs.length} watched pools`);
}

export function subscribeV4Scoped(chain: ChainConfig): void {
  const ws = wsClients.get(chain.id) as WebSocket | undefined;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const hotV4Ids = [...hotCandidates.entries()]
    .filter(([addr, info]) => info.chain === chain.id && v4PoolMap.has(addr))
    .map(([addr]) => addr);

  const poolIds = [...new Set([
    ...hotV4Ids,
    ...[...activeWatch.entries()]
      .filter(([addr, info]) => info.chain === chain.id && v4PoolMap.has(addr))
      .sort((a, b) => {
        const pa = watchPriority(a[1].kind);
        const pb = watchPriority(b[1].kind);
        if (pa !== pb) return pa - pb;
        return b[1].addedAt - a[1].addedAt;
      })
      .map(([addr]) => addr),
  ])].slice(0, MAX_V4_WATCH);

  if (!poolIds.length) {
    const oldId = v4SwapSubIds.get(chain.id);
    if (oldId) {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 50, method: "eth_unsubscribe", params: [oldId] }));
      v4SwapSubIds.delete(chain.id);
      v4SwapSubIds.delete(chain.id + "_snap");
      console.log(`[V4] Unsubscribed — nothing in watch`);
    }
    return;
  }

  const snapshot = poolIds.join(",");
  if (v4SwapSubIds.get(chain.id + "_snap") === snapshot) return;
  v4SwapSubIds.set(chain.id + "_snap", snapshot);

  const oldId = v4SwapSubIds.get(chain.id);
  if (oldId) {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: 50, method: "eth_unsubscribe", params: [oldId] }));
  }
  ws.send(JSON.stringify({
    jsonrpc: "2.0", id: 5,
    method: "eth_subscribe",
    params: ["logs", { address: UNISWAP_V4_POOL_MANAGER, topics: [SWAP_V4_TOPIC, poolIds] }],
  }));
  console.log(`[V4] Scoped subscribe: ${poolIds.length} watched pools`);
}

export function requestImmediateScopedSubscribe(chain: ChainConfig): void {
  const now = Date.now();
  const last = lastImmediateSub.get(chain.id) ?? 0;
  if (now - last < 2_000) return;
  lastImmediateSub.set(chain.id, now);
  setTimeout(() => subscribeV4Scoped(chain), 500);
  setTimeout(() => subscribeV3Scoped(chain), 800);
}
