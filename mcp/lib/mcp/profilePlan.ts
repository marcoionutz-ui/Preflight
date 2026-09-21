/**
 * lib/mcp/profilePlan.ts — PH-12 12.6 leaf 1 (model de profile + planner PUR, capability-bound). rev5 (după cgpt).
 *
 * ARHITECTURĂ:
 *   RAW (Railway/JSON) ──parseRawState──▶ RawState
 *      RawState ──buildObservation(target, caps)──▶ { ok, observation } | { ok:false, "validation_unavailable" }
 *      Observation (înregistrată privat + înghețată) ──planProfileTransition──▶ TransitionPlan
 *
 * INVARIANTE rev5:
 *  - **„Poate porni?" = VALIDATORUL CANONIC COMPLET al serviciului, nu un subset ales manual.** `Caps.validateService[s]`
 *    e legat (leaf 2) de validatorul REAL al rolului (`validateMcpEnv` + `buildEnvCheck`, `validateWorkerEvmEnv`,
 *    `validateIndexerEvmEnv`, `validateSolanaEnv` — vezi `lib/config/envSchema.ts` / `buildEnvCheck.ts`). Rulează pe env-ul
 *    EFECTIV (raw ∪ managed-override-urile profilului, ex. `ENABLED_CHAINS=base`) și întoarce `{ ok, problems }` REDACTAT
 *    (doar NUME de chei + `missing|invalid`). Nu mai există catalog local de chei required → nimic de ținut sincron, deci
 *    nici guard de paritate cu regex (era fail-open).
 *  - **Identitatea observației = `WeakSet` privat, NU un simbol enumerabil.** Un `{...obs, target:X}` (spread + relabel) e un
 *    OBIECT NOU, absent din registru → respins. Relabel-ul e imposibil fără a construi prin `buildObservation`.
 *  - **Capability fail-closed:** validator lipsă / care aruncă (posibil cu secret în mesaj) / cu retur malformat →
 *    `validation_unavailable`. Niciodată throw/leak.
 *  - **Blocat = FĂRĂ `ServiceAction[]`** (doar `PreviewDiff`). **„Nu știu" ≠ „oprit"** (`running: boolean | "unknown"`).
 *    **`unset` pe `hasOwn`** (cheie prezentă-goală tot se șterge). Enum-uri + catalog înghețate runtime.
 *
 * Testat în `profilePlan.test.ts`; cablat în `test:ph12-profile` (gate-14).
 */

export const SERVICE_IDS = Object.freeze(["redis", "mcp", "worker-evm", "indexer-evm", "solana-worker"] as const);
export type ServiceId = (typeof SERVICE_IDS)[number];
export const PROFILE_NAMES = Object.freeze(["parked", "auth-canary", "base-canary", "launch"] as const);
export type ProfileName = (typeof PROFILE_NAMES)[number];

// `MANAGED_ENV_KEYS` e DERIVAT din profile (mai jos), NU un catalog paralel — orice cheie pe care un profil o pune în
// `env` devine automat gestionată (set/unset + proiecție efectivă), deci nu poate drifta față de ce declară profilele.

// ── Capability injectat (leaf 2 leagă validatoarele CANONICE reale) ──────────────────────────────────────────
export interface EnvProblem { name: string; kind: "missing" | "invalid" | "forbidden"; } // REDACTAT: nume de cheie, niciodată valoare
export interface EnvValidation { ok: boolean; problems: readonly EnvProblem[]; }
export type ServiceEnvValidator = (env: Readonly<Record<string, string>>) => EnvValidation;
export interface Caps {
  /** Validatorul canonic per rol (rulează SCHEMA COMPLETĂ + build-check). Leaf 2 îl leagă de `envSchema.ts`/`buildEnvCheck.ts`. */
  validateService: Readonly<Partial<Record<ServiceId, ServiceEnvValidator>>>;
  /**
   * NUMELE canonice de câmp per rol (din ACEEAȘI schemă). Allowlist de PROVENIENȚĂ: un `problem.name` e acceptat DOAR dacă
   * e o cheie a schemei — sintaxa singură (regex) nu dovedește că numele vine de la schemă, nu că-i un secret bine format.
   */
  envKeys: Readonly<Partial<Record<ServiceId, readonly string[]>>>;
  /** Plasa anti-prod: env-ul Supabase e STAGING (nu ref-ul de prod). */
  isStagingSupabase: (env: Readonly<Record<string, string>>) => boolean;
}

