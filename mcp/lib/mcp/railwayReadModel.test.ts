/**
 * lib/mcp/railwayReadModel.test.ts — PH-12 12.6 leaf 2b-1: teste COMPORTAMENTALE pentru maparea snapshot Railway → RawState. rev3.
 *
 * Acoperă lock-urile (rev1+rev2 + schema-lock live 2b-2a): identitate UUID (rename vs UUID greșit); cross-check DISCRIMINAT pe
 * `commandSource` (inline byte-exact pe toate 4 + config_file pe Solana: path exact, startCommand null; negative: path greșit,
 * ambele absente, startCommand neașteptat pe config_file, manifest ≠ catalog); clasificator running revizuit (terminal non-running
 * {REMOVED,FAILED,CRASHED,SKIPPED}→false, tranzitoriu→unknown, active sănătos + latest roșu/divergent→unknown, active absent +
 * SUCCESS/SLEEPING→unknown); staged env-level + per-service → reject; sealed→fără placeholder; nemapat→reject; rol absent/duplicat;
 * parse EXACT (prototip, chei exacte incl. railwayConfigFile, getter care aruncă); manifest anti-TOCTOU + commandSource; anti-leak; frozen.
 */

import {
  mapRailwaySnapshotToRawState,
  classifyRunning,
  SERVICE_CROSSCHECK,
  type RailwayManifest,
  type RailwayServiceRead,
  type CommandSource,
} from "./railwayReadModel";
import { SERVICE_IDS, parseRawState, type ServiceId } from "./profilePlan";

let passed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }

// ── Manifest canonic (UUID-uri fake, injectate) ─────────────────────────────────────────────────────────────────
const PROJECT = "proj-uuid-0001";
const ENV = "env-uuid-prod-0001";
const UUID: Record<ServiceId, string> = {
  redis: "svc-redis-uuid",
  mcp: "svc-mcp-uuid",
  "worker-evm": "svc-workerevm-uuid",
  "indexer-evm": "svc-indexerevm-uuid",
  "solana-worker": "svc-solana-uuid",
};
// commandSource canonic = oglindește catalogul (declarat explicit de runner). Solana = config_file, restul inline.
const CMDSRC: Record<ServiceId, CommandSource> = {
  redis: "inline", mcp: "inline", "worker-evm": "inline", "indexer-evm": "inline", "solana-worker": "config_file",
};
const MANIFEST: RailwayManifest = Object.freeze({
  projectId: PROJECT, environmentId: ENV,
  serviceIds: Object.freeze({ ...UUID }),
  commandSource: Object.freeze({ ...CMDSRC }),
});

const D_OK = { id: "dep-1", status: "SUCCESS" };
// startCommand/railwayConfigFile default din catalogul discriminat (inline → startCommand; config_file → configFile).
function defaults(role: ServiceId): { startCommand: string | null; railwayConfigFile: string | null } {
  const cc = SERVICE_CROSSCHECK[role];
  return cc.commandSource === "inline"
    ? { startCommand: cc.startCommand, railwayConfigFile: null }
    : { startCommand: null, railwayConfigFile: cc.configFile };
}
function svc(role: ServiceId, over: Partial<RailwayServiceRead> = {}): RailwayServiceRead {
  const d = defaults(role);
  return {
    serviceId: UUID[role],
    name: SERVICE_CROSSCHECK[role].name,
    startCommand: d.startCommand,
    railwayConfigFile: d.railwayConfigFile,
    activeDeployment: { ...D_OK },
    latestDeployment: { ...D_OK },
    hasStagedChanges: false,
    variables: {},
    ...over,
  };
}
function fullSnapshot(over: Partial<Record<ServiceId, Partial<RailwayServiceRead>>> = {}) {
  return { projectId: PROJECT, environmentId: ENV, hasStagedChanges: false, services: SERVICE_IDS.map((r) => svc(r, over[r] ?? {})) };
}

