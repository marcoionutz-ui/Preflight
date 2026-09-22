/**
 * lib/mcp/railwayWriteReader.test.ts — PH-12 12.6 leaf 2c-2b-reader (rev3): teste HERMETICE.
 *
 * Transport FALS (fără rețea), scriptabil per-apel (fence). Acoperă cerințele decisive cgpt (rev3):
 *  • variabile schimbate cu etag/staged/tuple neschimbate → FĂRĂ capability (payload în fence);
 *  • rendered ≠ deploymentSnapshot activ → refuz (running_stale_drift);
 *  • accessorul public NU poate recupera RawState-ul (doar getWriteEvidence value-free + deriveWritePlan value-blind);
 *  • celula registrului nu poate fi substituită (spread/fabricat → not genuine, accessor → null);
 *  • manifest modificat după primul request NU e recitit (manifest canonic din `m` la mapper);
 *  • drift Git/image = gitBacked din SURSA canonică (SERVICE_CROSSCHECK);
 *  • ID invalid ȘI unmergedChangesCount malformat → respinse înainte de succes;
 *  plus: identitate (inline/config drift; drift A↔C); topologie (extra/lipsă/trunchiere/schimbată A↔C); staged-aware progress;
 *  prepare clean-state; status ENUM strict; wrong_scope; ambiguous; transport_error/invalid_response; invalid_manifest/options; aborted.
 */

import {
  readPrepareCapability, readWriteProgress, isGenuinePrepareCapability, isGenuineWriteProgress, derivePreparedInputs, isGenuinePreparedInputs,
  type PrepareResult, type ProgressResult,
} from "./railwayWriteReader";
import { QUERIES, type QueryName, type TransportResult, type GraphQLRequest, type GraphQLTransport, type TransportErrorCode } from "./railwayReadClient";
import { SERVICE_CROSSCHECK, type RailwayManifest, type CommandSource } from "./railwayReadModel";
import { SERVICE_IDS, type ServiceId } from "./profilePlan";
import * as profilePlanNs from "./profilePlan";
import * as profileCapsNs from "./profileCaps";
import { bindRoleCaps, isGenuineCaps } from "./profileCaps";

let passed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }
function rejP(r: PrepareResult): string { return r.ok ? "<ok>" : r.reason.kind; }
function rejG(r: ProgressResult): string { return r.ok ? "<ok>" : r.reason.kind; }

// Caps GENUIN — SINGURA sursă e fabrica de încredere `bindRoleCaps` (2a). Nu există mint public.
const CAPS = bindRoleCaps();

const PROJECT = "proj-uuid-0001";
const ENV = "env-uuid-prod-0001";
const UUID: Record<ServiceId, string> = {
  redis: "svc-redis-uuid", mcp: "svc-mcp-uuid", "worker-evm": "svc-workerevm-uuid",
  "indexer-evm": "svc-indexerevm-uuid", "solana-worker": "svc-solana-uuid",
};
const CMDSRC: Record<ServiceId, CommandSource> = {
  redis: "inline", mcp: "inline", "worker-evm": "inline", "indexer-evm": "inline", "solana-worker": "config_file",
};
const MANIFEST: RailwayManifest = Object.freeze({
  projectId: PROJECT, environmentId: ENV,
  serviceIds: Object.freeze({ ...UUID }), commandSource: Object.freeze({ ...CMDSRC }),
});
function canonStart(role: ServiceId): string | null { const cc = SERVICE_CROSSCHECK[role]; return cc.commandSource === "inline" ? cc.startCommand : null; }
function canonConfig(role: ServiceId): string | null { const cc = SERVICE_CROSSCHECK[role]; return cc.commandSource === "config_file" ? cc.configFile : null; }

