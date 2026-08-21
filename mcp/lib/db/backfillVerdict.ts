/**
 * lib/db/backfillVerdict.ts — PH-2a (verdict PUR pentru inspectorul de backfill). Zero I/O → testabil în tsx.
 *
 * Inspectorul face I/O-ul (paginare cu count exact la SURSĂ ȘI la ȚINTĂ, orphan check pe auth.users, citirea
 * tabelelor țintă, faza pre/post-schema) și adună FAPTELE într-un `BackfillVerdictInput`. Funcția asta decide
 * CLEAN vs PROBLEME și, esențial (cgpt), `clean=false` TREBUIE să ducă la exit non-zero.
 *
 * Fail-closed peste tot: secțiuni lipsă / NaN / negative / fracționare NU se transformă tacit în zero — devin probleme.
 *
 * Un raport e CURAT doar dacă TOATE canalele sunt zero:
 *  - integritatea citirii SURSĂ (fetched == expected);
 *  - integritatea citirii ȚINTĂ (fetched == expected) când tabelele există (altfel drift fals-curat peste ~1000 rânduri);
 *  - faza schema: la `post-schema` AMBELE tabele țintă TREBUIE să existe;
 *  - zero user_id orfani (auth.users);
 *  - contoare valide + zero la conflicte/invalidRows (entitlement + registration);
 *  - zero drift în tabelele țintă.
 */

export type SchemaPhase = "pre-schema" | "post-schema" | "post-backfill";

export interface FetchIntegrity { expected: number; fetched: number; }

export interface BackfillVerdictInput {
  /** faza rulării + prezența tabelelor țintă (din head-check I/O) */
  schema:        { phase: SchemaPhase; entPresent: boolean; regPresent: boolean };
  /** count(*) exact pe sursă vs. rânduri chiar aduse prin paginare */
  fetch:         FetchIntegrity;
  /** integritatea paginării țintă — null dacă tabelul lipsește (pre-schema) */
  targetFetch:   { entitlements: FetchIntegrity | null; registrations: FetchIntegrity | null };
  /** user_id non-null din sursă care NU există în auth.users (FK-ul ar pica) */
  orphanUserIds: readonly string[];
  entitlement:   { conflicts: number; invalidRows: number };
  registration:  { invalidRows: number };
  /** rânduri deja în tabelele țintă care CONTRAZIC ce ar produce backfill-ul (drift la re-rulare/cutover) */
  targetDrift:   readonly { table: string; detail: string }[];
}

export interface BackfillVerdict {
  clean:    boolean;
  problems: string[];
}

function isNonNegInt(n: unknown): n is number { return typeof n === "number" && Number.isInteger(n) && n >= 0; }

/** Verifică integritatea unei perechi expected/fetched; întoarce mesajul de problemă sau null. */
function fetchProblem(label: string, f: FetchIntegrity | null | undefined): string | null {
  if (!f || !isNonNegInt(f.expected) || !isNonNegInt(f.fetched)) {
    return `integritate citire ${label} necunoscută (expected/fetched lipsă sau nu-s întregi >= 0) — fail-closed`;
  }
  if (f.expected !== f.fetched) {
    return `paginare ${label} incompletă: count(*)=${f.expected} dar am adus ${f.fetched} rânduri`;
  }
  return null;
}

/** Contor obligatoriu non-negativ întreg; secțiune lipsă/NaN/negativ/fracționar => problemă (nu zero implicit). */
function counterProblem(label: string, n: unknown): string | null {
  if (!isNonNegInt(n)) return `contor ${label} invalid (${JSON.stringify(n)}) — trebuie întreg >= 0, fail-closed`;
  if ((n as number) > 0) return `${n} ${label}`;
  return null;
}

export function evaluateBackfillVerdict(input: BackfillVerdictInput): BackfillVerdict {
  const problems: string[] = [];

  // ── faza schema ──
  const phase = input.schema?.phase;
  const validPhase = phase === "pre-schema" || phase === "post-schema" || phase === "post-backfill";
  const requiresTargets = phase === "post-schema" || phase === "post-backfill";
  if (!validPhase) {
    problems.push(`fază schema invalidă (${JSON.stringify(phase)}) — trebuie 'pre-schema' | 'post-schema' | 'post-backfill'`);
  } else if (requiresTargets) {
    if (!input.schema.entPresent) problems.push(`${phase} dar account_entitlements LIPSEȘTE (migrația nu s-a aplicat corect)`);
    if (!input.schema.regPresent) problems.push(`${phase} dar oauth_client_registrations LIPSEȘTE`);
  }

  // ── integritate citire sursă ──
  const src = fetchProblem("sursă", input.fetch);
  if (src) problems.push(src);

  // ── integritate citire țintă ──
  // Fail-closed (cgpt slice3 #3): dacă un tabel e declarat PREZENT, perechea din targetFetch e OBLIGATORIE.
  // present=false + null e legit (pre-schema); present=true + null/lipsă = problemă (nu „sărim” tăcut integritatea).
  if (input.schema?.entPresent) {
    const p = fetchProblem("țintă account_entitlements", input.targetFetch?.entitlements);
    if (p) problems.push(p);
  }
  if (input.schema?.regPresent) {
    const p = fetchProblem("țintă oauth_client_registrations", input.targetFetch?.registrations);
    if (p) problems.push(p);
  }

  // ── orphan user_id → FK auth.users ar pica ── (fail-closed: secțiune lipsă/ne-array = problemă)
  if (!Array.isArray(input.orphanUserIds)) {
    problems.push("orphanUserIds lipsește/nu e array — fail-closed (nu presupunem zero orfani)");
  } else if (input.orphanUserIds.length > 0) {
    const orphans = input.orphanUserIds;
    problems.push(`${orphans.length} user_id orfani (nu există în auth.users): ${orphans.slice(0, 5).join(", ")}${orphans.length > 5 ? " …" : ""}`);
  }

  // ── contoare (fail-closed) ──
  const ec = counterProblem("conflicte de entitlement (blochează userii)", input.entitlement?.conflicts);
  if (ec) problems.push(ec);
  const ei = counterProblem("rânduri invalide la entitlements", input.entitlement?.invalidRows);
  if (ei) problems.push(ei);
  const ri = counterProblem("rânduri invalide la registrations", input.registration?.invalidRows);
  if (ri) problems.push(ri);

  // ── drift în țintă ── (fail-closed: secțiune lipsă/ne-array = problemă)
  if (!Array.isArray(input.targetDrift)) {
    problems.push("targetDrift lipsește/nu e array — fail-closed (nu presupunem zero drift)");
  } else {
    for (const d of input.targetDrift) problems.push(`drift în ${d.table}: ${d.detail}`);
  }

  return { clean: problems.length === 0, problems };
}