// ── A. happy path (incl. Solana config_file) ────────────────────────────────────────────────────────────────────
{
  const res = mapRailwaySnapshotToRawState(fullSnapshot(), MANIFEST);
  assert(res.ok === true, "A1: snapshot complet valid → ok");
  if (res.ok) {
    for (const r of SERVICE_IDS) assert(res.rawState[r]?.running === true, `A2: ${r} running:true`);
    assert(res.diagnostics.length === 0, "A3: zero diagnostice pe happy path (incl. Solana config_file)");
    assert(parseRawState(res.rawState) !== null, "A4: rawState satisface contractul leaf 1");
  }
}

// ── B. clasificatorul running (revizuit: terminal non-running → false) ───────────────────────────────────────────
{
  const d = (id: string, status: string) => ({ id, status });
  assert(classifyRunning(d("x", "SUCCESS"), d("x", "SUCCESS")) === true, "B1: activ SUCCESS coerent → true");
  assert(classifyRunning(d("x", "SLEEPING"), d("x", "SLEEPING")) === true, "B2: activ SLEEPING coerent → true (wakeable)");
  assert(classifyRunning(null, null) === false, "B3: fără activ + fără deployment → false");
  // REVIZIE: terminal non-running cu zero active → false (parcat startabil), NU unknown
  for (const s of ["REMOVED", "FAILED", "CRASHED", "SKIPPED"]) assert(classifyRunning(null, d("x", s)) === false, `B4: fără activ + latest ${s} (terminal) → false`);
  // tranzitorii: active prezent → unknown
  for (const s of ["INITIALIZING", "BUILDING", "DEPLOYING", "QUEUED", "WAITING", "NEEDS_APPROVAL", "REMOVING"]) assert(classifyRunning(d("x", s), d("x", s)) === "unknown", `B5: tranzitoriu activ ${s} → unknown`);
  // tranzitorii: fără activ → unknown (nu false — deployment în curs)
  for (const s of ["INITIALIZING", "BUILDING", "DEPLOYING", "QUEUED", "WAITING", "NEEDS_APPROVAL", "REMOVING"]) assert(classifyRunning(null, d("x", s)) === "unknown", `B5b: tranzitoriu fără activ ${s} → unknown`);
  // active prezent + status terminal coerent → unknown (nu false: un activ nu poate fi terminal sănătos)
  for (const s of ["FAILED", "CRASHED", "SKIPPED", "REMOVED"]) assert(classifyRunning(d("x", s), d("x", s)) === "unknown", `B6: activ ${s} coerent → unknown`);
  assert(classifyRunning(d("a", "SUCCESS"), d("b", "FAILED")) === "unknown", "B7: activ SUCCESS + latest FAILED (divergență id) → unknown");
  assert(classifyRunning(d("a", "SUCCESS"), d("b", "SUCCESS")) === "unknown", "B8: id diferit (divergență) → unknown");
  assert(classifyRunning(d("x", "SUCCESS"), null) === "unknown", "B9: activ fără latest → unknown");
  assert(classifyRunning(d("x", "WAT_NEW"), d("x", "WAT_NEW")) === "unknown", "B10: status necunoscut activ → unknown");
  assert(classifyRunning(null, d("x", "SUCCESS")) === "unknown", "B11: fără activ + latest SUCCESS (contradictoriu) → unknown");
  assert(classifyRunning(null, d("x", "SLEEPING")) === "unknown", "B12: fără activ + latest SLEEPING (contradictoriu) → unknown");
  assert(classifyRunning(null, d("x", "WAT_NEW")) === "unknown", "B12b: fără activ + latest status necunoscut → unknown (nu false)");
  // latest roșu pe ACELAȘI id → unknown (nu doar activul contează)
  for (const s of ["CRASHED", "FAILED", "REMOVED"]) assert(classifyRunning(d("x", "SUCCESS"), d("x", s)) === "unknown", `B13: active SUCCESS + latest ${s} pe același id → unknown`);
  assert(classifyRunning(d("x", "SLEEPING"), d("x", "CRASHED")) === "unknown", "B14: active SLEEPING + latest CRASHED același id → unknown");
}

