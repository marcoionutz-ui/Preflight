/**
 * lib/mcp/railwayReadLive.test.ts — PH-12 12.6 leaf 2b-3: teste HERMETICE pentru compoziția READ-ONLY.
 *
 * Reader INJECTAT (fake, întoarce `ClientResult` direct — fără lume GraphQL) + caps FAKE (validatoare ok/throw) + model + planner
 * REALE + snapshot-uri construite de mână. Acoperă: fail-closed pe fiecare stadiu (read→map→plan), passthrough de diagnostice de
 * mapare, render anti-leak, READ-ONLY (niciun export de apply/mutație).
 */

import { readLiveState, formatLiveResult, liveExitCode, type SnapshotReader, type LiveReadResult } from "./railwayReadLive";
import * as liveMod from "./railwayReadLive";
import { SERVICE_CROSSCHECK, type RailwayManifest, type RailwaySnapshot, type RailwayServiceRead, type CommandSource } from "./railwayReadModel";
import { SERVICE_IDS, formatPlanLines, planSummary, type ServiceId, type Caps, type ServiceEnvValidator } from "./profilePlan";

let passed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }

// ── Manifest canonic (commandSource DERIVAT din catalog → potrivire garantată cu modelul) ────────────────────────
const PROJECT = "proj-uuid-0001";
const ENV = "env-uuid-prod-0001";
const UUID: Record<ServiceId, string> = {
  redis: "svc-redis-uuid", mcp: "svc-mcp-uuid", "worker-evm": "svc-workerevm-uuid",
  "indexer-evm": "svc-indexerevm-uuid", "solana-worker": "svc-solana-uuid",
};
const CMDSRC = Object.fromEntries(SERVICE_IDS.map((r) => [r, SERVICE_CROSSCHECK[r].commandSource])) as Record<ServiceId, CommandSource>;
const MANIFEST: RailwayManifest = Object.freeze({
  projectId: PROJECT, environmentId: ENV,
  serviceIds: Object.freeze({ ...UUID }), commandSource: Object.freeze({ ...CMDSRC }),
});

// ── Snapshot happy (toate 5 running, identitate == catalog) ──────────────────────────────────────────────────────
function svc(role: ServiceId, over: Partial<RailwayServiceRead> = {}): RailwayServiceRead {
  const cc = SERVICE_CROSSCHECK[role];
  const dep = { id: `dep-${role}`, status: "SUCCESS" };
  return {
    serviceId: UUID[role],
    name: cc.name,
    startCommand: cc.commandSource === "inline" ? cc.startCommand : null,
    railwayConfigFile: cc.commandSource === "config_file" ? cc.configFile : null,
    activeDeployment: { ...dep },
    latestDeployment: { ...dep },
    hasStagedChanges: false,
    variables: { [`VAR_${role}`]: "value" },
    ...over,
  };
}
function happySnapshot(overrides: Partial<Record<ServiceId, Partial<RailwayServiceRead>>> = {}): RailwaySnapshot {
  return { projectId: PROJECT, environmentId: ENV, hasStagedChanges: false, services: SERVICE_IDS.map((r) => svc(r, overrides[r] ?? {})) };
}

// ── Caps fake ────────────────────────────────────────────────────────────────────────────────────────────────────
function okCaps(): Caps {
  const validateService: Partial<Record<ServiceId, ServiceEnvValidator>> = {};
  const envKeys: Partial<Record<ServiceId, readonly string[]>> = {};
  for (const r of SERVICE_IDS) { validateService[r] = () => ({ ok: true, problems: [] }); envKeys[r] = []; }
  return { validateService, envKeys, isStagingSupabase: () => true };
}
const readerOk = (snapshot: RailwaySnapshot): SnapshotReader => async () => ({ ok: true, snapshot });

