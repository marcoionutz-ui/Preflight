/**
 * scripts/beta1/harness/caseProtocol.ts — BETA-1, felia 2: protocolul dintre un proces de caz și supraveghetor.
 *
 * Un proces de caz scrie pe stdout EXACT O LINIE JSON (`CaseResult`) și iese natural cu cod 0. Orice altceva —
 * rezultat lipsă, dublu, invalid, cod ≠ 0, semnal, termen depășit — e `HARNESS_ERROR`, decis de supraveghetor.
 *
 * Enum ÎNCHIS. Rezultatul trebuie să fie COERENT cu ce a declarat manifestul pentru acel caz: un control nu poate
 * raporta `DEFECT_REPRODUCED`, un caz nu se poate muta singur în altă secțiune a raportului.
 *
 * Pur: fără I/O, fără procese. NU importă nimic din `src/`.
 */

export const CASE_RESULT_SCHEMA = "beta1-case/1";

export const OUTCOMES = [
  "CONTROL_OK", "CONTROL_FAILED",
  "DEFECT_REPRODUCED", "DEFECT_NOT_REPRODUCED",
  "PARTIAL_OBSERVED", "PARTIAL_NOT_OBSERVED",
  "HARNESS_ERROR",
] as const;
export type Outcome = typeof OUTCOMES[number];

/** Ce fel de afirmație face cazul. */
export type CaseKind = "control" | "defect" | "partial";
/**
 * Secțiunea de raport — cele trei NU se amestecă:
 *   filter  = logurile trec prin filtrul nodului local;
 *   forced  = livrare forțată (ocolește filtrul): nu dovedește nimic despre filtru sau despre un nod real;
 *   partial = observație parțială, fără nod/subscriere (ex. X1): nu e dovadă cap-coadă.
 */
export type CaseSection = "filter" | "forced" | "partial";

export interface CaseSpec {
  id:      string;
  kind:    CaseKind;
  section: CaseSection;
}

export interface CaseResult {
  schema:  typeof CASE_RESULT_SCHEMA;
  caseId:  string;
  kind:    CaseKind;
  section: CaseSection;
  outcome: Outcome;
  /** Motive lizibile (obligatoriu nevid pentru orice rezultat care nu confirmă predicția). */
  reasons: string[];
  /** Observații brute, separate: filtrul cerut / loguri trimise / primite / înregistrate etc. */
  observations: Record<string, unknown>;
}

const ALLOWED_BY_KIND: Record<CaseKind, readonly Outcome[]> = {
  control: ["CONTROL_OK", "CONTROL_FAILED", "HARNESS_ERROR"],
  defect:  ["DEFECT_REPRODUCED", "DEFECT_NOT_REPRODUCED", "HARNESS_ERROR"],
  partial: ["PARTIAL_OBSERVED", "PARTIAL_NOT_OBSERVED", "HARNESS_ERROR"],
};

/** Rezultatele care confirmă predicția cazului (singurele compatibile cu codul de ieșire 0). */
export const CONFIRMING: readonly Outcome[] = ["CONTROL_OK", "DEFECT_REPRODUCED", "PARTIAL_OBSERVED"];

const CASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `null` dacă specificația e coerentă; altfel motivul. Secțiunea `partial` ⇔ felul `partial`; un control stă doar în `filter`. */
export function specProblem(spec: CaseSpec): string | null {
  if (!CASE_ID_RE.test(spec.id)) return `id de caz invalid: ${JSON.stringify(spec.id)}`;
  if ((spec.kind === "partial") !== (spec.section === "partial")) return `${spec.id}: felul „partial" și secțiunea „partial" merg doar împreună`;
  if (spec.kind === "control" && spec.section !== "filter") return `${spec.id}: un control pozitiv stă doar în secțiunea „filter"`;
  return null;
}

