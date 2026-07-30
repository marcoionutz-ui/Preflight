/**
 * lib/mcp/degraded.ts — E10 (bounded degradation când Redis e indisponibil).
 *
 * Politica E10 (design înghețat): NU fail-open nelimitat, NICI outage total la fiecare blip Redis. Când gate-ul
 * bazat pe Redis (rate-limit / quota) nu poate fi aplicat, cădem pe un limiter IN-PROCESS foarte conservator, pe
 * o fereastră scurtă; după ce fereastra expiră (outage continuu) → fail-closed (caller-ul refuză requestul —
 * HTTP 503 pentru auth/rate-limit; eroare MCP QUOTA_UNAVAILABLE pentru quota, care e per-tool în dispatch).
 *
 * Logică PURĂ (frunză, zero importuri) — deciderele iau `(prev, now, opts)` → `{decision, state}`, deci-s
 * deterministe și testabile izolat. Starea per-client trăiește în Map-uri in-process (per instanță — de-aia
 * cap-ul e mic ȘI fereastra expiră repede: nu-i o limită globală perfectă, e o plasă de siguranță mărginită).
 *
 * `now` e injectat în deciderele pure (testabile); wrapper-ele in-process folosesc `Date.now()`.
 */

export type DegradedDecision = "allow" | "unavailable";

// ── Constante (design E10) ──────────────────────────────────────────────────
// NB: „cap 5 rpm + burst 2" = rată de REFILL 5/min cu o capacitate de bucket de 2 (nu „maximum 5 în orice
// fereastră de 60s"): în cel mai rău caz, pe o fereastră degraded, un client poate lua burstul (2) + refillurile
// (~5) ≈ 7 requesturi, apoi fereastra expiră → fail-closed. Mărginit, per instanță.
export const EMERGENCY_RATE_CAP_PER_MIN = 5;      // rata de refill (tokens/min) cât timp Redis e jos
export const EMERGENCY_RATE_BURST        = 2;     // capacitatea bucket-ului (burst instant)
export const EMERGENCY_QUOTA_MAX_REQ     = 3;     // ≤3 requesturi/client/proces pe fereastra degraded
export const DEGRADED_WINDOW_MS          = 60_000; // outage continuu peste asta → fail-closed
const MAX_DEGRADED_ENTRIES               = 50_000; // plafon de memorie per Map (evită creșterea nemărginită)

// ── Rate limit degraded (token bucket + fereastră) ──────────────────────────
export interface DegradedRateState {
  since:      number; // când a intrat clientul în degraded (primul eșec Redis) — outage continuu
  tokens:     number; // token bucket (capacitate = burst)
  lastRefill: number;
}

export interface DegradedRateOpts {
  capPerMin: number; // rata de refill (tokens/min) — deja plafonată la EMERGENCY_RATE_CAP_PER_MIN de wrapper
  burst:     number; // capacitatea bucket-ului
  windowMs:  number; // durata maximă de degraded înainte de fail-closed
}

/**
 * Decizie pură de rate-limit degraded. `prev=null` = primul request degraded al clientului (bucket plin, fereastra
 * pornește acum). Outage > windowMs → `unavailable` (fail-closed). Altfel token bucket: refill `capPerMin/min`,
 * plafonat la `burst`; token disponibil → allow, altfel → unavailable (backpressure).
 */
export function degradedRateDecision(
  prev: DegradedRateState | null,
  now:  number,
  opts: DegradedRateOpts,
): { decision: DegradedDecision; state: DegradedRateState } {
  const since = prev?.since ?? now;

  // Outage mai lung decât fereastra degraded → nu mai servim pe plasa locală.
  if (now - since > opts.windowMs) {
    return { decision: "unavailable", state: { since, tokens: 0, lastRefill: now } };
  }

  const cap         = Math.max(1, opts.burst);
  const refillPerMs = Math.max(0, opts.capPerMin) / 60_000;
  const last        = prev?.lastRefill ?? now;
  const startTokens = prev ? prev.tokens : cap; // primul request degraded pornește cu bucket-ul plin
  const tokens      = Math.min(cap, startTokens + Math.max(0, now - last) * refillPerMs);

  if (tokens >= 1) {
    return { decision: "allow", state: { since, tokens: tokens - 1, lastRefill: now } };
  }
  return { decision: "unavailable", state: { since, tokens, lastRefill: now } };
}

