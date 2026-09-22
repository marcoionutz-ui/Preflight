/**
 * lib/mcp/railwayWriteReader.ts — PH-12 12.6 leaf 2c-2b-reader: reads INTERMEDIARE pentru ciclul de WRITE. rev4 (după cgpt: +2 P1 +1 P2 frontieră).
 *
 * Clientul READ 2b-2 e fail-closed pe staged și NU surfacează OCC/identificatorii de care WRITE-ul are nevoie. 2c cere DOUĂ read-uri
 * DISTINCTE, ambele pure pe transport injectat, ambele producând CAPABILITĂȚI GENUINE (registrate; clonă/spread/fabricat → respins):
 *
 *   (A) readPrepareCapability(transport, manifest, opts?) ─▶ { ok, capability: PrepareCapability } | { ok:false, reason }
 *       CITIRE COMPLETĂ, CLEAN-STATE (refuză staged), cu topologie + env + variabile. Produce, din ACEEAȘI generație (fence A↔C):
 *         • `RawState` COMPLET (via mapper-ul 2b-1) — poartă valorile de env, deci trăiește DOAR într-un REGISTRY PRIVAT;
 *         • `ObservedWriteEvidence` (proiect/env/configEtag + per rol serviceId/gitBacked/running/activeDeploymentId).
 *       Capabilitatea PUBLICĂ e OPACĂ (fără valori/secrete). RawState-ul cu valori NU e recuperabil printr-un accessor public. O SINGURĂ
 *       operație, `derivePreparedInputs(cap, target, caps)`, întoarce plan+evidence ÎMPREUNĂ (din ACEEAȘI celulă → fără împerechere din
 *       citiri diferite); `caps` TREBUIE GENUIN (`bindRoleCaps`, 2a) fiindcă `planFromRaw` invocă callback-urile caps pe env-ul LIVE — un
 *       caps fabricat ar exfiltra secretele, deci e respins ÎNAINTE de orice callback. Planul e value-blind (doar valori managed de profil).
 *
 *   (B) readWriteProgress(transport, manifest, opts?) ─▶ { ok, capability: WriteProgressCapability } | { ok:false, reason }
 *       View STAGED-AWARE, VALUE-FREE (postcondiții/recovery, §9.4 pct.10 / §9.5.4): EXPUNE `stagedPatchId`+status + `configEtag` +
 *       per rol deployment `{id,status}`. NICIODATĂ valori/payload/mesaje/diagnostics — NU citește variabile deloc.
 *
 * LOCK-URI (schema-lock §9.5.5 + cgpt rev2):
 *  [Allowlist SUBSET 2b-2] EXCLUSIV query-uri deja din `QUERIES` (2b-2): projectToken/environment/environmentStagedChanges/
 *      projectServices/serviceInstance (+ variablesForServiceDeployment ȘI deploymentSnapshot DOAR la prepare). Transportul le validează la fel.
 *  [Topologie LIVE (P1.3)] `projectServices` verificat: `hasNextPage`→refuz; serviciu nemapat→`unexpected_service`; rol lipsă/dublu→refuz;
 *      topologia intră în semnătura A↔C. Un al 6-lea serviciu live (pe care commit/apply l-ar putea afecta) NU e invizibil.
 *  [Identitate EXECUȚIE (P1.2)] fiecare `serviceInstance` validat cu helper-ul CANONIC `commandIdentityMatches` (2b-1): inline byte-exact /
 *      config_file path-exact; drift de comandă/path → refuz. Identitatea intră în semnătura A↔C → drift apărut DOAR între A și C → instabil.
 *  [Genuinitate (P1.4)] rezultatele sunt ÎNREGISTRATE (WeakMap/WeakSet privat) + predicate `isGenuine*`; deep-freeze NU dovedește
 *      proveniența → un obiect fabricat/spread e respins de accessor/predicate.
 *  [Status = uniuni ÎNCHISE (P2.3)] `EnvironmentPatchStatus`/`DeploymentStatus` validate + TIPIZATE (nu `string` liber) → clientul WRITE
 *      poate face switch exhaustiv; status necunoscut → `invalid_response`.
 *  [Manifest frozen-plain (P2.2)] `normalizeManifestShared` (2b-1) întoarce structuri PLAIN deep-frozen (fără Map/Set mutabile exportate).
 *  [Opts anti-Proxy (P2.1)] normalizare într-UN SINGUR `try` (Reflect.ownKeys + chei exacte + own data-properties) → un Proxy cu
 *      `getPrototypeOf`/`ownKeys` care aruncă → `invalid_options`, niciun throw propagat.
 *  [Fence] Read A (etag+staged+topologie+per-rol SI/identitate) → [prepare: payload variabile între brackete] → Read C; orice diferență de
 *      semnătură → `reader_unstable`, retry ≤ 3. Abort extern anulează cererea activă + DOMINĂ. Refuzuri = coduri STATICE + opțional ROL.
 *
 * PROD-SCOPED: `environment.name === "production"` (calea de WRITE 2c e prod-only). Proba §9.6 pe env DISPENSABIL e un script SEPARAT.
 */

