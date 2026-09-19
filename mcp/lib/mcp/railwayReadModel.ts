/**
 * lib/mcp/railwayReadModel.ts — PH-12 12.6 leaf 2b-1: model PUR care traduce un snapshot Railway (citit read-only, 2b-2)
 * în `RawState`-ul STRICT al leaf-ului 1 (`profilePlan.ts`). Zero I/O, hermetic-testabil. rev3 (după schema-lock live 2b-2a).
 *
 * ARHITECTURĂ:
 *   RAW snapshot Railway (unknown) ──mapRailwaySnapshotToRawState(raw, manifest)──▶ { ok, rawState, diagnostics } | { ok:false, reason }
 *   apoi (2b-3): rawState ──planFromRaw(_, target, bindRoleCaps())──▶ preview de plan (fără apply)
 *
 * LOCK-URI (cgpt rev1+rev2 + schema-lock live 2b-2a):
 *  [P1] **Identitate = UUID**, nu nume. `manifest` (INJECTAT de runner) leagă fiecare `ServiceId` de `serviceId` Railway +
 *       `projectId`/`environmentId`, și declară `commandSource` per rol (`inline` | `config_file`). Numele = cross-check
 *       (rename ≠ remapare). Comanda de start = cross-check DISCRIMINAT:
 *         - `inline`      → `startCommand` prezent + BYTE-EXACT cu canonicul (verbatim din Railway; zero normalizare de whitespace);
 *         - `config_file` → `startCommand` NULL + `railwayConfigFile` === path-ul canonic exact (Railway ține comanda în fișierul
 *                           de config din repo, nu în câmpul instanță — ex. Worker Solana). Corectitudinea comenzii din fișier e
 *                           garantată separat de source-guard-ul sursă↔sursă (`railwayReadPlan.test.ts`).
 *       `manifest.commandSource[rol] ≠ catalogul canonic` → `malformed_manifest` (declarația runner-ului contrazice sursa de cod).
 *       UUID corect + nume≠ → `service_renamed` (se mapează la fel); UUID necunoscut → `unexpected_service`; identitate greșită
 *       (comandă inline≠ / config path≠ / startCommand prezent pe config_file / ambele absente) → `identity_drift` (rol OMIS).
 *  [P1] **Tuple de deployment** (schema-lock: `activeDeployments:[Deployment!]!` LISTĂ + `latestDeployment:Deployment`).
 *       Clientul 2b-2 colapsează lista: 0→`activeDeployment:null`, 1→`activeDeployments[0]`, >1→reject `ambiguous_active_deployments`
 *       ÎNAINTE de mapare (aici primim deja `activeDeployment` singular). `running`:
 *         - activ prezent → `true` DOAR când `active.id === latest.id` ȘI ambele statusuri ∈ {SUCCESS, SLEEPING}; altfel `unknown`;
 *         - activ absent + `latest` ∈ {REMOVED, FAILED, CRASHED, SKIPPED} SAU fără deployment → **`false` (terminal non-running)**;
 *         - activ absent + status tranzitoriu (BUILDING/DEPLOYING/QUEUED/WAITING/INITIALIZING/NEEDS_APPROVAL/REMOVING) → `unknown`;
 *         - activ absent + `latest` SUCCESS/SLEEPING (fără activ) → `unknown` (contradictoriu).
 *       *(Revizie față de rev2: serviciile parcate live au `latest=FAILED`/`null`, nu `REMOVED` — un status terminal cu zero active
 *        e `false` (parcat, startabil), nu `unknown`; altfel plannerul n-ar putea porni MCP-ul.)*
 *  [P1] **Config Railway ≠ env-ul activ**: staged changes la nivel de ENVIRONMENT (`snapshot.hasStagedChanges`, derivat de 2b-2 din
 *       `environmentStagedChanges.status`) SAU pe orice serviciu → snapshot NEADMISIBIL (`staged_changes`). Sursa de env a clientului
 *       = `variablesForServiceDeployment` (rendered curent; drift running-stale detectat de client vs `deploymentSnapshot.variables`
 *       pe subsetul non-`RAILWAY_*`, fail-closed). Valoare sealed/unavailable (marker `null`) → cheie OMISĂ, NICIODATĂ placeholder.
 *  [P1] **Serviciile live nemapate BLOCHează**: `serviceId` live absent din manifest → `unexpected_service`; rol absent → OMIS.
 *  [P2] **Parse EXACT**: prototip strict; chei EXACTE pe snapshot/serviciu/deployment (extra key → reject); env `Object.create(null)`;
 *       manifest normalizat O SINGURĂ DATĂ (anti-TOCTOU: double-read pe scalari, formă exactă).
 *
 * ANTI-LEAK: `RawState` cară valori de env DOAR spre `buildObservation` (care redactează). Diagnosticele sunt CODURI ÎNCHISE +
 * opțional `ServiceId` — niciodată nume live, status brut, comandă, path sau valori de env.
 */

