/**
 * infra/nativePriceState.ts — E25 (degradarea prețului nativ la null când e stale).
 *
 * Logică PURĂ de staleness, zero runtime imports → testabilă izolat în tsx.
 * `resolveNativePrice` întoarce prețul DOAR dacă e proaspăt ȘI valid; altfel `null`
 * (fail-closed). Respinge explicit:
 *   - value ne-finit sau ≤ 0 (preț inventat / corupt),
 *   - value / updatedAt lipsă (never-fetched),
 *   - updatedAt / now ne-finit,
 *   - maxAgeMs negativ sau ne-finit,
 *   - timestamp VIITOR / ceas sărit înapoi (`now - updatedAt < 0`) — un updatedAt din
 *     viitor NU trebuie să treacă drept „proaspăt".
 * Boundary: age == maxAgeMs este ÎNCĂ valid (inclusiv).
 */

export function resolveNativePrice(
  value:     number | null,
  updatedAt: number | null,
  now:       number,
  maxAgeMs:  number,
): number | null {
  if (value === null || updatedAt === null) return null;
  const ageMs = now - updatedAt;
  return (
    Number.isFinite(value) &&
    value > 0 &&
    Number.isFinite(updatedAt) &&
    Number.isFinite(now) &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    ageMs >= 0 &&
    ageMs <= maxAgeMs
  ) ? value : null;
}

/**
 * Freshness la SURSĂ (oracolul Chainlink), separat de TTL-ul local. `sourceUpdatedAtMs` este
 * `updatedAt` din `latestRoundData()` (ms). Un RPC poate răspunde în timp ce oracolul e înghețat
 * → answer „valid" dar `updatedAt` vechi; îl respingem aici. `maxSourceAgeMs` este prag PER-FEED
 * (nu uniform — fiecare feed are heartbeat-ul lui, ancorat la config-ul real al feedului). Respinge:
 * `updatedAt` ≤ 0 (round gol/necompletat), VIITOR peste `futureSkewMs` (ceas block vs local), sau
 * mai vechi decât `maxSourceAgeMs`. Orice input ne-finit / prag negativ → false (fail-closed).
 */
export function isOracleFresh(
  sourceUpdatedAtMs: number,
  nowMs:             number,
  maxSourceAgeMs:    number,
  futureSkewMs:      number,
): boolean {
  if (!Number.isFinite(sourceUpdatedAtMs) || sourceUpdatedAtMs <= 0) return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxSourceAgeMs) || maxSourceAgeMs < 0) return false;
  if (!Number.isFinite(futureSkewMs) || futureSkewMs < 0) return false;
  const age = nowMs - sourceUpdatedAtMs;
  if (age < -futureSkewMs) return false;     // timestamp din viitor (peste toleranța de skew)
  if (age > maxSourceAgeMs) return false;    // mai vechi decât pragul feedului
  return true;
}