// ── C. running unknown → OMIS; terminal non-running parcat → running:false MAPAT ─────────────────────────────────
{
  const res = mapRailwaySnapshotToRawState(fullSnapshot({ "worker-evm": { activeDeployment: { id: "a", status: "SUCCESS" }, latestDeployment: { id: "b", status: "FAILED" } } }), MANIFEST);
  assert(res.ok === true, "C1: ok");
  if (res.ok) {
    assert(res.rawState["worker-evm"] === undefined, "C2: worker-evm OMIS (running unknown pe divergență id)");
    assert(res.diagnostics.some((x) => x.code === "running_unknown" && x.service === "worker-evm"), "C3: diagnostic running_unknown");
    assert(res.rawState["mcp"]?.running === true, "C4: restul rămân");
  }
  const res2 = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { activeDeployment: { id: "s", status: "SUCCESS" }, latestDeployment: { id: "s", status: "CRASHED" } } }), MANIFEST);
  assert(res2.ok === true && res2.rawState["mcp"] === undefined, "C5: mcp latest CRASHED pe același id → OMIS");
  // REVIZIE cheie: serviciu parcat cu latest FAILED + zero active → running:false MAPAT (nu omis)
  const parkedFailed = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { activeDeployment: null, latestDeployment: { id: "old", status: "FAILED" } } }), MANIFEST);
  assert(parkedFailed.ok === true, "C6: ok");
  if (parkedFailed.ok) {
    assert(parkedFailed.rawState["mcp"]?.running === false, "C7: MCP parcat (0 active + latest FAILED) → running:false MAPAT (revizie)");
    assert(!parkedFailed.diagnostics.some((x) => x.code === "running_unknown" && x.service === "mcp"), "C8: fără running_unknown pe MCP parcat-failed");
  }
  // parcat fără deployment vreodată → false
  const neverDeployed = mapRailwaySnapshotToRawState(fullSnapshot({ "indexer-evm": { activeDeployment: null, latestDeployment: null } }), MANIFEST);
  assert(neverDeployed.ok === true && neverDeployed.rawState["indexer-evm"]?.running === false, "C9: 0 active + fără deployment → running:false");
}

// ── D. rename → mapează + service_renamed ───────────────────────────────────────────────────────────────────────
{
  const res = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { name: "Renamed MCP Thing" } }), MANIFEST);
  assert(res.ok === true, "D1: ok");
  if (res.ok) {
    assert(res.rawState["mcp"]?.running === true, "D2: mcp mapat la fel (rename NU remapează)");
    assert(res.diagnostics.some((x) => x.code === "service_renamed" && x.service === "mcp"), "D3: diagnostic service_renamed");
  }
}

// ── E. nume corect + UUID greșit → unexpected_service ───────────────────────────────────────────────────────────
{
  const res = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { serviceId: "svc-IMPOSTOR-uuid" } }), MANIFEST);
  assert(res.ok === false && res.reason === "unexpected_service", "E1: UUID necunoscut → unexpected_service");
}