export interface DesiredService {
  running: boolean;
  env: Readonly<Record<string, string>>; // managed de SETAT; cheile gestionate absente → unset
  requiresEnv: boolean;                   // rulează validatorul canonic al rolului pe env-ul efectiv
  stagingBinding: boolean;
}
export interface Profile { finalized: boolean; services: Readonly<Record<ServiceId, DesiredService>>; }

const LAUNCH_EVM_CHAINS = "base"; // ⚠️ ASUMPȚIE: setul public = decizie de produs → `launch` finalized:false
const STOPPED: DesiredService = { running: false, env: {}, requiresEnv: false, stagingBinding: false };
const REDIS_ON: DesiredService = { running: true, env: {}, requiresEnv: false, stagingBinding: false };

const RAW_PROFILES: Record<ProfileName, Profile> = {
  parked: { finalized: true, services: { redis: REDIS_ON, mcp: STOPPED, "worker-evm": STOPPED, "indexer-evm": STOPPED, "solana-worker": STOPPED } },
  "auth-canary": {
    finalized: true,
    services: {
      redis: REDIS_ON,
      mcp: { running: true, env: { HEALTH_EXPECT_INDEXER_EVM: "0", HEALTH_EXPECT_SOLANA_WORKER: "0", PH2_RESOURCE_OWNER_AUTHORIZE: "1" }, requiresEnv: true, stagingBinding: true },
      "worker-evm": STOPPED, "indexer-evm": STOPPED, "solana-worker": STOPPED,
    },
  },
  "base-canary": {
    finalized: true,
    services: {
      redis: REDIS_ON,
      mcp: { running: true, env: { HEALTH_EXPECTED_CHAINS: "base", HEALTH_EXPECT_INDEXER_EVM: "0", HEALTH_EXPECT_SOLANA_WORKER: "0", PH2_RESOURCE_OWNER_AUTHORIZE: "1" }, requiresEnv: true, stagingBinding: true },
      "worker-evm": { running: true, env: { ENABLED_CHAINS: "base", PREFLIGHT_MODE: "LIVE" }, requiresEnv: true, stagingBinding: false },
      "indexer-evm": STOPPED, "solana-worker": STOPPED,
    },
  },
  launch: {
    finalized: false, // ⚠️ NEFINALIZAT → profile_incomplete
    services: {
      redis: REDIS_ON,
      mcp: { running: true, env: { HEALTH_EXPECTED_CHAINS: LAUNCH_EVM_CHAINS, HEALTH_EXPECT_INDEXER_EVM: "1", HEALTH_EXPECT_SOLANA_WORKER: "1", PH2_RESOURCE_OWNER_AUTHORIZE: "1" }, requiresEnv: true, stagingBinding: false },
      "worker-evm": { running: true, env: { ENABLED_CHAINS: LAUNCH_EVM_CHAINS, PREFLIGHT_MODE: "LIVE" }, requiresEnv: true, stagingBinding: false },
      "indexer-evm": { running: true, env: {}, requiresEnv: true, stagingBinding: false },
      "solana-worker": { running: true, env: {}, requiresEnv: true, stagingBinding: false },
    },
  },
};
function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object") { for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v); Object.freeze(o); }
  return o;
}
export const PROFILES: Readonly<Record<ProfileName, Profile>> = deepFreeze(RAW_PROFILES);
export function profileFor(name: ProfileName): Profile { return PROFILES[name]; }

