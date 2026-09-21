/**
 * lib/mcp/railwayApplyPlan.ts — PH-12 12.6 leaf 2c-1: apply-planner PUR (AdmissiblePlan → ApplyProgram) + poartă de confirmare.
 *
 * Transformă un `AdmissiblePlan` (leaf 1) într-o SECVENȚĂ ORDONATĂ de intenții de mutație tipate (`ApplyProgram`), FĂRĂ NICIUN
 * I/O și FĂRĂ să atingă Railway. Aceasta e ULTIMA piesă pură dinaintea clientului de WRITE (2c-2): decide EXACT ce mutații
 * s-ar face și în ce ordine, cu poarta de confirmare pentru acțiunile distructive — dar nu le execută.
 *
 *   AdmissiblePlan (leaf 1, GENUIN) ──planApply(plan, confirmation?)──▶ ApplyProgram (GENUIN, înregistrat) { steps, stops }
 *
 * DOCTRINĂ (capability-bound, fail-closed, cost-aware, value-blind pe secrete):
 *  - **PROVENIENȚA planului, NU doar forma lui.** Validarea structurală NU dovedește că planul vine din plannerul canonic —
 *    un `{...plan, actions:[…set_env cu SECRET…]}` are forma corectă. De aceea acceptăm DOAR planuri GENUINE
 *    (`isGenuinePlan`, WeakSet emis de `profilePlan`); orice plan fabricat → `unregistered_plan` ÎNAINTE de a privi acțiunile.
 *  - **Programul e la rândul lui GENUIN + înregistrat** (`isGenuineProgram`): clientul de WRITE (2c-2) și renderer-ul acceptă
 *    DOAR programe emise de `planApply` — un program fabricat nu poate fi nici executat, nici reflectat (anti-leak).
 *  - **Doar un `AdmissiblePlan` se aplică.** `BlockedPlan` → `not_admissible`. Plan genuin dar cu acțiuni inconsistente
 *    (imposibil de la plannerul canonic; apărare-în-adâncime) → `invalid_plan`. Noop → `ok` cu program GOL (zero mutații).
 *  - **Poarta de confirmare (stop-in-prod = confirmare EXPLICITĂ), normalizată DEFENSIV.** Pași distructivi (`stop`) cer o
 *    confirmare legată de (a) profilul-țintă ȘI (b) setul EXACT de servicii oprite. Accesul la câmpurile confirmării e prins
 *    în try/catch (un Proxy ostil cu getteri care aruncă → `confirmation_mismatch`, NICIODATĂ throw). Lipsă → `confirmation_required`.
 *  - **Value-blind pe SECRETE.** Programul poartă doar valori declarate de PROFIL (config gestionat), moștenite din
 *    `plan.actions` — niciodată un token/cheie RPC. Ordine deterministă `configure→start→stop` RE-derivată din `kind`.
 *
 * ⚠️ ZERO MUTAȚIE aici. Testat în `railwayApplyPlan.test.ts`, cablat în `test:ph12-railway-apply-plan` (gate-14).
 */

import { SERVICE_IDS, parseProfileName, isGenuinePlan } from "./profilePlan";
import type { ServiceId, ProfileName, TransitionPlan, ServiceAction, Phase } from "./profilePlan";

// ── Intenție de mutație tipată (ce va executa clientul WRITE 2c-2, o SINGURĂ dată per pas) ────────────────────────
export type ApplyStepKind = "set_env" | "unset_env" | "start" | "stop";
export interface ApplyStep {
  readonly service: ServiceId;
  readonly kind: ApplyStepKind;
  readonly key?: string;   // set_env / unset_env
  readonly value?: string; // set_env — valoare declarată de PROFIL (config gestionat), NICIODATĂ un secret
  readonly destructive: boolean;
  readonly causesRestart: boolean;
}

export interface ApplyProgram {
  readonly target: ProfileName;
  readonly steps: readonly ApplyStep[];
  readonly stops: readonly ServiceId[];     // setul EXACT de servicii oprite (pentru legarea confirmării)
  readonly requiresConfirmation: boolean;   // ⇔ stops.length > 0
  readonly noop: boolean;                   // program gol (deja în stare)
}