import { SERVICE_IDS, parseRawState, type ServiceId, type RawState, type RawService } from "./profilePlan";

// ── Catalog de CROSS-CHECK (canonic, din cod; identitatea autoritară e UUID-ul din manifest) ────────────────────────
// Discriminat pe `commandSource`: `inline` cară `startCommand` canonic; `config_file` cară `configFile` (path repo exact).
export type CrossCheck =
  | { readonly name: string; readonly commandSource: "inline"; readonly startCommand: string }
  | { readonly name: string; readonly commandSource: "config_file"; readonly configFile: string };

export type CommandSource = "inline" | "config_file";

export const SERVICE_CROSSCHECK: Readonly<Record<ServiceId, CrossCheck>> = Object.freeze({
  redis: Object.freeze({
    name: "Preflight - Redis",
    commandSource: "inline",
    startCommand: '/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH"',
  }),
  mcp: Object.freeze({ name: "Preflight MCP", commandSource: "inline", startCommand: "npm run start --workspace=mcp" }),
  "worker-evm": Object.freeze({ name: "Worker EVM", commandSource: "inline", startCommand: "npm run start --workspace=@preflight/worker-evm" }),
  "indexer-evm": Object.freeze({ name: "Indexer EVM", commandSource: "inline", startCommand: "npm run start --workspace=@preflight/indexer-evm" }),
  // Worker Solana: comanda trăiește în fișierul de config din repo (câmpul instanță `startCommand` e null live). Identitate = path exact.
  "solana-worker": Object.freeze({ name: "Worker Solana", commandSource: "config_file", configFile: "/workers/solana/railway.json" }),
} as Record<ServiceId, CrossCheck>);

// ── Statusuri de deployment (frozen) ────────────────────────────────────────────────────────────────────────────
const RUNNING_STATUS: ReadonlySet<string> = new Set(["SUCCESS", "SLEEPING"]);                       // ambele + coerent → true
const TERMINAL_NON_RUNNING: ReadonlySet<string> = new Set(["REMOVED", "FAILED", "CRASHED", "SKIPPED"]); // fără activ → false (parcat)
// tranzitoriile (INITIALIZING/BUILDING/DEPLOYING/QUEUED/WAITING/NEEDS_APPROVAL/REMOVING) + SUCCESS/SLEEPING-fără-activ → "unknown"

export type RunningVerdict = boolean | "unknown";

/** Clasifică `running` din tuple-ul (activ, latest). `"unknown"` = OMITE serviciul (planner → `state_unknown`). Fail-closed. */
export function classifyRunning(
  activeDeployment: { readonly status: string; readonly id: string } | null,
  latestDeployment: { readonly status: string; readonly id: string } | null,
): RunningVerdict {
  if (activeDeployment !== null) {
    if (latestDeployment === null) return "unknown";                   // contradictoriu: activ fără niciun latest
    if (activeDeployment.id !== latestDeployment.id) return "unknown"; // divergență (ex. latest FAILED nou) → conservator
    // Același id: cere AMBELE statusuri sănătoase (un latest roșu pe același id, ex. CRASHED, NU e true).
    return RUNNING_STATUS.has(activeDeployment.status) && RUNNING_STATUS.has(latestDeployment.status) ? true : "unknown";
  }
  // activ absent:
  if (latestDeployment === null) return false;                          // niciun deployment vreodată → parcat
  if (TERMINAL_NON_RUNNING.has(latestDeployment.status)) return false;  // terminal non-running (REMOVED/FAILED/CRASHED/SKIPPED) → parcat
  return "unknown";                                                     // tranzitoriu / SUCCESS-SLEEPING-fără-activ (contradictoriu) → unknown
}

// ── Manifest injectat (UUID-uri + commandSource, din runner) ────────────────────────────────────────────────────
export interface RailwayManifest {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceIds: Readonly<Record<ServiceId, string>>;       // ServiceId → UUID Railway
  readonly commandSource: Readonly<Record<ServiceId, CommandSource>>; // ServiceId → sursa comenzii (declarată explicit de runner)
}

