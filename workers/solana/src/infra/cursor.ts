/**
 * infra/cursor.ts
 * Slot cursor persistent în Redis pentru indexer-solana.
 * Analog cu block cursor din indexer-evm, dar pe Solana "slot" ≈ "block".
 */

import { getRedis } from "./redis";
import { KEY_CURSOR } from "../config/constants";

/**
 * Citește slotul de unde continuăm indexarea.
 * Dacă nu există, returnează null (prima pornire).
 */
export async function readCursor(): Promise<number | null> {
  const redis = getRedis();
  const raw = await redis.get(KEY_CURSOR);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

/**
 * Salvează slotul curent în Redis.
 */
export async function writeCursor(slot: number): Promise<void> {
  const redis = getRedis();
  await redis.set(KEY_CURSOR, String(slot));
}
