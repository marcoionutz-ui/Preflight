/**
 * lib/mcp/railwayReadClient.ts — PH-12 12.6 leaf 2b-2: clientul READ-ONLY Railway GraphQL v2. rev5 (după cgpt: +4 P1 +3 P2 adversariale).
 *
 * ROL: citește live starea proiectului Preflight (read-only, zero apply, zero pornire de workeri) și produce un
 *      `RailwaySnapshot` STRICT — exact forma pe care mapper-ul pur 2b-1 (`railwayReadModel.ts`) o consumă. Orchestrarea e
 *      PURĂ (transport INJECTAT) → hermetic-testabilă fără rețea. Transportul real e un factory separat (`makeRailwayTransport`).
 *
 *   readRailwaySnapshot(transport, manifest, opts?) ─▶ { ok:true, snapshot } | { ok:false, reason }   (DEEP-FROZEN)
 *        snapshot ──mapRailwaySnapshotToRawState(snapshot, manifest)──▶ RawState (leaf 2b-1)
 *
 * LOCK-URI (schema-lock 2b-2a + cgpt rev1..rev4). rev5 (adversarial):
 *  [Allowlist FĂRĂ TOCTOU] transportul citește `req.{name,query,variables,signal}` O SINGURĂ DATĂ în locale, validează allowlist-ul
 *      pe valoarea capturată, apoi construiește corpul din ACEEAȘI valoare — un getter care întoarce canonic la prima citire și o
 *      mutație la a doua nu poate strecura o mutație (o singură citire). Getter ostil pe request → cod static, fără fetch.
 *  [Abort anulează cererea ACTIVĂ] `opts.signal` e propagat în request și legat de `AbortController`-ul transportului → o cerere
 *      never-resolving e anulată la abort extern; `call` face și `Promise.race` cu abort → operația se termină IMEDIAT cu `aborted`.
 *  [Semnătură INJECTIVĂ] `signatureOf`/`topologyOf`/tuple folosesc `JSON.stringify` pe structuri (nu concatenare cu delimitatori) →
 *      două stări distincte NU pot colide (nicio ambiguitate de frontieră între câmpuri).
 *  [Getteri ostili izolați] `opts`, `RailwayTransportOptions` și `GraphQLRequest` sunt citite defensiv (o dată, în try/catch);
 *      un getter care aruncă → rezultat/cod STATIC (`invalid_options`/`invalid_manifest`/`blocked_query` / eroare de config cu mesaj
 *      FIX), niciodată ecoul mesajului atacatorului.
 *  [commandSource == catalog] manifestul trebuie să declare `commandSource[rol] === SERVICE_CROSSCHECK[rol].commandSource` (nu doar enum
 *      valid) — altfel `invalid_manifest` ÎNAINTE de orice I/O.
 *  [maxAttempts strict] doar `undefined` → implicit; `0`/negativ/fracție/NaN → `invalid_options` (fail-closed, fără „reparare tăcută").
 *  [body_unavailable] lipsa stream-ului → cod semantic `body_unavailable` (NU `oversized`), `res.text()` NEapelat.
 *
 * Fence: Read A (token+env E0+staged S0+topologie P0 + semnătură SIG0 per-serviciu) → Read B (rendered + deploymentSnapshot) →
 *   Read C (env-level bracket început → semnături → env-level bracket final). Orice diferență (etag/staged/topologie/semnătură) →
 *   `snapshot_unstable`, retry ≤ 3 (plafon dur). Semnătura include serviceId/serviceName/startCommand/railwayConfigFile/tuple.
 * Staged fail-closed pe status; activeDeployments colaps (>1→`ambiguous_active_deployments`); topologie UUID-first (hasNextPage/dup/
 *   unexpected); drift running-stale byte-exact non-`RAILWAY_*`. Refuzuri = coduri statice, FĂRĂ UUID extern (rol, nu UUID).
 * Buget global: max 3 încercări + `opts.signal` (AbortSignal) → `aborted`.
 *
 * TRANSPORT REAL: endpoint FIX, header `Project-Access-Token` (NU Bearer), `redirect:"error"`, timeout+AbortSignal (acoperă corpul,
 *   propagă abort-ul extern), citire mărginită NEocolibilă, envelope validat, orice eșec → COD STATIC (fără corp/mesaj). Token în closure.
 */