/** Chei gestionate DERIVATE: uniunea cheilor pe care ORICE profil le pune în `env` per serviciu. Zero catalog paralel. */
const MANAGED_ENV_KEYS: Readonly<Record<ServiceId, readonly string[]>> = (() => {
  const acc = {} as Record<ServiceId, Set<string>>;
  for (const s of SERVICE_IDS) acc[s] = new Set<string>();
  for (const name of PROFILE_NAMES) for (const s of SERVICE_IDS) for (const k of Object.keys(PROFILES[name].services[s].env)) acc[s].add(k);
  const out = {} as Record<ServiceId, readonly string[]>;
  for (const s of SERVICE_IDS) out[s] = Object.freeze([...acc[s]].sort());
  return Object.freeze(out);
})();

// ── Frontiera RAW ─────────────────────────────────────────────────────────────────────────────────────────────
export interface RawService { running: boolean; env: Readonly<Record<string, string>>; }
export type RawState = Readonly<Partial<Record<ServiceId, RawService>>>;
const SERVICE_SET: ReadonlySet<string> = new Set(SERVICE_IDS);

export function parseProfileName(raw: unknown): ProfileName | null {
  if (typeof raw !== "string") return null;
  return (PROFILE_NAMES as readonly string[]).includes(raw) ? (raw as ProfileName) : null;
}
export function parseRawState(raw: unknown): RawState | null {
  try { // fail-closed: un getter care aruncă (Object.entries/keys îl invocă) → null, nu propagăm throw-ul la frontieră
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out: Partial<Record<ServiceId, RawService>> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!SERVICE_SET.has(k)) return null;
      if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
      const rec = v as Record<string, unknown>;
      const keys = Object.keys(rec);
      if (keys.length !== 2 || !keys.includes("running") || !keys.includes("env")) return null;
      if (typeof rec.running !== "boolean") return null;
      if (rec.env === null || typeof rec.env !== "object" || Array.isArray(rec.env)) return null;
      const env: Record<string, string> = {};
      for (const [ek, ev] of Object.entries(rec.env as Record<string, unknown>)) { if (typeof ev !== "string") return null; env[ek] = ev; }
      out[k as ServiceId] = { running: rec.running, env };
    }
    return out;
  } catch { return null; }
}

// ── Observația REDACTATĂ + registru privat de identitate ─────────────────────────────────────────────────────
export type StagingResult = "n/a" | "verified" | "unverified";
export interface ServiceObservation {
  running: boolean;
  managedEnv: Readonly<Record<string, string>>;
  env: EnvValidation;        // rezultatul validatorului canonic (redactat) — {ok:true,[]} dacă rolul nu cere env
  staging: StagingResult;
}
export interface Observation { readonly target: ProfileName; readonly services: Readonly<Partial<Record<ServiceId, ServiceObservation>>>; }
const REGISTRY = new WeakSet<object>(); // identitate: doar obiectele produse de buildObservation sunt „adevărate"
function isObservation(x: unknown): x is Observation { return typeof x === "object" && x !== null && REGISTRY.has(x); }

export type BuildResult = { ok: true; observation: Observation } | { ok: false; reason: "validation_unavailable" };

// Un `name` de problemă TREBUIE să fie un identificator de env (sau grup `A|B|C`) — NICIODATĂ text liber: un validator
// ostil/buggy ar putea altfel pune un secret / control-chars în `name`, reflectate apoi în render.
const SAFE_KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\|[A-Za-z_][A-Za-z0-9_]*)*$/;
/** `allowed` = cheile canonice ale rolului. Un `name` (sau fiecare membru dintr-un grup `A|B`) TREBUIE să fie o cheie a schemei. */
function redactProblems(raw: unknown, allowed: ReadonlySet<string>): EnvProblem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: EnvProblem[] = [];
  for (const p of raw) {
    if (p === null || typeof p !== "object") return null;
    const name = (p as { name?: unknown }).name;
    if (typeof name !== "string" || !SAFE_KEY_NAME.test(name)) return null; // hygiene sintactică
    if (!name.split("|").every((part) => allowed.has(part))) return null;   // PROVENIENȚĂ: doar chei ale schemei (nu secret bine format)
    const kind = (p as { kind?: unknown }).kind;
    if (kind !== "missing" && kind !== "invalid" && kind !== "forbidden") return null; // kind necunoscut → respins
    out.push({ name, kind });
  }
  return out;
}
/**
 * Rulare canonică în siguranță. `null` (→ `validation_unavailable`) pe: lipsă / throw / retur malformat / nume ne-safe /
 * kind necunoscut / **rezultat CONTRADICTORIU** (`ok` NU corespunde cu `problems.length===0`: `ok:true`+probleme sau
 * `ok:false`+zero probleme → inutilizabil, niciodată fals-verde).
 */
