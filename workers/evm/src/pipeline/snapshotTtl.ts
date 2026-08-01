/**
 * pipeline/snapshotTtl.ts — E24 (TTL snapshot ≥ 2× intervalul de scan).
 *
 * Frunză PURĂ (zero importuri) → testabilă în tsx.
 *
 * Bug: snapshot-urile per-chain (pair_states/active_watch/hot/armed + worker runtime heartbeat) se rescriu la
 * FIECARE scan cu `EX 120`. În DEV `scanIntervalMs = 120_000` (120s) → TTL == interval → cheia expiră EXACT când
 * scan-ul următor ar rescrie-o; orice întârziere minimă a scan-ului → cheia dispare o clipă → MCP raportează
 * chain-ul mort (flap fals).
 *
 * Fix: TTL ≥ 2× intervalul de scan. Păstrăm un floor de 120s (comportamentul sănătos al modurilor rapide) și
 * bumpăm doar când 2× interval îl depășește: DEV(120s)→240; BURST(60s)→120; LIVE(30s)/PAID(15s)→120. Toate ≥2×.
 * `scanIntervalMs` invalid/non-finit → cade pe floor-ul de 120 (nu produce NaN).
 */
export function snapshotTtlSec(scanIntervalMs: number): number {
  const twiceIntervalSec =
    Number.isFinite(scanIntervalMs) && scanIntervalMs > 0
      ? Math.ceil(scanIntervalMs / 1000) * 2
      : 0;
  return Math.max(120, twiceIntervalSec);
}
