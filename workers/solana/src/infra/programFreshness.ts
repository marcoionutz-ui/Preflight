/**
 * infra/programFreshness.ts — D2: freshness per-program (per-subscripție WS) pentru health onest.
 *
 * BUG-ul reparat: health-ul Solana raporta liveness dintr-un SINGUR `observedSlot` = cel mai mare slot
 * cu log WS văzut, agregat peste TOATE cele 4 programe de discovery (raydium_amm_v4/clmm/cpmm/pumpfun).
 * Dacă subscripția UNUI singur program moare tăcut (onLogs cade, RPC nu mai rutează), celelalte 3 tot
 * avansează `observedSlot` → `behindSlots` ≈ 0 → status „OK" — dar discovery-ul programului mort e ZERO
 * (ex. pump.fun nu mai detectează niciun launch). `behindSlots` prinde moartea TOTALĂ a WS, niciodată una
 * PARȚIALĂ. Exact tema Fazei D: pare viu, e mort pe o ramură.
 *
 * Fix: urmărim ultimul log per PROGRAM. Dacă un program n-a mai livrat niciun log în fereastra așteptată
 * (programe de mare volum pe mainnet → un gol lung = subscripție căzută, nu liniște), escaladăm health la
 * cel puțin DEGRADED și raportăm CARE program e stale. Starea e in-memory (liveness pur; la restart pornim
 * curat, cu o perioadă de grație). Decizia de staleness e PURĂ → testabilă izolat (fără RPC/Redis/timp real).
 */

export interface ProgramFreshnessState {
  lastLogAt: number; // ms epoch al ultimului log primit pt. program
  lastSlot:  number; // cel mai mare slot văzut pt. program
}

// ── Tracker in-memory (singleton de proces; NU persistă — liveness, nu istorie) ──
const freshness = new Map<string, ProgramFreshnessState>();

/** Înregistrează un log primit de la `program` la slotul `slot`, la momentul `nowMs`. */
export function recordProgramLog(program: string, slot: number, nowMs: number): void {
  const prev = freshness.get(program);
  freshness.set(program, {
    lastLogAt: nowMs,
    lastSlot:  prev && prev.lastSlot > slot ? prev.lastSlot : slot, // slot monoton per program
  });
}

/** Snapshot IMUABIL al stării curente (pt. health loop / teste) — clonează și obiectele-value,
 *  nu doar Map-ul, ca o mutare ulterioară a tracker-ului să nu se scurgă în snapshot. */
export function snapshotProgramFreshness(): Map<string, ProgramFreshnessState> {
  return new Map([...freshness.entries()].map(([program, state]) => [program, { ...state }]));
}

/** Reset (teste). */
export function resetProgramFreshness(): void {
  freshness.clear();
}

export interface ProgramHealthEntry {
  program:      string;
  critical:     boolean;       // dacă staleness-ul lui poate degrada statusul (vs. doar diagnostic)
  lastLogAgeMs: number | null; // null = program niciodată văzut de la pornire
  lastSlot:     number | null;
  stale:        boolean;
}

export interface ProgramHealthResult {
  perProgram: ProgramHealthEntry[];
  /** TOATE programele stale (inclusiv diagnostic-only) — onest cu `perProgram`. NU degradează statusul singur. */
  staleCount: number;
  /** DOAR programele CRITICE stale — ăsta escaladează statusul. (`staleCount` fără el ar minți payload-ul.) */
  staleCriticalCount: number;
}

/** Programul așteptat + dacă e health-critical (are pipeline de procesare, nu doar observed-slot). */
export interface ExpectedProgram {
  program:  string;
  critical: boolean;
}

export interface ProgramHealthOpts {
  now:       number; // ms epoch curent
  startedAt: number; // ms epoch la pornirea procesului
  staleMs:   number; // gol max fără log pt. un program DEJA văzut înainte de a-l marca stale
  graceMs:   number; // grație de pornire: un program niciodată văzut nu-i stale până nu trece atât
}