interface Dep { id: string; status: string; }
interface WSvc { name: string; startCommand: string | null; railwayConfigFile: string | null; latest: Dep | null; active: Dep[]; vars: Record<string, string | null>; snapVars: Record<string, string | null>; }
interface World {
  token: { projectId: string; environmentId: string };
  env: { id: string; name: string; configEtag: string; unmergedChangesCount: number | null };
  staged: { id: string; status: string };
  topology: { id: string; name: string }[];
  services: Record<string, WSvc>;
}
function happyWorld(stagedStatus = "COMMITTED"): World {
  const services: Record<string, WSvc> = {};
  const topology: { id: string; name: string }[] = [];
  for (const role of SERVICE_IDS) {
    const cc = SERVICE_CROSSCHECK[role]; const uuid = UUID[role];
    const dep: Dep = { id: `dep-${role}`, status: "SUCCESS" };
    const vars = { [`VAR_${role}`]: "val", RAILWAY_PROJECT_ID: PROJECT };
    services[uuid] = { name: cc.name, startCommand: canonStart(role), railwayConfigFile: canonConfig(role), latest: dep, active: [dep], vars, snapVars: { ...vars } };
    topology.push({ id: uuid, name: cc.name });
  }
  return {
    token: { projectId: PROJECT, environmentId: ENV },
    env: { id: ENV, name: "production", configEtag: "etag-0", unmergedChangesCount: null },
    staged: { id: "patch-abc", status: stagedStatus }, topology, services,
  };
}
function findByActive(w: World, depId: string): WSvc | undefined { for (const uuid of Object.keys(w.services)) { const s = w.services[uuid]; if (s.active.some((d) => d.id === depId)) return s; } return undefined; }

interface FakeOpts {
  onCall?: (n: number, name: QueryName, w: World) => void;
  override?: (name: QueryName, vars: Record<string, string>, w: World, n: number) => TransportResult | null;
}
function makeFake(w: World, o: FakeOpts = {}): { transport: GraphQLTransport; names: QueryName[] } {
  const names: QueryName[] = []; let n = 0;
  const transport: GraphQLTransport = async (req: GraphQLRequest): Promise<TransportResult> => {
    n++; names.push(req.name);
    if (o.onCall) o.onCall(n, req.name, w);
    if (o.override) { const r = o.override(req.name, req.variables as Record<string, string>, w, n); if (r !== null) return r; }
    const vs = req.variables as Record<string, string>;
    switch (req.name) {
      case "projectToken": return { ok: true, data: { projectToken: w.token } };
      case "environment": return { ok: true, data: { environment: w.env } };
      case "environmentStagedChanges": return { ok: true, data: { environmentStagedChanges: w.staged } };
      case "projectServices": return { ok: true, data: { project: { services: { edges: w.topology.map((t) => ({ node: { id: t.id, name: t.name } })), pageInfo: { hasNextPage: false } } } } };
      case "serviceInstance": {
        const svc = w.services[vs.s];
        if (!svc) return { ok: true, data: { serviceInstance: null } };
        return { ok: true, data: { serviceInstance: { serviceId: vs.s, serviceName: svc.name, startCommand: svc.startCommand, railwayConfigFile: svc.railwayConfigFile, latestDeployment: svc.latest, activeDeployments: svc.active } } };
      }
      case "variablesForServiceDeployment": { const svc = w.services[vs.s]; return { ok: true, data: { variablesForServiceDeployment: svc ? svc.vars : {} } }; }
      case "deploymentSnapshot": { const svc = findByActive(w, vs.d); return { ok: true, data: { deploymentSnapshot: svc ? { id: vs.d, variables: svc.snapVars } : null } }; }
      default: return { ok: false, code: "blocked_query" };
    }
  };
  return { transport, names };
}