function safeValidate(fn: ServiceEnvValidator | undefined, env: Readonly<Record<string, string>>, allowed: ReadonlySet<string>): EnvValidation | null {
  if (typeof fn !== "function") return null;
  let res: unknown;
  try { res = fn(env); } catch { return null; }
  if (res === null || typeof res !== "object") return null;
  if (typeof (res as { ok?: unknown }).ok !== "boolean") return null;
  const problems = redactProblems((res as { problems?: unknown }).problems, allowed);
  if (problems === null) return null;
  const ok = (res as { ok: boolean }).ok;
  if (ok !== (problems.length === 0)) return null; // contradictoriu → fail-closed
  return { ok, problems };
}

/** Construiește observația relativă la `target`. Capability-bound + fail-closed: ORICE defect de caps → cod închis. */
export function buildObservation(raw: RawState, target: ProfileName, caps: Caps): BuildResult {
  try {
    // Guard de formă pe `caps` (un obiect malformat / un getter care aruncă la ACCES ar sparge frontiera altfel).
    if (caps === null || typeof caps !== "object") return { ok: false, reason: "validation_unavailable" };
    const validateService = caps.validateService;
    if (validateService === null || typeof validateService !== "object") return { ok: false, reason: "validation_unavailable" };
    const envKeys = caps.envKeys;
    if (envKeys === null || typeof envKeys !== "object") return { ok: false, reason: "validation_unavailable" };
    if (typeof caps.isStagingSupabase !== "function") return { ok: false, reason: "validation_unavailable" };

    const profile = PROFILES[target];
    const services: Partial<Record<ServiceId, ServiceObservation>> = {};
    for (const s of SERVICE_IDS) {
      const rs = raw[s];
      if (rs === undefined) continue;
      const des = profile.services[s];
      const managedEnv: Record<string, string> = {};
      for (const key of MANAGED_ENV_KEYS[s]) if (Object.hasOwn(rs.env, key)) managedEnv[key] = rs.env[key];

      let env: EnvValidation = { ok: true, problems: [] };
      if (des.running && des.requiresEnv) {
        // Env-ul EFECTIV = exact ce va rula serviciul DUPĂ apply: raw ∪ set-overrides MINUS cheile gestionate pe care
        // profilul le UNSET-uiește (nu doar raw∪des.env — altfel validăm o cheie pe care planul o va șterge).
        const effective: Record<string, string> = { ...rs.env };
        for (const k of MANAGED_ENV_KEYS[s]) { if (k in des.env) effective[k] = des.env[k]; else delete effective[k]; }
        const keys = envKeys[s];
        if (!Array.isArray(keys)) return { ok: false, reason: "validation_unavailable" }; // fără allowlist de proveniență → fail-closed
        const v = safeValidate(validateService[s], effective, new Set(keys));
        if (v === null) return { ok: false, reason: "validation_unavailable" };
        env = v;
      }

      let staging: StagingResult = "n/a";
      if (des.stagingBinding) {
        const vetted: unknown = caps.isStagingSupabase(rs.env); // throw → prins de backstop-ul de mai jos
        if (typeof vetted !== "boolean") return { ok: false, reason: "validation_unavailable" };
        staging = vetted ? "verified" : "unverified";
      }
      services[s] = { running: rs.running, managedEnv, env, staging };
    }
    const observation = deepFreeze({ target, services });
    REGISTRY.add(observation);
    return { ok: true, observation };
  } catch {
    return { ok: false, reason: "validation_unavailable" }; // backstop: NICIUN throw nu iese, niciun mesaj propagat
  }
}