// ── Snapshot brut (produs de client 2b-2; AICI e primit ca `unknown` și parsat EXACT) ───────────────────────────
export interface RailwayDeployment { readonly id: string; readonly status: string; }
export interface RailwayServiceRead {
  readonly serviceId: string;
  readonly name: string;
  readonly startCommand: string | null;
  readonly railwayConfigFile: string | null; // path-ul fișierului de config bindat (schema-lock: ServiceInstance.railwayConfigFile)
  readonly activeDeployment: RailwayDeployment | null;   // colapsat de client din activeDeployments[] (0→null, 1→[0], >1→reject)
  readonly latestDeployment: RailwayDeployment | null;
  readonly hasStagedChanges: boolean;
  readonly variables: Readonly<Record<string, string | null>>; // null = sealed/unavailable/reference nerezolvată
}
export interface RailwaySnapshot {
  readonly projectId: string;
  readonly environmentId: string;
  readonly hasStagedChanges: boolean; // staged la nivel de ENVIRONMENT — derivat de 2b-2 din `environmentStagedChanges.status`
  readonly services: readonly RailwayServiceRead[];
}

// ── Diagnostice (coduri ÎNCHISE + opțional ServiceId — NIMIC altceva) ───────────────────────────────────────────
export type DiagCode = "service_renamed" | "identity_drift" | "running_unknown" | "env_unreadable" | "role_absent";
export interface MapDiagnostic { readonly code: DiagCode; readonly service?: ServiceId; }
export type MapRejectReason =
  | "malformed_snapshot"
  | "malformed_manifest"
  | "wrong_scope"
  | "unexpected_service"
  | "ambiguous_topology"
  | "staged_changes";
// NB: >1 activeDeployments pe un serviciu e detectat + respins de clientul 2b-2 (`ambiguous_active_deployments`) ÎNAINTE de a
// construi snapshot-ul — NU e o stare pe care mapper-ul o poate produce, deci nu apare în `MapRejectReason` (union fără stări imposibile).
export type MapResult =
  | { readonly ok: true; readonly rawState: RawState; readonly diagnostics: readonly MapDiagnostic[] }
  | { readonly ok: false; readonly reason: MapRejectReason; readonly diagnostics: readonly MapDiagnostic[] };

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === "object") { for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v); Object.freeze(o); }
  return o;
}
function fail(reason: MapRejectReason, diagnostics: MapDiagnostic[] = []): MapResult {
  return deepFreeze({ ok: false, reason, diagnostics });
}

// ── Parse defensiv (prototip STRICT + chei EXACTE + fail-closed pe getters/proxy) ───────────────────────────────
function isTrustedObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null; // fără instanțe cu prototip arbitrar
}
function hasExactKeys(o: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(o);
  if (keys.length !== expected.length) return false;
  for (const e of expected) if (!Object.hasOwn(o, e)) return false;
  return true;
}
const DEPLOY_KEYS = ["id", "status"] as const;
const SERVICE_KEYS = ["serviceId", "name", "startCommand", "railwayConfigFile", "activeDeployment", "latestDeployment", "hasStagedChanges", "variables"] as const;
const SNAPSHOT_KEYS = ["projectId", "environmentId", "hasStagedChanges", "services"] as const;
const MANIFEST_KEYS = ["projectId", "environmentId", "serviceIds", "commandSource"] as const;
const COMMAND_SOURCES: ReadonlySet<string> = new Set(["inline", "config_file"]);