async function run(): Promise<void> {
  // ═══ 1. Progress happy: value-free, genuine, anti-surface (NU citește variabile/deploymentSnapshot) ════════════════
  {
    const f = makeFake(happyWorld("COMMITTED"));
    const r = await readWriteProgress(f.transport, MANIFEST);
    assert(r.ok, `progress happy: ${rejG(r)}`);
    if (r.ok) {
      const v = r.capability.view;
      assert(v.configEtag === "etag-0" && v.staged.stagedPatchId === "patch-abc" && v.staged.status === "COMMITTED", "progress fields");
      const mcp = v.services.find((s) => s.role === "mcp")!;
      assert(JSON.stringify(Object.keys(mcp).sort()) === JSON.stringify(["activeDeployment", "latestDeployment", "role", "serviceId"]), "progress value-free keys");
      assert(isGenuineWriteProgress(r.capability) && Object.isFrozen(r.capability), "progress genuine+frozen");
    }
    assert(!f.names.includes("variablesForServiceDeployment") && !f.names.includes("deploymentSnapshot"), "progress anti-surface");
  }

  // ═══ 2. Progress staged-AWARE ═══════════════════════════════════════════════════════════════════════════════════
  for (const st of ["STAGED", "APPLYING", "FAILED", "COMMITTED"]) {
    const r = await readWriteProgress(makeFake(happyWorld(st)).transport, MANIFEST);
    assert(r.ok && r.capability.view.staged.status === st, `progress exposes ${st}: ${rejG(r)}`);
  }

  // ═══ 3. Prepare happy: cap opac + derivePreparedInputs → {plan value-blind, evidence value-free} + gitBacked canonic ══
  {
    const f = makeFake(happyWorld("COMMITTED"));
    const p = await readPrepareCapability(f.transport, MANIFEST);
    assert(p.ok, `prepare happy: ${rejP(p)}`);
    if (p.ok) {
      const cap = p.capability;
      assert(JSON.stringify(Object.keys(cap).sort()) === JSON.stringify(["configEtag", "environmentId", "kind", "projectId"]), "prepare cap opaque (no values)");
      assert(isGenuinePrepareCapability(cap), "prepare genuine");
      const pi = derivePreparedInputs(cap, "parked", CAPS);
      assert(pi !== null, "derivePreparedInputs genuine != null");
      if (pi) {
        const ev = pi.evidence;
        assert(ev.services.mcp.serviceId === UUID.mcp && ev.services.mcp.running === true && ev.services.mcp.activeDeploymentId === "dep-mcp", "evidence mcp");
        assert(ev.services.mcp.gitBacked === SERVICE_CROSSCHECK.mcp.gitBacked && ev.services.redis.gitBacked === SERVICE_CROSSCHECK.redis.gitBacked, "gitBacked from canonical");
        assert(ev.services.redis.gitBacked === false && ev.services.mcp.gitBacked === true, "gitBacked values");
        // RawState NU e recuperabil: nici evidence, nici plan nu conțin valoarea secretă live "val"
        assert(!JSON.stringify(ev).includes("val"), "evidence secret-free");
        assert(!JSON.stringify(pi.plan).includes("val"), "plan value-blind (no live secret)");
        assert(Object.isFrozen(pi) && isGenuinePreparedInputs(pi), "prepared inputs frozen + genuine");
      }
    }
    assert(f.names.includes("variablesForServiceDeployment") && f.names.includes("deploymentSnapshot"), "prepare reads variables+snapshot");
  }

  // ═══ 4. Prepare parcat: evidence running:false / activeDeploymentId:null ════════════════════════════════════════
  {
    const w = happyWorld("COMMITTED"); w.services[UUID.redis].active = []; w.services[UUID.redis].latest = { id: "dep-redis", status: "REMOVED" };
    const p = await readPrepareCapability(makeFake(w).transport, MANIFEST);
    assert(p.ok, `prepare parked: ${rejP(p)}`);
    if (p.ok) { const ev = derivePreparedInputs(p.capability, "parked", CAPS)!.evidence; assert(ev.services.redis.running === false && ev.services.redis.activeDeploymentId === null, "evidence parked coherent"); }
  }

  // ═══ 5. Prepare CLEAN-STATE (refuză staged) ═════════════════════════════════════════════════════════════════════
  assert(rejP(await readPrepareCapability(makeFake(happyWorld("STAGED")).transport, MANIFEST)) === "staged_changes", "prepare refuses STAGED");
  assert(rejP(await readPrepareCapability(makeFake(happyWorld("APPLYING")).transport, MANIFEST)) === "staged_changes", "prepare refuses APPLYING");
  assert(rejP(await readPrepareCapability(makeFake(happyWorld("FAILED")).transport, MANIFEST)) === "staged_indeterminate", "prepare refuses FAILED");

  // ═══ 6. Genuinitate + celula registrului nu poate fi substituită (spread/fabricat → null) ═══════════════════════
  {
    const p = await readPrepareCapability(makeFake(happyWorld()).transport, MANIFEST);
    const g = await readWriteProgress(makeFake(happyWorld()).transport, MANIFEST);
    if (p.ok && g.ok) {
      assert(!isGenuinePrepareCapability({ ...p.capability }), "prepare spread not genuine");
      assert(derivePreparedInputs({ ...p.capability }, "parked", CAPS) === null, "derivePreparedInputs spread cap → null");
      assert(derivePreparedInputs({ kind: "prepare", projectId: PROJECT, environmentId: ENV, configEtag: "etag-0" }, "parked", CAPS) === null, "derivePreparedInputs fabricated cap → null");
      assert(!isGenuineWriteProgress({ ...g.capability }), "progress spread not genuine");
    } else assert(false, "genuineness setup");
  }

  // ═══ 6b. Caps FABRICAT (validator + isStagingSupabase care încearcă să captureze secretul) → refuz FĂRĂ invocare ══
  {
    const p = await readPrepareCapability(makeFake(happyWorld()).transport, MANIFEST);
    assert(p.ok, "caps-inject setup");
    if (p.ok) {
      let captured: unknown = null; let validatorCalled = false; let stagingCalled = false;
      const evilCaps = {
        validateService: new Proxy({}, { get: () => (env: unknown) => { validatorCalled = true; captured = env; return { ok: true }; } }),
        envKeys: {},
        isStagingSupabase: (env: unknown) => { stagingCalled = true; captured = env; return true; },
      };
      const out = derivePreparedInputs(p.capability, "parked", evilCaps as never);
      assert(out === null, "fabricated caps → derivePreparedInputs null");
      assert(validatorCalled === false && stagingCalled === false && captured === null, "fabricated caps callbacks NOT invoked (no exfiltration)");
    }
  }

  // ═══ 6c. Genuinitate caps + pereche: NU există mint public; caps fabricat NEgenuin; bindRoleCaps genuin; pereche mixtă NEgenuină ══
  {
    // (a) NICIUN export public `registerCaps` — nici în core-ul pur, nici în fabrică
    assert((profilePlanNs as Record<string, unknown>).registerCaps === undefined, "no public registerCaps in profilePlan");
    assert((profileCapsNs as Record<string, unknown>).registerCaps === undefined, "no public registerCaps in profileCaps");
    // (b) caps FABRICAT nu poate deveni genuin; (c) bindRoleCaps() produce genuin
    assert(isGenuineCaps({ validateService: {}, envKeys: {}, isStagingSupabase: () => true }) === false, "fabricated caps NOT genuine");
    assert(isGenuineCaps(bindRoleCaps()) === true, "bindRoleCaps() → genuine");
    // (d) pereche mixtă A-plan + B-evidence → NEgenuină; fiecare pereche legată de citirea ei
    const w1 = happyWorld(); w1.env = { ...w1.env, configEtag: "etag-AAA" };
    const w2 = happyWorld(); w2.env = { ...w2.env, configEtag: "etag-BBB" }; w2.services[UUID.mcp].active = []; w2.services[UUID.mcp].latest = { id: "dep-mcp", status: "REMOVED" };
    const p1 = await readPrepareCapability(makeFake(w1).transport, MANIFEST);
    const p2 = await readPrepareCapability(makeFake(w2).transport, MANIFEST);
    assert(p1.ok && p2.ok, "two-cap setup");
    if (p1.ok && p2.ok) {
      const a = derivePreparedInputs(p1.capability, "parked", CAPS)!;
      const b = derivePreparedInputs(p2.capability, "parked", CAPS)!;
      assert(a.evidence.configEtag === "etag-AAA" && b.evidence.configEtag === "etag-BBB", "each pair bound to its own read");
      assert(isGenuinePreparedInputs(a) && isGenuinePreparedInputs(b), "genuine pairs");
      const mixed = { plan: a.plan, evidence: b.evidence };            // A-plan + B-evidence asamblat manual
      assert(!isGenuinePreparedInputs(mixed), "mixed pair (A-plan + B-evidence) NOT genuine");
      assert(!isGenuinePreparedInputs({ ...a }), "spread pair NOT genuine");
    }
  }

  // ═══ 7. Identitate: comandă inline / config path greșit → identity_drift ════════════════════════════════════════
  {
    const w = happyWorld(); w.services[UUID.mcp].startCommand = "npm run WRONG";
    assert(rejG(await readWriteProgress(makeFake(w).transport, MANIFEST)) === "identity_drift", "inline wrong cmd → drift (progress)");
    assert(rejP(await readPrepareCapability(makeFake(w).transport, MANIFEST)) === "identity_drift", "inline wrong cmd → drift (prepare)");
  }
  { const w = happyWorld(); w.services[UUID["solana-worker"]].railwayConfigFile = "/wrong/path.json"; assert(rejG(await readWriteProgress(makeFake(w).transport, MANIFEST)) === "identity_drift", "config wrong path → drift"); }
  { const w = happyWorld(); w.services[UUID["solana-worker"]].startCommand = "sneaky"; assert(rejG(await readWriteProgress(makeFake(w).transport, MANIFEST)) === "identity_drift", "config non-null startCommand → drift"); }

  // ═══ 8. Identitate drift DOAR între A și C → instabil ══════════════════════════════════════════════════════════
  {
    const w = happyWorld(); let mcpReads = 0;
    const f = makeFake(w, { override: (name, vars) => {
      if (name === "serviceInstance" && vars.s === UUID.mcp) {
        mcpReads++;
        const sc = mcpReads % 2 === 1 ? canonStart("mcp") : "npm run DRIFTED";
        return { ok: true, data: { serviceInstance: { serviceId: UUID.mcp, serviceName: SERVICE_CROSSCHECK.mcp.name, startCommand: sc, railwayConfigFile: null, latestDeployment: { id: "dep-mcp", status: "SUCCESS" }, activeDeployments: [{ id: "dep-mcp", status: "SUCCESS" }] } } };
      }
      return null;
    } });
    assert(rejG(await readWriteProgress(f.transport, MANIFEST)) === "reader_unstable", "identity drift A↔C → unstable");
  }

  // ═══ 9. Topologie: extra / lipsă / trunchiere / schimbată A↔C ══════════════════════════════════════════════════
  { const w = happyWorld(); w.topology.push({ id: "svc-EXTRA-uuid", name: "Rogue" }); assert(rejG(await readWriteProgress(makeFake(w).transport, MANIFEST)) === "unexpected_service", "extra → unexpected"); }
  { const w = happyWorld(); w.topology = w.topology.filter((t) => t.id !== UUID["indexer-evm"]); assert(rejG(await readWriteProgress(makeFake(w).transport, MANIFEST)) === "topology_incomplete", "missing → incomplete"); }
  {
    const w = happyWorld();
    const f = makeFake(w, { override: (name) => (name === "projectServices" ? { ok: true, data: { project: { services: { edges: w.topology.map((t) => ({ node: { id: t.id, name: t.name } })), pageInfo: { hasNextPage: true } } } } } : null) });
    assert(rejG(await readWriteProgress(f.transport, MANIFEST)) === "topology_truncated", "truncated → refuse");
  }
  {
    const w = happyWorld(); let topReads = 0;
    const f = makeFake(w, { onCall: (_n, name) => { if (name === "projectServices") { topReads++; w.topology[1] = { ...w.topology[1], name: topReads % 2 === 0 ? "Renamed" : SERVICE_CROSSCHECK.mcp.name }; } } });
    assert(rejG(await readWriteProgress(f.transport, MANIFEST)) === "reader_unstable", "topology changed A↔C → unstable");
  }

  // ═══ 10. Variabile schimbate cu etag/staged/tuple NESCHIMBATE → prepare FĂRĂ capability (payload în fence) ═══════
  {
    const w = happyWorld(); let mcpVarReads = 0;
    const f = makeFake(w, { override: (name, vars) => {
      if (name === "variablesForServiceDeployment" && vars.s === UUID.mcp) { mcpVarReads++; return { ok: true, data: { variablesForServiceDeployment: { VAR_mcp: `gen-${mcpVarReads}`, RAILWAY_PROJECT_ID: PROJECT } } }; }
      return null;
    } });
    assert(rejP(await readPrepareCapability(f.transport, MANIFEST)) === "reader_unstable", "env payload change (etag/tuple same) → no capability");
  }

  // ═══ 11. rendered ≠ deploymentSnapshot activ → running_stale_drift ══════════════════════════════════════════════
  {
    const w = happyWorld(); w.services[UUID.mcp].snapVars = { VAR_mcp: "OLD_DEPLOYED", RAILWAY_PROJECT_ID: PROJECT };
    assert(rejP(await readPrepareCapability(makeFake(w).transport, MANIFEST)) === "running_stale_drift", "rendered≠snapshot → running_stale_drift");
  }
  { // surplus RAILWAY_* între rendered și snapshot NU e drift
    const w = happyWorld(); w.services[UUID.mcp].snapVars = { VAR_mcp: "val" }; // fără RAILWAY_PROJECT_ID
    assert((await readPrepareCapability(makeFake(w).transport, MANIFEST)).ok, "RAILWAY_* diff tolerated");
  }

  // ═══ 12. Manifest modificat DURANTE I/O NU e recitit (mapper primește copia canonică din normalizarea inițială) ══
  {
    const mut: { projectId: string; environmentId: string; serviceIds: Record<ServiceId, string>; commandSource: Record<ServiceId, CommandSource> } =
      { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID }, commandSource: { ...CMDSRC } };
    // transportul mută `mut.serviceIds.mcp` în timpul I/O; dacă reader-ul ar reciti manifestul la mapare → ar folosi UUID-ul rău.
    const f = makeFake(happyWorld(), { onCall: (n) => { if (n === 1) mut.serviceIds.mcp = "svc-EVIL-uuid-xxxx"; } });
    const p = await readPrepareCapability(f.transport, mut);
    assert(p.ok, `mutating manifest prepare: ${rejP(p)}`);
    if (p.ok) assert(derivePreparedInputs(p.capability, "parked", CAPS)!.evidence.services.mcp.serviceId === UUID.mcp, "evidence din UUID-ul canonic (nu re-citit)");
  }
  // ═══ 12b. Formă EXACTĂ manifest: Symbol / non-enum / accessor / ID scurt → invalid_manifest ════════════════════
  {
    const symMan: Record<string | symbol, unknown> = { ...MANIFEST }; symMan[Symbol("x")] = 1;
    assert(rejG(await readWriteProgress(makeFake(happyWorld()).transport, symMan)) === "invalid_manifest", "symbol key → invalid_manifest");
    const nonEnum: Record<string, unknown> = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID }, commandSource: { ...CMDSRC } };
    Object.defineProperty(nonEnum, "sneaky", { value: 1, enumerable: false });
    assert(rejG(await readWriteProgress(makeFake(happyWorld()).transport, nonEnum)) === "invalid_manifest", "non-enum extra → invalid_manifest");
    const accMan: Record<string, unknown> = { environmentId: ENV, serviceIds: { ...UUID }, commandSource: { ...CMDSRC } };
    Object.defineProperty(accMan, "projectId", { enumerable: true, get: () => PROJECT });
    assert(rejG(await readWriteProgress(makeFake(happyWorld()).transport, accMan)) === "invalid_manifest", "accessor key → invalid_manifest");
    assert(rejG(await readWriteProgress(makeFake(happyWorld()).transport, { ...MANIFEST, projectId: "x" })) === "invalid_manifest", "short id 'x' → invalid_manifest");
    assert(rejG(await readWriteProgress(makeFake(happyWorld()).transport, { ...MANIFEST, serviceIds: { ...UUID, mcp: "x" } })) === "invalid_manifest", "short service id 'x' → invalid_manifest");
  }

  // ═══ 13. Status ENUM strict ═════════════════════════════════════════════════════════════════════════════════════
  { const w = happyWorld(); w.staged.status = "WEIRD"; assert(rejG(await readWriteProgress(makeFake(w).transport, MANIFEST)) === "invalid_response", "bad patch status"); }
  { const w = happyWorld(); w.services[UUID.mcp].active = [{ id: "dep-mcp", status: "NOPE" }]; assert(rejG(await readWriteProgress(makeFake(w).transport, MANIFEST)) === "invalid_response", "bad deploy status"); }

  // ═══ 14. wrong_scope + ambiguous ════════════════════════════════════════════════════════════════════════════════
  { const w = happyWorld(); w.token = { projectId: "other", environmentId: ENV }; assert(rejG(await readWriteProgress(makeFake(w).transport, MANIFEST)) === "wrong_scope", "wrong scope token"); }
  { const w = happyWorld(); w.env = { ...w.env, name: "staging" }; assert(rejG(await readWriteProgress(makeFake(w).transport, MANIFEST)) === "wrong_scope", "wrong scope name"); }
  { const w = happyWorld(); w.services[UUID["worker-evm"]].active = [{ id: "d1", status: "SUCCESS" }, { id: "d2", status: "SUCCESS" }]; const r = await readWriteProgress(makeFake(w).transport, MANIFEST); assert(!r.ok && r.reason.kind === "ambiguous_active_deployments", `ambiguous: ${rejG(r)}`); }

  // ═══ 15. transport_error (fiecare at, incl. prepare-only) + throw→network_error ═════════════════════════════════
  for (const at of ["projectToken", "environment", "environmentStagedChanges", "projectServices", "serviceInstance"] as QueryName[]) {
    const f = makeFake(happyWorld(), { override: (name) => (name === at ? { ok: false, code: "http_error" as TransportErrorCode } : null) });
    const r = await readWriteProgress(f.transport, MANIFEST);
    assert(!r.ok && r.reason.kind === "transport_error" && (r.reason as { at: QueryName }).at === at, `transport_error @ ${at}: ${rejG(r)}`);
  }
  for (const at of ["variablesForServiceDeployment", "deploymentSnapshot"] as QueryName[]) {
    const f = makeFake(happyWorld(), { override: (name) => (name === at ? { ok: false, code: "http_error" as TransportErrorCode } : null) });
    const r = await readPrepareCapability(f.transport, MANIFEST);
    assert(!r.ok && r.reason.kind === "transport_error" && (r.reason as { at: QueryName }).at === at, `prepare transport_error @ ${at}: ${rejP(r)}`);
  }
  {
    const w = happyWorld();
    const transport: GraphQLTransport = async (req) => { if (req.name === "environment") throw new Error("boom"); return { ok: true, data: { projectToken: w.token } }; };
    const r = await readWriteProgress(transport, MANIFEST);
    assert(!r.ok && r.reason.kind === "transport_error" && (r.reason as { code: string }).code === "network_error", `throw→network_error: ${rejG(r)}`);
  }

  // ═══ 16. invalid_response malformat (incl. deploymentSnapshot + unmergedChangesCount) ══════════════════════════
  const malformed: { at: QueryName; data: unknown; read: "p" | "g" }[] = [
    { at: "projectToken", data: { projectToken: { projectId: PROJECT } }, read: "g" },
    { at: "environment", data: { environment: { id: ENV, name: "production", configEtag: "", unmergedChangesCount: null } }, read: "g" },
    { at: "environment", data: { environment: { id: ENV, name: "production", configEtag: "etag-0", unmergedChangesCount: "5" } }, read: "g" }, // unmergedChangesCount malformat
    { at: "environmentStagedChanges", data: { environmentStagedChanges: { id: "p", status: 5 } }, read: "g" },
    { at: "projectServices", data: { project: { services: { edges: [{ node: { id: "x" } }], pageInfo: { hasNextPage: false } } } }, read: "g" },
    { at: "serviceInstance", data: { serviceInstance: { serviceId: UUID.redis, serviceName: "n", startCommand: null, railwayConfigFile: null, latestDeployment: { id: "d" }, activeDeployments: [] } }, read: "g" },
    { at: "deploymentSnapshot", data: { deploymentSnapshot: { id: "dep-mcp", variables: { X: 5 } } }, read: "p" }, // valoare non-string
  ];
  for (const { at, data, read } of malformed) {
    const f = makeFake(happyWorld(), { override: (name, _v, _w, _n) => (name === at ? { ok: true, data } : null) });
    const r = read === "p" ? await readPrepareCapability(f.transport, MANIFEST) : await readWriteProgress(f.transport, MANIFEST);
    const kind = r.ok ? "<ok>" : r.reason.kind;
    const gotAt = r.ok ? "" : (r.reason as { at?: QueryName }).at;
    assert(!r.ok && r.reason.kind === "invalid_response" && gotAt === at, `invalid_response @ ${at}: ${kind}/${gotAt}`);
  }

  // ═══ 17. invalid_manifest (ID invalid strict, dup UUID, catalog mismatch) ══════════════════════════════════════
  for (const bad of [null, 42, {}, { ...MANIFEST, projectId: "bad uuid!!" }, { ...MANIFEST, serviceIds: { ...UUID, mcp: UUID.redis } }, { ...MANIFEST, commandSource: { ...CMDSRC, mcp: "config_file" } }]) {
    assert(rejG(await readWriteProgress(makeFake(happyWorld()).transport, bad)) === "invalid_manifest", `invalid_manifest: ${JSON.stringify(bad)}`);
  }

  // ═══ 18. invalid_options + Proxy anti-throw ═════════════════════════════════════════════════════════════════════
  {
    const f = makeFake(happyWorld());
    assert(rejG(await readWriteProgress(f.transport, MANIFEST, { maxAttempts: 0 })) === "invalid_options", "opt 0");
    assert(rejG(await readWriteProgress(f.transport, MANIFEST, { signal: 42 } as never)) === "invalid_options", "opt signal");
    assert(rejG(await readWriteProgress(f.transport, MANIFEST, { extra: 1 } as never)) === "invalid_options", "opt extra");
    assert((await readWriteProgress(f.transport, MANIFEST, { maxAttempts: 1 })).ok, "opt maxAttempts 1");
  }
  {
    const throwProto = new Proxy({}, { getPrototypeOf() { throw new Error("boom"); } });
    assert(rejG(await readWriteProgress(makeFake(happyWorld()).transport, MANIFEST, throwProto as never)) === "invalid_options", "opts Proxy getPrototypeOf");
    const throwKeys = new Proxy({ maxAttempts: 1 }, { ownKeys() { throw new Error("boom"); } });
    assert(rejG(await readWriteProgress(makeFake(happyWorld()).transport, MANIFEST, throwKeys as never)) === "invalid_options", "opts Proxy ownKeys");
  }

  // ═══ 19. aborted (pre + mid-flight domină) ══════════════════════════════════════════════════════════════════════
  { const ac = new AbortController(); ac.abort(); assert(rejG(await readWriteProgress(makeFake(happyWorld()).transport, MANIFEST, { signal: ac.signal })) === "aborted", "aborted pre"); }
  {
    const w = happyWorld(); const ac = new AbortController();
    const transport: GraphQLTransport = async (req) => { if (req.name === "environment") { ac.abort(); return { ok: true, data: { environment: w.env } }; } return { ok: true, data: { projectToken: w.token } }; };
    assert(rejG(await readWriteProgress(transport, MANIFEST, { signal: ac.signal })) === "aborted", "aborted mid-flight");
  }

  if (fails.length) { console.error(`FAIL (${fails.length}):\n` + fails.map((f) => "  - " + f).join("\n")); process.exitCode = 1; }
  console.log(`railwayWriteReader.test: ${passed} passed, ${fails.length} failed`);
}

void run();
