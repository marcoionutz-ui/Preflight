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
 * @deprecated Folosește advanceCursor() — aceasta suprascrie direct fără compare-and-set
 * și poate regresa cursorul dacă sunt events paralele.
 */
export async function writeCursor(slot: number): Promise<void> {
  const redis = getRedis();
  await redis.set(KEY_CURSOR, String(slot));
}

/**
 * Avansează cursorul atomic via Lua — previne race condition când vin
 * events paralele din subscriptions multiple pe acelasi WS connection.
 * SET se face doar daca slot > current (compare-and-set atomic).
 */
export async function advanceCursor(slot: number): Promise<void> {
  const redis = getRedis();
  await (redis as any).eval(
    `local cur = tonumber(redis.call('GET', KEYS[1]) or '-1')
     local inc = tonumber(ARGV[1])
     if inc > cur then redis.call('SET', KEYS[1], ARGV[1]) end
     return 1`,
    1,
    KEY_CURSOR,
    String(slot),
  );
}
