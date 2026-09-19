/**
 * lib/mcp/railwayReadModel.ts — PH-12 12.6 leaf 2b-1: model PUR care traduce un snapshot Railway (citit read-only, 2b-2)
 * în `RawState`-ul STRICT al leaf-ului 1 (`profilePlan.ts`). Zero I/O, hermetic-testabil. rev2 (după cgpt).
 *
 * ARHITECTURĂ:
 *   RAW snapshot Railway (unknown) ──mapRailwaySnapshotToRawState(raw, manifest)──▶ { ok, rawState, diagnostics } | { ok:false, reason }
 *   apoi (2b-3): rawState ──planFromRaw(_, target, bindRoleCaps())──▶ preview de plan (fără apply)
 *
 * LOCK-URI (cgpt rev1 + rev2):
 *  [P1] **Identitate = UUID**, nu nume. `manifest` (INJECTAT de runner) leagă fiecare `ServiceId` de `serviceId` Railway +
 *       `projectId`/`environmentId`. Numele + comanda de start sunt DOAR cross-check BYTE-EXACT (după o normalizare de whitespace
 *       controlată) pe TOATE cele 5 servicii, inclusiv comanda critică a Redis-ului. UUID corect + nume≠ → `service_renamed`
 *       (se mapează la fel); UUID necunoscut → `unexpected_service`; UUID corect + comandă≠ → `identity_drift` (rol OMIS).
 *  [P1] **Tuple de deployment**: `activeDeployment` (rulează ACUM) + `latestDeployment` (ultima încercare). `running:true` DOAR când
 *       AMBELE statusuri sunt `SUCCESS`/`SLEEPING` ȘI `active.id === latest.id` (deployment coerent și sănătos — un `latest` roșu pe
 *       ACELAȘI id, ex. `CRASHED`, NU trece drept true). `false` DOAR la parcare CURATĂ. Restul → `"unknown"` → OMIS.
 *  [P1] **Config Railway ≠ env-ul activ**: staged changes la nivel de ENVIRONMENT (`snapshot.hasStagedChanges`) SAU pe orice serviciu
 *       gestionat (`service.hasStagedChanges`) → snapshot NEADMISIBIL (`staged_changes`), verificat ÎNAINTE de mapare. Valoare
 *       sealed/unavailable/reference (marker `null`) → cheie OMISĂ din env, NICIODATĂ placeholder — validatorul canonic o raportează
 *       `missing` dacă rolul o cere → preview neadmisibil, fără a slăbi validatorul.
 *  [P1] **Serviciile live nemapate BLOCHează**: `serviceId` live absent din manifest → reject dur `unexpected_service`; rol așteptat
 *       absent din live → rol OMIS → planner `state_unknown`.
 *  [P2] **Parse EXACT**: prototip `Object.prototype | null`; snapshot/serviciu/deployment cu SET EXACT de chei (extra key → reject);
 *       env construit cu `Object.create(null)` (fără muchia `__proto__`). Manifestul e normalizat O SINGURĂ DATĂ într-o copie proprie
 *       imutabilă (fără recitire TOCTOU din obiectul netrusted), cu double-read pe scalari pentru a prinde getteri ne-deterministici.
 *
 * ANTI-LEAK: `RawState` cară valori de env DOAR spre `buildObservation` (care redactează). Diagnosticele sunt CODURI ÎNCHISE +
 * opțional `ServiceId` — niciodată nume live, status brut, comandă sau valori de env.
 */

import { SERVICE_IDS, parseRawState, type ServiceId, type RawState, type RawService } from "./profilePlan";

// ── Catalog de CROSS-CHECK (nume + comandă de start CANONICĂ din cod; identitatea autoritară e UUID-ul din manifest) ──
interface CrossCheck { readonly name: string; readonly startCommand: string; }
export const SERVICE_CROSSCHECK: Readonly<Record<ServiceId, CrossCheck>> = Object.freeze({
  redis: Object.freeze({
    name: "Preflight - Redis",
    startCommand: '/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH"',
  }),
  mcp: Object.freeze({ name: "Preflight MCP", startCommand: "npm run start --workspace=mcp" }),
  "worker-evm": Object.freeze({ name: "Worker EVM", startCommand: "npm run start --workspace=@preflight/worker-evm" }),
  "indexer-evm": Object.freeze({ name: "Indexer EVM", startCommand: "npm run start --workspace=@preflight/indexer-evm" }),
  "solana-worker": Object.freeze({ name: "Worker Solana", startCommand: "npm run start --workspace=@preflight/indexer-solana" }),
} as Record<ServiceId, CrossCheck>);

/**
 * Normalizare de whitespace CONTROLATĂ: DOAR spațiul ASCII (0x20) e echivalent — colapsăm rulaje de spații + tăiem spații la
 * capete. `\n`/`\r`/`\t`/`\f`/`\v` NU sunt whitespace „controlat" (un newline e separator de comenzi în shell) → rămân în șir și
 * rup egalitatea byte-exactă, deci un script pe mai multe linii (o linie canonică + una malițioasă) NU trece drept comanda canonică.
 */
function normalizeCommand(s: string): string { return s.replace(/ +/g, " ").replace(/^ +/, "").replace(/ +$/, ""); }