import { SERVICE_IDS, type ServiceId } from "./profilePlan";
import { SERVICE_CROSSCHECK } from "./railwayReadModel";
import type { RailwaySnapshot, RailwayServiceRead, RailwayDeployment } from "./railwayReadModel";

// ── Endpoint & implicite/plafoane ────────────────────────────────────────────────────────────────────────────────
const RAILWAY_ENDPOINT = "https://backboard.railway.com/graphql/v2";
const DEFAULT_TIMEOUT_MS = 15_000, MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 2_000_000, MAX_BYTES_CAP = 10_000_000;
const MAX_ATTEMPTS = 3;
const RAILWAY_PREFIX = "RAILWAY_";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ── Contract de transport (INJECTAT) ────────────────────────────────────────────────────────────────────────────
export type QueryName =
  | "projectToken" | "environment" | "environmentStagedChanges" | "projectServices"
  | "serviceInstance" | "variablesForServiceDeployment" | "deploymentSnapshot";

export type TransportErrorCode =
  | "http_error" | "graphql_errors" | "parse_error" | "invalid_structure"
  | "oversized" | "body_unavailable" | "timeout" | "network_error" | "blocked_query";

export interface GraphQLRequest {
  readonly name: QueryName;
  readonly query: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal; // propagat de orchestrare → anulează cererea activă la abort extern
}
export type TransportResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: TransportErrorCode };
export type GraphQLTransport = (req: GraphQLRequest) => Promise<TransportResult>;

// ── Query-uri (selecții EXACTE din schema-lock) — allowlist autoritară ───────────────────────────────────────────
export const QUERIES: Readonly<Record<QueryName, string>> = Object.freeze({
  projectToken: "query { projectToken { projectId environmentId } }",
  environment: "query($e:String!,$p:String){ environment(id:$e, projectId:$p){ id name configEtag unmergedChangesCount } }",
  environmentStagedChanges: "query($e:String!){ environmentStagedChanges(environmentId:$e){ id status } }",
  projectServices: "query($p:String!){ project(id:$p){ services(first:100){ edges{ node{ id name } } pageInfo{ hasNextPage } } } }",
  serviceInstance: "query($e:String!,$s:String!){ serviceInstance(environmentId:$e, serviceId:$s){ serviceId serviceName startCommand railwayConfigFile latestDeployment{ id status } activeDeployments{ id status } } }",
  variablesForServiceDeployment: "query($e:String!,$p:String!,$s:String!){ variablesForServiceDeployment(environmentId:$e, projectId:$p, serviceId:$s) }",
  deploymentSnapshot: "query($d:String!){ deploymentSnapshot(deploymentId:$d){ id variables } }",
});
const QUERY_NAMES: ReadonlySet<string> = new Set(Object.keys(QUERIES));

// ── Rezultatul clientului (fără UUID extern în refuzuri) ─────────────────────────────────────────────────────────
export type ClientRejectReason =
  | { readonly kind: "invalid_manifest" }
  | { readonly kind: "invalid_options" }
  | { readonly kind: "aborted" }
  | { readonly kind: "transport_error"; readonly at: QueryName; readonly code: TransportErrorCode }
  | { readonly kind: "invalid_response"; readonly at: QueryName }
  | { readonly kind: "wrong_scope" }
  | { readonly kind: "topology_truncated" }
  | { readonly kind: "unexpected_service" }
  | { readonly kind: "ambiguous_active_deployments"; readonly service: ServiceId }
  | { readonly kind: "staged_changes" }
  | { readonly kind: "staged_indeterminate" }
  | { readonly kind: "running_stale_drift"; readonly service: ServiceId }
  | { readonly kind: "snapshot_unstable" };
export type ClientResult =
  | { readonly ok: true; readonly snapshot: RailwaySnapshot }
  | { readonly ok: false; readonly reason: ClientRejectReason };

export interface ReadOptions { readonly maxAttempts?: number; readonly signal?: AbortSignal; }

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