// ── F. cross-check DISCRIMINAT: inline byte-exact + config_file path exact ───────────────────────────────────────
{
  // inline (identice cu rev2)
  const drift = mapRailwaySnapshotToRawState(fullSnapshot({ "indexer-evm": { startCommand: "npm run start --workspace=@preflight/worker-evm" } }), MANIFEST);
  assert(drift.ok === true, "F1: ok (drift omite rolul)");
  if (drift.ok) assert(drift.rawState["indexer-evm"] === undefined && drift.diagnostics.some((x) => x.code === "identity_drift" && x.service === "indexer-evm"), "F2: indexer-evm identity_drift → OMIS");
  const nullCmd = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: null } }), MANIFEST);
  assert(nullCmd.ok === true && nullCmd.rawState["mcp"] === undefined, "F3: inline startCommand null → identity_drift → omis");
  const malicious = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "npm run start --workspace=mcp-malicious" } }), MANIFEST);
  assert(malicious.ok === true && malicious.rawState["mcp"] === undefined, "F4: coliziune substring mcp-malicious → identity_drift");
  const shellPrefix = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "echo pwn && npm run start --workspace=mcp" } }), MANIFEST);
  assert(shellPrefix.ok === true && shellPrefix.rawState["mcp"] === undefined, "F5: prefix shell → identity_drift");
  const shellSuffix = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "npm run start --workspace=mcp && curl evil" } }), MANIFEST);
  assert(shellSuffix.ok === true && shellSuffix.rawState["mcp"] === undefined, "F6: sufix shell → identity_drift");
  const redisDrift = mapRailwaySnapshotToRawState(fullSnapshot({ redis: { startCommand: "redis-server --requirepass X --save 60 1" } }), MANIFEST);
  assert(redisDrift.ok === true && redisDrift.rawState["redis"] === undefined, "F7: comandă Redis diferită → identity_drift");
  const ccRedis = SERVICE_CROSSCHECK["redis"];
  const redisCanon = ccRedis.commandSource === "inline" ? ccRedis.startCommand : "";
  // BYTE-EXACT: whitespace multiplu / trim ≠ canonicul verbatim → identity_drift (spre deosebire de rev2 care normaliza spațiile).
  const wsRedis = mapRailwaySnapshotToRawState(fullSnapshot({ redis: { startCommand: "  " + redisCanon.replace(/ /g, "  ") + "  " } }), MANIFEST);
  assert(wsRedis.ok === true && wsRedis.rawState["redis"] === undefined, "F8: byte-exact → spații multiple/trim ≠ canonic → identity_drift (omis)");
  const wsExact = mapRailwaySnapshotToRawState(fullSnapshot({ redis: { startCommand: redisCanon } }), MANIFEST);
  assert(wsExact.ok === true && wsExact.rawState["redis"]?.running === true, "F8b: startCommand EXACT canonic → mapat (running:true)");
  const nlInstead = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "npm run start\n--workspace=mcp" } }), MANIFEST);
  assert(nlInstead.ok === true && nlInstead.rawState["mcp"] === undefined, "F9: newline în loc de spațiu → identity_drift");
  const nlMalicious = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "npm run start --workspace=mcp\nrm -rf /" } }), MANIFEST);
  assert(nlMalicious.ok === true && nlMalicious.rawState["mcp"] === undefined, "F10: canonic + linie malițioasă → identity_drift");
  const tabInstead = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "npm run start\t--workspace=mcp" } }), MANIFEST);
  assert(tabInstead.ok === true && tabInstead.rawState["mcp"] === undefined, "F11: tab în loc de spațiu → identity_drift");

  // config_file (Solana): happy deja acoperit de A. Negative:
  const solWrongPath = mapRailwaySnapshotToRawState(fullSnapshot({ "solana-worker": { railwayConfigFile: "/workers/solana/OTHER.json" } }), MANIFEST);
  assert(solWrongPath.ok === true && solWrongPath.rawState["solana-worker"] === undefined && solWrongPath.diagnostics.some((x) => x.code === "identity_drift" && x.service === "solana-worker"), "F12: config_file path greșit → identity_drift → omis");
  const solNullPath = mapRailwaySnapshotToRawState(fullSnapshot({ "solana-worker": { railwayConfigFile: null } }), MANIFEST);
  assert(solNullPath.ok === true && solNullPath.rawState["solana-worker"] === undefined, "F13: config_file cu railwayConfigFile null (ambele absente) → identity_drift");
  const solHasStart = mapRailwaySnapshotToRawState(fullSnapshot({ "solana-worker": { startCommand: "npm run start --workspace=@preflight/indexer-solana" } }), MANIFEST);
  assert(solHasStart.ok === true && solHasStart.rawState["solana-worker"] === undefined, "F14: config_file cu startCommand NEAȘTEPTAT (prezent) → identity_drift");
  // inline cu railwayConfigFile setat (EVM/Indexer live) → NU contează pentru inline (verifică startCommand)
  const inlineWithPath = mapRailwaySnapshotToRawState(fullSnapshot({ "worker-evm": { railwayConfigFile: "/workers/evm/railway.json" } }), MANIFEST);
  assert(inlineWithPath.ok === true && inlineWithPath.rawState["worker-evm"]?.running === true, "F15: inline cu railwayConfigFile setat → ignorat (startCommand decide) → mapat");
}