/**
 * Decide, PUR, ce programe sunt stale + un rezumat per-program. Reguli:
 *   - program văzut înainte → stale dacă `now - lastLogAt > staleMs`;
 *   - program NICIODATĂ văzut → stale doar dacă a trecut grația de pornire (`now - startedAt > graceMs`),
 *     altfel încă are voie să tacă (subscripția abia s-a conectat).
 * `expectedPrograms` = programele la care ne-am abonat + flag `critical` (un program absent din tracker
 * e tot raportat, nu ignorat tăcut). Întoarce DOUĂ contoare: `staleCount` = toate stale (onest cu
 * `perProgram`), `staleCriticalCount` = doar critice stale (ăsta escaladează statusul). Un program
 * non-critic (ex. raydium_amm_v4, fără pipeline de procesare, doar observed slot) apare stale în
 * diagnostic dar NU degradează statusul.
 */
export function computeProgramHealth(
  freshnessSnapshot: ReadonlyMap<string, ProgramFreshnessState>,
  expectedPrograms: readonly ExpectedProgram[],
  opts: ProgramHealthOpts,
): ProgramHealthResult {
  const perProgram: ProgramHealthEntry[] = expectedPrograms.map(({ program, critical }) => {
    const st = freshnessSnapshot.get(program);
    if (!st) {
      return { program, critical, lastLogAgeMs: null, lastSlot: null, stale: opts.now - opts.startedAt > opts.graceMs };
    }
    const ageMs = opts.now - st.lastLogAt;
    return { program, critical, lastLogAgeMs: ageMs, lastSlot: st.lastSlot, stale: ageMs > opts.staleMs };
  });
  const stalePrograms = perProgram.filter((p) => p.stale);
  return {
    perProgram,
    staleCount:         stalePrograms.length,
    staleCriticalCount: stalePrograms.filter((p) => p.critical).length,
  };
}

// ── Escaladare de status (PURĂ) — folosită de health.ts::buildHealth ────────────
export type SolanaLivenessStatus = "OK" | "DEGRADED" | "BEHIND" | "STARTING";

/**
 * Statusul final: un semnal de integritate (dead-letter/backlog din C6 — `degradedBySignal`) SAU un
 * program CRITIC stale (D2 — `staleCriticalCount > 0`) escaladează un status altfel OK/STARTING la
 * DEGRADED. NU coboară un status deja mai rău (BEHIND rămâne BEHIND — liveness-ul de slot e mai grav).
 */
export function resolveDegradedStatus(
  base: SolanaLivenessStatus,
  opts: { degradedBySignal: boolean; staleCriticalCount: number },
): SolanaLivenessStatus {
  if ((opts.degradedBySignal || opts.staleCriticalCount > 0) && (base === "OK" || base === "STARTING")) {
    return "DEGRADED";
  }
  return base;
}

/**
 * `true` dacă TOATE programele critice au livrat cel puțin un log în procesul CURENT (`lastLogAgeMs`
 * ne-null). Distinge „subscripțiile actuale respiră" de „am doar un cursor persistent din procesul vechi".
 * Un program care a livrat înainte și acum e stale are tot `lastLogAgeMs` ne-null (dovadă veche dar reală).
 */
export function hasCriticalEvidence(perProgram: readonly ProgramHealthEntry[]): boolean {
  return perProgram.filter((p) => p.critical).every((p) => p.lastLogAgeMs !== null);
}

/**
 * Statusul Solana complet (PUR): dacă subscripțiile procesului CURENT n-au dovedit încă viață
 * (`!hasCurrentCriticalEvidence`) SAU n-avem observed slot, statusul de bază e STARTING — NU ne bazăm
 * pe `observedSlot` persistent (din procesul mort) ca dovadă a socketului actual (edge de restart).
 * Altfel = statusul de slot (`slotStatus` = resolveStatus(behindSlots)). Apoi aplicăm escaladarea
 * DEGRADED (dead-letter/backlog sau program critic stale). Cursorul persistent rămâne pt. observabilitate,
 * doar nu e considerat dovadă de liveness curent.
 */
export function resolveSolanaStatus(input: {
  hasCurrentCriticalEvidence: boolean;
  observedSlot:               number | null;
  slotStatus:                 SolanaLivenessStatus; // resolveStatus(behindSlots), calculat de caller
  degradedBySignal:           boolean;
  staleCriticalCount:         number;
}): SolanaLivenessStatus {
  const base: SolanaLivenessStatus =
    (!input.hasCurrentCriticalEvidence || input.observedSlot === null) ? "STARTING" : input.slotStatus;
  return resolveDegradedStatus(base, { degradedBySignal: input.degradedBySignal, staleCriticalCount: input.staleCriticalCount });
}