function parseScalarVarMap(v: unknown): Record<string, string | null> | null {
  if (!isPlainObject(v)) return null;
  const out: Record<string, string | null> = Object.create(null);
  for (const [k, val] of Object.entries(v)) {
    if (val === null) out[k] = null;
    else if (typeof val === "string") out[k] = val;
    else return null;
  }
  return out;
}
function parseDeployment(v: unknown): RailwayDeployment | null | "err" {
  if (v === null) return null;
  if (!isPlainObject(v) || !hasExactKeys(v, ["id", "status"])) return "err";
  const { id, status } = v as { id: unknown; status: unknown };
  if (!isId(id) || !isNonEmptyString(status)) return "err";
  return { id, status };
}

interface ParsedServiceInstance {
  readonly serviceId: string; readonly serviceName: string;
  readonly startCommand: string | null; readonly railwayConfigFile: string | null;
  readonly latestDeployment: RailwayDeployment | null; readonly activeDeployments: readonly RailwayDeployment[];
}
function parseServiceInstance(data: unknown): ParsedServiceInstance | null {
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
  const active: RailwayDeployment[] = [];
  for (const d of activeDeployments) { const p = parseDeployment(d); if (p === null || p === "err") return null; active.push(p); }
  return { serviceId, serviceName, startCommand: startCommand as string | null, railwayConfigFile: railwayConfigFile as string | null, latestDeployment: latest, activeDeployments: active };
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
  if (unmergedChangesCount !== null && !(Number.isSafeInteger(unmergedChangesCount) && (unmergedChangesCount as number) >= 0)) return null;
  return { id, name, configEtag };
}
function parseStaged(data: unknown): { status: string } | null {
  if (!isPlainObject(data)) return null;
  const sc = data.environmentStagedChanges;
  if (!isPlainObject(sc) || !hasExactKeys(sc, ["id", "status"])) return null;
  const { id, status } = sc as Record<string, unknown>;
  if (!isId(id) || !isNonEmptyString(status)) return null;
  return { status };
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
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!isPlainObject(edge) || !hasExactKeys(edge, ["node"])) return null;
    const node = (edge as Record<string, unknown>).node;
    if (!isPlainObject(node) || !hasExactKeys(node, ["id", "name"])) return null;
    const { id, name } = node as Record<string, unknown>;
    if (!isId(id) || typeof name !== "string") return null;
    if (seen.has(id)) return null;
    seen.add(id);
    services.push({ id, name });
  }
  return { services, hasNextPage: hnp };
}
function parseDeploymentSnapshot(data: unknown): { id: string; vars: Record<string, string | null> } | null {
  if (!isPlainObject(data)) return null;
  const ds = data.deploymentSnapshot;
  if (!isPlainObject(ds) || !hasExactKeys(ds, ["id", "variables"])) return null;
  const { id } = ds as Record<string, unknown>;
  if (!isId(id)) return null;
  const vars = parseScalarVarMap((ds as Record<string, unknown>).variables);
  return vars === null ? null : { id, vars };
}
function parseVariablesForDeployment(data: unknown): Record<string, string | null> | null {
  if (!isPlainObject(data)) return null;
  if (!Object.hasOwn(data, "variablesForServiceDeployment")) return null;
  return parseScalarVarMap(data.variablesForServiceDeployment);
}

// ── Canonicalizări pt. fence — INJECTIVE (JSON.stringify pe structuri, fără delimitatori ambigui) ────────────────
function deployTuple(d: RailwayDeployment | null): readonly [string, string] | null { return d === null ? null : [d.id, d.status]; }
function cmpTuple(a: readonly [string, string], b: readonly [string, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}
/** Semnătură per-serviciu (injectivă): identitate + comandă/config + tuple deployment. */
export function signatureOf(si: ParsedServiceInstance): string {
  const active = si.activeDeployments.map((d) => [d.id, d.status] as [string, string]).slice().sort(cmpTuple);
  return JSON.stringify([si.serviceId, si.serviceName, si.startCommand, si.railwayConfigFile, active, deployTuple(si.latestDeployment)]);
}
/** Semnătură topologie (injectivă): array de [id,name] sortat după id (id-uri unice, dedup la parse). */
export function topologyOf(services: readonly { id: string; name: string }[]): string {
  const arr = services.map((s) => [s.id, s.name] as [string, string]).slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(arr);
}

// ── Staged verdict ───────────────────────────────────────────────────────────────────────────────────────────────
type StagedVerdict = "clean" | "staged" | "indeterminate";
function classifyStaged(status: string): StagedVerdict {
  if (status === "COMMITTED") return "clean";
  if (status === "STAGED" || status === "APPLYING") return "staged";
  return "indeterminate";
}

// ── Drift running-stale ──────────────────────────────────────────────────────────────────────────────────────────
function nonRailwayEntries(m: Record<string, string | null>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [k, v] of Object.entries(m)) if (!k.startsWith(RAILWAY_PREFIX)) out.set(k, v);
  return out;
}
function varMapsEqual(a: Map<string, string | null>, b: Map<string, string | null>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) { if (!b.has(k) || b.get(k) !== v) return false; }
  return true;
}