// ── F2b. manifest commandSource ≠ catalog → malformed_manifest ──────────────────────────────────────────────────
{
  const wrongCs: RailwayManifest = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID }, commandSource: { ...CMDSRC, "solana-worker": "inline" } };
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), wrongCs).ok === false, "F16: commandSource declarat (inline pt Solana) ≠ catalog (config_file) → reject");
  const wrongCs2: RailwayManifest = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID }, commandSource: { ...CMDSRC, mcp: "config_file" } };
  const r16b = mapRailwaySnapshotToRawState(fullSnapshot(), wrongCs2);
  assert(r16b.ok === false && r16b.reason === "malformed_manifest", "F17: commandSource declarat (config_file pt MCP) ≠ catalog (inline) → malformed_manifest");
}

// ── G. serviciu suplimentar → unexpected_service ────────────────────────────────────────────────────────────────
{
  const snap = fullSnapshot();
  snap.services.push(svc("mcp", { serviceId: "svc-EXTRA-unknown", name: "Ghost Worker" }));
  assert(mapRailwaySnapshotToRawState(snap, MANIFEST).ok === false, "G1: serviciu extra nemapat → reject (unexpected_service)");
}

// ── H. rol duplicat → ambiguous_topology ────────────────────────────────────────────────────────────────────────
{
  const snap = fullSnapshot();
  snap.services.push(svc("solana-worker"));
  const res = mapRailwaySnapshotToRawState(snap, MANIFEST);
  assert(res.ok === false && res.reason === "ambiguous_topology", "H1: două live pentru același rol → ambiguous_topology");
}

// ── I. rol absent → OMIS + role_absent ──────────────────────────────────────────────────────────────────────────
{
  const snap = { projectId: PROJECT, environmentId: ENV, hasStagedChanges: false, services: SERVICE_IDS.filter((r) => r !== "solana-worker").map((r) => svc(r)) };
  const res = mapRailwaySnapshotToRawState(snap, MANIFEST);
  assert(res.ok === true, "I1: ok (rol absent nu respinge)");
  if (res.ok) assert(res.rawState["solana-worker"] === undefined && res.diagnostics.some((x) => x.code === "role_absent" && x.service === "solana-worker"), "I2: solana-worker absent → OMIS + role_absent");
}

// ── J. staged changes: per-service ȘI environment-level → NEADMISIBIL ────────────────────────────────────────────
{
  const perSvc = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { hasStagedChanges: true } }), MANIFEST);
  assert(perSvc.ok === false && perSvc.reason === "staged_changes", "J1: staged per-serviciu → staged_changes");
  const envLevel = mapRailwaySnapshotToRawState({ ...fullSnapshot(), hasStagedChanges: true }, MANIFEST);
  assert(envLevel.ok === false && envLevel.reason === "staged_changes", "J2: staged la nivel de environment → staged_changes (înainte de mapare)");
}