// ── Statusuri de deployment (frozen) ────────────────────────────────────────────────────────────────────────────
const RUNNING_STATUS: ReadonlySet<string> = new Set(["SUCCESS", "SLEEPING"]);        // ambele + coerent → true
const TORN_DOWN_STATUS: ReadonlySet<string> = new Set(["REMOVED"]);                   // fără activ → false (parcat)
// tot restul (INITIALIZING/BUILDING/DEPLOYING/QUEUED/WAITING/REMOVING/FAILED/CRASHED/SKIPPED/necunoscut/contradictoriu) → "unknown"

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
  if (latestDeployment === null) return false;                         // niciun deployment vreodată → parcat
  if (TORN_DOWN_STATUS.has(latestDeployment.status)) return false;     // demolat curat → parcat
  return "unknown";                                                    // latest SUCCESS-neactiv / FAILED / SKIPPED / … → unknown
}

// ── Manifest injectat (UUID-uri, din runner) ────────────────────────────────────────────────────────────────────
export interface RailwayManifest {
  readonly projectId: string;
  readonly environmentId: string;
  readonly serviceIds: Readonly<Record<ServiceId, string>>; // ServiceId → UUID Railway
}

// ── Snapshot brut (produs de client 2b-2; AICI e primit ca `unknown` și parsat EXACT) ───────────────────────────
export interface RailwayDeployment { readonly id: string; readonly status: string; }
export interface RailwayServiceRead {
  readonly serviceId: string;
  readonly name: string;
  readonly startCommand: string | null;
  readonly activeDeployment: RailwayDeployment | null;
  readonly latestDeployment: RailwayDeployment | null;
  readonly hasStagedChanges: boolean;
  readonly variables: Readonly<Record<string, string | null>>; // null = sealed/unavailable/reference nerezolvată
}
export interface RailwaySnapshot {
  readonly projectId: string;
  readonly environmentId: string;
  readonly hasStagedChanges: boolean; // staged changes la nivel de ENVIRONMENT (shared) — derivate de 2b-2 din query-ul de environment
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
const SERVICE_KEYS = ["serviceId", "name", "startCommand", "activeDeployment", "latestDeployment", "hasStagedChanges", "variables"] as const;
const SNAPSHOT_KEYS = ["projectId", "environmentId", "hasStagedChanges", "services"] as const;
const MANIFEST_KEYS = ["projectId", "environmentId", "serviceIds"] as const;

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
  const { serviceId, name, startCommand, hasStagedChanges, variables } = v as Record<string, unknown>;
  if (typeof serviceId !== "string" || serviceId.length === 0) return null;
  if (typeof name !== "string") return null;
  if (startCommand !== null && typeof startCommand !== "string") return null;
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
  return { serviceId, name, startCommand: startCommand as string | null, activeDeployment: active, latestDeployment: latest, hasStagedChanges, variables: vars };
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
interface NormManifest { readonly projectId: string; readonly environmentId: string; readonly reverse: ReadonlyMap<string, ServiceId>; }
function normalizeManifest(m: unknown): NormManifest | null {
  if (!isTrustedObject(m) || !hasExactKeys(m, MANIFEST_KEYS)) return null; // formă EXACTĂ (fără chei extra)
  // double-read pe scalari: un getter ne-determinist (valid o dată, apoi aruncă/schimbă) → respins.
  const pid1 = m.projectId, pid2 = m.projectId;
  const eid1 = m.environmentId, eid2 = m.environmentId;
  if (typeof pid1 !== "string" || pid1.length === 0 || pid1 !== pid2) return null;
  if (typeof eid1 !== "string" || eid1.length === 0 || eid1 !== eid2) return null;
  const ids = m.serviceIds;
  if (!isTrustedObject(ids)) return null;
  const entries = Object.entries(ids); // o SINGURĂ evaluare
  if (entries.length !== SERVICE_IDS.length) return null;
  const forward = new Map<ServiceId, string>();
  for (const [k, val] of entries) {
    if (!(SERVICE_IDS as readonly string[]).includes(k)) return null; // cheie ne-rol
    if (typeof val !== "string" || val.length === 0) return null;
    forward.set(k as ServiceId, val);
  }
  if (forward.size !== SERVICE_IDS.length) return null; // trebuie EXACT rolurile noastre
  const reverse = new Map<string, ServiceId>();
  for (const role of SERVICE_IDS) {
    const uuid = forward.get(role);
    if (uuid === undefined) return null;
    if (reverse.has(uuid)) return null; // UUID duplicat între roluri → topologie ambiguă
    reverse.set(uuid, role);
  }
  return { projectId: pid1, environmentId: eid1, reverse };
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
      if (svc.name !== cc.name) diagnostics.push({ code: "service_renamed", service: role }); // rename ≠ remapare (UUID e autoritatea)
      // Cross-check comandă BYTE-EXACT (după normalizare de whitespace): UUID corect + comandă≠ → identity_drift → rol OMIS.
      if (svc.startCommand === null || normalizeCommand(svc.startCommand) !== normalizeCommand(cc.startCommand)) { diagnostics.push({ code: "identity_drift", service: role }); continue; }

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