function parseDeployment(v: unknown): RailwayDeployment | null | "err" {
  if (v === null) return null;
  if (!isTrustedObject(v) || !hasExactKeys(v, DEPLOY_KEYS)) return "err";
  const { id, status } = v as { id: unknown; status: unknown };
  if (typeof id !== "string" || id.length === 0) return "err";
  if (typeof status !== "string" || status.length === 0) return "err";
  return { id, status };
}
function parseServiceRead(v: unknown): RailwayServiceRead | null {
  if (!isTrustedObject(v) || !hasExactKeys(v, SERVICE_KEYS)) return null;
  const { serviceId, name, startCommand, railwayConfigFile, hasStagedChanges, variables } = v as Record<string, unknown>;
  if (typeof serviceId !== "string" || serviceId.length === 0) return null;
  if (typeof name !== "string") return null;
  if (startCommand !== null && typeof startCommand !== "string") return null;
  if (railwayConfigFile !== null && typeof railwayConfigFile !== "string") return null;
  if (typeof hasStagedChanges !== "boolean") return null;
  const active = parseDeployment(v.activeDeployment); if (active === "err") return null;
  const latest = parseDeployment(v.latestDeployment); if (latest === "err") return null;
  if (!isTrustedObject(variables)) return null;
  const vars: Record<string, string | null> = Object.create(null);
  for (const [k, val] of Object.entries(variables)) {
    if (val === null) vars[k] = null;
    else if (typeof val === "string") vars[k] = val;
    else return null; // number/obiect/array/undefined → snapshot malformat
  }
  return {
    serviceId, name,
    startCommand: startCommand as string | null,
    railwayConfigFile: railwayConfigFile as string | null,
    activeDeployment: active, latestDeployment: latest, hasStagedChanges, variables: vars,
  };
}
function parseSnapshot(raw: unknown): RailwaySnapshot | null {
  if (!isTrustedObject(raw) || !hasExactKeys(raw, SNAPSHOT_KEYS)) return null;
  const { projectId, environmentId, hasStagedChanges, services } = raw as Record<string, unknown>;
  if (typeof projectId !== "string" || projectId.length === 0) return null;
  if (typeof environmentId !== "string" || environmentId.length === 0) return null;
  if (typeof hasStagedChanges !== "boolean") return null;
  if (!Array.isArray(services)) return null;
  const out: RailwayServiceRead[] = [];
  for (const s of services) { const p = parseServiceRead(s); if (p === null) return null; out.push(p); }
  return { projectId, environmentId, hasStagedChanges, services: out };
}

// ── Manifest normalizat O SINGURĂ DATĂ (anti-TOCTOU): copie proprie imutabilă, double-read pe scalari ───────────
interface NormManifest {
  readonly projectId: string;
  readonly environmentId: string;
  readonly reverse: ReadonlyMap<string, ServiceId>;                 // UUID → rol
  readonly commandSource: ReadonlyMap<ServiceId, CommandSource>;    // rol → sursa declarată
}
function normalizeManifest(m: unknown): NormManifest | null {
  if (!isTrustedObject(m) || !hasExactKeys(m, MANIFEST_KEYS)) return null; // formă EXACTĂ (fără chei extra)
  // double-read pe scalari: un getter ne-determinist (valid o dată, apoi aruncă/schimbă) → respins.
  const pid1 = m.projectId, pid2 = m.projectId;
  const eid1 = m.environmentId, eid2 = m.environmentId;
  if (typeof pid1 !== "string" || pid1.length === 0 || pid1 !== pid2) return null;
  if (typeof eid1 !== "string" || eid1.length === 0 || eid1 !== eid2) return null;

  const ids = m.serviceIds;
  if (!isTrustedObject(ids)) return null;
  const idEntries = Object.entries(ids); // o SINGURĂ evaluare
  if (idEntries.length !== SERVICE_IDS.length) return null;
  const forward = new Map<ServiceId, string>();
  for (const [k, val] of idEntries) {
    if (!(SERVICE_IDS as readonly string[]).includes(k)) return null; // cheie ne-rol
    if (typeof val !== "string" || val.length === 0) return null;
    forward.set(k as ServiceId, val);
  }
  if (forward.size !== SERVICE_IDS.length) return null;

  const cs = m.commandSource;
  if (!isTrustedObject(cs)) return null;
  const csEntries = Object.entries(cs); // o SINGURĂ evaluare
  if (csEntries.length !== SERVICE_IDS.length) return null;
  const cmdSource = new Map<ServiceId, CommandSource>();
  for (const [k, val] of csEntries) {
    if (!(SERVICE_IDS as readonly string[]).includes(k)) return null;
    if (typeof val !== "string" || !COMMAND_SOURCES.has(val)) return null;
    cmdSource.set(k as ServiceId, val as CommandSource);
  }
  if (cmdSource.size !== SERVICE_IDS.length) return null;

  const reverse = new Map<string, ServiceId>();
  for (const role of SERVICE_IDS) {
    const uuid = forward.get(role);
    if (uuid === undefined) return null;
    if (reverse.has(uuid)) return null; // UUID duplicat între roluri → topologie ambiguă
    reverse.set(uuid, role);
    if (cmdSource.get(role) === undefined) return null; // fiecare rol trebuie să-și declare sursa
  }
  return { projectId: pid1, environmentId: eid1, reverse, commandSource: cmdSource };
}