// ── K. sealed (null) → cheie OMISĂ, fără placeholder + env_unreadable + anti-leak ────────────────────────────────
{
  const SECRET = "super-secret-service-role-key-VALUE";
  const res = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { variables: { REDIS_URL: "redis://x:6379", SUPABASE_SERVICE_ROLE_KEY: null, READABLE: SECRET } } }), MANIFEST);
  assert(res.ok === true, "K1: ok");
  if (res.ok) {
    const env = res.rawState["mcp"]?.env ?? {};
    assert(env["REDIS_URL"] === "redis://x:6379", "K2: cheie readable păstrată");
    assert(!("SUPABASE_SERVICE_ROLE_KEY" in env), "K3: cheie sealed OMISĂ (fără placeholder)");
    assert(JSON.stringify(env).indexOf("<sealed>") === -1, "K4: NICIUN placeholder <sealed>");
    assert(res.diagnostics.some((x) => x.code === "env_unreadable" && x.service === "mcp"), "K5: diagnostic env_unreadable");
    assert(JSON.stringify(res.diagnostics).indexOf(SECRET) === -1, "K6: valoarea env NU se scurge în diagnostice");
  }
}

// ── L. wrong scope → wrong_scope ────────────────────────────────────────────────────────────────────────────────
{
  assert(mapRailwaySnapshotToRawState({ ...fullSnapshot(), projectId: "OTHER-proj" }, MANIFEST).ok === false, "L1: proiect greșit → wrong_scope");
  assert(mapRailwaySnapshotToRawState({ ...fullSnapshot(), environmentId: "OTHER-env" }, MANIFEST).ok === false, "L2: environment greșit → wrong_scope");
}

// ── M. manifest malformat + anti-TOCTOU ─────────────────────────────────────────────────────────────────────────
{
  const dup: RailwayManifest = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID, mcp: UUID["redis"] }, commandSource: { ...CMDSRC } };
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), dup).ok === false, "M1: UUID duplicat → reject");
  const missing = { projectId: PROJECT, environmentId: ENV, serviceIds: { redis: "a", mcp: "b" }, commandSource: { ...CMDSRC } } as unknown as RailwayManifest;
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), missing).ok === false, "M2: serviceIds incomplet → reject");
  const emptyUuid: RailwayManifest = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID, redis: "" }, commandSource: { ...CMDSRC } };
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), emptyUuid).ok === false, "M3: UUID gol → reject");
  const extraRole = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID, ghost: "x" }, commandSource: { ...CMDSRC } } as unknown as RailwayManifest;
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), extraRole).ok === false, "M4: cheie ne-rol în serviceIds → reject");
  // commandSource lipsă / incomplet / valoare invalidă
  const noCs = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID } } as unknown as RailwayManifest;
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), noCs).ok === false, "M4b: manifest fără commandSource → malformed (formă exactă)");
  const csIncomplete = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID }, commandSource: { redis: "inline", mcp: "inline" } } as unknown as RailwayManifest;
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), csIncomplete).ok === false, "M4c: commandSource incomplet → reject");
  const csBadVal = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID }, commandSource: { ...CMDSRC, mcp: "weird" } } as unknown as RailwayManifest;
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), csBadVal).ok === false, "M4d: valoare commandSource invalidă → reject");

  // anti-TOCTOU: getter valid-apoi-throw pe projectId → malformed_manifest, fără throw
  let reads = 0;
  const toctou: Record<string, unknown> = { environmentId: ENV, serviceIds: { ...UUID }, commandSource: { ...CMDSRC } };
  Object.defineProperty(toctou, "projectId", { enumerable: true, get() { reads++; if (reads >= 2) throw new Error("toctou"); return PROJECT; } });
  const r1 = mapRailwaySnapshotToRawState(fullSnapshot(), toctou);
  assert(r1.ok === false && r1.reason === "malformed_manifest", "M5: getter valid-apoi-throw pe projectId → malformed_manifest (fără throw)");

  let reads2 = 0;
  const changing: Record<string, unknown> = { projectId: PROJECT, serviceIds: { ...UUID }, commandSource: { ...CMDSRC } };
  Object.defineProperty(changing, "environmentId", { enumerable: true, get() { reads2++; return reads2 === 1 ? ENV : "MUTATED"; } });
  const r2 = mapRailwaySnapshotToRawState(fullSnapshot(), changing);
  assert(r2.ok === false && r2.reason === "malformed_manifest", "M6: getter care schimbă environmentId → malformed_manifest");

  class Weird { projectId = PROJECT; environmentId = ENV; serviceIds = { ...UUID }; commandSource = { ...CMDSRC }; }
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), new Weird()).ok === false, "M7: manifest cu prototip arbitrar → reject");
  const extraKey = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID }, commandSource: { ...CMDSRC }, sneaky: 1 } as unknown as RailwayManifest;
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), extraKey).ok === false, "M8: cheie extra pe manifest → malformed_manifest (formă exactă)");
}