import { QUERIES, type QueryName, type TransportErrorCode, type GraphQLTransport, type GraphQLRequest } from "./railwayReadClient";
import {
  SERVICE_CROSSCHECK, commandIdentityMatches, normalizeManifestShared, mapRailwaySnapshotToRawState,
  type SharedManifest, type RailwaySnapshot, type RailwayServiceRead,
} from "./railwayReadModel";
import { SERVICE_IDS, planFromRaw, type ServiceId, type RawState, type PlanResult } from "./profilePlan";
import { isGenuineCaps } from "./profileCaps"; // predicat DEȚINUT de fabrica de încredere (2a); core-ul pur NU poate mint-ui caps

const MAX_ATTEMPTS = 3;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RAILWAY_PREFIX = "RAILWAY_";

type ReaderQueryName = Extract<QueryName,
  "projectToken" | "environment" | "environmentStagedChanges" | "projectServices" | "serviceInstance" | "variablesForServiceDeployment" | "deploymentSnapshot">;

// ── Uniuni de status ÎNCHISE (schema-lock §9.3 / §1) — tipizate, nu `string` liber (P2.3) ─────────────────────────
export type EnvironmentPatchStatus = "STAGED" | "APPLYING" | "COMMITTED" | "FAILED";
export type DeploymentStatus =
  | "BUILDING" | "CRASHED" | "DEPLOYING" | "FAILED" | "INITIALIZING" | "NEEDS_APPROVAL"
  | "QUEUED" | "REMOVED" | "REMOVING" | "SKIPPED" | "SLEEPING" | "SUCCESS" | "WAITING";
const PATCH_STATUS: ReadonlySet<string> = new Set<EnvironmentPatchStatus>(["STAGED", "APPLYING", "COMMITTED", "FAILED"]);
const DEPLOY_STATUS: ReadonlySet<string> = new Set<DeploymentStatus>([
  "BUILDING", "CRASHED", "DEPLOYING", "FAILED", "INITIALIZING", "NEEDS_APPROVAL",
  "QUEUED", "REMOVED", "REMOVING", "SKIPPED", "SLEEPING", "SUCCESS", "WAITING",
]);
function asPatchStatus(s: unknown): EnvironmentPatchStatus | null { return typeof s === "string" && PATCH_STATUS.has(s) ? (s as EnvironmentPatchStatus) : null; }
function asDeployStatus(s: unknown): DeploymentStatus | null { return typeof s === "string" && DEPLOY_STATUS.has(s) ? (s as DeploymentStatus) : null; }

// ═══ Tipuri de ieșire ════════════════════════════════════════════════════════════════════════════════════════════
export interface ReaderDeployment { readonly id: string; readonly status: DeploymentStatus; }
export interface ReaderServiceView {
  readonly role: ServiceId; readonly serviceId: string;
  readonly activeDeployment: ReaderDeployment | null; readonly latestDeployment: ReaderDeployment | null;
}
export interface ReaderStagedView { readonly stagedPatchId: string; readonly status: EnvironmentPatchStatus; } // ownership NEAFIRMAT (Q7)
export interface WriteProgressView {
  readonly projectId: string; readonly environmentId: string; readonly configEtag: string;
  readonly staged: ReaderStagedView; readonly services: readonly ReaderServiceView[];
}
/** ObservedWriteEvidence (§9.5.1) — identificatori live, FĂRĂ secrete. Consumat de prepareWrite prin `derivePreparedInputs`. */
export interface EvidenceService {
  readonly serviceId: string; readonly gitBacked: boolean; readonly running: boolean; readonly activeDeploymentId: string | null;
}
export interface ObservedWriteEvidence {
  readonly projectId: string; readonly environmentId: string; readonly configEtag: string;
  readonly services: Readonly<Record<ServiceId, EvidenceService>>;
}