// ── deep-freeze + reject frozen ──────────────────────────────────────────────────────────────────────────────────
function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object") { for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v); Object.freeze(o); }
  return o;
}
function reject(reason: ClientRejectReason): ClientResult { return deepFreeze({ ok: false, reason }); }

// ── Validare manifest (anti-Proxy/TOCTOU, chei exacte, commandSource==catalog, fail-closed) ──────────────────────
interface ValidManifest { readonly projectId: string; readonly environmentId: string; readonly byRole: ReadonlyMap<ServiceId, string>; readonly liveWanted: ReadonlySet<string>; }
function validateManifest(m: unknown): ValidManifest | null {
  if (!isPlainObject(m) || !hasExactKeys(m, ["projectId", "environmentId", "serviceIds", "commandSource"])) return null;
  const pid1 = m.projectId, pid2 = m.projectId;
  const eid1 = m.environmentId, eid2 = m.environmentId;
  if (!isId(pid1) || pid1 !== pid2) return null;
  if (!isId(eid1) || eid1 !== eid2) return null;
  const ids = m.serviceIds;
  if (!isPlainObject(ids) || !hasExactKeys(ids, SERVICE_IDS)) return null;
  const byRole = new Map<ServiceId, string>();
  const seen = new Set<string>();
  for (const role of SERVICE_IDS) {
    const uuid = (ids as Record<string, unknown>)[role];
    if (!isId(uuid)) return null;
    if (seen.has(uuid)) return null;
    seen.add(uuid);
    byRole.set(role, uuid);
  }
  const cs = m.commandSource;
  if (!isPlainObject(cs) || !hasExactKeys(cs, SERVICE_IDS)) return null;
  for (const role of SERVICE_IDS) {
    const v = (cs as Record<string, unknown>)[role];
    if (v !== "inline" && v !== "config_file") return null;          // enum valid
    if (v !== SERVICE_CROSSCHECK[role].commandSource) return null;    // ȘI potrivit rolului (== catalog canonic)
  }
  return { projectId: pid1, environmentId: eid1, byRole, liveWanted: seen };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  Orchestrare PURĂ. Fence bracketat + retry mărginit + buget global (abort anulează cererea activă). Fail-closed.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
function isAbortedSignal(signal?: AbortSignal): boolean { return signal?.aborted === true; }

async function call(transport: GraphQLTransport, name: QueryName, variables: Record<string, string>, signal?: AbortSignal): Promise<{ ok: true; data: unknown } | { ok: false; reason: ClientRejectReason }> {
  if (isAbortedSignal(signal)) return { ok: false, reason: { kind: "aborted" } };
  const req: GraphQLRequest = signal ? { name, query: QUERIES[name], variables, signal } : { name, query: QUERIES[name], variables };
  // AȘTEPTĂM settle-ul transportului (fără abandon → cleanup-ul lui rulează). Abort-ul extern e propagat prin `req.signal`, deci
  // transportul (de încredere) își anulează cererea activă și se termină prompt. Verificăm abort DUPĂ settle → abort-ul DOMINĂ.
  let r: TransportResult;
  try { r = await transport(req); }
  catch { return { ok: false, reason: { kind: "transport_error", at: name, code: "network_error" } }; }
  if (isAbortedSignal(signal)) return { ok: false, reason: { kind: "aborted" } }; // abort domină chiar dacă transportul a produs un rezultat
  if (!r.ok) return { ok: false, reason: { kind: "transport_error", at: name, code: r.code } };
  return { ok: true, data: r.data };
}

export async function readRailwaySnapshot(transport: GraphQLTransport, manifest: unknown, opts: ReadOptions = {}): Promise<ClientResult> {
  // Forma opțiunilor: `undefined`/`null` → implicit; altfel TREBUIE obiect simplu cu chei ⊆ {maxAttempts, signal} (42/[]/extra key → refuz).
  if (opts !== undefined && opts !== null) {
    if (!isPlainObject(opts)) return reject({ kind: "invalid_options" });
    for (const k of Object.keys(opts)) if (k !== "maxAttempts" && k !== "signal") return reject({ kind: "invalid_options" });
  }
  const o = (opts ?? {}) as ReadOptions;
  let maxAttemptsOpt: unknown, signalOpt: AbortSignal | undefined;
  try { maxAttemptsOpt = o.maxAttempts; signalOpt = o.signal; } catch { return reject({ kind: "invalid_options" }); }
  if (signalOpt !== undefined && !(signalOpt instanceof AbortSignal)) return reject({ kind: "invalid_options" });
  let maxAttempts: number;
  if (maxAttemptsOpt === undefined) maxAttempts = MAX_ATTEMPTS;
  else if (Number.isInteger(maxAttemptsOpt) && (maxAttemptsOpt as number) >= 1) maxAttempts = Math.min(maxAttemptsOpt as number, MAX_ATTEMPTS);
  else return reject({ kind: "invalid_options" }); // 0/negativ/fracție/NaN → fail-closed (fără reparare tăcută)

  let vm: ValidManifest | null;
  try { vm = validateManifest(manifest); } catch { return reject({ kind: "invalid_manifest" }); }
  if (vm === null) return reject({ kind: "invalid_manifest" });

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isAbortedSignal(signalOpt)) return reject({ kind: "aborted" });
      const r = await attemptRead(transport, vm, signalOpt);
      if (r.ok) return r;
      if (r.reason.kind === "snapshot_unstable") continue;
      return r;
    }
    return reject({ kind: "snapshot_unstable" });
  } catch {
    return reject({ kind: "snapshot_unstable" });
  }
}

