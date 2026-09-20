/**
 * lib/mcp/railwayReadClient.test.ts — PH-12 12.6 leaf 2b-2: teste HERMETICE pentru clientul READ-ONLY Railway.
 *
 * Două suprafețe, ambele fără rețea:
 *  (1) Orchestrarea `readRailwaySnapshot` cu un TRANSPORT FALS (date canonice per query, scriptabile pe a n-a apelare pt. fence).
 *  (2) Transportul REAL `makeRailwayTransport` cu un `fetch` FALS (endpoint fix, header Project-Access-Token, redirect:error,
 *      body mărginit, mapare envelope → coduri statice, anti-leak token).
 *
 * Acoperă: happy-path + integrarea cu mapper-ul 2b-1; wrong_scope (token/name/id); staged fail-closed (STAGED/APPLYING→reject,
 * FAILED/necunoscut→indeterminate, COMMITTED→ok); topologie (hasNextPage, unexpected_service, rol absent→OMIS→role_absent la mapper);
 * colaps activeDeployments (0/1/>1→ambiguous); fence (etag/staged/topologie/tuple schimbate → snapshot_unstable; recuperare cu retry);
 * drift running-stale (mismatch non-RAILWAY_* → reject; surplus RAILWAY_* tolerat; serviciu parcat fără drift); erori de transport
 * (fiecare `at`+cod; throw→network_error); răspunsuri malformate (fiecare `at`); manifest invalid; sealed (null)→păstrat→env_unreadable.
 */

import {
  readRailwaySnapshot, makeRailwayTransport, QUERIES, signatureOf, topologyOf,
  type GraphQLTransport, type GraphQLRequest, type TransportResult, type ClientResult, type ClientRejectReason,
  type QueryName, type TransportErrorCode, type ReadOptions, type RailwayTransportOptions,
} from "./railwayReadClient";
import { mapRailwaySnapshotToRawState, SERVICE_CROSSCHECK, type RailwayManifest, type CommandSource } from "./railwayReadModel";
import { SERVICE_IDS, type ServiceId } from "./profilePlan";

let passed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }
function rejKind(r: ClientResult): string { return r.ok ? "<ok>" : r.reason.kind; }

// ── Manifest canonic (UUID-uri fake) ─────────────────────────────────────────────────────────────────────────────
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
// ── Model de lume (mutabil pt. fence) ───────────────────────────────────────────────────────────────────────────
interface Dep { id: string; status: string; }
interface WorldService {
  serviceName: string; startCommand: string | null; railwayConfigFile: string | null;
  latestDeployment: Dep | null; activeDeployments: Dep[];
  rendered: Record<string, string | null>;
  snapshotVars: Record<string, Record<string, string | null>>; // by deploymentId
}
interface World {
  token: { projectId: string; environmentId: string };
  env: { id: string; name: string; configEtag: string; unmergedChangesCount: number | null };
  staged: string;
  topology: { id: string; name: string }[];
  services: Record<string, WorldService>;
}

/** Lume canonică „fericită": 5 servicii, toate running (active==latest==SUCCESS), rendered==snapshot (fără drift), COMMITTED. */
function happyWorld(): World {
  const services: Record<string, WorldService> = {};
  const topology: { id: string; name: string }[] = [];
  for (const role of SERVICE_IDS) {
    const cc = SERVICE_CROSSCHECK[role];
    const uuid = UUID[role];
    const dep: Dep = { id: `dep-${role}`, status: "SUCCESS" };
    const rendered: Record<string, string | null> = { [`VAR_${role}`]: "value", RAILWAY_PROJECT_ID: PROJECT };
    services[uuid] = {
      serviceName: cc.name,
      startCommand: cc.commandSource === "inline" ? cc.startCommand : null,
      railwayConfigFile: cc.commandSource === "config_file" ? cc.configFile : null,
      latestDeployment: { ...dep },
      activeDeployments: [{ ...dep }],
      rendered,
      snapshotVars: { [dep.id]: { [`VAR_${role}`]: "value" } }, // non-RAILWAY_* subset identic
    };
    topology.push({ id: uuid, name: cc.name });
  }
  return {
    token: { projectId: PROJECT, environmentId: ENV },
    env: { id: ENV, name: "production", configEtag: "etag-A", unmergedChangesCount: null },
    staged: "COMMITTED",
    topology, services,
  };
}

// ── Transport fals scriptabil ────────────────────────────────────────────────────────────────────────────────────
type Responder = (req: GraphQLRequest, nth: number) => TransportResult;
function makeFakeTransport(responder: Responder): { transport: GraphQLTransport; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const transport: GraphQLTransport = async (req) => {
    const nth = counts[req.name] ?? 0;
    counts[req.name] = nth + 1;
    return responder(req, nth);
  };
  return { transport, counts };
}
/** Construiește envelope-ul `data` pt. un query din lume (folosit de responderi). */
function dataFor(world: World, req: GraphQLRequest): unknown {
  switch (req.name) {
    case "projectToken": return { projectToken: world.token };
    case "environment": return { environment: world.env };
    case "environmentStagedChanges": return { environmentStagedChanges: { id: "patch-1", status: world.staged } };
    case "projectServices": return { project: { services: { edges: world.topology.map((s) => ({ node: { id: s.id, name: s.name } })), pageInfo: { hasNextPage: false } } } };
    case "serviceInstance": {
      const s = world.services[req.variables.s];
      if (!s) return { serviceInstance: null }; // va pica parse-ul (invalid_response) — folosit doar dacă se cere un uuid inexistent
      return { serviceInstance: { serviceId: req.variables.s, serviceName: s.serviceName, startCommand: s.startCommand, railwayConfigFile: s.railwayConfigFile, latestDeployment: s.latestDeployment, activeDeployments: s.activeDeployments } };
    }
    case "variablesForServiceDeployment": { const s = world.services[req.variables.s]; return { variablesForServiceDeployment: s ? s.rendered : {} }; }
    case "deploymentSnapshot": {
      for (const uuid of Object.keys(world.services)) { const s = world.services[uuid]; if (Object.hasOwn(s.snapshotVars, req.variables.d)) return { deploymentSnapshot: { id: req.variables.d, variables: s.snapshotVars[req.variables.d] } }; }
      return { deploymentSnapshot: { id: req.variables.d, variables: {} } };
    }
  }
}
function worldResponder(world: World): Responder { return (req) => ({ ok: true, data: dataFor(world, req) }); }
async function run(world: World, maxAttempts = 1): Promise<ClientResult> {
  return readRailwaySnapshot(makeFakeTransport(worldResponder(world)).transport, MANIFEST, { maxAttempts });
}