/**
 * Traduce snapshot-ul Railway (unknown) în `RawState`. Fail-closed pe TOT. Manifestul e normalizat înainte; snapshot-ul e parsat
 * exact; rezultatul e deep-frozen și validat printr-un ultim `parseRawState` (invariant: NU putem produce un RawState pe care leaf 1
 * l-ar respinge). Frontieră cu `try/catch` exterior — niciun throw nu iese.
 */
export function mapRailwaySnapshotToRawState(rawSnapshot: unknown, manifest: unknown): MapResult {
  let norm: NormManifest | null;
  try { norm = normalizeManifest(manifest); } catch { return fail("malformed_manifest"); }
  if (norm === null) return fail("malformed_manifest");

  try {
    const snap = parseSnapshot(rawSnapshot);
    if (snap === null) return fail("malformed_snapshot");
    if (snap.projectId !== norm.projectId || snap.environmentId !== norm.environmentId) return fail("wrong_scope");
    if (snap.hasStagedChanges) return fail("staged_changes"); // staged la nivel de environment (shared) → neadmisibil

    const diagnostics: MapDiagnostic[] = [];
    const built: Partial<Record<ServiceId, RawService>> = {};
    const seenRoles = new Set<ServiceId>();

    for (const svc of snap.services) {
      const role = norm.reverse.get(svc.serviceId);
      if (role === undefined) return fail("unexpected_service", diagnostics); // UUID live absent din manifest → reject dur
      if (seenRoles.has(role)) return fail("ambiguous_topology", diagnostics); // două live pentru același rol
      seenRoles.add(role);

      if (svc.hasStagedChanges) return fail("staged_changes", diagnostics); // staged per-serviciu (apărare suplimentară)

      const cc = SERVICE_CROSSCHECK[role];
      const declared = norm.commandSource.get(role);
      if (declared !== cc.commandSource) return fail("malformed_manifest", diagnostics); // runner declară o sursă ≠ catalogul canonic

      if (svc.name !== cc.name) diagnostics.push({ code: "service_renamed", service: role }); // rename ≠ remapare (UUID e autoritatea)

      // Cross-check DISCRIMINAT al identității comenzii — BYTE-EXACT pe ambele ramuri. UUID corect + identitate≠ → identity_drift → rol OMIS.
      let identityOk: boolean;
      if (cc.commandSource === "inline") {
        // `startCommand` live e citit VERBATIM din Railway (fără reformatare) → egalitate BYTE-EXACTĂ (nicio normalizare de whitespace:
        // un spațiu/tab/newline în plus schimbă șirul → drift; nu tolerăm nimic).
        identityOk = svc.startCommand !== null && svc.startCommand === cc.startCommand;
      } else {
        // config_file: comanda NU e în câmpul instanță (trebuie null) + path-ul de config === canonicul EXACT (byte-exact, e o cale).
        identityOk = svc.startCommand === null && svc.railwayConfigFile === cc.configFile;
      }
      if (!identityOk) { diagnostics.push({ code: "identity_drift", service: role }); continue; }

      const verdict = classifyRunning(svc.activeDeployment, svc.latestDeployment);
      if (verdict === "unknown") { diagnostics.push({ code: "running_unknown", service: role }); continue; }

      const env: Record<string, string> = Object.create(null); // fără muchia __proto__
      let hadUnreadable = false;
      for (const [k, val] of Object.entries(svc.variables)) { if (val === null) hadUnreadable = true; else env[k] = val; }
      if (hadUnreadable) diagnostics.push({ code: "env_unreadable", service: role });

      built[role] = { running: verdict, env };
    }

    for (const role of SERVICE_IDS) if (!seenRoles.has(role)) diagnostics.push({ code: "role_absent", service: role });

    // Invariant final: rezultatul TREBUIE să satisfacă contractul strict al leaf-ului 1 (validare, NU rebuild — păstrăm env null-proto).
    if (parseRawState(built) === null) return fail("malformed_snapshot", diagnostics); // niciodată așteptat — backstop
    return deepFreeze({ ok: true, rawState: built, diagnostics });
  } catch {
    return fail("malformed_snapshot"); // backstop de frontieră — niciun throw nu iese
  }
}
