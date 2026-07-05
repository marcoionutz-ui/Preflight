/**
 * infra/health.ts
 * Scrie health key în Redis după fiecare ciclu de slot check.
 * Același pattern ca indexer-evm: TTL scurt, reînnoit la fiecare heartbeat.
 */

import { getRedis }    from "./redis";
import {
  KEY_HEALTH,
  HEALTH_TTL_SEC,
  BEHIND_OK_SLOTS,
  BEHIND_DEGRADED_SLOTS,
  INDEXER_VERSION,
  CHAIN,
} from "../config/constants";

export type SlotStatus = "OK" | "DEGRADED" | "BEHIND" | "STARTING";

export interface SolanaHealth {
  chain:         typeof CHAIN;
  version:       string;
  latestSlot:    number;
  cursorSlot:    number | null;
  behindSlots:   number;
  status:        SlotStatus;
  updatedAt:     string;
  indexerVersion: string;
}

export function resolveStatus(behindSlots: number): SlotStatus {
  if (behindSlots <= BEHIND_OK_SLOTS)       return "OK";
  if (behindSlots <= BEHIND_DEGRADED_SLOTS) return "DEGRADED";
  return "BEHIND";
}

export async function writeHealth(health: SolanaHealth): Promise<void> {
  const redis = getRedis();
  await redis.set(KEY_HEALTH, JSON.stringify(health), "EX", HEALTH_TTL_SEC);
}

export function buildHealth(
  latestSlot: number,
  cursorSlot: number | null,
  nodeVersion: string,
): SolanaHealth {
  const behindSlots = cursorSlot !== null ? Math.max(0, latestSlot - cursorSlot) : 0;
  return {
    chain:          CHAIN,
    version:        nodeVersion,
    latestSlot,
    cursorSlot,
    behindSlots,
    status:         cursorSlot === null ? "STARTING" : resolveStatus(behindSlots),
    updatedAt:      new Date().toISOString(),
    indexerVersion: INDEXER_VERSION,
  };
}