async function main(): Promise<void> {
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// A. Happy path + integrare cu mapper-ul 2b-1
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const res = await run(happyWorld());
  assert(res.ok === true, "A1: happy → ok");
  if (res.ok) {
    assert(res.snapshot.projectId === PROJECT && res.snapshot.environmentId === ENV, "A2: scope corect în snapshot");
    assert(res.snapshot.hasStagedChanges === false, "A3: hasStagedChanges false");
    assert(res.snapshot.services.length === SERVICE_IDS.length, "A4: toate cele 5 servicii");
    const mcp = res.snapshot.services.find((s) => s.serviceId === UUID.mcp);
    const ccMcp = SERVICE_CROSSCHECK.mcp;
    assert(mcp !== undefined && ccMcp.commandSource === "inline" && mcp.startCommand === ccMcp.startCommand, "A5: mcp startCommand byte-exact (inline)");
    assert(mcp !== undefined && mcp.activeDeployment !== null, "A6: mcp are active colapsat");
    assert(mcp !== undefined && Object.hasOwn(mcp.variables, "RAILWAY_PROJECT_ID"), "A7: rendered include RAILWAY_* (surplus)");
    // Integrare: snapshot-ul e consumat de mapper fără reject.
    const mapped = mapRailwaySnapshotToRawState(res.snapshot, MANIFEST);
    assert(mapped.ok === true, "A8: mapper acceptă snapshot-ul clientului");
    if (mapped.ok) {
      assert(Object.keys(mapped.rawState).length === SERVICE_IDS.length, "A9: toate rolurile mapate");
      assert(mapped.rawState["mcp"]?.running === true, "A10: mcp running:true");
      assert(mapped.diagnostics.every((d) => d.code !== "identity_drift" && d.code !== "service_renamed"), "A11: fără drift/rename");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// B. wrong_scope
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w1 = happyWorld(); w1.token = { projectId: "OTHER", environmentId: ENV };
  assert(rejKind(await run(w1)) === "wrong_scope", "B1: token projectId ≠ → wrong_scope");
  const w2 = happyWorld(); w2.token = { projectId: PROJECT, environmentId: "OTHER" };
  assert(rejKind(await run(w2)) === "wrong_scope", "B2: token environmentId ≠ → wrong_scope");
  const w3 = happyWorld(); w3.env = { ...w3.env, name: "staging" };
  assert(rejKind(await run(w3)) === "wrong_scope", "B3: env.name ≠ production → wrong_scope");
  const w4 = happyWorld(); w4.env = { ...w4.env, id: "OTHER" };
  assert(rejKind(await run(w4)) === "wrong_scope", "B4: env.id ≠ manifest → wrong_scope");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// C. staged fail-closed pe status
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  for (const s of ["STAGED", "APPLYING"]) { const w = happyWorld(); w.staged = s; assert(rejKind(await run(w)) === "staged_changes", `C: ${s} → staged_changes`); }
  for (const s of ["FAILED", "WAT", "committed", ""]) { const w = happyWorld(); w.staged = s; const r = await run(w); assert(!r.ok && (r.reason.kind === "staged_indeterminate" || r.reason.kind === "invalid_response"), `C: ${s || "<empty>"} → indeterminate/invalid`); }
  const wc = happyWorld(); wc.staged = "COMMITTED"; assert((await run(wc)).ok === true, "C: COMMITTED → ok");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// D. topologie: hasNextPage, unexpected_service, rol absent → omis → role_absent la mapper
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // hasNextPage: injectăm un responder care setează pageInfo.hasNextPage=true.
  const w = happyWorld();
  const { transport } = makeFakeTransport((req) => {
    if (req.name === "projectServices") return { ok: true, data: { project: { services: { edges: w.topology.map((s) => ({ node: s })), pageInfo: { hasNextPage: true } } } } };
    return { ok: true, data: dataFor(w, req) };
  });
  assert(rejKind(await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 })) === "topology_truncated", "D1: hasNextPage → topology_truncated");

  // unexpected: UUID live ∉ manifest.
  const w2 = happyWorld(); w2.topology.push({ id: "svc-INTRUDER", name: "Intruder" });
  const r2 = await run(w2);
  assert(!r2.ok && r2.reason.kind === "unexpected_service" && !("service" in r2.reason), "D2: UUID live nemapat → unexpected_service (FĂRĂ UUID extern)");

  // rol absent: scoatem solana din topologie ȘI din servicii → 4 servicii; mapper → role_absent(solana).
  const w3 = happyWorld();
  w3.topology = w3.topology.filter((s) => s.id !== UUID["solana-worker"]);
  delete w3.services[UUID["solana-worker"]];
  const r3 = await run(w3);
  assert(r3.ok === true && r3.snapshot.services.length === 4, "D3: rol absent → 4 servicii în snapshot");
  if (r3.ok) {
    const mapped = mapRailwaySnapshotToRawState(r3.snapshot, MANIFEST);
    assert(mapped.ok === true, "D4: mapper ok cu 4 servicii");
    if (mapped.ok) assert(mapped.diagnostics.some((d) => d.code === "role_absent" && d.service === "solana-worker"), "D5: role_absent(solana) emis de mapper");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// E/F. colaps activeDeployments
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // >1 activ → ambiguous_active_deployments (pe UUID-ul respectiv).
  const w = happyWorld();
  w.services[UUID.mcp].activeDeployments = [{ id: "d1", status: "SUCCESS" }, { id: "d2", status: "SUCCESS" }];
  const r = await run(w);
  assert(!r.ok && r.reason.kind === "ambiguous_active_deployments" && r.reason.service === "mcp", "E1: >1 activ → ambiguous_active_deployments (rol, nu UUID)");

  // 0 activ + latest FAILED (parcat) → activeDeployment null; mapper → running:false (fără drift check).
  const w2 = happyWorld();
  w2.services[UUID.mcp].activeDeployments = [];
  w2.services[UUID.mcp].latestDeployment = { id: "dep-mcp", status: "FAILED" };
  const r2 = await run(w2);
  assert(r2.ok === true, "F1: 0 activ → ok");
  if (r2.ok) {
    const mcp = r2.snapshot.services.find((s) => s.serviceId === UUID.mcp);
    assert(mcp?.activeDeployment === null, "F2: activeDeployment null (colaps 0)");
    const mapped = mapRailwaySnapshotToRawState(r2.snapshot, MANIFEST);
    assert(mapped.ok === true && mapped.rawState["mcp"]?.running === false, "F3: mapper → mcp running:false (parcat)");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// G. fence: etag / staged / topologie / tuple schimbate între Read A și Read C → snapshot_unstable
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // etag schimbat la a 2-a citire environment (nth 1 = Read C).
  {
    const w = happyWorld();
    const { transport } = makeFakeTransport((req, nth) => {
      if (req.name === "environment") return { ok: true, data: { environment: { ...w.env, configEtag: nth === 0 ? "etag-A" : "etag-B" } } };
      return { ok: true, data: dataFor(w, req) };
    });
    assert(rejKind(await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 })) === "snapshot_unstable", "G1: etag A→B → snapshot_unstable");
  }
  // staged schimbat (COMMITTED → STAGED) la Read C.
  {
    const w = happyWorld();
    const { transport } = makeFakeTransport((req, nth) => {
      if (req.name === "environmentStagedChanges") return { ok: true, data: { environmentStagedChanges: { id: "p", status: nth === 0 ? "COMMITTED" : "STAGED" } } };
      return { ok: true, data: dataFor(w, req) };
    });
    assert(rejKind(await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 })) === "snapshot_unstable", "G2: staged COMMITTED→STAGED la C → snapshot_unstable");
  }
  // topologie schimbată (un serviciu redenumit) la Read C.
  {
    const w = happyWorld();
    const { transport } = makeFakeTransport((req, nth) => {
      if (req.name === "projectServices") {
        const topo = nth === 0 ? w.topology : w.topology.map((s) => (s.id === UUID.mcp ? { ...s, name: "Renamed" } : s));
        return { ok: true, data: { project: { services: { edges: topo.map((s) => ({ node: s })), pageInfo: { hasNextPage: false } } } } };
      }
      return { ok: true, data: dataFor(w, req) };
    });
    assert(rejKind(await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 })) === "snapshot_unstable", "G3: topologie schimbată la C → snapshot_unstable");
  }
  // tuple schimbat (deployment status flip) la Read C.
  {
    const w = happyWorld();
    const { transport } = makeFakeTransport((req, nth) => {
      if (req.name === "serviceInstance" && req.variables.s === UUID.mcp) {
        const st = nth < SERVICE_IDS.length ? "SUCCESS" : "CRASHED"; // primul val de servicii = Read A, al doilea = Read C
        return { ok: true, data: { serviceInstance: { serviceId: UUID.mcp, serviceName: SERVICE_CROSSCHECK.mcp.name, startCommand: SERVICE_CROSSCHECK.mcp.commandSource === "inline" ? SERVICE_CROSSCHECK.mcp.startCommand : null, railwayConfigFile: null, latestDeployment: { id: "dep-mcp", status: st }, activeDeployments: [{ id: "dep-mcp", status: st }] } } };
      }
      return { ok: true, data: dataFor(w, req) };
    });
    assert(rejKind(await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 })) === "snapshot_unstable", "G4: tuple schimbat la C → snapshot_unstable");
  }
  // recuperare: fence pică o dată apoi se stabilizează (maxAttempts:2 → ok).
  {
    const w = happyWorld();
    const { transport } = makeFakeTransport((req, nth) => {
      if (req.name === "environment") { const etag = nth <= 1 ? (nth === 0 ? "etag-A" : "etag-B") : "etag-B"; return { ok: true, data: { environment: { ...w.env, configEtag: etag } } }; }
      return { ok: true, data: dataFor(w, req) };
    });
    // Attempt 1: env nth0=A, nth1=B → unstable. Attempt 2: nth2=B, nth3=B → stabil → ok.
    const r = await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 2 });
    assert(r.ok === true, "G5: fence se recuperează cu retry (maxAttempts:2) → ok");
  }
  // epuizare: instabil pe toate încercările → snapshot_unstable.
  {
    const w = happyWorld();
    const { transport } = makeFakeTransport((req, nth) => {
      if (req.name === "environment") return { ok: true, data: { environment: { ...w.env, configEtag: `etag-${nth}` } } }; // mereu diferit A→C
      return { ok: true, data: dataFor(w, req) };
    });
    assert(rejKind(await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 3 })) === "snapshot_unstable", "G6: fence instabil pe 3 încercări → snapshot_unstable");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// H. drift running-stale
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // Mismatch non-RAILWAY_*: rendered are o cheie/valoare diferită de deploymentSnapshot pe un serviciu ACTIV.
  const w = happyWorld();
  const dep = w.services[UUID.mcp].activeDeployments[0].id;
  w.services[UUID.mcp].rendered = { VAR_mcp: "NEW", RAILWAY_PROJECT_ID: PROJECT };
  w.services[UUID.mcp].snapshotVars = { [dep]: { VAR_mcp: "OLD" } }; // valoare diferită → running-stale
  const r = await run(w);
  assert(!r.ok && r.reason.kind === "running_stale_drift" && r.reason.service === "mcp", "H1: valoare non-RAILWAY_* diferită → running_stale_drift (rol, nu UUID)");

  // Surplus RAILWAY_* în rendered (nu și în snapshot) → NU e drift.
  const w2 = happyWorld();
  const dep2 = w2.services[UUID.mcp].activeDeployments[0].id;
  w2.services[UUID.mcp].rendered = { VAR_mcp: "value", RAILWAY_PROJECT_ID: PROJECT, RAILWAY_EXTRA: "x" };
  w2.services[UUID.mcp].snapshotVars = { [dep2]: { VAR_mcp: "value" } };
  assert((await run(w2)).ok === true, "H2: surplus RAILWAY_* tolerat (fără drift)");

  // Cheie non-RAILWAY_* în plus în rendered (adăugată post-deploy) → drift.
  const w3 = happyWorld();
  const dep3 = w3.services[UUID.mcp].activeDeployments[0].id;
  w3.services[UUID.mcp].rendered = { VAR_mcp: "value", NEW_KEY: "y", RAILWAY_PROJECT_ID: PROJECT };
  w3.services[UUID.mcp].snapshotVars = { [dep3]: { VAR_mcp: "value" } };
  assert(rejKind(await run(w3)) === "running_stale_drift", "H3: cheie non-RAILWAY_* nouă în rendered → drift");

  // Serviciu PARCAT (0 activ) cu snapshot diferit → NU se face drift check (fără deploymentSnapshot).
  const w4 = happyWorld();
  w4.services[UUID.mcp].activeDeployments = [];
  w4.services[UUID.mcp].latestDeployment = { id: "dep-mcp", status: "FAILED" };
  w4.services[UUID.mcp].rendered = { VAR_mcp: "WHATEVER", RAILWAY_PROJECT_ID: PROJECT };
  assert((await run(w4)).ok === true, "H4: serviciu parcat → fără drift check");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// I. erori de transport → transport_error{at, code}
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const failAt = async (name: QueryName, code: TransportErrorCode): Promise<ClientResult> => {
    const w = happyWorld();
    const { transport } = makeFakeTransport((req) => (req.name === name ? { ok: false, code } : { ok: true, data: dataFor(w, req) }));
    return readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 });
  };
  for (const [name, code] of [["projectToken", "network_error"], ["environment", "http_error"], ["environmentStagedChanges", "timeout"], ["projectServices", "graphql_errors"], ["serviceInstance", "parse_error"], ["variablesForServiceDeployment", "oversized"], ["deploymentSnapshot", "invalid_structure"]] as [QueryName, TransportErrorCode][]) {
    const r = await failAt(name, code);
    assert(!r.ok && r.reason.kind === "transport_error" && r.reason.at === name && r.reason.code === code, `I: transport ${code} @ ${name}`);
  }
  // throw în transport → network_error (nu iese excepție).
  {
    const w = happyWorld();
    const transport: GraphQLTransport = async (req) => { if (req.name === "environment") throw new Error("boom"); return { ok: true, data: dataFor(w, req) }; };
    const r = await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 });
    assert(!r.ok && r.reason.kind === "transport_error" && r.reason.code === "network_error", "I8: throw → network_error (fără excepție)");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// J. răspunsuri malformate → invalid_response{at}
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const bad = async (name: QueryName, data: unknown): Promise<ClientResult> => {
    const w = happyWorld();
    const { transport } = makeFakeTransport((req) => (req.name === name ? { ok: true, data } : { ok: true, data: dataFor(w, req) }));
    return readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 });
  };
  const cases: [QueryName, unknown][] = [
    ["projectToken", { projectToken: { projectId: "" } }],                 // lipsă environmentId + gol
    ["environment", { environment: { id: ENV, name: "production", configEtag: "e" } }], // lipsă unmergedChangesCount
    ["environmentStagedChanges", { environmentStagedChanges: { id: "p" } }],// lipsă status
    ["projectServices", { project: { services: { edges: [{ node: { id: "x" } }], pageInfo: { hasNextPage: false } } } }], // node fără name
    ["serviceInstance", { serviceInstance: { serviceId: UUID.mcp } }],      // formă incompletă
    ["variablesForServiceDeployment", { variablesForServiceDeployment: { K: 5 } }], // valoare non-string/null
    ["deploymentSnapshot", { deploymentSnapshot: { id: "d", variables: [1, 2] } }], // variables nu e map
  ];
  for (const [name, data] of cases) { const r = await bad(name, data); assert(!r.ok && r.reason.kind === "invalid_response" && r.reason.at === name, `J: invalid_response @ ${name}`); }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// K. manifest invalid
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = happyWorld();
  const t = makeFakeTransport(worldResponder(w)).transport;
  assert(rejKind(await readRailwaySnapshot(t, { ...MANIFEST, projectId: "" } as RailwayManifest, {})) === "invalid_manifest", "K1: projectId gol → invalid_manifest");
  assert(rejKind(await readRailwaySnapshot(t, { ...MANIFEST, serviceIds: { redis: "x" } } as unknown as RailwayManifest, {})) === "invalid_manifest", "K2: serviceIds incomplet → invalid_manifest");
  const dupIds = { ...UUID, mcp: UUID.redis };
  assert(rejKind(await readRailwaySnapshot(t, { ...MANIFEST, serviceIds: dupIds } as RailwayManifest, {})) === "invalid_manifest", "K3: UUID duplicat → invalid_manifest");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// L. sealed (null) păstrat → env_unreadable la mapper
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = happyWorld();
  const dep = w.services[UUID.mcp].activeDeployments[0].id;
  w.services[UUID.mcp].rendered = { VAR_mcp: "value", SEALED_KEY: null, RAILWAY_PROJECT_ID: PROJECT };
  w.services[UUID.mcp].snapshotVars = { [dep]: { VAR_mcp: "value", SEALED_KEY: null } }; // identice → fără drift
  const r = await run(w);
  assert(r.ok === true, "L1: sealed → ok");
  if (r.ok) {
    const mcp = r.snapshot.services.find((s) => s.serviceId === UUID.mcp);
    assert(mcp !== undefined && mcp.variables["SEALED_KEY"] === null, "L2: null păstrat în snapshot.variables");
    const mapped = mapRailwaySnapshotToRawState(r.snapshot, MANIFEST);
    assert(mapped.ok === true, "L3: mapper ok");
    if (mapped.ok) {
      assert(mapped.diagnostics.some((d) => d.code === "env_unreadable" && d.service === "mcp"), "L4: env_unreadable(mcp)");
      assert(mapped.rawState["mcp"]?.env["SEALED_KEY"] === undefined, "L5: cheia sealed OMISĂ din env (fără placeholder)");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// M. transport REAL (makeRailwayTransport) cu fetch fals
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
const TOKEN = "tok-SECRET-should-only-appear-in-header";
function jsonResponse(obj: unknown, status = 200): Response { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } }); }