/** Recitește semnalele de environment (etag+staged+topologie) și le compară cu baseline-ul A. `null` = ok; altfel un refuz. */
async function readEnvLevel(transport: GraphQLTransport, vm: ValidManifest, signal: AbortSignal | undefined, base: { E: string; S: string; P: string }): Promise<ClientRejectReason | null> {
  const { projectId, environmentId } = vm;
  const rEnv = await call(transport, "environment", { e: environmentId, p: projectId }, signal);
  if (!rEnv.ok) return rEnv.reason;
  const env = parseEnvironment(rEnv.data);
  if (env === null) return { kind: "invalid_response", at: "environment" };
  if (env.id !== environmentId || env.name !== "production") return { kind: "wrong_scope" };
  if (env.configEtag !== base.E) return { kind: "snapshot_unstable" };

  const rStaged = await call(transport, "environmentStagedChanges", { e: environmentId }, signal);
  if (!rStaged.ok) return rStaged.reason;
  const staged = parseStaged(rStaged.data);
  if (staged === null) return { kind: "invalid_response", at: "environmentStagedChanges" };
  if (staged.status !== base.S) return { kind: "snapshot_unstable" };

  const rTop = await call(transport, "projectServices", { p: projectId }, signal);
  if (!rTop.ok) return rTop.reason;
  const top = parseProjectServices(rTop.data);
  if (top === null) return { kind: "invalid_response", at: "projectServices" };
  if (top.hasNextPage) return { kind: "topology_truncated" };
  if (topologyOf(top.services) !== base.P) return { kind: "snapshot_unstable" };
  return null;
}

