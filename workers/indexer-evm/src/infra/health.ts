/**
 * infra/health.ts
 * Indexer health reporting în Redis.
 *
 * Key: preflight:indexer:health:{chain}
 * TTL: 60s — dacă indexer-ul pică, health devine stale rapid
 *
 * Citit de:
 *   - sources/indexed.ts (Faza 6.3) pentru health-aware fallback în scan.ts
 *   - tp_health_check (Faza 6.3+) pentru vizibilitate agent
 */

import { getRedis } from "./redis";
import type { CursorState } from "./cursor";

const KEY_PREFIX  = "preflight:indexer:health";
const HEALTH_TTL  = 60; // secunde

export type IndexerHealthStatus = "OK" | "DEGRADED" | "CATCHING_UP";

export interface IndexerHealth {
  status:          IndexerHealthStatus;
  blocksBehind:    number;
  lastSuccessAt:   number | null;
  lastErrorAt:     number | null;
  pairsDiscovered: number;   // total perechi văzute (crește în Faza 6.2+)
  freshPairs24h:   number;   // perechi noi în ultimele 24h (crește în Faza 6.2+)
  cursorAge:       number;   // secunde de la lastSuccessAt
}

function healthKey(chain: string): string {
  return `${KEY_PREFIX}:${chain.toLowerCase()}`;
}

/** Citește health pentru un chain din Redis. */
export async function readIndexerHealth(chain: string): Promise<IndexerHealth | null> {
  const r = getRedis();
  if (!r) return null;

  try {
    const raw = await r.get(healthKey(chain));
    return raw ? (JSON.parse(raw) as IndexerHealth) : null;
  } catch (err) {
    console.error(`[INDEXER][HEALTH] read(${chain}) error:`, (err as Error).message);
    return null;
  }
}

/** Scrie health în Redis cu TTL 60s. */
export async function writeIndexerHealth(
  chain:  string,
  health: IndexerHealth,
): Promise<void> {
  const r = getRedis();
  if (!r) return;

  try {
    await r.set(healthKey(chain), JSON.stringify(health), "EX", HEALTH_TTL);
  } catch (err) {
    console.error(`[INDEXER][HEALTH] write(${chain}) error:`, (err as Error).message);
  }
}

/** Construiește un IndexerHealth din starea curentă a cursorului. */
export function buildHealthFromCursor(args: {
  cursorState:     CursorState;
  lastSuccessAt:   number;
  lastErrorAt:     number | null;
  pairsDiscovered: number;
  freshPairs24h:   number;
}): IndexerHealth {
  const { cursorState, lastSuccessAt, lastErrorAt, pairsDiscovered, freshPairs24h } = args;
  const now      = Date.now();
  const cursorAge = Math.round((now - lastSuccessAt) / 1000);

  return {
    status:          cursorState.status,
    blocksBehind:    cursorState.blocksBehind,
    lastSuccessAt,
    lastErrorAt,
    pairsDiscovered,
    freshPairs24h,
    cursorAge,
  };
}

/** Construiește un IndexerHealth în stare DEGRADED (RPC failure, missing URL, etc.). */
export function buildDegradedHealth(args: {
  blocksBehind?: number;
  lastErrorAt:   number;
  reason:        string;
}): IndexerHealth {
  console.warn(`[INDEXER][HEALTH] DEGRADED: ${args.reason}`);
  return {
    status:          "DEGRADED",
    blocksBehind:    args.blocksBehind ?? -1,
    lastSuccessAt:   null,
    lastErrorAt:     args.lastErrorAt,
    pairsDiscovered: 0,
    freshPairs24h:   0,
    cursorAge:       0,
  };
}
