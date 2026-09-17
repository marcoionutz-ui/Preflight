/**
 * lib/mcp/releaseGateReport.ts — PH-12 12.5d-1 (raport structurat + verdict al gate-ului de release).
 *
 * Formalizează dovada compusă din 12.5c-4 într-un ARTEFACT de gate reutilizabil: runner-ul `.mjs` produce cei 6 booleeni
 * ai lanțului (`ReleaseParts`), iar acest modul PUR îi transformă într-un raport structurat (rând per etapă + verdict),
 * îl randează în TEXT uman ȘI JSON machine-readable, și dă un cod de ieșire ONEST. Zero I/O, tsx-testabil.
 *
 * ⭐ VERDICTUL rămâne al lui `composeReleaseVerdict` (sursă UNICĂ a deciziei ok / etapă-vinovată). Acest modul NU
 *   re-implementează short-circuit-ul NICĂIERI. Decizia și prezentarea nu pot diverge.
 *
 * ⭐ ANTI-LEAK PRIN STRUCTURĂ: raportul (`ReleaseReport`) și rândurile lui (`StageRow`) poartă DOAR enums (`ReleaseStage`)
 *   și booleeni — ZERO câmp de text liber. Tot textul uman e DERIVAT la render din hărți STATICE ÎNGHEȚATE keyed pe enum.
 *
 * ⭐ FAIL-CLOSED (NU doar type-safe) LA FRONTIERA `.mjs` (fix cgpt): TypeScript nu protejează rendererul de un apelant
 *   untyped. De aceea `canonicalizeReport` NU are încredere în `ok`/`blamedStage`/etichetele venite din raport:
 *   - reconstruiește `ReleaseParts` din `stages` (care trebuie să fie EXACT cele 6 canonice în ordine) și RE-DERIVĂ
 *     verdictul prin `buildReleaseReport`→`composeReleaseVerdict` → un raport INCONSISTENT (ex. `ok:true` cu o etapă roșie)
 *     NU poate primi `exit 0`; un `blamedStage`/`id` = string arbitrar (token) → raport nestructural → `malformed` static;
 *   - hărțile statice sunt ÎNGHEȚATE (`Object.freeze`) → un consumator nu le poate muta ca să otrăvească render-ul.
 *
 * ⭐ ARTEFACT versionat + validat fail-closed: `ReleaseReportJson` poartă `version`; `parseReleaseReportJson` cere
 *   `version === RELEASE_REPORT_VERSION`, reconstruiește canonicul și acceptă DOAR identic (reason falsificat → `null`).
 */
import { composeReleaseVerdict, type ReleaseParts, type ReleaseStage } from "./releaseGateCompose";

/** Versiunea schemei artefactului JSON (discriminator; bump la orice schimbare de formă). */
export const RELEASE_REPORT_VERSION = 1 as const;

// Etichete SCURTE, STATICE, ÎNGHEȚATE, per etapă (derivate la render; NU stocate în raport). Cheile = etapele din compose.
export const RELEASE_STAGE_LABEL: Readonly<Record<ReleaseStage, string>> = Object.freeze({
  gate1:            "Gate 1 — login→consent→token→MCP→refresh→mcp_rotated",
  at2_capture:      "AT2 — token rotit capturat dintr-un refresh valid",
  gate2:            "Gate 2 — worker Base + strict health + date reale + WS subs",
  worker_cleanup:   "Worker backstop — niciun grup orfan rămas în registru",
  redis_cleanup:    "Cleanup Redis — țintit + dovadă de absență",
  supabase_cleanup: "Cleanup Supabase — fixture curățat",
});

// Ordinea canonică de diagnostic (egală cu `composeReleaseVerdict`). Înghețată; declarată explicit (nu din Object.keys).
const STAGE_ORDER: readonly ReleaseStage[] = Object.freeze([
  "gate1", "at2_capture", "gate2", "worker_cleanup", "redis_cleanup", "supabase_cleanup",
] as const);
const STAGE_SET: ReadonlySet<string> = new Set<string>(STAGE_ORDER);

// Cheile așteptate în intrarea brută (numele câmpurilor din `ReleaseParts`), pentru parse fail-closed.
const PARTS_KEYS: readonly (keyof ReleaseParts)[] = Object.freeze([
  "gate1Ok", "at2Captured", "gate2Ok", "workerBackstopOk", "redisCleanupOk", "supabaseCleanupOk",
] as const);