async function attemptRead(transport: GraphQLTransport, vm: ValidManifest, signal?: AbortSignal): Promise<ClientResult> {
  const { projectId, environmentId } = vm;

  // ── Read A: scope vet ─────────────────────────────────────────────────────────────────────
  const rTok = await call(transport, "projectToken", {}, signal);
  if (!rTok.ok) return reject(rTok.reason);
  const tok = parseProjectToken(rTok.data);
  if (tok === null) return reject({ kind: "invalid_response", at: "projectToken" });
  if (tok.projectId !== projectId || tok.environmentId !== environmentId) return reject({ kind: "wrong_scope" });

  const rEnvA = await call(transport, "environment", { e: environmentId, p: projectId }, signal);
  if (!rEnvA.ok) return reject(rEnvA.reason);
  const envA = parseEnvironment(rEnvA.data);
  if (envA === null) return reject({ kind: "invalid_response", at: "environment" });
  if (envA.id !== environmentId || envA.name !== "production") return reject({ kind: "wrong_scope" });
  const E0 = envA.configEtag;

  // ── Read A: staged fail-closed pe status (ÎNAINTE de payload) ─────────────────────────────
  const rStagedA = await call(transport, "environmentStagedChanges", { e: environmentId }, signal);
  if (!rStagedA.ok) return reject(rStagedA.reason);
  const stagedA = parseStaged(rStagedA.data);
  if (stagedA === null) return reject({ kind: "invalid_response", at: "environmentStagedChanges" });
  const S0 = stagedA.status;
  const verdict = classifyStaged(S0);
  if (verdict === "staged") return reject({ kind: "staged_changes" });
  if (verdict === "indeterminate") return reject({ kind: "staged_indeterminate" });

  // ── Read A: topologie ─────────────────────────────────────────────────────────────────────
  const rTopA = await call(transport, "projectServices", { p: projectId }, signal);
  if (!rTopA.ok) return reject(rTopA.reason);
  const topA = parseProjectServices(rTopA.data);
  if (topA === null) return reject({ kind: "invalid_response", at: "projectServices" });
  if (topA.hasNextPage) return reject({ kind: "topology_truncated" });
  const P0 = topologyOf(topA.services);
  const liveIds = new Set(topA.services.map((s) => s.id));
  for (const id of liveIds) if (!vm.liveWanted.has(id)) return reject({ kind: "unexpected_service" });

  const rolesLive: { role: ServiceId; uuid: string }[] = [];
  for (const role of SERVICE_IDS) { const uuid = vm.byRole.get(role)!; if (liveIds.has(uuid)) rolesLive.push({ role, uuid }); }
  const base = { E: E0, S: S0, P: P0 };

  // ── Read A: per-serviciu serviceInstance (legat de UUID + colaps + semnătură A) ────────────
  const siA = new Map<string, ParsedServiceInstance>();
  const collapsed = new Map<string, RailwayDeployment | null>();
  const SIG0 = new Map<string, string>();
  for (const { role, uuid } of rolesLive) {
    const r = await call(transport, "serviceInstance", { e: environmentId, s: uuid }, signal);
    if (!r.ok) return reject(r.reason);
    const si = parseServiceInstance(r.data);
    if (si === null || si.serviceId !== uuid) return reject({ kind: "invalid_response", at: "serviceInstance" });
    if (si.activeDeployments.length > 1) return reject({ kind: "ambiguous_active_deployments", service: role });
    siA.set(uuid, si);
    collapsed.set(uuid, si.activeDeployments.length === 1 ? si.activeDeployments[0] : null);
    SIG0.set(uuid, signatureOf(si));
  }

  // ── Read B: payload ─────────────────────────────────────────────────────────────────────────
  const rendered = new Map<string, Record<string, string | null>>();
  const snapVars = new Map<string, Record<string, string | null>>();
  for (const { uuid } of rolesLive) {
    const rv = await call(transport, "variablesForServiceDeployment", { e: environmentId, p: projectId, s: uuid }, signal);
    if (!rv.ok) return reject(rv.reason);
    const vars = parseVariablesForDeployment(rv.data);
    if (vars === null) return reject({ kind: "invalid_response", at: "variablesForServiceDeployment" });
    rendered.set(uuid, vars);

    const active = collapsed.get(uuid) ?? null;
    if (active !== null) {
      const rd = await call(transport, "deploymentSnapshot", { d: active.id }, signal);
      if (!rd.ok) return reject(rd.reason);
      const ds = parseDeploymentSnapshot(rd.data);
      if (ds === null || ds.id !== active.id) return reject({ kind: "invalid_response", at: "deploymentSnapshot" });
      snapVars.set(uuid, ds.vars);
    }
  }

  // ── Read C: env-level bracket (început) → semnături per-serviciu → env-level bracket (final) ──
  const cStart = await readEnvLevel(transport, vm, signal, base);
  if (cStart !== null) return reject(cStart);

  for (const { uuid } of rolesLive) {
    const r = await call(transport, "serviceInstance", { e: environmentId, s: uuid }, signal);
    if (!r.ok) return reject(r.reason);
    const si = parseServiceInstance(r.data);
    if (si === null || si.serviceId !== uuid) return reject({ kind: "invalid_response", at: "serviceInstance" });
    if (signatureOf(si) !== SIG0.get(uuid)) return reject({ kind: "snapshot_unstable" });
  }

  const cEnd = await readEnvLevel(transport, vm, signal, base);
  if (cEnd !== null) return reject(cEnd);

  // ── Drift running-stale (fence stabil) ───────────────────────────────────────────────────────
  for (const { role, uuid } of rolesLive) {
    const active = collapsed.get(uuid) ?? null;
    if (active === null) continue;
    const rend = rendered.get(uuid)!;
    const snap = snapVars.get(uuid)!;
    if (!varMapsEqual(nonRailwayEntries(rend), nonRailwayEntries(snap))) return reject({ kind: "running_stale_drift", service: role });
  }

  // ── Asamblare snapshot (hasStagedChanges ÎNTOTDEAUNA false; deep-frozen) ──────────────────────
  const services: RailwayServiceRead[] = [];
  for (const { uuid } of rolesLive) {
    const si = siA.get(uuid)!;
    services.push({
      serviceId: uuid, name: si.serviceName,
      startCommand: si.startCommand, railwayConfigFile: si.railwayConfigFile,
      activeDeployment: collapsed.get(uuid) ?? null, latestDeployment: si.latestDeployment,
      hasStagedChanges: false, variables: rendered.get(uuid)!,
    });
  }
  const snapshot: RailwaySnapshot = { projectId, environmentId, hasStagedChanges: false, services };
  return deepFreeze({ ok: true, snapshot });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
//  Transport REAL — fetch-based, anti-leak. Allowlist fără TOCTOU. Abort extern anulează cererea. Corp mărginit.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface RailwayTransportOptions {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

function isAbortError(e: unknown): boolean { return e !== null && typeof e === "object" && "name" in e && (e as { name?: unknown }).name === "AbortError"; }

/**
 * Snapshot al request-ului O SINGURĂ DATĂ + refuz al getterilor (proprietăți accessor) → anti-TOCTOU. Întoarce `null` (hostile/invalid).
 * Corpul se construiește ulterior din constanta canonică `QUERIES[name]`, NU din `req.query` (query-ul e complet determinat de nume).
 */
function snapshotRequest(req: unknown): { name: QueryName; variables: unknown; signal: unknown } | null {
  if (!isPlainObject(req)) return null;
  for (const k of ["name", "query", "variables", "signal"]) {
    const d = Object.getOwnPropertyDescriptor(req, k);
    if (d && (typeof d.get === "function" || typeof d.set === "function")) return null; // accessor (getter/setter) → hostile
  }
  const name = req.name, query = req.query; // câte O citire
  if (typeof name !== "string" || !QUERY_NAMES.has(name)) return null;
  if (query !== QUERIES[name as QueryName]) return null; // allowlist: query trebuie să fie EXACT canonicul pt. nume
  return { name: name as QueryName, variables: req.variables, signal: req.signal };
}

type BodyRead = { kind: "ok"; text: string } | { kind: "oversized" } | { kind: "no_stream" } | { kind: "decode_error" };
/** Citire de corp MĂRGINITĂ prin reader. Fără stream → `no_stream`. UTF-8 invalid → `decode_error` (fatal, fără normalizare la U+FFFD). */
async function readBounded(res: Response, maxBytes: number): Promise<BodyRead> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") return { kind: "no_stream" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) { try { void reader.cancel().catch(() => { /* ignore */ }); } catch { /* ignore */ } return { kind: "oversized" }; } // fire-and-forget: terminare bounded (NU await pe cancel)
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try { return { kind: "ok", text: new TextDecoder("utf-8", { fatal: true }).decode(buf) }; } // fatal → UTF-8 invalid aruncă
  catch { return { kind: "decode_error" }; }
}