/** Confirmare umană LEGATĂ: target-ul ȘI setul exact de stopuri trebuie să coincidă cu programul proaspăt. */
export interface ApplyConfirmation {
  readonly target: ProfileName;
  readonly confirmedStops: readonly ServiceId[];
}

export type ApplyRejectReason = "unregistered_plan" | "not_admissible" | "invalid_plan" | "confirmation_required" | "confirmation_mismatch";
export type ApplyPlanResult =
  | { readonly ok: true; readonly program: ApplyProgram }
  | { readonly ok: false; readonly reason: ApplyRejectReason };

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object") { for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v); Object.freeze(o); }
  return o;
}

// Registru de identitate al PROGRAMELOR: doar cele emise de `planApply` sunt „adevărate". Capability-bound pentru clientul de
// WRITE (2c-2) ȘI pentru renderer (un program fabricat nu poate fi reflectat → anti-leak).
const PROGRAM_REGISTRY = new WeakSet<object>();
export function isGenuineProgram(x: unknown): x is ApplyProgram { return typeof x === "object" && x !== null && PROGRAM_REGISTRY.has(x); }

const SERVICE_SET: ReadonlySet<string> = new Set(SERVICE_IDS);
const STEP_KINDS: ReadonlySet<string> = new Set<ApplyStepKind>(["set_env", "unset_env", "start", "stop"]);
// Ordine de apply re-derivată din `kind` (NU din ordinea plan-ului): configurează întâi, apoi pornește, apoi oprește.
const KIND_PHASE: Readonly<Record<ApplyStepKind, number>> = { set_env: 0, unset_env: 0, start: 1, stop: 2 };
// Faza canonică declarată de plan pentru fiecare kind — verificată strict (un plan cu `phase` nepotrivit e inconsistent).
const CANONICAL_PHASE: Readonly<Record<ApplyStepKind, Phase>> = { set_env: "configure", unset_env: "configure", start: "start", stop: "stop" };
const svcIndex = (s: ServiceId): number => SERVICE_IDS.indexOf(s);

/**
 * Validează structural o `ServiceAction` (apărare-în-adâncime — chiar și pe un plan genuin) și o mapează la un `ApplyStep`.
 * Întoarce `null` pe orice inconsistență → `invalid_plan`. Coerență STRICTĂ: stop⇔destructive, set_env are key+value string,
 * unset_env are key fără value, start/stop fără key/value, `phase` == faza canonică a kind-ului.
 */
function toStep(a: ServiceAction): ApplyStep | null {
  if (a === null || typeof a !== "object") return null;
  const { service, kind, phase, key, value, destructive, causesRestart } = a;
  if (typeof service !== "string" || !SERVICE_SET.has(service)) return null;
  if (typeof kind !== "string" || !STEP_KINDS.has(kind)) return null;
  if (typeof destructive !== "boolean" || typeof causesRestart !== "boolean") return null;
  if (phase !== CANONICAL_PHASE[kind]) return null; // `phase` trebuie să corespundă kind-ului (anti-inconsistență)

  switch (kind) {
    case "set_env":
      if (typeof key !== "string" || key.length === 0 || typeof value !== "string") return null;
      if (destructive) return null; // set_env NU e distructiv
      return { service, kind, key, value, destructive: false, causesRestart };
    case "unset_env":
      if (typeof key !== "string" || key.length === 0 || value !== undefined) return null;
      if (destructive) return null;
      return { service, kind, key, destructive: false, causesRestart };
    case "start":
      if (key !== undefined || value !== undefined) return null;
      if (destructive) return null; // start NU e distructiv
      return { service, kind, destructive: false, causesRestart };
    case "stop":
      if (key !== undefined || value !== undefined) return null;
      if (!destructive) return null; // stop TREBUIE marcat distructiv
      return { service, kind, destructive: true, causesRestart };
    default:
      { const _exhaustive: never = kind; void _exhaustive; return null; }
  }
}

