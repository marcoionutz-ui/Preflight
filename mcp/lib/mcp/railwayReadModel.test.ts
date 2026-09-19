/**
 * lib/mcp/railwayReadModel.test.ts — PH-12 12.6 leaf 2b-1: teste COMPORTAMENTALE pentru maparea snapshot Railway → RawState. rev2.
 *
 * Acoperă lock-urile cgpt (rev1+rev2): identitate UUID (rename vs UUID greșit vs identity_drift); comandă BYTE-EXACT pe toate 5
 * (coliziune mcp-malicious, prefix/sufix shell, drift Redis); tuple activ/latest (matrice + latest roșu pe același id → unknown +
 * SLEEPING→true + FAILED/CRASHED/SKIPPED→unknown + active SUCCESS/latest FAILED→unknown); staged env-level + per-service → reject;
 * sealed→fără placeholder; nemapat→reject; rol absent/duplicat; parse EXACT (prototip, chei exacte, extra-key→malformed, getter care
 * aruncă, valoare ne-string); manifest anti-TOCTOU (getter valid-apoi-throw → malformed_manifest); anti-leak; frozen.
 */

import {
  mapRailwaySnapshotToRawState,
  classifyRunning,
  SERVICE_CROSSCHECK,
  type RailwayManifest,
  type RailwayServiceRead,
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
const MANIFEST: RailwayManifest = Object.freeze({ projectId: PROJECT, environmentId: ENV, serviceIds: Object.freeze({ ...UUID }) });

const D_OK = { id: "dep-1", status: "SUCCESS" };
function svc(role: ServiceId, over: Partial<RailwayServiceRead> = {}): RailwayServiceRead {
  return {
    serviceId: UUID[role],
    name: SERVICE_CROSSCHECK[role].name,
    startCommand: SERVICE_CROSSCHECK[role].startCommand,
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

// ── A. happy path ───────────────────────────────────────────────────────────────────────────────────────────────
{
  const res = mapRailwaySnapshotToRawState(fullSnapshot(), MANIFEST);
  assert(res.ok === true, "A1: snapshot complet valid → ok");
  if (res.ok) {
    for (const r of SERVICE_IDS) assert(res.rawState[r]?.running === true, `A2: ${r} running:true`);
    assert(res.diagnostics.length === 0, "A3: zero diagnostice pe happy path");
    assert(parseRawState(res.rawState) !== null, "A4: rawState satisface contractul leaf 1");
  }
}

// ── B. clasificatorul running (matrice + latest roșu pe același id) ──────────────────────────────────────────────
{
  const d = (id: string, status: string) => ({ id, status });
  assert(classifyRunning(d("x", "SUCCESS"), d("x", "SUCCESS")) === true, "B1: activ SUCCESS coerent → true");
  assert(classifyRunning(d("x", "SLEEPING"), d("x", "SLEEPING")) === true, "B2: activ SLEEPING coerent → true (wakeable)");
  assert(classifyRunning(null, null) === false, "B3: fără activ + fără deployment → false");
  assert(classifyRunning(null, d("x", "REMOVED")) === false, "B4: fără activ + latest REMOVED → false");
  for (const s of ["INITIALIZING", "BUILDING", "DEPLOYING", "QUEUED", "WAITING", "REMOVING"]) assert(classifyRunning(d("x", s), d("x", s)) === "unknown", `B5: tranzitoriu ${s} → unknown`);
  for (const s of ["FAILED", "CRASHED", "SKIPPED"]) assert(classifyRunning(null, d("x", s)) === "unknown", `B6: fără activ + latest ${s} → unknown (niciodată false)`);
  for (const s of ["FAILED", "CRASHED", "SKIPPED"]) assert(classifyRunning(d("x", s), d("x", s)) === "unknown", `B6b: activ ${s} coerent → unknown`);
  assert(classifyRunning(d("a", "SUCCESS"), d("b", "FAILED")) === "unknown", "B7: activ SUCCESS + latest FAILED (divergență id) → unknown");
  assert(classifyRunning(d("a", "SUCCESS"), d("b", "SUCCESS")) === "unknown", "B8: id diferit (divergență) → unknown");
  assert(classifyRunning(d("x", "SUCCESS"), null) === "unknown", "B9: activ fără latest → unknown");
  assert(classifyRunning(d("x", "REMOVED"), d("x", "REMOVED")) === "unknown", "B10: activ REMOVED coerent → unknown");
  assert(classifyRunning(d("x", "WAT_NEW"), d("x", "WAT_NEW")) === "unknown", "B11: status necunoscut → unknown");
  assert(classifyRunning(null, d("x", "SUCCESS")) === "unknown", "B12: fără activ + latest SUCCESS-neactiv → unknown");
  // P1 rev2: latest roșu pe ACELAȘI id → unknown (nu doar activul contează)
  for (const s of ["CRASHED", "FAILED", "REMOVED"]) assert(classifyRunning(d("x", "SUCCESS"), d("x", s)) === "unknown", `B13: active SUCCESS + latest ${s} pe același id → unknown`);
  assert(classifyRunning(d("x", "SLEEPING"), d("x", "CRASHED")) === "unknown", "B14: active SLEEPING + latest CRASHED același id → unknown");
}

// ── C. running "unknown" → OMIS ─────────────────────────────────────────────────────────────────────────────────
{
  const res = mapRailwaySnapshotToRawState(fullSnapshot({ "worker-evm": { activeDeployment: { id: "a", status: "SUCCESS" }, latestDeployment: { id: "b", status: "FAILED" } } }), MANIFEST);
  assert(res.ok === true, "C1: ok");
  if (res.ok) {
    assert(res.rawState["worker-evm"] === undefined, "C2: worker-evm OMIS (running unknown)");
    assert(res.diagnostics.some((x) => x.code === "running_unknown" && x.service === "worker-evm"), "C3: diagnostic running_unknown");
    assert(res.rawState["mcp"]?.running === true, "C4: restul rămân");
  }
  // latest roșu pe același id → omis prin mapare
  const res2 = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { activeDeployment: { id: "s", status: "SUCCESS" }, latestDeployment: { id: "s", status: "CRASHED" } } }), MANIFEST);
  assert(res2.ok === true && res2.rawState["mcp"] === undefined, "C5: mcp latest CRASHED pe același id → OMIS");
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

// ── F. comandă BYTE-EXACT: drift, coliziune mcp-malicious, prefix/sufix shell, drift Redis ──────────────────────
{
  const drift = mapRailwaySnapshotToRawState(fullSnapshot({ "indexer-evm": { startCommand: "npm run start --workspace=@preflight/worker-evm" } }), MANIFEST);
  assert(drift.ok === true, "F1: ok (drift omite rolul)");
  if (drift.ok) assert(drift.rawState["indexer-evm"] === undefined && drift.diagnostics.some((x) => x.code === "identity_drift" && x.service === "indexer-evm"), "F2: indexer-evm identity_drift → OMIS");

  const nullCmd = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: null } }), MANIFEST);
  assert(nullCmd.ok === true && nullCmd.rawState["mcp"] === undefined, "F3: startCommand null → identity_drift → omis");

  const malicious = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "npm run start --workspace=mcp-malicious" } }), MANIFEST);
  assert(malicious.ok === true && malicious.rawState["mcp"] === undefined, "F4: coliziune substring mcp-malicious → identity_drift (byte-exact respinge)");

  const shellPrefix = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "echo pwn && npm run start --workspace=mcp" } }), MANIFEST);
  assert(shellPrefix.ok === true && shellPrefix.rawState["mcp"] === undefined, "F5: prefix shell → identity_drift");
  const shellSuffix = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "npm run start --workspace=mcp && curl evil" } }), MANIFEST);
  assert(shellSuffix.ok === true && shellSuffix.rawState["mcp"] === undefined, "F6: sufix shell → identity_drift");

  const redisDrift = mapRailwaySnapshotToRawState(fullSnapshot({ redis: { startCommand: "redis-server --requirepass X --save 60 1" } }), MANIFEST);
  assert(redisDrift.ok === true && redisDrift.rawState["redis"] === undefined, "F7: comandă Redis diferită → identity_drift (Redis e verificat acum)");

  // normalizare de whitespace: același conținut cu spații multiple → NU e drift
  const wsRedis = mapRailwaySnapshotToRawState(fullSnapshot({ redis: { startCommand: "  " + SERVICE_CROSSCHECK["redis"].startCommand.replace(/ /g, "  ") + "  " } }), MANIFEST);
  assert(wsRedis.ok === true && wsRedis.rawState["redis"]?.running === true, "F8: whitespace multiplu, conținut identic → NU drift");

  // P1 rev3: newline NU e echivalent cu spațiul (separator de comenzi în shell) → drift
  const nlInstead = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "npm run start\n--workspace=mcp" } }), MANIFEST);
  assert(nlInstead.ok === true && nlInstead.rawState["mcp"] === undefined, "F9: newline în loc de spațiu → identity_drift (nu trece drept canonic)");
  const nlMalicious = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "npm run start --workspace=mcp\nrm -rf /" } }), MANIFEST);
  assert(nlMalicious.ok === true && nlMalicious.rawState["mcp"] === undefined, "F10: canonic + linie malițioasă → identity_drift");
  const tabInstead = mapRailwaySnapshotToRawState(fullSnapshot({ mcp: { startCommand: "npm run start\t--workspace=mcp" } }), MANIFEST);
  assert(tabInstead.ok === true && tabInstead.rawState["mcp"] === undefined, "F11: tab în loc de spațiu → identity_drift");
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
  const dup: RailwayManifest = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID, mcp: UUID["redis"] } };
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), dup).ok === false, "M1: UUID duplicat → reject");
  const missing = { projectId: PROJECT, environmentId: ENV, serviceIds: { redis: "a", mcp: "b" } } as unknown as RailwayManifest;
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), missing).ok === false, "M2: manifest incomplet → reject");
  const emptyUuid: RailwayManifest = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID, redis: "" } };
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), emptyUuid).ok === false, "M3: UUID gol → reject");
  const extraRole = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID, ghost: "x" } } as unknown as RailwayManifest;
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), extraRole).ok === false, "M4: cheie ne-rol în manifest → reject");

  // anti-TOCTOU: getter care întoarce valid o dată apoi aruncă la recitire → malformed_manifest, fără throw
  let reads = 0;
  const toctou: Record<string, unknown> = { environmentId: ENV, serviceIds: { ...UUID } };
  Object.defineProperty(toctou, "projectId", { enumerable: true, get() { reads++; if (reads >= 2) throw new Error("toctou"); return PROJECT; } });
  const r1 = mapRailwaySnapshotToRawState(fullSnapshot(), toctou);
  assert(r1.ok === false && r1.reason === "malformed_manifest", "M5: getter valid-apoi-throw pe projectId → malformed_manifest (fără throw)");

  // getter care schimbă valoarea între citiri → malformed_manifest
  let reads2 = 0;
  const changing: Record<string, unknown> = { projectId: PROJECT, serviceIds: { ...UUID } };
  Object.defineProperty(changing, "environmentId", { enumerable: true, get() { reads2++; return reads2 === 1 ? ENV : "MUTATED"; } });
  const r2 = mapRailwaySnapshotToRawState(fullSnapshot(), changing);
  assert(r2.ok === false && r2.reason === "malformed_manifest", "M6: getter care schimbă environmentId → malformed_manifest");

  // manifest cu prototip arbitrar → reject
  class Weird { projectId = PROJECT; environmentId = ENV; serviceIds = { ...UUID }; }
  assert(mapRailwaySnapshotToRawState(fullSnapshot(), new Weird()).ok === false, "M7: manifest cu prototip arbitrar → reject");
  // P2 rev3: manifest cu cheie EXTRA → malformed (formă exactă)
  const extraKey = { projectId: PROJECT, environmentId: ENV, serviceIds: { ...UUID }, sneaky: 1 } as unknown as RailwayManifest;
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
}