function validateEnvelope(parsed: unknown): TransportResult {
  if (!isPlainObject(parsed)) return { ok: false, code: "invalid_structure" };
  if (Object.hasOwn(parsed, "errors")) {
    const errs = (parsed as Record<string, unknown>).errors;
    if (!Array.isArray(errs)) return { ok: false, code: "invalid_structure" };
    if (errs.length > 0) return { ok: false, code: "graphql_errors" };
  }
  if (!Object.hasOwn(parsed, "data")) return { ok: false, code: "invalid_structure" };
  const data = (parsed as Record<string, unknown>).data;
  if (data === null || data === undefined) return { ok: false, code: "invalid_structure" };
  return { ok: true, data };
}

export function makeRailwayTransport(options: RailwayTransportOptions): GraphQLTransport {
  // Snapshot defensiv al opțiunilor (getter ostil → eroare de config cu mesaj FIX, fără ecou).
  let token: unknown, fetchOpt: unknown, timeoutOpt: unknown, maxBytesOpt: unknown;
  try { token = options.token; fetchOpt = options.fetchImpl; timeoutOpt = options.timeoutMs; maxBytesOpt = options.maxBytes; }
  catch { throw new Error("railway transport: options invalide"); }
  if (typeof token !== "string" || token.length === 0) throw new Error("railway transport: token invalid");
  const fetchImpl = (fetchOpt ?? (globalThis.fetch as unknown)) as typeof fetch | undefined;
  if (typeof fetchImpl !== "function") throw new Error("railway transport: fetch indisponibil");
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (timeoutOpt !== undefined) {
    if (typeof timeoutOpt !== "number" || !Number.isFinite(timeoutOpt) || timeoutOpt <= 0) throw new Error("railway transport: timeoutMs invalid");
    timeoutMs = Math.min(timeoutOpt, MAX_TIMEOUT_MS);
  }
  let maxBytes = DEFAULT_MAX_BYTES;
  if (maxBytesOpt !== undefined) {
    if (typeof maxBytesOpt !== "number" || !Number.isInteger(maxBytesOpt) || maxBytesOpt <= 0) throw new Error("railway transport: maxBytes invalid");
    maxBytes = Math.min(maxBytesOpt, MAX_BYTES_CAP);
  }
  const theToken = token;

  return async (req: GraphQLRequest): Promise<TransportResult> => {
    // Snapshot O SINGURĂ DATĂ + refuz al getterilor (anti-TOCTOU + getter ostil pe request → cod static, fără fetch).
    let snap: { name: QueryName; variables: unknown; signal: unknown } | null;
    try { snap = snapshotRequest(req); } catch { return { ok: false, code: "blocked_query" }; }
    if (snap === null) return { ok: false, code: "blocked_query" };
    let bodyStr: string;
    try { bodyStr = JSON.stringify({ query: QUERIES[snap.name], variables: snap.variables }); } catch { return { ok: false, code: "blocked_query" }; } // corp din constanta canonică

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const ext = snap.signal instanceof AbortSignal ? snap.signal : undefined;
    const onExt = () => controller.abort();
    if (ext) { if (ext.aborted) controller.abort(); else ext.addEventListener("abort", onExt, { once: true }); }
    try {
      let res: Response;
      try {
        res = await fetchImpl(RAILWAY_ENDPOINT, {
          method: "POST",
          headers: { "Project-Access-Token": theToken, "Content-Type": "application/json", "Accept": "application/json" },
          body: bodyStr,
          redirect: "error",
          signal: controller.signal,
        });
      } catch (e) { return { ok: false, code: isAbortError(e) ? "timeout" : "network_error" }; }

      if (!res.ok) return { ok: false, code: "http_error" };

      let read: BodyRead;
      try { read = await readBounded(res, maxBytes); }
      catch (e) { return { ok: false, code: isAbortError(e) ? "timeout" : "network_error" }; }
      if (read.kind === "no_stream") return { ok: false, code: "body_unavailable" };
      if (read.kind === "oversized") return { ok: false, code: "oversized" };
      if (read.kind === "decode_error") return { ok: false, code: "parse_error" }; // UTF-8 invalid → refuz static

      let parsed: unknown;
      try { parsed = JSON.parse(read.text); } catch { return { ok: false, code: "parse_error" }; }
      return validateEnvelope(parsed);
    } finally {
      clearTimeout(timer);
      if (ext) ext.removeEventListener("abort", onExt);
    }
  };
}