// Texte STATICE de verdict (singura sursă de reason uman; niciodată un string venit din afară).
const GREEN_NOTE       = "release chain VERDE end-to-end (Gate 1 → AT2 → Gate 2 → worker → Redis → Supabase)";
const MALFORMED_REASON = "parts de release malformate / raport nestructural sau inconsistent — fail-closed ROȘU";

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}
function isReleaseStage(x: unknown): x is ReleaseStage {
  return typeof x === "string" && STAGE_SET.has(x);
}

// Rând per etapă — DOAR enum + boolean (ZERO text liber; eticheta se derivă la render).
export interface StageRow {
  id: ReleaseStage;
  ok: boolean;
}

// Raport PUR STRUCTURAT — DOAR enums + booleeni, ZERO text liber (anti-leak prin structură).
export type ReleaseReport =
  | { kind: "malformed"; ok: false }
  | { kind: "verdict"; ok: boolean; blamedStage: ReleaseStage | null; stages: StageRow[] };

const MALFORMED_REPORT: ReleaseReport = Object.freeze({ kind: "malformed", ok: false });

// Cheile EXACTE ale unui raport `verdict` (pentru poarta accept-only-if-identical din canonicalizeReport).
const VERDICT_REPORT_KEYS: readonly string[] = Object.freeze(["kind", "ok", "blamedStage", "stages"]);

/**
 * Parsează intrarea BRUTĂ (de la runner-ul `.mjs` untyped) în `ReleaseParts`, fail-closed: obiect simplu (nu array/null),
 * EXACT cele 6 chei așteptate, fiecare STRICT `boolean`, fără chei în plus. Orice abatere → `null`.
 */
export function parseReleaseParts(raw: unknown): ReleaseParts | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).length !== PARTS_KEYS.length) return null;   // chei în plus/lipsă → fail-closed
  for (const k of PARTS_KEYS) {
    if (!hasOwn(obj, k)) return null;
    if (typeof obj[k] !== "boolean") return null;                   // non-boolean (inclusiv undefined) → fail-closed
  }
  return {
    gate1Ok:           obj.gate1Ok as boolean,
    at2Captured:       obj.at2Captured as boolean,
    gate2Ok:           obj.gate2Ok as boolean,
    workerBackstopOk:  obj.workerBackstopOk as boolean,
    redisCleanupOk:    obj.redisCleanupOk as boolean,
    supabaseCleanupOk: obj.supabaseCleanupOk as boolean,
  };
}

/**
 * Construiește raportul structurat din `ReleaseParts` VALIDE. Decizia (ok + etapa vinovată) vine DIN
 * `composeReleaseVerdict` (sursă unică). Rândurile pe etape reflectă boolean-ul FIECĂREI etape (prezentare, nu decizie) —
 * un reader vede TOATE etapele roșii, iar `blamedStage` e prima în ordinea de diagnostic.
 */
export function buildReleaseReport(parts: ReleaseParts): ReleaseReport {
  const verdict = composeReleaseVerdict(parts);
  const stageOk: Record<ReleaseStage, boolean> = {
    gate1:            parts.gate1Ok === true,
    at2_capture:      parts.at2Captured === true,
    gate2:            parts.gate2Ok === true,
    worker_cleanup:   parts.workerBackstopOk === true,
    redis_cleanup:    parts.redisCleanupOk === true,
    supabase_cleanup: parts.supabaseCleanupOk === true,
  };
  const stages: StageRow[] = STAGE_ORDER.map((id) => ({ id, ok: stageOk[id] }));
  return verdict.ok
    ? { kind: "verdict", ok: true, blamedStage: null, stages }
    : { kind: "verdict", ok: false, blamedStage: verdict.stage, stages };
}

/** Comodă: raw (untyped) → raport. `parse` pică → raport `malformed` ROȘU (nu presupune nimic). */
export function buildReleaseReportFromRaw(raw: unknown): ReleaseReport {
  const parts = parseReleaseParts(raw);
  return parts === null ? MALFORMED_REPORT : buildReleaseReport(parts);
}

/**
 * Poartă RUNTIME de canonicalizare la frontiera de render (fix cgpt: fail-closed, nu doar type-safe). `stages` (care TREBUIE
 * să fie EXACT cele 6 canonice, în ordine, cu `id` stage valid + `ok` boolean) DETERMINĂ canonicul, prin
 * `buildReleaseReport` (deci `composeReleaseVerdict` — sursă unică). Inputul e ACCEPTAT DOAR dacă `ok`/`blamedStage` sunt
 * IDENTICE cu canonicul derivat din stages. Un raport CONTRADICTORIU (`ok:true` cu o etapă roșie, `ok:false` cu toate verzi,
 * `blamedStage` greșit ori token) NU e normalizat tăcut — → `MALFORMED_REPORT` (RESPINS). Nestructural (forme străine,
 * `id` invalid) → la fel. Un raport verde/roșu CONSISTENT trece prin nealterat.
 */