export type Validation =
  | { ok: true; result: CaseResult }
  | { ok: false; problem: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validează STRICT stdout-ul unui proces de caz față de specificația din manifest. Acceptă exact o linie nevidă,
 * JSON obiect, cu exact câmpurile protocolului și valori din enum, coerente cu `expected`.
 */
export function validateCaseOutput(stdout: string, expected: CaseSpec): Validation {
  const lines = stdout.split("\n").filter(l => l.trim() !== "");
  if (lines.length === 0) return { ok: false, problem: "rezultat lipsă (stdout gol)" };
  if (lines.length > 1)  return { ok: false, problem: `rezultat neunic (${lines.length} linii pe stdout)` };

  let raw: unknown;
  try { raw = JSON.parse(lines[0]); }
  catch { return { ok: false, problem: "rezultat invalid (nu e JSON)" }; }
  if (!isPlainObject(raw)) return { ok: false, problem: "rezultat invalid (nu e obiect)" };

  const KEYS = ["schema", "caseId", "kind", "section", "outcome", "reasons", "observations"];
  const extra = Object.keys(raw).filter(k => !KEYS.includes(k));
  const missing = KEYS.filter(k => !(k in raw));
  if (missing.length) return { ok: false, problem: `rezultat invalid (lipsesc: ${missing.join(", ")})` };
  if (extra.length)   return { ok: false, problem: `rezultat invalid (câmpuri necunoscute: ${extra.slice(0, 5).join(", ")})` };

  if (raw.schema !== CASE_RESULT_SCHEMA) return { ok: false, problem: "rezultat invalid (schema)" };
  if (raw.caseId !== expected.id)        return { ok: false, problem: "rezultatul aparține altui caz" };
  if (raw.kind !== expected.kind)        return { ok: false, problem: `felul raportat diferă de manifest (${expected.kind})` };
  if (raw.section !== expected.section)  return { ok: false, problem: `secțiunea raportată diferă de manifest (${expected.section})` };
  if (typeof raw.outcome !== "string" || !(OUTCOMES as readonly string[]).includes(raw.outcome)) {
    return { ok: false, problem: "rezultat în afara enumului" };
  }
  const outcome = raw.outcome as Outcome;
  if (!ALLOWED_BY_KIND[expected.kind].includes(outcome)) {
    return { ok: false, problem: `rezultatul ${outcome} nu e permis pentru un caz „${expected.kind}"` };
  }
  if (!Array.isArray(raw.reasons) || !raw.reasons.every(r => typeof r === "string")) {
    return { ok: false, problem: "rezultat invalid (reasons)" };
  }
  if (!CONFIRMING.includes(outcome) && raw.reasons.length === 0) {
    return { ok: false, problem: "rezultat neconfirmator fără niciun motiv" };
  }
  if (!isPlainObject(raw.observations)) return { ok: false, problem: "rezultat invalid (observations)" };

  return {
    ok: true,
    result: {
      schema: CASE_RESULT_SCHEMA, caseId: expected.id, kind: expected.kind, section: expected.section,
      outcome, reasons: raw.reasons as string[], observations: raw.observations,
    },
  };
}

/** Linia unică pe care o scrie un proces de caz. */
export function serializeCaseResult(r: CaseResult): string {
  return JSON.stringify(r) + "\n";
}

// ── Agregare ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Verdictul supraveghetorului pentru un caz: rezultatul lui, sau de ce nu a rulat. */
export interface CaseVerdict {
  spec:     CaseSpec;
  /** `false` = nerulat, fiindcă nu toate controalele pozitive au trecut. */
  ran:      boolean;
  /** `null` doar când `ran` e `false`. */
  outcome:  Outcome | null;
  reasons:  string[];
  /** Observațiile brute raportate de caz și validate. GOALE pentru orice HARNESS_ERROR, oricine l-a decis. */
  observations: Record<string, unknown>;
  /** Ce a văzut supraveghetorul la procesul de caz; `null` dacă nu a pornit niciun proces. */
  diagnostics:  CaseDiagnostics | null;
}

export interface CaseDiagnostics {
  pid:      number | null;
  ms:       number;
  code:     number | null;
  signal:   string | null;
  timedOut: boolean;
  overflow: boolean;
  /** Procese rămase în grupul cazului după ieșirea lui (oprite forțat). */
  leftover: boolean;
  /** `false` = NU s-a putut confirma că procesul și grupul lui nu mai au procese vii. */
  terminationConfirmed: boolean;
}

export const EXIT = { confirmed: 0, contradicted: 2, invalid: 3 } as const;

export interface SuiteSummary {
  exitCode: 0 | 2 | 3;
  /** De ce rularea e invalidă (cod 3), dacă e. */
  invalid:  string[];
  counts:   Record<CaseSection, Partial<Record<Outcome | "NOT_RUN", number>>>;
}

/**
 * Codul de ieșire al unei rulări:
 *   3 — rularea nu dovedește nimic: niciun caz; niciun control pozitiv; vreun `CONTROL_FAILED`; vreun
 *       `HARNESS_ERROR`; vreun caz nerulat;
 *   2 — controale în regulă, dar cel puțin o predicție contrazisă (`DEFECT_NOT_REPRODUCED`/`PARTIAL_NOT_OBSERVED`);
 *   0 — experiment valid și toate predicțiile confirmate. NU înseamnă produs sănătos.
 */
export function summarize(verdicts: CaseVerdict[]): SuiteSummary {
  const counts: SuiteSummary["counts"] = { filter: {}, forced: {}, partial: {} };
  const invalid: string[] = [];
  let contradicted = false;

  for (const v of verdicts) {
    const key = v.ran && v.outcome !== null ? v.outcome : "NOT_RUN";
    counts[v.spec.section][key] = (counts[v.spec.section][key] ?? 0) + 1;
    if (!v.ran || v.outcome === null) { invalid.push(`${v.spec.id}: nerulat`); continue; }
    if (v.outcome === "HARNESS_ERROR")  invalid.push(`${v.spec.id}: HARNESS_ERROR`);
    if (v.outcome === "CONTROL_FAILED") invalid.push(`${v.spec.id}: CONTROL_FAILED`);
    if (v.outcome === "DEFECT_NOT_REPRODUCED" || v.outcome === "PARTIAL_NOT_OBSERVED") contradicted = true;
  }
  if (verdicts.length === 0) invalid.push("niciun caz");
  if (!verdicts.some(v => v.spec.kind === "control")) invalid.push("niciun control pozitiv în rulare");

  const exitCode = invalid.length > 0 ? EXIT.invalid : contradicted ? EXIT.contradicted : EXIT.confirmed;
  return { exitCode, invalid, counts };
}