// ── Capabilități GENUINE (registrate; clonă/spread/fabricat → respins) ────────────────────────────────────────────
export interface PrepareCapability { readonly kind: "prepare"; readonly projectId: string; readonly environmentId: string; readonly configEtag: string; }
export interface WriteProgressCapability { readonly kind: "progress"; readonly view: WriteProgressView; }
const PREPARE_REGISTRY = new WeakMap<object, { readonly rawState: RawState; readonly evidence: ObservedWriteEvidence }>();
const PROGRESS_REGISTRY = new WeakSet<object>();
export function isGenuinePrepareCapability(c: unknown): c is PrepareCapability { return typeof c === "object" && c !== null && PREPARE_REGISTRY.has(c as object); }
export function isGenuineWriteProgress(c: unknown): c is WriteProgressCapability { return typeof c === "object" && c !== null && PROGRESS_REGISTRY.has(c as object); }
/**
 * ⚠️ RawState (care poartă VALORILE de env) NU e recuperabil printr-un accessor public. O SINGURĂ operație consumă capabilitatea,
 * returnând plan+evidence ÎMPREUNĂ (value-blind), din ACEEAȘI celulă (aceeași generație) — imposibil de împerecheat un plan cu un
 * evidence din citiri diferite. `caps` TREBUIE să fie GENUIN (`bindRoleCaps`, 2a): fiindcă `planFromRaw` invocă `caps.validateService`/
 * `caps.isStagingSupabase` pe env-ul LIVE, un caps FABRICAT ar exfiltra secretele → e respins ÎNAINTE de orice callback.
 */
export interface PreparedInputs { readonly plan: PlanResult; readonly evidence: ObservedWriteEvidence; }
// Registrul PERECHILOR: doar o pereche emisă de `derivePreparedInputs` (plan+evidence din ACEEAȘI citire) e genuină. O pereche
// asamblată manual — `{plan: A.plan, evidence: B.evidence}` — e un OBIECT NOU, absent → downstream-ul (2c-2b-prepare) o respinge.
const PREPARED_REGISTRY = new WeakSet<object>();
export function isGenuinePreparedInputs(x: unknown): x is PreparedInputs { return typeof x === "object" && x !== null && PREPARED_REGISTRY.has(x as object); }
export function derivePreparedInputs(c: unknown, target: unknown, caps: unknown): PreparedInputs | null {
  if (!isGenuinePrepareCapability(c)) return null;
  if (!isGenuineCaps(caps)) return null;                  // caps fabricat/necunoscut → refuz ÎNAINTE de a rula vreun callback pe secrete
  const cell = PREPARE_REGISTRY.get(c as object);
  if (!cell) return null;
  const plan = planFromRaw(cell.rawState, target, caps);  // caps genuin → callback-uri de încredere; RawState-ul nu părăsește modulul
  const pair = deepFreeze({ plan, evidence: cell.evidence }); // pereche plan↔evidence din aceeași citire
  PREPARED_REGISTRY.add(pair);
  return pair;
}

// ── Rezultate (refuzuri = coduri STATICE + opțional ROL; niciodată UUID extern / status brut / valoare) ───────────
export type ReaderRejectReason =
  | { readonly kind: "invalid_manifest" }
  | { readonly kind: "invalid_options" }
  | { readonly kind: "aborted" }
  | { readonly kind: "transport_error"; readonly at: ReaderQueryName; readonly code: TransportErrorCode }
  | { readonly kind: "invalid_response"; readonly at: ReaderQueryName }
  | { readonly kind: "wrong_scope" }
  | { readonly kind: "topology_truncated" }
  | { readonly kind: "unexpected_service" }
  | { readonly kind: "topology_incomplete" }
  | { readonly kind: "ambiguous_active_deployments"; readonly service: ServiceId }
  | { readonly kind: "identity_drift"; readonly service: ServiceId }
  | { readonly kind: "staged_changes" }
  | { readonly kind: "staged_indeterminate" }
  | { readonly kind: "prepare_mapping_failed" }
  | { readonly kind: "evidence_incoherent"; readonly service: ServiceId }
  | { readonly kind: "running_stale_drift"; readonly service: ServiceId }
  | { readonly kind: "reader_unstable" };
export type PrepareResult = { readonly ok: true; readonly capability: PrepareCapability } | { readonly ok: false; readonly reason: ReaderRejectReason };
export type ProgressResult = { readonly ok: true; readonly capability: WriteProgressCapability } | { readonly ok: false; readonly reason: ReaderRejectReason };

export interface ReaderOptions { readonly maxAttempts?: number; readonly signal?: AbortSignal; }

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  Parse defensiv
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function hasExactKeys(o: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(o);
  if (keys.length !== expected.length) return false;
  for (const e of expected) if (!Object.hasOwn(o, e)) return false;
  return true;
}
function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isId(v: unknown): v is string { return typeof v === "string" && ID_RE.test(v); }
function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object") { for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v); Object.freeze(o); }
  return o;
}