function sameServiceSet(a: readonly ServiceId[], b: readonly ServiceId[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

/**
 * Poarta de confirmare, normalizată STRICT-STRUCTURAL cu snapshot EXACT + ATOMIC + izolată DEFENSIV. Confirmarea TREBUIE să fie
 * un obiect simplu (prototip `Object.prototype` sau `null`) cu EXACT cheile own `{target, confirmedStops}` — `Reflect.ownKeys`
 * prinde ȘI Symbol-urile ȘI cheile non-enumerable pe care `Object.keys` le-ar rata. AMBELE câmpuri sunt own DATA-properties,
 * iar valorile se citesc DIN DESCRIPTOR (`descriptor.value`), NU prin acces `confirmation.x` → un `get`-trap ostil NU e invocat.
 *  (a) `target` = `ProfileName` valid EGAL cu al planului;
 *  (b) `confirmedStops` = array de `ServiceId` valide, COPIAT defensiv (anti-TOCTOU/anti-mutație), FĂRĂ duplicate, set-egal EXACT.
 * Orice abatere (prototip custom, cheie în plus string/Symbol/non-enumerable, accesor, moștenire, throw) → `false`, niciodată throw.
 */
function confirmationSatisfies(confirmation: ApplyConfirmation, target: ProfileName, stops: readonly ServiceId[]): boolean {
  try {
    if (confirmation === null || typeof confirmation !== "object" || Array.isArray(confirmation)) return false;
    // Prototip: DOAR Object.prototype sau null (respinge prototipuri custom chiar cu câmpuri own corecte).
    const proto = Object.getPrototypeOf(confirmation);
    if (proto !== Object.prototype && proto !== null) return false;
    // Set EXACT de chei — Reflect.ownKeys prinde Symbol-uri ȘI chei non-enumerable (Object.keys le-ar rata).
    const keys = Reflect.ownKeys(confirmation);
    if (keys.length !== 2 || !keys.includes("target") || !keys.includes("confirmedStops")) return false;
    // Snapshot ATOMIC via descriptori: own DATA-properties (au `value`); valorile din descriptor → NU declanșează `get`-trap.
    const targetDesc = Object.getOwnPropertyDescriptor(confirmation, "target");
    const stopsDesc = Object.getOwnPropertyDescriptor(confirmation, "confirmedStops");
    if (targetDesc === undefined || !Object.hasOwn(targetDesc, "value") || stopsDesc === undefined || !Object.hasOwn(stopsDesc, "value")) return false;
    const ct = targetDesc.value;
    const src = stopsDesc.value;

    // (a) target
    if (parseProfileName(ct) === null || ct !== target) return false;
    // (b) confirmedStops — COPIE defensivă (o singură citire a sursei; restul lucrează pe copie), unicitate, set-egalitate exactă.
    if (!Array.isArray(src)) return false;
    const confirmed: readonly unknown[] = [...src];
    if (!confirmed.every((s) => typeof s === "string" && SERVICE_SET.has(s))) return false;
    if (new Set(confirmed).size !== confirmed.length) return false; // duplicate → respins EXPLICIT
    return sameServiceSet(confirmed as readonly ServiceId[], stops);
  } catch { return false; } // orice throw la accesul câmpurilor → refuz (nu propagăm)
}

/**
 * Sinteză + poartă. Rulează pe planul PROASPĂT (2c-3 re-citește imediat înainte). Capability-bound + fail-closed pe fiecare treaptă.
 */
export function planApply(plan: TransitionPlan, confirmation?: ApplyConfirmation): ApplyPlanResult {
  // 1. PROVENIENȚĂ: doar planuri GENUINE (emise de plannerul canonic). Un plan fabricat — oricât de bine format — e respins AICI.
  if (!isGenuinePlan(plan)) return { ok: false, reason: "unregistered_plan" };
  // 2. `target` re-validat ca ProfileName cunoscut (apărare-în-adâncime).
  const target = parseProfileName(plan.target);
  if (target === null) return { ok: false, reason: "invalid_plan" };
  // 3. Doar admisibil.
  if (!plan.admissible) return { ok: false, reason: "not_admissible" };

  const actions = plan.actions;
  if (!Array.isArray(actions)) return { ok: false, reason: "invalid_plan" };

  const steps: ApplyStep[] = [];
  const stops: ServiceId[] = [];
  const seen = new Set<string>();          // (service|kind|key) — fără duplicate
  const startsBy = new Set<ServiceId>();   // detectare start+stop pe același serviciu
  const stopsBy = new Set<ServiceId>();
  for (const a of actions) {
    const step = toStep(a);
    if (step === null) return { ok: false, reason: "invalid_plan" };
    const sig = `${step.service}|${step.kind}|${step.key ?? ""}`;
    if (seen.has(sig)) return { ok: false, reason: "invalid_plan" }; // acțiune duplicată
    seen.add(sig);
    if (step.kind === "start") startsBy.add(step.service);
    if (step.kind === "stop") { stopsBy.add(step.service); stops.push(step.service); }
    steps.push(step);
  }
  // start ȘI stop pe același serviciu = contradictoriu (imposibil de la plannerul canonic).
  for (const s of startsBy) if (stopsBy.has(s)) return { ok: false, reason: "invalid_plan" };

  // Ordine deterministă re-derivată (nu ne bazăm pe ordinea din plan): configure(0) → start(1) → stop(2), apoi index serviciu, apoi cheie.
  steps.sort((x, y) => KIND_PHASE[x.kind] - KIND_PHASE[y.kind] || svcIndex(x.service) - svcIndex(y.service) || (x.key ?? "").localeCompare(y.key ?? ""));

  const requiresConfirmation = stops.length > 0;
  const noop = steps.length === 0;

  // 4. Poarta de confirmare (stop-in-prod), normalizată STRICT. Absentă (undefined/null) → required; prezentă dar ne-conformă → mismatch.
  if (requiresConfirmation) {
    if (confirmation === undefined || confirmation === null) return { ok: false, reason: "confirmation_required" };
    if (!confirmationSatisfies(confirmation, target, stops)) return { ok: false, reason: "confirmation_mismatch" };
  }

  const program = deepFreeze({ target, steps, stops: [...stops].sort(), requiresConfirmation, noop } as ApplyProgram);
  PROGRAM_REGISTRY.add(program); // GENUIN → clientul de WRITE + renderer îl acceptă
  return { ok: true, program };
}

// ── Render pentru operator (capability-bound: DOAR programe genuine; anti-leak: rol + cheie + valoare declarată-de-profil) ──
function stepLine(s: ApplyStep): string {
  if (s.kind === "start") return `▶ start ${s.service}`;
  if (s.kind === "stop") return `⏹ stop ${s.service}  (DISTRUCTIV)`;
  if (s.kind === "set_env") return `⚙ ${s.service} set ${s.key}=${s.value}${s.causesRestart ? "  (redeploy)" : ""}`;
  return `⚙ ${s.service} unset ${s.key}${s.causesRestart ? "  (redeploy)" : ""}`;
}

export function formatApplyProgram(program: ApplyProgram): string[] {
  if (!isGenuineProgram(program)) return ["APPLY: program neînregistrat — refuzat (nu se reflectă)"]; // anti-leak: NU reflectăm un program fabricat
  const lines: string[] = [`APPLY (profil țintă: ${program.target}):`];
  if (program.noop) { lines.push("  (deja în stare — nicio mutație)"); return lines; }
  for (const s of program.steps) lines.push("  " + stepLine(s));
  if (program.requiresConfirmation) lines.push(`  → CONFIRMARE necesară pentru oprirea: ${program.stops.join(", ")}`);
  return lines;
}

/**
 * Rezumat numeric (fără valori). Program fabricat → `valid:false` (NU `noop:true`): un program neînregistrat NU e „nimic de
 * făcut / sigur", ci INVALID — un consumator trebuie să vadă `valid:false` și să refuze, nu să-l citească drept noop benign.
 */
export interface ApplySummary { valid: boolean; setEnv: number; unsetEnv: number; starts: number; stops: number; requiresConfirmation: boolean; noop: boolean; }
export function applySummary(program: ApplyProgram): ApplySummary {
  if (!isGenuineProgram(program)) return { valid: false, setEnv: 0, unsetEnv: 0, starts: 0, stops: 0, requiresConfirmation: false, noop: false };
  let setEnv = 0, unsetEnv = 0, starts = 0, stops = 0;
  for (const s of program.steps) { if (s.kind === "set_env") setEnv++; else if (s.kind === "unset_env") unsetEnv++; else if (s.kind === "start") starts++; else stops++; }
  return { valid: true, setEnv, unsetEnv, starts, stops, requiresConfirmation: program.requiresConfirmation, noop: program.noop };
}