// ── Plan (uniune discriminată) ────────────────────────────────────────────────────────────────────────────────
export type ActionKind = "set_env" | "unset_env" | "start" | "stop";
export type Phase = "configure" | "start" | "stop";
const PHASE_ORDER: Readonly<Record<Phase, number>> = { configure: 0, start: 1, stop: 2 };
export interface ServiceAction { service: ServiceId; kind: ActionKind; phase: Phase; key?: string; value?: string; destructive: boolean; causesRestart: boolean; }
export type BlockerKind = "env_missing" | "env_invalid" | "env_forbidden" | "staging_unverified" | "state_unknown" | "profile_incomplete" | "invalid_observation";
export interface Blocker { service: ServiceId | "__profile__"; kind: BlockerKind; key: string; }

export interface ServiceSnapshot { running: boolean | "unknown"; managedEnv: Readonly<Record<string, string>>; env: EnvValidation | "n/a"; staging: StagingResult; }
export type StateSnapshot = Readonly<Record<ServiceId, ServiceSnapshot>>;
export interface PreviewDiff { lines: readonly string[]; starts: number; stops: number; setEnv: number; unsetEnv: number; }

interface PlanCommon { target: ProfileName; before: StateSnapshot; after: StateSnapshot; }
export interface AdmissiblePlan extends PlanCommon { admissible: true; actions: readonly ServiceAction[]; noop: boolean; requiresConfirmation: boolean; }
export interface BlockedPlan extends PlanCommon { admissible: false; blockers: readonly Blocker[]; preview: PreviewDiff; }
export type TransitionPlan = AdmissiblePlan | BlockedPlan;

function actionLine(a: ServiceAction): string {
  if (a.kind === "start") return `▶ [start] ${a.service}`;
  if (a.kind === "stop") return `⏹ [stop] ${a.service}  (DISTRUCTIV — cere confirmare)`;
  if (a.kind === "set_env") return `⚙ [configure] ${a.service} set ${a.key}=${a.value}${a.causesRestart ? "  (redeploy)" : ""}`;
  return `⚙ [configure] ${a.service} unset ${a.key}${a.causesRestart ? "  (redeploy)" : ""}`;
}
function toPreview(proposed: readonly ServiceAction[]): PreviewDiff {
  let starts = 0, stops = 0, setEnv = 0, unsetEnv = 0;
  for (const a of proposed) { if (a.kind === "start") starts++; else if (a.kind === "stop") stops++; else if (a.kind === "set_env") setEnv++; else unsetEnv++; }
  return { lines: proposed.map((a) => "(preview) " + actionLine(a)), starts, stops, setEnv, unsetEnv };
}
const UNKNOWN_SNAP: ServiceSnapshot = { running: "unknown", managedEnv: {}, env: "n/a", staging: "n/a" };
function allUnknownSnapshot(): StateSnapshot { const s = {} as Record<ServiceId, ServiceSnapshot>; for (const id of SERVICE_IDS) s[id] = UNKNOWN_SNAP; return s; }
function managedEnvProjected(service: ServiceId, des: DesiredService, obs: ServiceObservation | undefined): Record<string, string> {
  if (des.running) { const m: Record<string, string> = {}; for (const k of MANAGED_ENV_KEYS[service]) if (k in des.env) m[k] = des.env[k]; return m; }
  return obs ? { ...obs.managedEnv } : {};
}
function snapshot(obs: Observation, projected: boolean): StateSnapshot {
  const profile = PROFILES[obs.target];
  const snap = {} as Record<ServiceId, ServiceSnapshot>;
  for (const s of SERVICE_IDS) {
    const o = obs.services[s]; const des = profile.services[s];
    if (o === undefined) { snap[s] = UNKNOWN_SNAP; continue; }
    snap[s] = { running: projected ? des.running : o.running, managedEnv: projected ? managedEnvProjected(s, des, o) : { ...o.managedEnv }, env: des.requiresEnv ? o.env : "n/a", staging: o.staging };
  }
  return snap;
}

