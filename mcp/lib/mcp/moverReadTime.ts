/**
 * lib/mcp/moverReadTime.ts — E38 (offset read-time pe movers Solana).
 *
 * Frunză PURĂ (doar un `import type`, zero importuri runtime) → testabilă în tsx.
 *
 * Bug: fiecare mover poartă `currentAgeSec` (vârsta ultimului preț) și `historyStatus`, calculate de worker la
 * COMPUTE-TIME. Snapshot-ul de movers e servit până la `computedAgeSec` mai târziu (TTL 5m, recompute ~60s), dar
 * reader-ul (`readSolanaMovers`) le servea neschimbate → un mover „proaspăt acum 9 min la compute" apărea în
 * continuare cu `currentAgeSec` mic, iar `historyStatus` putea rămâne READY/PARTIAL deși prețul e de fapt vechi.
 *
 * Fix: adună offset-ul read-time (`computedAgeSec`) la `currentAgeSec` și re-derivă STALE dacă vârsta efectivă
 * trece pragul de 10m. Replică precedența din `moversTracker.getHistoryStatus` (STALE verificat PRIMUL → suprascrie
 * orice status non-STALE, inclusiv INSUFFICIENT). `UNKNOWN` (coercion defensiv de reader pt. date vechi/malformate)
 * e lăsat neatins — nu inventăm certitudine pe un record deja suspect.
 */
import type { PreflightSolanaHistoryStatus } from "@preflight/schema";

export type MoverReadTimeStatus = PreflightSolanaHistoryStatus | "UNKNOWN";

/** Pragul STALE din moversTracker.getHistoryStatus: ultimul sample mai vechi de 10m. */
export const MOVER_STALE_AGE_SEC = 10 * 60;

export function adjustMoverReadTime(
  computeAgeSec:  number,
  status:         MoverReadTimeStatus,
  computedAgeSec: number,
): { currentAgeSec: number; historyStatus: MoverReadTimeStatus } {
  const offset = Number.isFinite(computedAgeSec) && computedAgeSec > 0 ? computedAgeSec : 0;
  const base   = Number.isFinite(computeAgeSec)  && computeAgeSec  > 0 ? computeAgeSec  : 0;

  const currentAgeSec = Math.round(base + offset);
  const historyStatus: MoverReadTimeStatus =
    currentAgeSec > MOVER_STALE_AGE_SEC && status !== "UNKNOWN" ? "STALE" : status;

  return { currentAgeSec, historyStatus };
}