// ── Quota degraded (buget mic + fereastră) ──────────────────────────────────
export interface DegradedQuotaState {
  since: number; // start-ul ferestrei degraded (outage continuu)
  count: number; // requesturi permise nereconciliate în fereastră
}

export interface DegradedQuotaOpts {
  maxReq:   number; // buget de requesturi nereconciliate pe fereastră
  windowMs: number;
}

/**
 * Decizie pură de quota degraded. Fără Redis nu putem enforce quota lunară → permitem un buget MIC (≤maxReq)
 * per client/proces pe o fereastră scurtă, apoi fail-closed. Cele ≤maxReq pot rămâne nereconciliate, dar pierderea
 * e STRICT mărginită (mult mai bine decât fail-open nelimitat sau outage total la un reconnect de 2s).
 */
export function degradedQuotaDecision(
  prev: DegradedQuotaState | null,
  now:  number,
  opts: DegradedQuotaOpts,
): { decision: DegradedDecision; state: DegradedQuotaState } {
  const since = prev?.since ?? now;
  if (now - since > opts.windowMs) {
    return { decision: "unavailable", state: { since, count: prev?.count ?? 0 } };
  }
  const count = prev?.count ?? 0;
  if (count < opts.maxReq) {
    return { decision: "allow", state: { since, count: count + 1 } };
  }
  return { decision: "unavailable", state: { since, count } };
}

// ── Wrapper-e in-process (stare per-client, per instanță) ────────────────────
const rateStates  = new Map<string, DegradedRateState>();
const quotaStates = new Map<string, DegradedQuotaState>();

/** Cap efectiv: plan nelimitat (rpm<0) sau peste 5 → plafonat la EMERGENCY_RATE_CAP_PER_MIN. */
function effectiveRateCap(configuredRpm: number): number {
  return configuredRpm < 0 ? EMERGENCY_RATE_CAP_PER_MIN : Math.min(configuredRpm, EMERGENCY_RATE_CAP_PER_MIN);
}

/** Plafon de memorie: la depășire, evacuează cele mai VECHI intrări (Map păstrează ordinea de inserare). */
function capMap<V>(m: Map<string, V>): void {
  while (m.size > MAX_DEGRADED_ENTRIES) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

export function emergencyRateAllow(clientId: string, configuredRpm: number, now: number = Date.now()): DegradedDecision {
  const { decision, state } = degradedRateDecision(rateStates.get(clientId) ?? null, now, {
    capPerMin: effectiveRateCap(configuredRpm),
    burst:     EMERGENCY_RATE_BURST,
    windowMs:  DEGRADED_WINDOW_MS,
  });
  rateStates.set(clientId, state);
  capMap(rateStates);
  return decision;
}

export function emergencyQuotaAllow(clientId: string, now: number = Date.now()): DegradedDecision {
  const { decision, state } = degradedQuotaDecision(quotaStates.get(clientId) ?? null, now, {
    maxReq:   EMERGENCY_QUOTA_MAX_REQ,
    windowMs: DEGRADED_WINDOW_MS,
  });
  quotaStates.set(clientId, state);
  capMap(quotaStates);
  return decision;
}

/** Redis a răspuns cu succes → clientul iese din degraded; starea locală se resetează (outage-ul s-a terminat). */
export function clearDegradedRate(clientId: string):  void { rateStates.delete(clientId); }
export function clearDegradedQuota(clientId: string): void { quotaStates.delete(clientId); }

/** Doar pentru teste — golește starea in-process între cazuri. */
export function __resetDegradedState(): void { rateStates.clear(); quotaStates.clear(); }