// ── N. parse fail-closed pe snapshot ────────────────────────────────────────────────────────────────────────────
{
  assert(mapRailwaySnapshotToRawState(null, MANIFEST).ok === false, "N1: null → malformed_snapshot");
  assert(mapRailwaySnapshotToRawState([], MANIFEST).ok === false, "N2: array → malformed_snapshot");
  assert(mapRailwaySnapshotToRawState({ projectId: PROJECT, environmentId: ENV, hasStagedChanges: false, services: "nope" }, MANIFEST).ok === false, "N3: services ne-array → malformed");
  const badVar = fullSnapshot({ mcp: { variables: { X: 123 as unknown as string } } });
  assert(mapRailwaySnapshotToRawState(badVar, MANIFEST).ok === false, "N4: valoare env ne-string/ne-null → malformed_snapshot");
  const evil: Record<string, unknown> = { environmentId: ENV, hasStagedChanges: false, services: [] };
  Object.defineProperty(evil, "projectId", { enumerable: true, get() { throw new Error("boom"); } });
  assert(mapRailwaySnapshotToRawState(evil, MANIFEST).ok === false, "N5: getter care aruncă → malformed_snapshot (fără throw)");
  const badDep = fullSnapshot({ mcp: { activeDeployment: { id: "x" } as unknown as { id: string; status: string } } });
  assert(mapRailwaySnapshotToRawState(badDep, MANIFEST).ok === false, "N6: deployment fără status (cheie lipsă) → malformed");
  const missingSnapKey = { projectId: PROJECT, environmentId: ENV, services: fullSnapshot().services }; // fără hasStagedChanges
  assert(mapRailwaySnapshotToRawState(missingSnapKey, MANIFEST).ok === false, "N7: snapshot fără hasStagedChanges → malformed");
  // railwayConfigFile de tip greșit → malformed
  const badCfg = fullSnapshot({ mcp: { railwayConfigFile: 123 as unknown as string } });
  assert(mapRailwaySnapshotToRawState(badCfg, MANIFEST).ok === false, "N8: railwayConfigFile ne-string/ne-null → malformed");
}

