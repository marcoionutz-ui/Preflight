/**
 * infra/health.ts
 * Scrie health key în Redis după fiecare ciclu de slot check.
 * Același pattern ca indexer-evm: TTL scurt, reînnoit la fiecare heartbeat.
 *
 * C6: health ONEST. Înainte, singurul semnal era „behind" pe OBSERVED slot (cel mai mare slot cu
 * log WS văzut) — care avansa la simpla observare, deci raporta „OK" chiar când un candidat pica la
 * fetch/write (pool pierdut). Acum:
 *   - `behindSlots` rămâne pe OBSERVED slot = LIVENESS (WS livrează logs aproape de head).
 *   - Integritatea PROCESĂRII vine din starea cozii de discovery: `deadCount > 0` (candidați picați
 *     definitiv = pierdere reală de date) sau backlog vechi (pending nedrenajat) → status escaladat
 *     la cel puțin DEGRADED. Gata cu falsul „OK".
 *   - `processedSlot` / `lastProcessedAt` = observabilitate (ultimul write durabil), NU măsură de lag.
 */

import { getRedis }    from "./redis";
import {
  KEY_HEALTH,
  HEALTH_TTL_SEC,
  BEHIND_OK_SLOTS,
  BEHIND_DEGRADED_SLOTS,
  DISC_BACKLOG_DEGRADED_MS,
  INDEXER_VERSION,
  CHAIN,
} from "../config/constants";
import { resolveSolanaStatus, type ProgramHealthResult } from "./programFreshness";
import type { PreflightSolanaHealth, PreflightSolanaSlotStatus } from "@preflight/schema";

export type SlotStatus = PreflightSolanaSlotStatus;

export type SolanaHealth = PreflightSolanaHealth;

export interface DiscoveryQueueSnapshot {
  pending:            number;
  processing:         number;
  dead:               number;
  oldestPendingAgeMs: number | null;
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
  latestSlot:      number,
  observedSlot:    number | null,
  processedSlot:   number | null,
  lastProcessedAt: number | null,   // ms epoch
  queue:           DiscoveryQueueSnapshot,
  programHealth:   ProgramHealthResult,  // D2: freshness per-program (subscripție WS)
  hasCurrentCriticalEvidence: boolean,   // D2: subscripțiile procesului CURENT au dovedit viață?
  nodeVersion:     string,
): SolanaHealth {
  const behindSlots = observedSlot !== null ? Math.max(0, latestSlot - observedSlot) : 0;
  const slotStatus: SlotStatus = resolveStatus(behindSlots);

  // Escaladare ONESTĂ (pură, testabilă): integritate procesare (dead-letter/backlog blocat — C6) SAU
  // un program CRITIC de discovery mort tăcut (D2 — pierdere PARȚIALĂ pe care `behindSlots` n-o vede).
  // + edge de restart: fără dovadă de viață din procesul CURENT, statusul e STARTING (nu ne bazăm pe
  // `observedSlot` persistent din procesul mort ca dovadă a socketului actual).
  const degradedBySignal =
    queue.dead > 0 ||
    (queue.oldestPendingAgeMs !== null && queue.oldestPendingAgeMs > DISC_BACKLOG_DEGRADED_MS);
  const status = resolveSolanaStatus({
    hasCurrentCriticalEvidence,
    observedSlot,
    slotStatus,
    degradedBySignal,
    staleCriticalCount: programHealth.staleCriticalCount, // DOAR critice → escaladare
  });

  return {
    chain:           CHAIN,
    version:         nodeVersion,
    latestSlot,
    cursorSlot:      observedSlot,   // OBSERVED slot (alias istoric „cursor")
    behindSlots,
    status,
    updatedAt:       new Date().toISOString(),
    indexerVersion:  INDEXER_VERSION,
    // ── C6 ──
    processedSlot,
    lastProcessedAt: lastProcessedAt !== null ? new Date(lastProcessedAt).toISOString() : null,
    pendingCount:    queue.pending,
    processingCount: queue.processing,
    deadCount:       queue.dead,
    // ── D2: freshness per-program ──
    programHealth:             programHealth.perProgram,
    staleProgramCount:         programHealth.staleCount,          // TOATE stale (onest cu programHealth[])
    staleCriticalProgramCount: programHealth.staleCriticalCount,  // doar critice (ăsta a dat DEGRADED)
  };
}
