/**
 * lib/mcp/canaryRedisRetry.ts — PH-12 12.5b-4b (retry BOUNDED al cleanup-ului Redis pe același ledger, PUR).
 *
 * Orchestrator de retry PUR peste un `runOnce` injectat (o rulare de `runCanaryRedisCleanup`). Extras din runner ca să
 * fie testabil hermetic + comis (nu logică netestată în `.mjs`). Politica (lock cgpt 4b):
 *   - TRANZITORII (o rulare `!ok` NON-structurală: `unavailable` / `proofUnavailable` / `stillPresent` — Redis a hopțăit
 *     sau dovada n-a putut confirma) → se REÎNCEARCĂ, până la `maxAttempts`, pe ACELAȘI ledger (care păstrează
 *     `resolvedFamilyIds` → familia se prinde la retry chiar dacă tokenurile-s deja șterse).
 *   - STRUCTURALE (`corrupt_payload` / `unexpected_payload` / `invariantBroken`) → oprire IMEDIATĂ, definitiv roșu, FĂRĂ retry.
 *   - O eroare structurală văzută la ORICE încercare face rezultatul final roșu — un run verde ulterior NU o poate masca.
 */

import type { RedisCleanupReport } from "./canaryRedisCleanup";

/** O rulare de cleanup a eșuat STRUCTURAL (nereparabil prin retry)? */
export function isStructuralCleanupFailure(report: RedisCleanupReport): boolean {
  return report.invariantBroken
    || report.errors.some((e) => e.code === "corrupt_payload" || e.code === "unexpected_payload");
}

export interface BoundedRetryResult {
  ok:            boolean;             // verde DOAR dacă ultima rulare e ok ȘI nicio încercare n-a fost structurală
  sawStructural: boolean;            // s-a văzut o eroare structurală la vreo încercare (sticky)
  attempts:      number;             // câte rulări s-au făcut efectiv (≤ maxAttempts)
  report:        RedisCleanupReport; // raportul ultimei rulări
}

/**
 * Rulează `runOnce` până la succes, o eroare STRUCTURALĂ, sau `maxAttempts`. `onRetry` (opțional) e chemat între
 * încercări (log/backoff). Nu aruncă (presupune că `runOnce` nu aruncă — `runCanaryRedisCleanup` e best-effort).
 */
export async function runCleanupWithBoundedRetry(
  runOnce: () => Promise<RedisCleanupReport>,
  opts?: { maxAttempts?: number; onRetry?: (attempt: number, report: RedisCleanupReport) => void | Promise<void> },
): Promise<BoundedRetryResult> {
  // Fix cgpt (P2): un `maxAttempts` non-finit rupe garanția de bounded — `Infinity` ar bucla la nesfârșit, `NaN` ar sări
  // complet bucla (`i <= NaN` e mereu false) → `report` nedefinit. Cerem un ÎNTREG FINIT ≥ 1; orice altceva → default 3.
  const requested = opts?.maxAttempts ?? 3;
  const maxAttempts = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 3;
  let report!: RedisCleanupReport;
  let sawStructural = false;
  let attempts = 0;
  for (let i = 1; i <= maxAttempts; i++) {
    attempts = i;
    report = await runOnce();
    if (isStructuralCleanupFailure(report)) sawStructural = true;
    if (report.ok || sawStructural) break;         // verde SAU structural (definitiv roșu) → oprire
    if (i < maxAttempts) await opts?.onRetry?.(i, report);
  }
  return { ok: report.ok && !sawStructural, sawStructural, attempts, report };
}