function parseDeployment(v: unknown): ReaderDeployment | null | "err" {
  if (v === null) return null;
  if (!isPlainObject(v) || !hasExactKeys(v, ["id", "status"])) return "err";
  const { id, status } = v as { id: unknown; status: unknown };
  const st = asDeployStatus(status);
  if (!isId(id) || st === null) return "err";
  return { id, status: st };
}
interface ParsedSI {
  readonly serviceId: string; readonly name: string;
  readonly startCommand: string | null; readonly railwayConfigFile: string | null;
  readonly latest: ReaderDeployment | null; readonly active: readonly ReaderDeployment[];
}
function parseServiceInstance(data: unknown): ParsedSI | null {
  if (!isPlainObject(data)) return null;
  const si = data.serviceInstance;
  if (!isPlainObject(si) || !hasExactKeys(si, ["serviceId", "serviceName", "startCommand", "railwayConfigFile", "latestDeployment", "activeDeployments"])) return null;
  const { serviceId, serviceName, startCommand, railwayConfigFile, activeDeployments } = si as Record<string, unknown>;
  if (!isId(serviceId)) return null;
  if (typeof serviceName !== "string") return null;
  if (startCommand !== null && typeof startCommand !== "string") return null;
  if (railwayConfigFile !== null && typeof railwayConfigFile !== "string") return null;
  const latest = parseDeployment(si.latestDeployment); if (latest === "err") return null;
  if (!Array.isArray(activeDeployments)) return null;
  const active: ReaderDeployment[] = [];
  for (const d of activeDeployments) { const p = parseDeployment(d); if (p === null || p === "err") return null; active.push(p); }
  return { serviceId, name: serviceName, startCommand: startCommand as string | null, railwayConfigFile: railwayConfigFile as string | null, latest, active };
}
function parseProjectToken(data: unknown): { projectId: string; environmentId: string } | null {
  if (!isPlainObject(data)) return null;
  const t = data.projectToken;
  if (!isPlainObject(t) || !hasExactKeys(t, ["projectId", "environmentId"])) return null;
  const { projectId, environmentId } = t as Record<string, unknown>;
  if (!isId(projectId) || !isId(environmentId)) return null;
  return { projectId, environmentId };
}
function parseEnvironment(data: unknown): { id: string; name: string; configEtag: string } | null {
  if (!isPlainObject(data)) return null;
  const e = data.environment;
  if (!isPlainObject(e) || !hasExactKeys(e, ["id", "name", "configEtag", "unmergedChangesCount"])) return null;
  const { id, name, configEtag, unmergedChangesCount } = e as Record<string, unknown>;
  if (!isId(id) || typeof name !== "string" || !isNonEmptyString(configEtag)) return null;
  // forma lui `unmergedChangesCount` e validată (null sau întreg sigur ≥0) chiar dacă nu-l folosim — un tip neașteptat = răspuns malformat.
  if (unmergedChangesCount !== null && !(Number.isSafeInteger(unmergedChangesCount) && (unmergedChangesCount as number) >= 0)) return null;
  return { id, name, configEtag };
}
function parseScalarVars(v: unknown): Record<string, string | null> | null {
  if (!isPlainObject(v)) return null;
  const out: Record<string, string | null> = Object.create(null);
  for (const [k, val] of Object.entries(v)) {
    if (val === null) out[k] = null;
    else if (typeof val === "string") out[k] = val;
    else return null;
  }
  return out;
}
function parseDeploymentSnapshot(data: unknown): { id: string; vars: Record<string, string | null> } | null {
  if (!isPlainObject(data)) return null;
  const ds = data.deploymentSnapshot;
  if (!isPlainObject(ds) || !hasExactKeys(ds, ["id", "variables"])) return null;
  const { id } = ds as Record<string, unknown>;
  if (!isId(id)) return null;
  const vars = parseScalarVars((ds as Record<string, unknown>).variables);
  return vars === null ? null : { id, vars };
}
function nonRailway(m: Record<string, string | null>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [k, v] of Object.entries(m)) if (!k.startsWith(RAILWAY_PREFIX)) out.set(k, v);
  return out;
}
function varMapsEqual(a: Map<string, string | null>, b: Map<string, string | null>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) { if (!b.has(k) || b.get(k) !== v) return false; }
  return true;
}
function parseStaged(data: unknown): ReaderStagedView | null {
  if (!isPlainObject(data)) return null;
  const sc = data.environmentStagedChanges;
  if (!isPlainObject(sc) || !hasExactKeys(sc, ["id", "status"])) return null;
  const { id, status } = sc as Record<string, unknown>;
  const st = asPatchStatus(status);
  if (!isId(id) || st === null) return null;
  return { stagedPatchId: id, status: st };
}
function parseProjectServices(data: unknown): { services: { id: string; name: string }[]; hasNextPage: boolean } | null {
  if (!isPlainObject(data)) return null;
  const p = data.project;
  if (!isPlainObject(p) || !hasExactKeys(p, ["services"])) return null;
  const svc = p.services;
  if (!isPlainObject(svc) || !hasExactKeys(svc, ["edges", "pageInfo"])) return null;
  const { edges, pageInfo } = svc as Record<string, unknown>;
  if (!Array.isArray(edges)) return null;
  if (!isPlainObject(pageInfo) || !hasExactKeys(pageInfo, ["hasNextPage"])) return null;
  const hnp = (pageInfo as Record<string, unknown>).hasNextPage;
  if (typeof hnp !== "boolean") return null;
  const services: { id: string; name: string }[] = [];
  for (const edge of edges) {
    if (!isPlainObject(edge) || !hasExactKeys(edge, ["node"])) return null;
    const node = (edge as Record<string, unknown>).node;
    if (!isPlainObject(node) || !hasExactKeys(node, ["id", "name"])) return null;
    const { id, name } = node as Record<string, unknown>;
    if (!isId(id) || typeof name !== "string") return null;
    services.push({ id, name });
  }
  return { services, hasNextPage: hnp };
}
function parseVars(data: unknown): Record<string, string | null> | null {
  if (!isPlainObject(data) || !Object.hasOwn(data, "variablesForServiceDeployment")) return null;
  return parseScalarVars(data.variablesForServiceDeployment);
}