function canonicalizeReport(report: ReleaseReport): ReleaseReport {
  const o = report as unknown;
  if (typeof o !== "object" || o === null || Array.isArray(o)) return MALFORMED_REPORT;
  const ro = o as Record<string, unknown>;
  if (ro.kind === "malformed") return MALFORMED_REPORT;
  if (ro.kind !== "verdict") return MALFORMED_REPORT;
  // chei EXACTE pe raportul verdict (accept-only-if-identical: fără câmp străin care ar purta un secret).
  if (Object.keys(ro).length !== VERDICT_REPORT_KEYS.length) return MALFORMED_REPORT;
  for (const k of VERDICT_REPORT_KEYS) if (!hasOwn(ro, k)) return MALFORMED_REPORT;
  if (!Array.isArray(ro.stages) || ro.stages.length !== STAGE_ORDER.length) return MALFORMED_REPORT;
  const oks: boolean[] = [];
  for (let i = 0; i < STAGE_ORDER.length; i++) {
    const s = ro.stages[i];
    if (typeof s !== "object" || s === null || Array.isArray(s)) return MALFORMED_REPORT;
    const so = s as Record<string, unknown>;
    if (Object.keys(so).length !== 2 || !hasOwn(so, "id") || !hasOwn(so, "ok")) return MALFORMED_REPORT; // rând = EXACT {id,ok}
    if (!isReleaseStage(so.id) || so.id !== STAGE_ORDER[i] || typeof so.ok !== "boolean") return MALFORMED_REPORT;
    oks.push(so.ok);
  }
  // stages determină canonicul; inputul e acceptat DOAR dacă e IDENTIC (ok + blamedStage). Contradicție → RESPINS.
  const canonical = buildReleaseReport({
    gate1Ok: oks[0], at2Captured: oks[1], gate2Ok: oks[2],
    workerBackstopOk: oks[3], redisCleanupOk: oks[4], supabaseCleanupOk: oks[5],
  });
  const canonBlamed = canonical.kind === "verdict" ? canonical.blamedStage : null;
  if (ro.ok !== canonical.ok || ro.blamedStage !== canonBlamed) return MALFORMED_REPORT;
  return canonical;
}

/**
 * SINGURA sursă de reason uman — DERIVAT din structura CANONICALIZATĂ, keyed pe enum. Niciodată un string venit din afară.
 * malformed/nestructural/inconsistent → mesaj static; verde → notă statică; roșu → eticheta STATICĂ a etapei vinovate.
 */
export function releaseReportReason(report: ReleaseReport): string {
  const r = canonicalizeReport(report);
  if (r.kind === "malformed") return MALFORMED_REASON;
  if (r.ok) return GREEN_NOTE;
  return r.blamedStage !== null
    ? `ROȘU @ ${r.blamedStage}: ${RELEASE_STAGE_LABEL[r.blamedStage]}`
    : "ROȘU (etapă necunoscută)"; // inatingibil: buildReleaseReport roșu ⇒ blamedStage non-null
}

/** Cod de ieșire ONEST: 0 DOAR pe VERDE canonic; roșu / malformed / nestructural / INCONSISTENT → 1. */
export function releaseExitCode(report: ReleaseReport): 0 | 1 {
  return canonicalizeReport(report).ok === true ? 0 : 1;
}

/** Randare TEXT umană (anti-leak: canonicalizat la frontieră; etichetă + reason DERIVATE static din hărți înghețate). */
export function renderReleaseReportText(report: ReleaseReport): string {
  const r = canonicalizeReport(report);
  if (r.kind === "malformed") {
    return `❌ RELEASE GATE — MALFORMED\n${releaseReportReason(r)}`;
  }
  const lines = r.stages.map((s) => `  ${s.ok ? "✅" : "❌"} ${RELEASE_STAGE_LABEL[s.id]}`);
  const tag = r.blamedStage !== null ? r.blamedStage : "?";
  const head = r.ok ? "✅ RELEASE GATE — VERDE" : `❌ RELEASE GATE — ROȘU @ ${tag}`;
  return `${head}\n${lines.join("\n")}\n→ ${releaseReportReason(r)}`;
}

export interface ReleaseReportJson {
  version:     typeof RELEASE_REPORT_VERSION;
  ok:          boolean;
  malformed:   boolean;
  blamedStage: ReleaseStage | null;
  reason:      string;
  stages:      { id: ReleaseStage; ok: boolean }[];
}

