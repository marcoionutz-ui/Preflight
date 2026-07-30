/**
 * lib/mcp/freshness.ts — E11 + E12 + E13 (freshness honesty pentru path-urile EVM/Solana din reader & reports).
 *
 * Logică PURĂ (frunză, zero importuri) → testabilă izolat. Trei preocupări:
 *  - E13: `safeAgeSec` — vârstă în secunde ONESTĂ. Un timestamp SERIOS în viitor (> `futureToleranceMs`, clock
 *    skew real / dată coruptă) → `null` (necunoscut → LOW/OFFLINE), NU 0: altfel „30s în viitor" devenea „0s
 *    proaspăt" și primea VIP pass la HIGH/online/READY. Skew MIC (≤5s, NTP normal) → 0 (proaspăt). `ts` invalid → null.
 *    TOATE path-urile EVM ȘI Solana trec prin asta (reader + reports) — altfel repari EVM și Solana tot crede viitorul.
 *  - E11: `quotePriceCurrentAgeSec` — vârsta CURENTĂ a quote price-ului. Preferă `quotePriceCheckedAt` (absolut →
 *    îmbătrânește). Fallback pt. intrări LEGACY (fără checkedAt): `quotePriceAgeSec` frozen + timpul scurs de la
 *    `pricedAt` → tot îmbătrânește (nu rămâne la age-at-write, care ținea bugul E11 viu până la re-pricing).
 *  - E12: `pricePoolsWindowStart` — începutul ferestrei de activitate pt. ZSET-ul `price:pools` (reader `ZCOUNT
 *    windowStart +inf`, worker `ZREMRANGEBYSCORE -inf (windowStart`).
 */

/**
 * E13: vârstă (secunde) ONESTĂ, clampată la ≥0. `ts` null/non-finit → null. Timestamp > `futureToleranceMs` în
 * viitor → null (necunoscut, NU proaspăt). Skew mic (≤ tolerance) → 0.
 */
export function safeAgeSec(
  now:               number,
  tsMs:              number | null | undefined,
  futureToleranceMs = 5_000,
): number | null {
  if (tsMs === null || tsMs === undefined || !Number.isFinite(tsMs)) return null;
  const delta = now - tsMs;
  if (delta < -futureToleranceMs) return null; // serios în viitor → necunoscut (nu 0/„fresh")
  return Math.max(0, Math.round(delta / 1000));
}

/** E13: varianta în ms pentru câmpuri `ageMs` de afișare. Aceeași semantică (viitor serios → null). */
export function safeAgeMs(
  now:               number,
  tsMs:              number | null | undefined,
  futureToleranceMs = 5_000,
): number | null {
  if (tsMs === null || tsMs === undefined || !Number.isFinite(tsMs)) return null;
  const delta = now - tsMs;
  if (delta < -futureToleranceMs) return null;
  return Math.max(0, delta);
}

/**
 * E11: vârsta CURENTĂ a quote price-ului dintr-o intrare de registry.
 *   1. `quotePriceCheckedAt` PREZENT → e sursa autoritativă: corupt/non-finit → null; serios în viitor →
 *      `safeAgeSec` null. NU cădem NICIODATĂ pe legacy dacă checkedAt e prezent — altfel un checkedAt viitor
 *      cu `quotePriceAgeSec=0` (scris pt. skew) ar reintra pe ușa fallback-ului purtând „0s proaspăt" fals.
 *   2. LEGACY (checkedAt chiar ABSENT): `quotePriceAgeSec` frozen + timpul scurs de la `pricedAt` → tot
 *      îmbătrânește (o intrare veche de 1h cu frozen=5 raportează ~3605s, nu 5s). `pricedAt` corupt → null.
 *   3. nimic utilizabil → null.
 */
export function quotePriceCurrentAgeSec(
  entry: { quotePriceCheckedAt?: unknown; quotePriceAgeSec?: unknown; pricedAt?: unknown },
  now:   number,
): number | null {
  const checkedAtPresent = entry.quotePriceCheckedAt !== undefined && entry.quotePriceCheckedAt !== null;
  if (checkedAtPresent) {
    // Prezent dar corupt → null (necunoscut), NU fallback. Prezent + serios în viitor → safeAgeSec null.
    if (typeof entry.quotePriceCheckedAt !== "number" || !Number.isFinite(entry.quotePriceCheckedAt)) return null;
    return safeAgeSec(now, entry.quotePriceCheckedAt);
  }

  // Doar intrările care CHIAR nu au checkedAt sunt legacy.
  const frozen =
    typeof entry.quotePriceAgeSec === "number" && Number.isFinite(entry.quotePriceAgeSec)
      ? Math.max(0, entry.quotePriceAgeSec)
      : null;
  if (frozen === null) return null;

  const pricedAtPresent = entry.pricedAt !== undefined && entry.pricedAt !== null;
  if (!pricedAtPresent) return Math.round(frozen); // legacy fără pricedAt → best-effort frozen
  if (typeof entry.pricedAt !== "number" || !Number.isFinite(entry.pricedAt)) return null; // pricedAt corupt → null

  const elapsed = safeAgeSec(now, entry.pricedAt);
  return elapsed === null ? null : Math.round(frozen + elapsed);
}

/** E12: fereastra de activitate pentru `price:pools` (2h). Trebuie să coincidă cu pragul de prune din worker. */
export const PRICE_POOLS_WINDOW_MS = 2 * 60 * 60 * 1000;

/** E12: scorul minim (ms) pentru un pool considerat „activ" — folosit de reader la `ZCOUNT windowStart +inf`. */
export function pricePoolsWindowStart(now: number): number {
  return now - PRICE_POOLS_WINDOW_MS;
}