// ── O. EXACT: extra/lipsă key pe snapshot/serviciu/deployment → malformed ────────────────────────────────────────
{
  const s1 = fullSnapshot() as Record<string, unknown>; s1["someNewRailwayField"] = { nested: true };
  assert(mapRailwaySnapshotToRawState(s1, MANIFEST).ok === false, "O1: extra key pe snapshot → malformed (parse EXACT)");
  const s2 = fullSnapshot(); (s2.services[0] as unknown as Record<string, unknown>)["extra"] = 1;
  assert(mapRailwaySnapshotToRawState(s2, MANIFEST).ok === false, "O2: extra key pe serviciu → malformed");
  const s3 = fullSnapshot({ mcp: { activeDeployment: { id: "d", status: "SUCCESS", extra: 1 } as unknown as { id: string; status: string } } });
  assert(mapRailwaySnapshotToRawState(s3, MANIFEST).ok === false, "O3: extra key pe deployment → malformed");
  // serviciu fără railwayConfigFile (cheie lipsă) → malformed (formă exactă)
  const s3b = fullSnapshot(); delete (s3b.services[1] as unknown as Record<string, unknown>)["railwayConfigFile"];
  assert(mapRailwaySnapshotToRawState(s3b, MANIFEST).ok === false, "O3b: serviciu fără railwayConfigFile → malformed");
  // serviciu cu prototip arbitrar → malformed
  const s4 = fullSnapshot();
  class WeirdSvc { serviceId = UUID["mcp"]; name = SERVICE_CROSSCHECK["mcp"].name; startCommand = defaults("mcp").startCommand; railwayConfigFile = null; activeDeployment = { ...D_OK }; latestDeployment = { ...D_OK }; hasStagedChanges = false; variables = {}; }
  s4.services[1] = new WeirdSvc() as unknown as RailwayServiceRead;
  assert(mapRailwaySnapshotToRawState(s4, MANIFEST).ok === false, "O4: serviciu cu prototip arbitrar → malformed");
}

// ── P. anti-leak: diagnosticele au DOAR {code, service∈ServiceId} ───────────────────────────────────────────────
{
  const res = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { name: "X", variables: { A: null } }, "worker-evm": { latestDeployment: { id: "z", status: "FAILED" }, activeDeployment: { id: "y", status: "SUCCESS" } } }), MANIFEST);
  if (res.ok) {
    for (const dg of res.diagnostics) {
      const keys = Object.keys(dg).sort().join(",");
      assert(keys === "code" || keys === "code,service", `P1: diagnostic DOAR {code[,service]}: ${keys}`);
      if (dg.service !== undefined) assert((SERVICE_IDS as readonly string[]).includes(dg.service), `P2: service e ServiceId: ${dg.service}`);
    }
  } else assert(false, "P0: aștept ok");
}

// ── Q. frozen ───────────────────────────────────────────────────────────────────────────────────────────────────
{
  const res = mapRailwaySnapshotToRawState(fullSnapshot(), MANIFEST);
  assert(Object.isFrozen(res), "Q1: rezultat înghețat");
  if (res.ok) {
    assert(Object.isFrozen(res.rawState), "Q2: rawState înghețat");
    assert(Object.isFrozen(res.diagnostics), "Q3: diagnostics înghețat");
    assert(Object.isFrozen(res.rawState["mcp"]), "Q4: rawState[mcp] înghețat");
    assert(Object.isFrozen(res.rawState["mcp"]?.env), "Q5: env înghețat");
  }
  assert(Object.isFrozen(SERVICE_CROSSCHECK), "Q6: SERVICE_CROSSCHECK înghețat");
  for (const r of SERVICE_IDS) assert(Object.isFrozen(SERVICE_CROSSCHECK[r]), `Q7: SERVICE_CROSSCHECK[${r}] înghețat`);
}

// ── R. env __proto__ nu poluează (Object.create(null)) ──────────────────────────────────────────────────────────
{
  const vars: Record<string, string | null> = Object.create(null);
  vars["__proto__"] = "polluted";
  vars["REDIS_URL"] = "redis://x:6379";
  const res = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { variables: vars } }), MANIFEST);
  assert(res.ok === true, "R1: ok cu variabilă __proto__");
  if (res.ok) {
    assert(({} as Record<string, unknown>)["polluted"] === undefined, "R2: fără poluare de prototip global");
    const env = res.rawState["mcp"]?.env as Record<string, string> | undefined;
    assert(env?.["REDIS_URL"] === "redis://x:6379", "R3: cheile normale rămân");
  }
}

if (fails.length > 0) {
  console.error(`railwayReadModel.test: ${fails.length} EȘUAT / ${passed} ok`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`railwayReadModel.test: ${passed}/${passed} ok`);