async function main(): Promise<void> {
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// A. happy read + target parked → ok cu preview + rezumat cu stopuri + confirmare
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const r = await readLiveState(readerOk(happySnapshot()), MANIFEST, "parked", okCaps());
  assert(r.ok === true, "A1: happy parked → ok");
  if (r.ok) {
    // `lines`/`summary` NU se stochează pe rezultat — se derivă din unica sursă (`r.plan`).
    const s = planSummary(r.plan);
    const planLines = formatPlanLines(r.plan);
    assert(r.target === "parked", "A2: target propagat");
    assert(s.admissible === true, "A3: admisibil");
    assert(s.stops === 4, "A4: 4 stopuri (mcp+worker-evm+indexer-evm+solana), redis rămâne");
    assert(s.requiresConfirmation === true, "A5: stopuri distructive → confirmare");
    assert(planLines.length > 0 && planLines[0].includes("parked"), "A6: linii de plan populate");
    const out = formatLiveResult(r);
    assert(out[0].startsWith("PREVIEW (read-only"), "A7: render marchează READ-ONLY");
    assert(out.some((l) => l.startsWith("rezumat:")), "A8: render are rezumat");
    // Anti-divergență: rezultatul poartă DOAR `plan` (+target+diagnostice) — fără `lines`/`summary` stocate.
    assert(!("lines" in r) && !("summary" in r), "A9: rezultatul NU stochează derivate duplicate (lines/summary)");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// B. reader refuză (staged_changes) → stadiu read
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const reader: SnapshotReader = async () => ({ ok: false, reason: { kind: "staged_changes" } });
  const r = await readLiveState(reader, MANIFEST, "parked", okCaps());
  assert(!r.ok && r.stage === "read" && r.reason.kind === "staged_changes", "B1: refuz client → stadiu read");
  assert(formatLiveResult(r)[0] === "EȘEC @ citire: staged_changes", "B2: render eșec citire");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// C. reader ok dar snapshot cu scope greșit → stadiu map (wrong_scope)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const bad = { ...happySnapshot(), projectId: "OTHER" };
  const r = await readLiveState(readerOk(bad), MANIFEST, "parked", okCaps());
  assert(!r.ok && r.stage === "map" && r.reason === "wrong_scope", "C1: snapshot scope greșit → stadiu map");
  assert(formatLiveResult(r)[0] === "EȘEC @ mapare: wrong_scope", "C2: render eșec mapare");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// D. reader aruncă → stadiu read (reader_error, fără throw scăpat)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const reader: SnapshotReader = async () => { throw new Error("boom"); };
  const r = await readLiveState(reader, MANIFEST, "parked", okCaps());
  assert(!r.ok && r.stage === "read" && r.reason.kind === "reader_error", "D1: reader aruncă → reader_error");
  assert(formatLiveResult(r)[0] === "EȘEC @ citire: reader_error", "D2: render reader_error");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// E. plan-stage: caps.validateService[mcp] aruncă + target cere env mcp → validation_unavailable
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const caps = okCaps();
  (caps.validateService as Record<string, ServiceEnvValidator>).mcp = () => { throw new Error("validator boom"); };
  const r = await readLiveState(readerOk(happySnapshot()), MANIFEST, "auth-canary", caps);
  assert(!r.ok && r.stage === "plan" && r.reason === "validation_unavailable", "E1: validator aruncă → stadiu plan validation_unavailable");
  assert(formatLiveResult(r)[0] === "EȘEC @ plan: validation_unavailable", "E2: render eșec plan");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// F. passthrough diagnostice de mapare (service_renamed + env_unreadable) pe rezultat OK
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // mcp redenumit (nume ≠ catalog) → service_renamed; solana cu var sealed (null) → env_unreadable.
  const snap = happySnapshot({
    mcp: { name: "Renamed MCP" },
    "solana-worker": { variables: { VAR_x: "v", SEALED: null } },
  });
  const r = await readLiveState(readerOk(snap), MANIFEST, "parked", okCaps());
  assert(r.ok === true, "F1: renamed/sealed → tot ok (mapabil)");
  if (r.ok) {
    assert(r.diagnostics.some((d) => d.code === "service_renamed" && d.service === "mcp"), "F2: diagnostic service_renamed(mcp)");
    assert(r.diagnostics.some((d) => d.code === "env_unreadable" && d.service === "solana-worker"), "F3: diagnostic env_unreadable(solana)");
    const out = formatLiveResult(r);
    assert(out.some((l) => l === "diagnostice mapare:"), "F4: render listează diagnostice");
    assert(out.some((l) => l.includes("service_renamed")) && out.some((l) => l.includes("env_unreadable")), "F5: coduri de diagnostic în render");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// G. anti-leak: render-ul NU conține valori de env (nici pe stadiu read, nici pe ok)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const snap = happySnapshot({ mcp: { variables: { SECRET_KEY: "s3cr3t-value-xyz" } } });
  const r = await readLiveState(readerOk(snap), MANIFEST, "parked", okCaps());
  const joined = formatLiveResult(r).join("\n");
  assert(!joined.includes("s3cr3t-value-xyz"), "G1: valoarea de env NU apare în render");
  // și codurile din refuzul de read nu ecouă nimic din snapshot
  const rr = await readLiveState(async () => ({ ok: false, reason: { kind: "transport_error", at: "environment", code: "http_error" } }), MANIFEST, "parked", okCaps());
  assert(formatLiveResult(rr)[0] === "EȘEC @ citire: transport_error(environment/http_error)", "G2: render transport_error cu at+code (static)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// H. render pt. refuzuri client cu ROL (nu UUID) + drift + ambiguous
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const drift = await readLiveState(async () => ({ ok: false, reason: { kind: "running_stale_drift", service: "mcp" } }), MANIFEST, "parked", okCaps());
  assert(formatLiveResult(drift)[0] === "EȘEC @ citire: running_stale_drift(mcp)", "H1: drift cu rol");
  const amb = await readLiveState(async () => ({ ok: false, reason: { kind: "ambiguous_active_deployments", service: "worker-evm" } }), MANIFEST, "parked", okCaps());
  assert(formatLiveResult(amb)[0] === "EȘEC @ citire: ambiguous_active_deployments(worker-evm)", "H2: ambiguous cu rol");
  const unexp = await readLiveState(async () => ({ ok: false, reason: { kind: "unexpected_service" } }), MANIFEST, "parked", okCaps());
  assert(formatLiveResult(unexp)[0] === "EȘEC @ citire: unexpected_service", "H3: unexpected_service fără identificator");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// I. READ-ONLY: modulul NU exportă niciun apply/mutație
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const names = Object.keys(liveMod);
  const forbidden = names.filter((n) => /apply|mutate|start|stop|write|commit|deploy/i.test(n));
  assert(forbidden.length === 0, `I1: niciun export de mutație (găsit: ${forbidden.join(",") || "niciunul"})`);
  assert(typeof readLiveState === "function" && typeof formatLiveResult === "function", "I2: doar compoziție read-only + render");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// J. liveExitCode — 0 DOAR pt. plan admisibil; blocat / eșec de stadiu → 1
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // admisibil (parked din all-running) → 0
  const okAdm = await readLiveState(readerOk(happySnapshot()), MANIFEST, "parked", okCaps());
  assert(okAdm.ok === true && okAdm.plan.admissible === true, "J0: parked → plan admisibil");
  assert(liveExitCode(okAdm) === 0, "J1: plan admisibil → exit 0");

  // launch NEfinalizat → plan BLOCAT (profile_incomplete) DAR readLiveState ok:true → exit 1 (P1 fix)
  const blocked = await readLiveState(readerOk(happySnapshot()), MANIFEST, "launch", okCaps());
  assert(blocked.ok === true && blocked.plan.admissible === false, "J2: launch → ok:true dar plan BLOCAT");
  assert(liveExitCode(blocked) === 1, "J3: plan blocat (launch) → exit 1 (nu 0)");

  // eșec de stadiu read → 1
  const rf = await readLiveState(async () => ({ ok: false, reason: { kind: "staged_changes" } }), MANIFEST, "parked", okCaps());
  assert(liveExitCode(rf) === 1, "J4: eșec read → exit 1");
  // eșec de stadiu map → 1
  const mf = await readLiveState(readerOk({ ...happySnapshot(), projectId: "OTHER" }), MANIFEST, "parked", okCaps());
  assert(liveExitCode(mf) === 1, "J5: eșec map → exit 1");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// K. deadline/opts passthrough — signal e forwardat reader-ului; abort → stadiu read aborted (fără operație abandonată)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  // opts.signal e transmis reader-ului (runner-ul își pune deadline-ul global aici).
  let seenSignal: AbortSignal | undefined;
  const capturing: SnapshotReader = async (_m, o) => { seenSignal = o?.signal; return { ok: true, snapshot: happySnapshot() }; };
  const ac0 = new AbortController();
  await readLiveState(capturing, MANIFEST, "parked", okCaps(), { signal: ac0.signal });
  assert(seenSignal === ac0.signal, "K1: opts.signal forwardat reader-ului (deadline global funcțional)");

  // reader care respectă signal-ul: deja abortat → aborted → stadiu read, exit 1, fără operație abandonată.
  const ac = new AbortController(); ac.abort();
  let awaited: boolean = false;
  const signalAware: SnapshotReader = async (_m, o) => { awaited = true; return o?.signal?.aborted ? { ok: false, reason: { kind: "aborted" } } : { ok: true, snapshot: happySnapshot() }; };
  const r = await readLiveState(signalAware, MANIFEST, "parked", okCaps(), { signal: ac.signal });
  assert(awaited, "K2: reader-ul a fost AȘTEPTAT (fără abandon)");
  assert(!r.ok && r.stage === "read" && r.reason.kind === "aborted", "K3: deadline global → aborted @ stadiu read");
  assert(liveExitCode(r) === 1 && formatLiveResult(r)[0] === "EȘEC @ citire: aborted", "K4: aborted → exit 1 + render");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// L. fallback runtime: un `kind` de reason NECUNOSCUT (input malformat, bypass de tip) → marker STATIC, FĂRĂ reflectare.
//    Branch-ul `default` din renderReadReason e imposibil la compilare (gardă `never`); îl exercităm la runtime forțat.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const bogus = { ok: false, stage: "read", reason: { kind: "totally_bogus_kind", leak: "SECRET-LEAK-abc123" } } as unknown as LiveReadResult;
  const out = formatLiveResult(bogus);
  assert(out[0] === "EȘEC @ citire: unknown", "L1: kind necunoscut la runtime → marker STATIC 'unknown'");
  const joined = out.join("\n");
  assert(!joined.includes("totally_bogus_kind") && !joined.includes("SECRET-LEAK-abc123"), "L2: fallback-ul NU reflectă kind-ul/valoarea runtime (anti-leak)");
}

if (fails.length > 0) {
  console.error(`railwayReadLive.test: ${fails.length} EȘUAT / ${passed} ok`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`railwayReadLive.test: ${passed}/${passed} ok`);
}

main().catch((e) => { console.error("railwayReadLive.test: EXCEPȚIE", e); process.exit(1); });