// ── O. EXACT: extra key pe snapshot/serviciu/deployment → malformed (inversat față de rev1) ──────────────────────
{
  const s1 = fullSnapshot() as Record<string, unknown>; s1["someNewRailwayField"] = { nested: true };
  assert(mapRailwaySnapshotToRawState(s1, MANIFEST).ok === false, "O1: extra key pe snapshot → malformed (parse EXACT)");
  const s2 = fullSnapshot(); (s2.services[0] as unknown as Record<string, unknown>)["extra"] = 1;
  assert(mapRailwaySnapshotToRawState(s2, MANIFEST).ok === false, "O2: extra key pe serviciu → malformed");
  const s3 = fullSnapshot({ mcp: { activeDeployment: { id: "d", status: "SUCCESS", extra: 1 } as unknown as { id: string; status: string } } });
  assert(mapRailwaySnapshotToRawState(s3, MANIFEST).ok === false, "O3: extra key pe deployment → malformed");
  // serviciu cu prototip arbitrar → malformed
  const s4 = fullSnapshot();
  class WeirdSvc { serviceId = UUID["mcp"]; name = SERVICE_CROSSCHECK["mcp"].name; startCommand = SERVICE_CROSSCHECK["mcp"].startCommand; activeDeployment = { ...D_OK }; latestDeployment = { ...D_OK }; hasStagedChanges = false; variables = {}; }
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