{
  // Success + assertări pe cererea fetch.
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => { seenUrl = String(url); seenInit = init; return jsonResponse({ data: { projectToken: { projectId: PROJECT, environmentId: ENV } } }); }) as unknown as typeof fetch;
  const t = makeRailwayTransport({ token: TOKEN, fetchImpl });
  const r = await t({ name: "projectToken", query: "query { projectToken { projectId environmentId } }", variables: {} });
  assert(r.ok === true, "M1: success → ok");
  assert(seenUrl === "https://backboard.railway.com/graphql/v2", "M2: endpoint FIX");
  assert(seenInit?.method === "POST", "M3: POST");
  assert(seenInit?.redirect === "error", "M4: redirect:error");
  const hdrs = (seenInit?.headers ?? {}) as Record<string, string>;
  assert(hdrs["Project-Access-Token"] === TOKEN, "M5: header Project-Access-Token = token");
  assert(!("Authorization" in hdrs), "M6: fără Authorization/Bearer");
  const body = JSON.parse(String(seenInit?.body));
  assert(body.query.includes("projectToken") && typeof body.variables === "object", "M7: body = {query, variables}");
  if (r.ok) { const d = r.data as { projectToken?: { projectId?: string } }; assert(d.projectToken?.projectId === PROJECT, "M8: data extras corect"); }
}
{
  // non-2xx → http_error (corpul NU e citit).
  const fetchImpl = (async () => jsonResponse({ data: { x: 1 } }, 500)) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "http_error", "M9: 500 → http_error");
}
{
  // errors non-empty → graphql_errors (fără mesaj).
  const fetchImpl = (async () => jsonResponse({ errors: [{ message: "SECRET LEAK" }], data: null })) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "graphql_errors", "M10: errors[] → graphql_errors");
}
{
  // data null fără errors → invalid_structure.
  const fetchImpl = (async () => jsonResponse({ data: null })) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "invalid_structure", "M11: data null → invalid_structure");
}
{
  // JSON invalid → parse_error.
  const fetchImpl = (async () => new Response("not json{", { status: 200 })) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "parse_error", "M12: JSON invalid → parse_error");
}
{
  // corp peste limită → oversized.
  const big = "x".repeat(5000);
  const fetchImpl = (async () => new Response(JSON.stringify({ data: { big } }), { status: 200 })) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl, maxBytes: 1000 })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "oversized", "M13: corp > maxBytes → oversized");
}
{
  // AbortError → timeout.
  const fetchImpl = (async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "timeout", "M14: AbortError → timeout");
}
{
  // eroare generică → network_error.
  const fetchImpl = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "network_error", "M15: throw generic → network_error");
}
{
  // end-to-end cu transport real fals: readRailwaySnapshot condus prin makeRailwayTransport pe o lume-fetch.
  const w = happyWorld();
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
    // dispatch pe conținutul query-ului
    let name: QueryName;
    if (b.query.includes("projectToken")) name = "projectToken";
    else if (b.query.includes("environmentStagedChanges")) name = "environmentStagedChanges";
    else if (b.query.includes("environment(")) name = "environment";
    else if (b.query.includes("project(")) name = "projectServices";
    else if (b.query.includes("serviceInstance(")) name = "serviceInstance";
    else if (b.query.includes("variablesForServiceDeployment(")) name = "variablesForServiceDeployment";
    else name = "deploymentSnapshot";
    return jsonResponse({ data: dataFor(w, { name, query: b.query, variables: b.variables }) });
  }) as unknown as typeof fetch;
  const transport = makeRailwayTransport({ token: TOKEN, fetchImpl });
  const r = await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 });
  assert(r.ok === true && r.snapshot.services.length === SERVICE_IDS.length, "M16: e2e prin transport real fals → ok");
}
{
  // M17: allowlist — mutation, shorthand ȘI query de READ arbitrar → blocked_query, fetch NEapelat.
  const tryBlocked = async (name: QueryName, query: string): Promise<{ code: string | undefined; called: boolean }> => {
    let called = false;
    const fetchImpl = (async () => { called = true; return jsonResponse({ data: {} }); }) as unknown as typeof fetch;
    const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })({ name, query, variables: {} });
    return { code: r.ok ? undefined : r.code, called };
  };
  const a = await tryBlocked("environment", "mutation { doThing }");
  assert(a.code === "blocked_query" && a.called === false, "M17: mutation → blocked_query (fără fetch)");
  const b = await tryBlocked("environment", "{ projectToken { projectId } }");
  assert(b.code === "blocked_query" && b.called === false, "M17b: shorthand → blocked_query (fără fetch)");
  const c = await tryBlocked("environment", "query { somethingElse { id } }"); // READ arbitrar, dar ≠ allowlist
  assert(c.code === "blocked_query" && c.called === false, "M17c: query READ arbitrar → blocked_query (fără fetch)");
  const d = await tryBlocked("environment", QUERIES.projectToken); // query cunoscut dar nepotrivit cu name
  assert(d.code === "blocked_query" && d.called === false, "M17d: query≠QUERIES[name] → blocked_query");
}
{
  // M18: corp care nu se termină → timeout-ul acoperă citirea (signal abortează stream-ul).
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const boom = () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal.aborted) { boom(); return; }
        signal.addEventListener("abort", boom); // altfel nu emite/închide niciodată
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl, timeoutMs: 60 })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "timeout", "M18: corp never-resolving → timeout (acoperă corpul)");
}
{
  // M19: envelope cu `errors` non-array + data validă → invalid_structure (nu acceptat).
  const fetchImpl = (async () => jsonResponse({ errors: "garbage", data: { x: 1 } })) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "invalid_structure", "M19: errors non-array → invalid_structure");
}
{
  // M20: factory validează token/timeoutMs/maxBytes (config-time throw).
  const threw = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };
  assert(threw(() => makeRailwayTransport({ token: "" })), "M20a: token gol → throw");
  assert(threw(() => makeRailwayTransport({ token: TOKEN, timeoutMs: -5 })), "M20b: timeoutMs ≤0 → throw");
  assert(threw(() => makeRailwayTransport({ token: TOKEN, timeoutMs: Number.NaN })), "M20c: timeoutMs NaN → throw");
  assert(threw(() => makeRailwayTransport({ token: TOKEN, maxBytes: 0 })), "M20d: maxBytes 0 → throw");
  assert(!threw(() => makeRailwayTransport({ token: TOKEN, timeoutMs: 1_000_000, maxBytes: 999_999_999 })), "M20e: valori enorme → acceptate (plafonate)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// N. legare cerere↔răspuns
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // N1: serviceInstance răspunde cu alt serviceId decât cel cerut → invalid_response.
  const w = happyWorld();
  const { transport } = makeFakeTransport((req) => {
    if (req.name === "serviceInstance" && req.variables.s === UUID.mcp) {
      const s = w.services[UUID.mcp];
      return { ok: true, data: { serviceInstance: { serviceId: "svc-WRONG-uuid", serviceName: s.serviceName, startCommand: s.startCommand, railwayConfigFile: s.railwayConfigFile, latestDeployment: s.latestDeployment, activeDeployments: s.activeDeployments } } };
    }
    return { ok: true, data: dataFor(w, req) };
  });
  const r = await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 });
  assert(!r.ok && r.reason.kind === "invalid_response" && r.reason.at === "serviceInstance", "N1: serviceId greșit → invalid_response");

  // N2: deploymentSnapshot răspunde cu alt id decât deploymentId-ul cerut → invalid_response.
  const w2 = happyWorld();
  const { transport: t2 } = makeFakeTransport((req) => {
    if (req.name === "deploymentSnapshot") return { ok: true, data: { deploymentSnapshot: { id: "dep-WRONG", variables: {} } } };
    return { ok: true, data: dataFor(w2, req) };
  });
  const r2 = await readRailwaySnapshot(t2, MANIFEST, { maxAttempts: 1 });
  assert(!r2.ok && r2.reason.kind === "invalid_response" && r2.reason.at === "deploymentSnapshot", "N2: deploymentId greșit → invalid_response");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// O. fence bracket: schimbare DUPĂ primul etag din Read C (prinsă de etag-ul de final)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = happyWorld();
  // environment: nth0=A (Read A, E0), nth1=A (Read C început, == E0), nth2=B (Read C final ≠ E0).
  const { transport } = makeFakeTransport((req, nth) => {
    if (req.name === "environment") return { ok: true, data: { environment: { ...w.env, configEtag: nth < 2 ? "etag-A" : "etag-B" } } };
    return { ok: true, data: dataFor(w, req) };
  });
  assert(rejKind(await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 })) === "snapshot_unstable", "O1: schimbare după primul etag Read-C → snapshot_unstable (bracket)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// P. manifest null / Proxy ostil → invalid_manifest (fără throw scăpat)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const t = makeFakeTransport(worldResponder(happyWorld())).transport;
  assert(rejKind(await readRailwaySnapshot(t, null)) === "invalid_manifest", "P1: manifest null → invalid_manifest");
  assert(rejKind(await readRailwaySnapshot(t, undefined)) === "invalid_manifest", "P2: manifest undefined → invalid_manifest");
  // Proxy al cărui getter aruncă → prins de try/catch → invalid_manifest.
  const hostile = new Proxy({} as Record<string, unknown>, {
    get() { throw new Error("hostile getter"); },
    has() { return true; },
    ownKeys() { return ["projectId", "environmentId", "serviceIds", "commandSource"]; },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
  assert(rejKind(await readRailwaySnapshot(t, hostile)) === "invalid_manifest", "P3: Proxy getter care aruncă → invalid_manifest (fără throw)");
  // getter ne-determinist pe projectId → double-read îl prinde.
  let n = 0;
  const toctou = { get projectId() { return `p${n++}`; }, environmentId: ENV, serviceIds: { ...UUID }, commandSource: { ...CMDSRC } };
  assert(rejKind(await readRailwaySnapshot(t, toctou)) === "invalid_manifest", "P4: projectId ne-determinist → invalid_manifest (double-read)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Q. maxAttempts enorm → plafonat, se termină (fără buclă infinită)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = happyWorld();
  const { transport } = makeFakeTransport((req, nth) => {
    if (req.name === "environment") return { ok: true, data: { environment: { ...w.env, configEtag: `etag-${nth}` } } }; // mereu instabil A→C
    return { ok: true, data: dataFor(w, req) };
  });
  const r = await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1e9 });
  assert(rejKind(r) === "snapshot_unstable", "Q1: maxAttempts enorm → snapshot_unstable (plafonat, terminat)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// R. ID malformat (newline) + topologie duplicată → invalid_response
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // R1: UUID extern cu newline în topologie → parse respinge (nu unexpected_service).
  const w = happyWorld(); w.topology.push({ id: "svc-\nHACK", name: "x" });
  const r = await run(w);
  assert(!r.ok && r.reason.kind === "invalid_response" && r.reason.at === "projectServices", "R1: UUID cu newline → invalid_response");

  // R2: ID duplicat în topologie → refuz (Set-ul nu colapsează tăcut).
  const w2 = happyWorld(); w2.topology.push({ id: UUID.mcp, name: "Duplicat" });
  const r2 = await run(w2);
  assert(!r2.ok && r2.reason.kind === "invalid_response" && r2.reason.at === "projectServices", "R2: topologie duplicată → invalid_response");

  // R3: unmergedChangesCount non-number/null → invalid_response @ environment.
  const w3 = happyWorld();
  const { transport } = makeFakeTransport((req) => {
    if (req.name === "environment") return { ok: true, data: { environment: { ...w3.env, unmergedChangesCount: "many" } } };
    return { ok: true, data: dataFor(w3, req) };
  });
  const r3 = await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 });
  assert(!r3.ok && r3.reason.kind === "invalid_response" && r3.reason.at === "environment", "R3: unmergedChangesCount invalid → invalid_response");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// S. output DEEP-FROZEN
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const r = await run(happyWorld());
  assert(Object.isFrozen(r), "S1: ClientResult frozen");
  if (r.ok) {
    assert(Object.isFrozen(r.snapshot), "S2: snapshot frozen");
    assert(Object.isFrozen(r.snapshot.services), "S3: services frozen");
    assert(Object.isFrozen(r.snapshot.services[0]), "S4: service[0] frozen");
    assert(Object.isFrozen(r.snapshot.services[0].variables), "S5: variables frozen");
  }
  // refuz frozen.
  const rej = await readRailwaySnapshot(makeFakeTransport(worldResponder(happyWorld())).transport, null);
  assert(Object.isFrozen(rej), "S6: reject frozen");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// T. limita corpului NEocolibilă: stream absent → NU se cheamă res.text() → oversized (fail-closed)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  let textCalled = false;
  const fakeRes = { ok: true, status: 200, body: null, text: async () => { textCalled = true; return JSON.stringify({ data: { x: 1 } }); } } as unknown as Response;
  const fetchImpl = (async () => fakeRes) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "body_unavailable", "T1: stream absent → body_unavailable (cod semantic)");
  assert(textCalled === false, "T2: res.text() NU a fost apelat (limita neocolibilă)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// V. fence: schimbare startCommand / railwayConfigFile în Read C → snapshot_unstable
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // serviceInstance pt. mcp: startCommand diferit la Read C (nth ≥ nr. servicii = a doua rundă).
  const w = happyWorld();
  const mkSI = (cmd: string) => ({ serviceInstance: { serviceId: UUID.mcp, serviceName: SERVICE_CROSSCHECK.mcp.name, startCommand: cmd, railwayConfigFile: null, latestDeployment: { id: "dep-mcp", status: "SUCCESS" }, activeDeployments: [{ id: "dep-mcp", status: "SUCCESS" }] } });
  const orig = SERVICE_CROSSCHECK.mcp.commandSource === "inline" ? SERVICE_CROSSCHECK.mcp.startCommand : "x";
  const { transport } = makeFakeTransport((req, nth) => {
    if (req.name === "serviceInstance" && req.variables.s === UUID.mcp) return { ok: true, data: mkSI(nth < SERVICE_IDS.length ? orig : "npm run HACKED") };
    return { ok: true, data: dataFor(w, req) };
  });
  assert(rejKind(await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 })) === "snapshot_unstable", "V1: startCommand schimbat în Read C → snapshot_unstable");

  // railwayConfigFile schimbat la Read C pentru solana (config_file).
  const w2 = happyWorld();
  const mkSol = (cf: string) => ({ serviceInstance: { serviceId: UUID["solana-worker"], serviceName: SERVICE_CROSSCHECK["solana-worker"].name, startCommand: null, railwayConfigFile: cf, latestDeployment: { id: "dep-solana-worker", status: "SUCCESS" }, activeDeployments: [{ id: "dep-solana-worker", status: "SUCCESS" }] } });
  const origCf = SERVICE_CROSSCHECK["solana-worker"].commandSource === "config_file" ? SERVICE_CROSSCHECK["solana-worker"].configFile : "/x";
  const { transport: t2 } = makeFakeTransport((req, nth) => {
    if (req.name === "serviceInstance" && req.variables.s === UUID["solana-worker"]) return { ok: true, data: mkSol(nth < SERVICE_IDS.length ? origCf : "/workers/solana/HACKED.json") };
    return { ok: true, data: dataFor(w2, req) };
  });
  assert(rejKind(await readRailwaySnapshot(t2, MANIFEST, { maxAttempts: 1 })) === "snapshot_unstable", "V2: railwayConfigFile schimbat în Read C → snapshot_unstable");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// W. fence bracket: staged schimbat DUPĂ prima citire din Read C → snapshot_unstable (bracket final)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const w = happyWorld();
  // staged: nth0=COMMITTED (Read A, S0), nth1=COMMITTED (Read C început, ==S0), nth2=STAGED (Read C final ≠ S0).
  const { transport } = makeFakeTransport((req, nth) => {
    if (req.name === "environmentStagedChanges") return { ok: true, data: { environmentStagedChanges: { id: "patch-1", status: nth < 2 ? "COMMITTED" : "STAGED" } } };
    return { ok: true, data: dataFor(w, req) };
  });
  assert(rejKind(await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 })) === "snapshot_unstable", "W1: staged schimbat după prima citire C → snapshot_unstable (bracket)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// X. manifest hardening: serviceIds extra key, commandSource invalid, opts=null, getter ostil
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const t = makeFakeTransport(worldResponder(happyWorld())).transport;
  const extraIds = { ...UUID, extraneous: "svc-extra-uuid" };
  assert(rejKind(await readRailwaySnapshot(t, { ...MANIFEST, serviceIds: extraIds } as unknown as RailwayManifest)) === "invalid_manifest", "X1: serviceIds cu extra key → invalid_manifest");
  const badCmd = { ...CMDSRC, mcp: "wat" };
  assert(rejKind(await readRailwaySnapshot(t, { ...MANIFEST, commandSource: badCmd } as unknown as RailwayManifest)) === "invalid_manifest", "X2: commandSource invalid → invalid_manifest");
  const extraCmdKey = { ...CMDSRC, extraneous: "inline" };
  assert(rejKind(await readRailwaySnapshot(t, { ...MANIFEST, commandSource: extraCmdKey } as unknown as RailwayManifest)) === "invalid_manifest", "X3: commandSource cu extra key → invalid_manifest");
  // opts=null → tratat ca {} (fără throw).
  const rNull = await readRailwaySnapshot(t, MANIFEST, null as unknown as undefined);
  assert(rNull.ok === true, "X4: opts=null → tratat ca implicit (ok)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Y. anti-leak: NICIUN UUID extern în ClientRejectReason
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const uuidLike = /uuid|svc-|proj-|env-|dep-/i;
  const reasons: ClientRejectReason[] = [];
  // unexpected_service
  { const w = happyWorld(); w.topology.push({ id: "svc-INTRUDER", name: "x" }); const r = await run(w); if (!r.ok) reasons.push(r.reason); }
  // ambiguous
  { const w = happyWorld(); w.services[UUID.mcp].activeDeployments = [{ id: "d1", status: "SUCCESS" }, { id: "d2", status: "SUCCESS" }]; const r = await run(w); if (!r.ok) reasons.push(r.reason); }
  // drift
  { const w = happyWorld(); const dep = w.services[UUID.mcp].activeDeployments[0].id; w.services[UUID.mcp].rendered = { VAR_mcp: "NEW", RAILWAY_PROJECT_ID: PROJECT }; w.services[UUID.mcp].snapshotVars = { [dep]: { VAR_mcp: "OLD" } }; const r = await run(w); if (!r.ok) reasons.push(r.reason); }
  assert(reasons.length === 3, "Y0: cele 3 refuzuri produse");
  for (const reason of reasons) {
    // orice valoare string din reason NU trebuie să semene cu un UUID de serviciu/proiect/deployment.
    const leak = Object.values(reason as Record<string, unknown>).some((v) => typeof v === "string" && uuidLike.test(v));
    assert(!leak, `Y: fără UUID extern în refuz ${(reason as { kind: string }).kind}`);
  }
  // rolurile din ambiguous/drift sunt ServiceId valide (nu UUID).
  const amb = reasons.find((r) => r.kind === "ambiguous_active_deployments");
  const drift = reasons.find((r) => r.kind === "running_stale_drift");
  assert(amb !== undefined && amb.kind === "ambiguous_active_deployments" && (SERVICE_IDS as readonly string[]).includes(amb.service), "Y1: ambiguous.service e rol valid");
  assert(drift !== undefined && drift.kind === "running_stale_drift" && (SERVICE_IDS as readonly string[]).includes(drift.service), "Y2: drift.service e rol valid");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Z. buget global: maxAttempts plafonat la 3 + AbortSignal → aborted (terminare determinist)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // AbortSignal deja abortat → aborted, fără citiri.
  const ac = new AbortController(); ac.abort();
  let anyCall = false;
  const transport: GraphQLTransport = async () => { anyCall = true; return { ok: true, data: {} }; };
  const r = await readRailwaySnapshot(transport, MANIFEST, { signal: ac.signal });
  assert(!r.ok && r.reason.kind === "aborted", "Z1: signal abortat → aborted");
  assert(anyCall === false, "Z2: niciun apel de transport după abort");

  // Abort la jumătate (după N apeluri) → se termină determinist cu aborted.
  const ac2 = new AbortController();
  let n = 0;
  const w = happyWorld();
  const t2: GraphQLTransport = async (req) => { if (++n === 3) ac2.abort(); return { ok: true, data: dataFor(w, req) }; };
  const r2 = await readRailwaySnapshot(t2, MANIFEST, { signal: ac2.signal, maxAttempts: 3 });
  assert(!r2.ok && r2.reason.kind === "aborted", "Z3: abort la jumătate → aborted (determinist)");

  // maxAttempts enorm + fence mereu instabil → plafonat la 3, se termină.
  const wU = happyWorld();
  const { transport: tU } = makeFakeTransport((req, nth) => {
    if (req.name === "environment") return { ok: true, data: { environment: { ...wU.env, configEtag: `etag-${nth}` } } };
    return { ok: true, data: dataFor(wU, req) };
  });
  assert(rejKind(await readRailwaySnapshot(tU, MANIFEST, { maxAttempts: 1e9 })) === "snapshot_unstable", "Z4: maxAttempts enorm → plafonat, snapshot_unstable");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// AA. unmergedChangesCount: NaN / Infinity / negativ / fracție → invalid_response (null/int≥0 acceptate)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const badU = async (val: unknown): Promise<ClientResult> => {
    const w = happyWorld();
    const { transport } = makeFakeTransport((req) => {
      if (req.name === "environment") return { ok: true, data: { environment: { ...w.env, unmergedChangesCount: val } } };
      return { ok: true, data: dataFor(w, req) };
    });
    return readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 });
  };
  for (const [label, val] of [["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["negativ", -1], ["fracție", 1.5], ["string", "many"]] as [string, unknown][]) {
    const r = await badU(val);
    assert(!r.ok && r.reason.kind === "invalid_response" && r.reason.at === "environment", `AA: unmergedChangesCount ${label} → invalid_response`);
  }
  // null și int≥0 → acceptate.
  const rNull = await badU(null); assert(rNull.ok === true, "AA: unmergedChangesCount null → ok");
  const rInt = await badU(3); assert(rInt.ok === true, "AA: unmergedChangesCount 3 → ok");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// BB. allowlist FĂRĂ TOCTOU: getter pe req.query → blocked_query, fetch NEapelat; corpul e mereu canonicul
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // req.query ca getter (canonic la prima citire, mutation la a doua) → detectat ca accessor → blocked_query, fără fetch.
  let called = false;
  const fetchImpl = (async () => { called = true; return jsonResponse({ data: {} }); }) as unknown as typeof fetch;
  let reads = 0;
  const hostileReq = { name: "projectToken" as QueryName, variables: {} as Record<string, string> };
  Object.defineProperty(hostileReq, "query", { enumerable: true, configurable: true, get() { return reads++ === 0 ? QUERIES.projectToken : "mutation { hack }"; } });
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })(hostileReq as unknown as GraphQLRequest);
  assert(!r.ok && r.code === "blocked_query", "BB1: getter pe query → blocked_query");
  assert(called === false, "BB2: fetch NEapelat pt. getter pe query");

  // Corpul trimis e ÎNTOTDEAUNA canonicul (chiar dacă req.query ar diferi ca valoare de date, e respins înainte).
  let seenBody = "";
  const fetchImpl2 = (async (_u: string, init?: RequestInit) => { seenBody = String(init?.body); return jsonResponse({ data: { projectToken: { projectId: PROJECT, environmentId: ENV } } }); }) as unknown as typeof fetch;
  const ok = await makeRailwayTransport({ token: TOKEN, fetchImpl: fetchImpl2 })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(ok.ok === true && JSON.parse(seenBody).query === QUERIES.projectToken, "BB3: corpul trimis = query canonic");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// CC. AbortSignal anulează cererea ACTIVĂ (never-resolving) → operația se termină imediat cu aborted + fetch anulat
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const ac = new AbortController();
  let fetchAborted: boolean = false;
  const w = happyWorld();
  // fetch never-resolving care RESPECTĂ signal-ul (rejectează la abort) → dovedește că cererea activă e anulată.
  const fetchImpl = ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    const sig = init?.signal as AbortSignal;
    if (sig) sig.addEventListener("abort", () => { fetchAborted = true; rej(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  })) as unknown as typeof fetch;
  const transport = makeRailwayTransport({ token: TOKEN, fetchImpl });
  const p = readRailwaySnapshot(transport, MANIFEST, { signal: ac.signal, maxAttempts: 1 });
  setTimeout(() => ac.abort(), 20); // abort extern după ce cererea e în zbor
  const r = await p;
  assert(!r.ok && r.reason.kind === "aborted", "CC1: never-resolving + abort → aborted (imediat)");
  assert(fetchAborted, "CC2: cererea activă (fetch) a fost anulată prin req.signal");
  void w;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// DD. semnături INJECTIVE — coliziuni deliberate rămân distincte
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // topologyOf: două stări care ar colida sub concatenare naivă (name conține delimitatori) → distincte cu JSON.
  const t1 = topologyOf([{ id: "a", name: "b\u001ec\u001fd" }]);
  const t2 = topologyOf([{ id: "a", name: "b" }, { id: "c", name: "d" }]);
  assert(t1 !== t2, "DD1: topologyOf injectiv (coliziune naivă evitată)");

  // signatureOf: name/startCommand cu delimitatori care ar colida naiv → distincte.
  const mk = (name: string, cmd: string) => ({ serviceId: "svc-x", serviceName: name, startCommand: cmd, railwayConfigFile: null, latestDeployment: { id: "d", status: "SUCCESS" }, activeDeployments: [{ id: "d", status: "SUCCESS" }] });
  const s1 = signatureOf(mk("a", "b\u001dc"));
  const s2 = signatureOf(mk("a\u001db", "c"));
  assert(s1 !== s2, "DD2: signatureOf injectiv (coliziune naivă evitată)");

  // și prin fence: schimbare name↔cmd care ar colida naiv → snapshot_unstable.
  const w = happyWorld();
  const mkSI = (name: string, cmd: string) => ({ serviceInstance: { serviceId: UUID.mcp, serviceName: name, startCommand: cmd, railwayConfigFile: null, latestDeployment: { id: "dep-mcp", status: "SUCCESS" }, activeDeployments: [{ id: "dep-mcp", status: "SUCCESS" }] } });
  const { transport } = makeFakeTransport((req, nth) => {
    if (req.name === "serviceInstance" && req.variables.s === UUID.mcp) return { ok: true, data: nth < SERVICE_IDS.length ? mkSI("a", "b\u001dc") : mkSI("a\u001db", "c") };
    return { ok: true, data: dataFor(w, req) };
  });
  assert(rejKind(await readRailwaySnapshot(transport, MANIFEST, { maxAttempts: 1 })) === "snapshot_unstable", "DD3: coliziune name↔cmd în Read C → snapshot_unstable");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// EE. getteri ostili pe opts / factory options → cod static, fără ecoul mesajului
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const t = makeFakeTransport(worldResponder(happyWorld())).transport;
  // opts cu getter care aruncă → invalid_options (fără throw scăpat, fără ecou).
  const hostileOpts = {} as ReadOptions;
  Object.defineProperty(hostileOpts, "maxAttempts", { get() { throw new Error("SECRET opts leak"); } });
  const r = await readRailwaySnapshot(t, MANIFEST, hostileOpts);
  assert(!r.ok && r.reason.kind === "invalid_options", "EE1: getter ostil pe opts → invalid_options");

  // factory options cu getter care aruncă → eroare de config cu mesaj FIX (fără ecou).
  const hostileFactory = { fetchImpl: (async () => jsonResponse({ data: {} })) as unknown as typeof fetch } as RailwayTransportOptions;
  Object.defineProperty(hostileFactory, "token", { get() { throw new Error("SECRET token leak"); } });
  let msg = "";
  try { makeRailwayTransport(hostileFactory); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
  assert(msg.startsWith("railway transport:") && !msg.includes("SECRET"), "EE2: getter ostil pe factory options → mesaj fix (fără ecou)");

  // signal invalid (nu e AbortSignal) → invalid_options.
  const r2 = await readRailwaySnapshot(t, MANIFEST, { signal: {} as AbortSignal });
  assert(!r2.ok && r2.reason.kind === "invalid_options", "EE3: signal ne-AbortSignal → invalid_options");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// FF. commandSource enum-valid dar GREȘIT pentru rol → invalid_manifest, ZERO apeluri de transport
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  let calls = 0;
  const transport: GraphQLTransport = async (req) => { calls++; return { ok: true, data: dataFor(happyWorld(), req) }; };
  const badRole = { ...CMDSRC, mcp: "config_file" as CommandSource };          // mcp e inline în catalog
  const r = await readRailwaySnapshot(transport, { ...MANIFEST, commandSource: badRole } as RailwayManifest, { maxAttempts: 1 });
  assert(!r.ok && r.reason.kind === "invalid_manifest", "FF1: commandSource greșit pt. rol → invalid_manifest");
  assert(calls === 0, "FF2: ZERO apeluri de transport (respins înainte de I/O)");
  const badRole2 = { ...CMDSRC, "solana-worker": "inline" as CommandSource };  // solana e config_file în catalog
  const r2 = await readRailwaySnapshot(transport, { ...MANIFEST, commandSource: badRole2 } as RailwayManifest, { maxAttempts: 1 });
  assert(!r2.ok && r2.reason.kind === "invalid_manifest", "FF3: solana inline → invalid_manifest");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// GG. maxAttempts invalid → invalid_options (doar undefined folosește implicitul)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const t = makeFakeTransport(worldResponder(happyWorld())).transport;
  for (const [label, val] of [["0", 0], ["negativ", -2], ["fracție", 1.5], ["NaN", Number.NaN]] as [string, number][]) {
    const r = await readRailwaySnapshot(t, MANIFEST, { maxAttempts: val });
    assert(!r.ok && r.reason.kind === "invalid_options", `GG: maxAttempts ${label} → invalid_options`);
  }
  // undefined → implicit (ok).
  const rDef = await readRailwaySnapshot(makeFakeTransport(worldResponder(happyWorld())).transport, MANIFEST, {});
  assert(rDef.ok === true, "GG: maxAttempts undefined → implicit (ok)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// HH. lifecycle abort: transportul face settle (fără abandon) înainte de rezultat; abort domină la settle simultan
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // abort ÎN TIMPUL unui request → operația se termină cu aborted, iar transportul a settle-uit (inflight revine la 0).
  const ac = new AbortController();
  const w = happyWorld();
  let inflight = 0;
  const transport: GraphQLTransport = async (req) => {
    inflight++;
    if (req.name === "environmentStagedChanges") ac.abort(); // abort în timp ce o cerere e în zbor
    await Promise.resolve();
    const res: TransportResult = { ok: true, data: dataFor(w, req) };
    inflight--; // settle → cleanup
    return res;
  };
  const r = await readRailwaySnapshot(transport, MANIFEST, { signal: ac.signal, maxAttempts: 1 });
  assert(!r.ok && r.reason.kind === "aborted", "HH1: abort în timpul requestului → aborted");
  assert(inflight === 0, "HH2: transportul a settle-uit (fără abandon) înainte de rezultat");

  // rezultat produs ȘI semnal abortat la settle → abort DOMINĂ.
  const ac2 = new AbortController();
  const w2 = happyWorld();
  let n = 0;
  const t2: GraphQLTransport = async (req) => { n++; const res: TransportResult = { ok: true, data: dataFor(w2, req) }; if (n === 2) ac2.abort(); return res; };
  const r2 = await readRailwaySnapshot(t2, MANIFEST, { signal: ac2.signal, maxAttempts: 1 });
  assert(!r2.ok && r2.reason.kind === "aborted", "HH3: rezultat + abort la settle → abort domină");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// II. UTF-8 invalid în corp → parse_error (fatal, fără normalizare la U+FFFD)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const badBytes = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0xfe, 0x7d]); // {"x": <bytes UTF-8 invalide>}
  const fetchImpl = (async () => new Response(badBytes, { status: 200 })) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "parse_error", "II: UTF-8 invalid → parse_error (refuz static)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// JJ. oversized cu cancel() care nu se rezolvă niciodată → terminare bounded (nu await pe cancel)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const big = new Uint8Array(5000);
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(big); },                       // produce continuu → depășește maxBytes
    cancel() { return new Promise<void>(() => { /* pending pentru totdeauna */ }); },
  });
  const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
  const r = await makeRailwayTransport({ token: TOKEN, fetchImpl, maxBytes: 1000 })({ name: "projectToken", query: QUERIES.projectToken, variables: {} });
  assert(!r.ok && r.code === "oversized", "JJ: oversized cu cancel() pending → oversized (bounded)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// KK. forma opts: 42 / [] / extra key → invalid_options; null/undefined → implicit
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const t = makeFakeTransport(worldResponder(happyWorld())).transport;
  assert(rejKind(await readRailwaySnapshot(t, MANIFEST, 42 as unknown as ReadOptions)) === "invalid_options", "KK1: opts=42 → invalid_options");
  assert(rejKind(await readRailwaySnapshot(t, MANIFEST, [] as unknown as ReadOptions)) === "invalid_options", "KK2: opts=[] → invalid_options");
  assert(rejKind(await readRailwaySnapshot(t, MANIFEST, { maxAttempts: 1, foo: 1 } as unknown as ReadOptions)) === "invalid_options", "KK3: opts cu extra key → invalid_options");
  const rNull = await readRailwaySnapshot(makeFakeTransport(worldResponder(happyWorld())).transport, MANIFEST, null as unknown as ReadOptions);
  assert(rNull.ok === true, "KK4: opts=null → implicit (ok)");
}

if (fails.length > 0) {
  console.error(`railwayReadClient.test: ${fails.length} EȘUAT / ${passed} ok`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`railwayReadClient.test: ${passed}/${passed} ok`);
}

main().catch((e) => { console.error("railwayReadClient.test: EXCEPȚIE", e); process.exit(1); });