// Registru de identitate al PLANURILOR (analog cu REGISTRY-ul observațiilor): doar planurile emise de `planProfileTransition`
// sunt „adevărate". Capability-bound pentru consumatorul de WRITE (2c): un `{...plan}` fabricat (spread + relabel, sau obiect
// inventat) e un OBIECT NOU, absent din registru → respins la apply (`unregistered_plan`). Validarea structurală NU dovedește
// proveniența; identitatea o dovedește.
const PLAN_REGISTRY = new WeakSet<object>();
export function isGenuinePlan(x: unknown): x is TransitionPlan { return typeof x === "object" && x !== null && PLAN_REGISTRY.has(x); }
function registerPlan<T extends TransitionPlan>(p: T): T { PLAN_REGISTRY.add(p); return p; }

/** Planner PUR, value-blind, UN SINGUR arg. Fail-closed. */
export function planProfileTransition(observation: Observation): TransitionPlan {
  if (!isObservation(observation)) {
    // Citire DEFENSIVĂ a target-ului dintr-un obiect ne-de-încredere: un Proxy cu `get` care aruncă n-are voie să spargă aici.
    let claimed: unknown;
    try { claimed = (observation as { target?: unknown })?.target; } catch { claimed = undefined; }
    const target = parseProfileName(claimed) ?? PROFILE_NAMES[0];
    const empty = allUnknownSnapshot();
    return registerPlan(deepFreeze({ admissible: false, target, before: empty, after: empty, blockers: [{ service: "__profile__", kind: "invalid_observation", key: "__identity__" }], preview: { lines: ["observație neînregistrată — respinsă"], starts: 0, stops: 0, setEnv: 0, unsetEnv: 0 } } as BlockedPlan));
  }
  const target = observation.target;
  const profile = PROFILES[target];
  const proposed: ServiceAction[] = [];
  const blockers: Blocker[] = [];
  if (!profile.finalized) blockers.push({ service: "__profile__", kind: "profile_incomplete", key: target });

  for (const service of SERVICE_IDS) {
    const des = profile.services[service];
    const obs = observation.services[service];
    if (obs === undefined) { blockers.push({ service, kind: "state_unknown", key: "__state__" }); continue; }

    if (des.running) {
      if (des.requiresEnv && !obs.env.ok) for (const p of obs.env.problems) blockers.push({ service, kind: p.kind === "invalid" ? "env_invalid" : p.kind === "forbidden" ? "env_forbidden" : "env_missing", key: p.name });
      if (des.stagingBinding && obs.staging !== "verified") blockers.push({ service, kind: "staging_unverified", key: "__staging__" });

      const restart = obs.running;
      for (const key of MANAGED_ENV_KEYS[service]) {
        if (key in des.env) { if (obs.managedEnv[key] !== des.env[key]) proposed.push({ service, kind: "set_env", phase: "configure", key, value: des.env[key], destructive: false, causesRestart: restart }); }
        else if (Object.hasOwn(obs.managedEnv, key)) proposed.push({ service, kind: "unset_env", phase: "configure", key, destructive: false, causesRestart: restart });
      }
      if (!obs.running) proposed.push({ service, kind: "start", phase: "start", destructive: false, causesRestart: true });
    } else if (obs.running) proposed.push({ service, kind: "stop", phase: "stop", destructive: true, causesRestart: true });
  }

  const svcIndex = (s: ServiceId): number => SERVICE_IDS.indexOf(s);
  proposed.sort((a, b) => PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] || svcIndex(a.service) - svcIndex(b.service) || (a.key ?? "").localeCompare(b.key ?? ""));

  const before = snapshot(observation, false);
  const after = snapshot(observation, true);
  // deepFreeze: odată validat/întors, planul (inclusiv `actions`) e IMUTABIL — un consumator nu-l mai poate modifica.
  if (blockers.length > 0) return registerPlan(deepFreeze({ admissible: false, target, before, after, blockers, preview: toPreview(proposed) } as BlockedPlan));
  return registerPlan(deepFreeze({ admissible: true, target, before, after, actions: proposed, noop: proposed.length === 0, requiresConfirmation: proposed.some((a) => a.destructive) } as AdmissiblePlan));
}