/** Randare JSON machine-readable (anti-leak; canonicalizat; reason DERIVAT static; versionat). */
export function renderReleaseReportJson(report: ReleaseReport): ReleaseReportJson {
  const r = canonicalizeReport(report);
  if (r.kind === "malformed") {
    return { version: RELEASE_REPORT_VERSION, ok: false, malformed: true, blamedStage: null, reason: releaseReportReason(r), stages: [] };
  }
  return {
    version:     RELEASE_REPORT_VERSION,
    ok:          r.ok,
    malformed:   false,
    blamedStage: r.blamedStage,
    reason:      releaseReportReason(r),
    stages:      r.stages.map((s) => ({ id: s.id, ok: s.ok })),
  };
}

const JSON_KEYS: readonly (keyof ReleaseReportJson)[] = Object.freeze([
  "version", "ok", "malformed", "blamedStage", "reason", "stages",
] as const);

// Egalitate STRUCTURALĂ artefact↔canonic (independentă de ordinea cheilor JSON). `inStages` e deja validat structural.
function artifactEqualsCanonical(
  o: Record<string, unknown>, inStages: { id: ReleaseStage; ok: boolean }[], canonical: ReleaseReportJson,
): boolean {
  if (o.version !== canonical.version || o.ok !== canonical.ok || o.malformed !== canonical.malformed) return false;
  if (o.blamedStage !== canonical.blamedStage || o.reason !== canonical.reason) return false;
  if (inStages.length !== canonical.stages.length) return false;
  for (let i = 0; i < canonical.stages.length; i++) {
    if (inStages[i].id !== canonical.stages[i].id || inStages[i].ok !== canonical.stages[i].ok) return false;
  }
  return true;
}

/**
 * Validator FAIL-CLOSED al artefactului JSON emis (frontiera de consumator — CI/monitor re-parsează raportul). Poartă
 * STRUCTURALĂ (chei exacte; `version === RELEASE_REPORT_VERSION`; `ok`/`malformed` booleeni; `reason` string; `blamedStage`
 * null-sau-stage-valid; `stages` array de `{id: stage valid, ok: boolean}` cu formă exactă), apoi reconstruiește CANONICUL
 * din STRUCTURĂ prin `buildReleaseReport` (deci prin `composeReleaseVerdict` — ZERO re-implementare) și ACCEPTĂ artefactul
 * DOAR dacă e IDENTIC cu canonicul. Orice deviație (versiune greșită, `reason` FALSIFICAT, coerență ruptă) → `null`.
 */
export function parseReleaseReportJson(raw: unknown): ReleaseReportJson | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).length !== JSON_KEYS.length) return null;
  for (const k of JSON_KEYS) if (!hasOwn(o, k)) return null;
  if (o.version !== RELEASE_REPORT_VERSION) return null;                       // discriminator de versiune, fail-closed
  if (typeof o.ok !== "boolean" || typeof o.malformed !== "boolean" || typeof o.reason !== "string") return null;
  if (o.blamedStage !== null && !isReleaseStage(o.blamedStage)) return null;
  if (!Array.isArray(o.stages)) return null;

  const inStages: { id: ReleaseStage; ok: boolean }[] = [];
  for (const s of o.stages) {
    if (typeof s !== "object" || s === null || Array.isArray(s)) return null;
    const so = s as Record<string, unknown>;
    if (Object.keys(so).length !== 2) return null;
    if (!hasOwn(so, "id") || !hasOwn(so, "ok")) return null;
    if (!isReleaseStage(so.id) || typeof so.ok !== "boolean") return null;
    inStages.push({ id: so.id, ok: so.ok });
  }

  let canonical: ReleaseReportJson;
  if (o.malformed === true) {
    if (inStages.length !== 0) return null;
    canonical = renderReleaseReportJson(MALFORMED_REPORT);
  } else {
    if (inStages.length !== STAGE_ORDER.length) return null;
    for (let i = 0; i < STAGE_ORDER.length; i++) if (inStages[i].id !== STAGE_ORDER[i]) return null;
    canonical = renderReleaseReportJson(buildReleaseReport({
      gate1Ok:           inStages[0].ok,
      at2Captured:       inStages[1].ok,
      gate2Ok:           inStages[2].ok,
      workerBackstopOk:  inStages[3].ok,
      redisCleanupOk:    inStages[4].ok,
      supabaseCleanupOk: inStages[5].ok,
    }));
  }

  return artifactEqualsCanonical(o, inStages, canonical) ? canonical : null;
}