// ── Semnătură fence (INJECTIVĂ) ──────────────────────────────────────────────────────────────────────────────────
function depTuple(d: ReaderDeployment | null): readonly [string, string] | null { return d === null ? null : [d.id, d.status]; }
function topologyOf(services: readonly { id: string; name: string }[]): string {
  return JSON.stringify(services.map((s) => [s.id, s.name] as [string, string]).slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  Orchestrare PURĂ
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
function isAbortedSignal(signal?: AbortSignal): boolean { return signal?.aborted === true; }

async function call(transport: GraphQLTransport, name: ReaderQueryName, variables: Record<string, string>, signal?: AbortSignal): Promise<{ ok: true; data: unknown } | { ok: false; reason: ReaderRejectReason }> {
  if (isAbortedSignal(signal)) return { ok: false, reason: { kind: "aborted" } };
  const req: GraphQLRequest = signal ? { name, query: QUERIES[name], variables, signal } : { name, query: QUERIES[name], variables };
  let r: { ok: true; data: unknown } | { ok: false; code: TransportErrorCode };
  try { r = await transport(req); }
  catch { return { ok: false, reason: { kind: "transport_error", at: name, code: "network_error" } }; }
  if (isAbortedSignal(signal)) return { ok: false, reason: { kind: "aborted" } }; // abort domină
  if (!r.ok) return { ok: false, reason: { kind: "transport_error", at: name, code: r.code } };
  return { ok: true, data: r.data };
}

interface RoleSignal { readonly role: ServiceId; readonly si: ParsedSI; readonly active: ReaderDeployment | null; readonly identityOk: boolean; }
interface Signals { readonly configEtag: string; readonly staged: ReaderStagedView; readonly topologySig: string; readonly roles: readonly RoleSignal[]; }

/** O trecere: scope vet + env(configEtag,name==production) + staged(EXPUS) + topologie LIVE + per-rol serviceInstance (identitate+colaps). */
async function collectSignals(transport: GraphQLTransport, m: SharedManifest, signal?: AbortSignal): Promise<{ ok: true; signals: Signals } | { ok: false; reason: ReaderRejectReason }> {
  const { projectId, environmentId } = m;

  const rTok = await call(transport, "projectToken", {}, signal);
  if (!rTok.ok) return rTok;
  const tok = parseProjectToken(rTok.data);
  if (tok === null) return { ok: false, reason: { kind: "invalid_response", at: "projectToken" } };
  if (tok.projectId !== projectId || tok.environmentId !== environmentId) return { ok: false, reason: { kind: "wrong_scope" } };

  const rEnv = await call(transport, "environment", { e: environmentId, p: projectId }, signal);
  if (!rEnv.ok) return rEnv;
  const env = parseEnvironment(rEnv.data);
  if (env === null) return { ok: false, reason: { kind: "invalid_response", at: "environment" } };
  if (env.id !== environmentId || env.name !== "production") return { ok: false, reason: { kind: "wrong_scope" } };

  const rStaged = await call(transport, "environmentStagedChanges", { e: environmentId }, signal);
  if (!rStaged.ok) return rStaged;
  const staged = parseStaged(rStaged.data);
  if (staged === null) return { ok: false, reason: { kind: "invalid_response", at: "environmentStagedChanges" } };

  // Topologie LIVE (P1.3): trunchiere→refuz; fiecare serviciu live ∈ manifest; dedup; EXACT rolurile manifestului.
  const rTop = await call(transport, "projectServices", { p: projectId }, signal);
  if (!rTop.ok) return rTop;
  const top = parseProjectServices(rTop.data);
  if (top === null) return { ok: false, reason: { kind: "invalid_response", at: "projectServices" } };
  if (top.hasNextPage) return { ok: false, reason: { kind: "topology_truncated" } };
  const liveIds = new Set<string>();
  for (const s of top.services) {
    if (liveIds.has(s.id)) return { ok: false, reason: { kind: "unexpected_service" } };  // id duplicat în topologie
    liveIds.add(s.id);
    if (!Object.hasOwn(m.byUuid, s.id)) return { ok: false, reason: { kind: "unexpected_service" } }; // serviciu live nemapat
  }
  for (const role of SERVICE_IDS) if (!liveIds.has(m.byRole[role])) return { ok: false, reason: { kind: "topology_incomplete" } };
  const topologySig = topologyOf(top.services);

  // Per rol: serviceInstance prin UUID din manifest (identitate = manifest, confirmată de serviceId returnat + comandă canonică).
  const roles: RoleSignal[] = [];
  for (const role of SERVICE_IDS) {
    const uuid = m.byRole[role];
    const r = await call(transport, "serviceInstance", { e: environmentId, s: uuid }, signal);
    if (!r.ok) return r;
    const si = parseServiceInstance(r.data);
    if (si === null || si.serviceId !== uuid) return { ok: false, reason: { kind: "invalid_response", at: "serviceInstance" } };
    if (si.active.length > 1) return { ok: false, reason: { kind: "ambiguous_active_deployments", service: role } };
    const identityOk = commandIdentityMatches(SERVICE_CROSSCHECK[role], si.startCommand, si.railwayConfigFile);
    roles.push({ role, si, active: si.active.length === 1 ? si.active[0] : null, identityOk });
  }
  return { ok: true, signals: { configEtag: env.configEtag, staged, topologySig, roles } };
}

function signatureOf(s: Signals): string {
  return JSON.stringify([
    s.configEtag, s.staged.stagedPatchId, s.staged.status, s.topologySig,
    s.roles.map((r) => [r.role, r.si.serviceId, r.si.name, r.si.startCommand, r.si.railwayConfigFile, depTuple(r.active), depTuple(r.si.latest)]),
  ]);
}

interface RolePayload { readonly vars: Record<string, string | null>; readonly snapVars: Record<string, string | null> | null; }
/** Citește PAYLOAD-ul de env (variabile rendered) + snapshot-ul deployment-ului activ per rol. Value-bearing → ține-l INTERN. */
async function collectPayload(transport: GraphQLTransport, m: SharedManifest, signal: AbortSignal | undefined, roles: readonly RoleSignal[]): Promise<{ ok: true; byRole: Map<ServiceId, RolePayload> } | { ok: false; reason: ReaderRejectReason }> {
  const byRole = new Map<ServiceId, RolePayload>();
  for (const r of roles) {
    const rv = await call(transport, "variablesForServiceDeployment", { e: m.environmentId, p: m.projectId, s: r.si.serviceId }, signal);
    if (!rv.ok) return rv;
    const vars = parseVars(rv.data);
    if (vars === null) return { ok: false, reason: { kind: "invalid_response", at: "variablesForServiceDeployment" } };
    let snapVars: Record<string, string | null> | null = null;
    if (r.active !== null) {
      const rd = await call(transport, "deploymentSnapshot", { d: r.active.id }, signal);
      if (!rd.ok) return rd;
      const ds = parseDeploymentSnapshot(rd.data);
      if (ds === null || ds.id !== r.active.id) return { ok: false, reason: { kind: "invalid_response", at: "deploymentSnapshot" } };
      snapVars = ds.vars;
    }
    byRole.set(r.role, { vars, snapVars });
  }
  return { ok: true, byRole };
}
/** Semnătură INJECTIVĂ a payload-ului (P1.3): variabilele intră în fence, deci o schimbare cu etag/staged/tuple neschimbate → instabil. */
function payloadSig(byRole: Map<ServiceId, RolePayload>, roles: readonly RoleSignal[]): string {
  const sortEntries = (o: Record<string, string | null>) => Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(roles.map((r) => { const p = byRole.get(r.role)!; return [r.role, sortEntries(p.vars), p.snapVars ? sortEntries(p.snapVars) : null]; }));
}

/** Trecere fenced comună (A → [payload] → C). `requireClean` = prepare (refuză staged); `readPayload` = citește variabile+snapshot (prepare). */
async function fencedAttempt(
  transport: GraphQLTransport, m: SharedManifest, signal: AbortSignal | undefined,
  cfg: { requireClean: boolean; readPayload: boolean },
): Promise<{ ok: true; signals: Signals; payload: Map<ServiceId, RolePayload> | null } | { ok: false; reason: ReaderRejectReason; retriable: boolean }> {
  const A = await collectSignals(transport, m, signal);
  if (!A.ok) return { ok: false, reason: A.reason, retriable: false };
  // identitate PERSISTENTĂ (drift prezent chiar în A) → refuz dur (P1.2)
  for (const r of A.signals.roles) if (!r.identityOk) return { ok: false, reason: { kind: "identity_drift", service: r.role }, retriable: false };
  // staged policy
  if (cfg.requireClean) {
    const st = A.signals.staged.status;
    if (st === "STAGED" || st === "APPLYING") return { ok: false, reason: { kind: "staged_changes" }, retriable: false };
    if (st !== "COMMITTED") return { ok: false, reason: { kind: "staged_indeterminate" }, retriable: false }; // FAILED
  }
  // payload (prepare) — ÎNTRE brackete; citit ȘI în A ȘI în C și INCLUS în semnătură → o schimbare de env fără etag/staged/tuple e prinsă.
  let payloadA: Map<ServiceId, RolePayload> | null = null;
  if (cfg.readPayload) {
    const pa = await collectPayload(transport, m, signal, A.signals.roles);
    if (!pa.ok) return { ok: false, reason: pa.reason, retriable: false };
    payloadA = pa.byRole;
  }
  const C = await collectSignals(transport, m, signal);
  if (!C.ok) return { ok: false, reason: C.reason, retriable: false };
  let sigA = signatureOf(A.signals), sigC = signatureOf(C.signals);
  if (cfg.readPayload) {
    const pc = await collectPayload(transport, m, signal, C.signals.roles);
    if (!pc.ok) return { ok: false, reason: pc.reason, retriable: false };
    sigA += payloadSig(payloadA!, A.signals.roles);
    sigC += payloadSig(pc.byRole, C.signals.roles);
  }
  if (sigA !== sigC) return { ok: false, reason: { kind: "reader_unstable" }, retriable: true };
  return { ok: true, signals: A.signals, payload: payloadA };
}

// ── Normalizare opts (UN singur try; Reflect.ownKeys; own data-properties) — P2.1 ────────────────────────────────
function normalizeOpts(opts: unknown): { ok: true; maxAttempts: number; signal: AbortSignal | undefined } | { ok: false } {
  try {
    if (opts === undefined || opts === null) return { ok: true, maxAttempts: MAX_ATTEMPTS, signal: undefined };
    if (!isPlainObject(opts)) return { ok: false };
    for (const k of Reflect.ownKeys(opts)) if (k !== "maxAttempts" && k !== "signal") return { ok: false };
    const maDesc = Object.getOwnPropertyDescriptor(opts, "maxAttempts");
    const sigDesc = Object.getOwnPropertyDescriptor(opts, "signal");
    if (maDesc && (typeof maDesc.get === "function" || typeof maDesc.set === "function")) return { ok: false };
    if (sigDesc && (typeof sigDesc.get === "function" || typeof sigDesc.set === "function")) return { ok: false };
    const ma = maDesc ? maDesc.value : undefined;
    const sig = sigDesc ? sigDesc.value : undefined;
    let maxAttempts: number;
    if (ma === undefined) maxAttempts = MAX_ATTEMPTS;
    else if (Number.isInteger(ma) && (ma as number) >= 1) maxAttempts = Math.min(ma as number, MAX_ATTEMPTS);
    else return { ok: false };
    if (sig !== undefined && !(sig instanceof AbortSignal)) return { ok: false };
    return { ok: true, maxAttempts, signal: sig as AbortSignal | undefined };
  } catch { return { ok: false }; }
}

function normManifest(manifest: unknown): SharedManifest | null {
  let sm: SharedManifest | null;
  try { sm = normalizeManifestShared(manifest); } catch { return null; }
  if (sm === null) return null;
  for (const role of SERVICE_IDS) if (sm.commandSource[role] !== SERVICE_CROSSCHECK[role].commandSource) return null; // == catalog canonic
  return sm;
}

// ═══ Publice ═════════════════════════════════════════════════════════════════════════════════════════════════════
export async function readWriteProgress(transport: GraphQLTransport, manifest: unknown, opts: ReaderOptions = {}): Promise<ProgressResult> {
  const no = normalizeOpts(opts);
  if (!no.ok) return deepFreeze({ ok: false, reason: { kind: "invalid_options" } });
  const m = normManifest(manifest);
  if (m === null) return deepFreeze({ ok: false, reason: { kind: "invalid_manifest" } });
  try {
    for (let i = 0; i < no.maxAttempts; i++) {
      if (isAbortedSignal(no.signal)) return deepFreeze({ ok: false, reason: { kind: "aborted" } });
      const a = await fencedAttempt(transport, m, no.signal, { requireClean: false, readPayload: false });
      if (a.ok) {
        const view: WriteProgressView = {
          projectId: m.projectId, environmentId: m.environmentId, configEtag: a.signals.configEtag, staged: a.signals.staged,
          services: a.signals.roles.map((r) => ({ role: r.role, serviceId: r.si.serviceId, activeDeployment: r.active, latestDeployment: r.si.latest })),
        };
        const capability = deepFreeze({ kind: "progress" as const, view });
        PROGRESS_REGISTRY.add(capability);
        return { ok: true, capability };
      }
      if (a.retriable) continue;
      return deepFreeze({ ok: false, reason: a.reason });
    }
    return deepFreeze({ ok: false, reason: { kind: "reader_unstable" } });
  } catch { return deepFreeze({ ok: false, reason: { kind: "reader_unstable" } }); }
}

export async function readPrepareCapability(transport: GraphQLTransport, manifest: unknown, opts: ReaderOptions = {}): Promise<PrepareResult> {
  const no = normalizeOpts(opts);
  if (!no.ok) return deepFreeze({ ok: false, reason: { kind: "invalid_options" } });
  const m = normManifest(manifest);
  if (m === null) return deepFreeze({ ok: false, reason: { kind: "invalid_manifest" } });
  try {
    for (let i = 0; i < no.maxAttempts; i++) {
      if (isAbortedSignal(no.signal)) return deepFreeze({ ok: false, reason: { kind: "aborted" } });
      const a = await fencedAttempt(transport, m, no.signal, { requireClean: true, readPayload: true });
      if (!a.ok) { if (a.retriable) continue; return deepFreeze({ ok: false, reason: a.reason }); }
      const payload = a.payload!;

      // Drift running-stale (P1.2): pentru un serviciu ACTIV, configul rendered (non-`RAILWAY_*`) trebuie să == snapshot-ul deploy-ului activ.
      for (const r of a.signals.roles) {
        const p = payload.get(r.role)!;
        if (r.active !== null && p.snapVars !== null && !varMapsEqual(nonRailway(p.vars), nonRailway(p.snapVars))) {
          return deepFreeze({ ok: false, reason: { kind: "running_stale_drift", service: r.role } });
        }
      }

      // Construiește RailwaySnapshot din ACEEAȘI generație → RawState via mapper-ul 2b-1.
      const services: RailwayServiceRead[] = a.signals.roles.map((r) => ({
        serviceId: r.si.serviceId, name: r.si.name, startCommand: r.si.startCommand, railwayConfigFile: r.si.railwayConfigFile,
        activeDeployment: r.active, latestDeployment: r.si.latest, hasStagedChanges: false, variables: payload.get(r.role)!.vars,
      }));
      const snapshot: RailwaySnapshot = { projectId: m.projectId, environmentId: m.environmentId, hasStagedChanges: false, services };
      // Manifest CANONIC din `m` (frozen, deja validat) — NU re-citim inputul brut `manifest` după I/O (anti-TOCTOU, P2). DEEP-FROZEN efectiv.
      const canonicalManifest = deepFreeze({ projectId: m.projectId, environmentId: m.environmentId, serviceIds: { ...m.byRole }, commandSource: { ...m.commandSource } });
      const mapped = mapRailwaySnapshotToRawState(snapshot, canonicalManifest);
      if (!mapped.ok) return deepFreeze({ ok: false, reason: { kind: "prepare_mapping_failed" } });
      const rawState = mapped.rawState;
      for (const role of SERVICE_IDS) if (!Object.hasOwn(rawState, role)) return deepFreeze({ ok: false, reason: { kind: "prepare_mapping_failed" } }); // rol omis (running unknown etc.)

      // ObservedWriteEvidence + coerență running ⟺ activeDeploymentId (§9.5.1). `gitBacked` = SURSĂ CANONICĂ (SERVICE_CROSSCHECK), nu catalog paralel.
      const evServices: Record<string, EvidenceService> = Object.create(null);
      for (const r of a.signals.roles) {
        const running = rawState[r.role]!.running;
        const activeDeploymentId = r.active ? r.active.id : null;
        if (running !== (activeDeploymentId !== null)) return deepFreeze({ ok: false, reason: { kind: "evidence_incoherent", service: r.role } });
        evServices[r.role] = { serviceId: r.si.serviceId, gitBacked: SERVICE_CROSSCHECK[r.role].gitBacked, running, activeDeploymentId };
      }
      const evidence: ObservedWriteEvidence = deepFreeze({
        projectId: m.projectId, environmentId: m.environmentId, configEtag: a.signals.configEtag,
        services: evServices as Record<ServiceId, EvidenceService>,
      });

      // Capabilitate PUBLICĂ opacă (fără valori); internals (rawState cu valori + evidence) → REGISTRY PRIVAT.
      const capability = deepFreeze({ kind: "prepare" as const, projectId: m.projectId, environmentId: m.environmentId, configEtag: a.signals.configEtag });
      PREPARE_REGISTRY.set(capability, { rawState, evidence });
      return { ok: true, capability };
    }
    return deepFreeze({ ok: false, reason: { kind: "reader_unstable" } });
  } catch { return deepFreeze({ ok: false, reason: { kind: "reader_unstable" } }); }
}