// ── Frontieră completă ────────────────────────────────────────────────────────────────────────────────────────
export type PlanResult = { ok: true; plan: TransitionPlan } | { ok: false; reason: "invalid_input" | "unknown_profile" | "validation_unavailable" };
export function planFromRaw(rawState: unknown, rawTarget: unknown, caps: Caps): PlanResult {
  const target = parseProfileName(rawTarget);
  if (target === null) return { ok: false, reason: "unknown_profile" };
  const raw = parseRawState(rawState);
  if (raw === null) return { ok: false, reason: "invalid_input" };
  const built = buildObservation(raw, target, caps);
  if (!built.ok) return { ok: false, reason: built.reason };
  return { ok: true, plan: planProfileTransition(built.observation) };
}

// ── Rezumat + render ─────────────────────────────────────────────────────────────────────────────────────────
export interface PlanSummary { starts: number; stops: number; setEnv: number; unsetEnv: number; blockers: number; requiresConfirmation: boolean; admissible: boolean; noop: boolean; }
export function planSummary(plan: TransitionPlan): PlanSummary {
  if (!plan.admissible) { const p = plan.preview; return { starts: p.starts, stops: p.stops, setEnv: p.setEnv, unsetEnv: p.unsetEnv, blockers: plan.blockers.length, requiresConfirmation: false, admissible: false, noop: false }; }
  let starts = 0, stops = 0, setEnv = 0, unsetEnv = 0;
  for (const a of plan.actions) { if (a.kind === "start") starts++; else if (a.kind === "stop") stops++; else if (a.kind === "set_env") setEnv++; else unsetEnv++; }
  return { starts, stops, setEnv, unsetEnv, blockers: 0, requiresConfirmation: plan.requiresConfirmation, admissible: true, noop: plan.noop };
}
export function formatPlanLines(plan: TransitionPlan): string[] {
  const lines: string[] = [`profil țintă: ${plan.target}`];
  if (!plan.admissible) {
    for (const b of plan.blockers) {
      if (b.kind === "state_unknown") lines.push(`  ⛔ ${b.service}: stare curentă necunoscută`);
      else if (b.kind === "invalid_observation") lines.push(`  ⛔ observație neînregistrată`);
      else if (b.kind === "profile_incomplete") lines.push(`  ⛔ profil „${b.key}" NEfinalizat`);
      else if (b.kind === "staging_unverified") lines.push(`  ⛔ ${b.service}: binding de staging neconfirmat`);
      else if (b.kind === "env_invalid") lines.push(`  ⛔ ${b.service}: env canonic INVALID → ${b.key}`);
      else if (b.kind === "env_forbidden") lines.push(`  ⛔ ${b.service}: env INTERZIS în prod → ${b.key}`);
      else lines.push(`  ⛔ ${b.service}: env canonic lipsă → ${b.key}`);
    }
    for (const l of plan.preview.lines) lines.push("  " + l);
    lines.push("  → NEadmisibil — nu se aplică");
    return lines;
  }
  if (plan.noop) { lines.push("  (deja în stare — nimic de făcut)"); return lines; }
  for (const a of plan.actions) lines.push("  " + actionLine(a));
  if (plan.requiresConfirmation) lines.push("  → cere confirmare explicită (acțiuni distructive)");
  return lines;
}
