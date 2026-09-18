/**
 * lib/mcp/profilePlan.test.ts — PH-12 12.6 leaf 1 (rev5). Validator canonic per rol injectat + identitate prin WeakSet.
 * `tsx lib/mcp/profilePlan.test.ts`. Cablat în `test:ph12-profile` (gate-14).
 */
import {
  SERVICE_IDS, PROFILE_NAMES, PROFILES, parseRawState, buildObservation, planFromRaw,
  planProfileTransition, planSummary, formatPlanLines,
  type Caps, type RawState, type ServiceId, type ProfileName, type ServiceAction, type Observation, type TransitionPlan, type EnvValidation,
} from "./profilePlan";

let failures = 0;
function check(name: string, cond: boolean): void { console.log((cond ? "PASS" : "FAIL") + "  " + name); if (!cond) failures++; }

const SECRET_WS = "wss://base-mainnet.g.alchemy.com/v2/SUPERSECRETALCHEMYKEY999";
// Validatoare canonice ca TEST-DOUBLES (leaf 2 injectează cele reale: validateMcpEnv+buildEnvCheck, validateWorkerEvmEnv, ...).
const caps: Caps = {
  validateService: {
    mcp: (env): EnvValidation => {
      const problems: { name: string; kind: "missing" | "invalid" }[] = [];
      for (const k of ["PUBLIC_BASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "REDIS_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
        const v = env[k];
        if (!v || v.trim() === "") problems.push({ name: k, kind: "missing" });
        else if ((k === "PUBLIC_BASE_URL" || k === "NEXT_PUBLIC_SUPABASE_URL") && !/^https:\/\//.test(v)) problems.push({ name: k, kind: "invalid" });
        else if (k === "REDIS_URL" && !/^rediss?:\/\//.test(v)) problems.push({ name: k, kind: "invalid" });
      }
      return { ok: problems.length === 0, problems };
    },
    "worker-evm": (env): EnvValidation => {
      const problems: { name: string; kind: "missing" | "invalid" }[] = [];
      if (!env.REDIS_URL) problems.push({ name: "REDIS_URL", kind: "missing" });
      if (env.PREFLIGHT_MODE === "LIVE" && (env.ENABLED_CHAINS ?? "").split(",").includes("base")) { // cross-field
        const ws = env.ALCHEMY_BASE_WS;
        if (!ws) problems.push({ name: "ALCHEMY_BASE_WS", kind: "missing" });
        else if (!/^wss:\/\/[^\s#]+$/.test(ws)) problems.push({ name: "ALCHEMY_BASE_WS", kind: "invalid" });
      }
      return { ok: problems.length === 0, problems };
    },
    "indexer-evm": (env): EnvValidation => { const p: { name: string; kind: "missing" | "invalid" }[] = []; if (!env.REDIS_URL) p.push({ name: "REDIS_URL", kind: "missing" }); if (!env.ALCHEMY_BASE_RPC) p.push({ name: "ALCHEMY_BASE_RPC", kind: "missing" }); else if (!/^https:\/\//.test(env.ALCHEMY_BASE_RPC)) p.push({ name: "ALCHEMY_BASE_RPC", kind: "invalid" }); return { ok: p.length === 0, problems: p }; },
    "solana-worker": (env): EnvValidation => { const p: { name: string; kind: "missing" | "invalid" }[] = []; if (!env.REDIS_URL) p.push({ name: "REDIS_URL", kind: "missing" }); const rpc = env.SOLANA_RPC_URL ?? env.HELIUS_RPC_URL ?? env.ALCHEMY_SOLANA_RPC_URL; if (!rpc || rpc.trim() === "") p.push({ name: "SOLANA_RPC_URL|HELIUS_RPC_URL|ALCHEMY_SOLANA_RPC_URL", kind: "missing" }); return { ok: p.length === 0, problems: p }; },
  },
  envKeys: { // NUMELE canonice de câmp per rol (din aceeași schemă) — allowlist de proveniență
    mcp: ["PUBLIC_BASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "REDIS_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "HEALTH_EXPECTED_CHAINS", "HEALTH_EXPECT_INDEXER_EVM", "HEALTH_EXPECT_SOLANA_WORKER", "PH2_RESOURCE_OWNER_AUTHORIZE", "MCP_DEV_AUTH_BYPASS"],
    "worker-evm": ["ALCHEMY_BASE_WS", "REDIS_URL", "ENABLED_CHAINS", "PREFLIGHT_MODE"],
    "indexer-evm": ["ALCHEMY_BASE_RPC", "REDIS_URL"],
    "solana-worker": ["REDIS_URL", "SOLANA_RPC_URL", "HELIUS_RPC_URL", "ALCHEMY_SOLANA_RPC_URL"],
  },
  isStagingSupabase: (env) => (env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("staging"),
};

const PRECOND: Record<ServiceId, Record<string, string>> = {
  redis: {},
  mcp: { PUBLIC_BASE_URL: "https://preflight.jackspools.lol", SUPABASE_SERVICE_ROLE_KEY: "svc-role", REDIS_URL: "redis://127.0.0.1:6379", NEXT_PUBLIC_SUPABASE_URL: "https://staging-xyz.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" },
  "worker-evm": { ALCHEMY_BASE_WS: SECRET_WS, REDIS_URL: "redis://127.0.0.1:6379" },
  "indexer-evm": { ALCHEMY_BASE_RPC: "https://base.g.alchemy.com/v2/k", REDIS_URL: "redis://127.0.0.1:6379" },
  "solana-worker": { REDIS_URL: "redis://127.0.0.1:6379", SOLANA_RPC_URL: "https://solana.g/k" },
};
function rawMatching(name: ProfileName): RawState {
  const p = PROFILES[name]; const out: Record<ServiceId, { running: boolean; env: Record<string, string> }> = {} as never;
  for (const s of SERVICE_IDS) { const des = p.services[s]; out[s] = { running: des.running, env: { ...PRECOND[s], ...des.env } }; }
  return out;
}
function obsOf(from: ProfileName, to: ProfileName): Observation { const r = buildObservation(rawMatching(from), to, caps); if (!r.ok) throw new Error(`build eșuat ${from}->${to}`); return r.observation; }
function planTo(from: ProfileName, to: ProfileName): TransitionPlan { return planProfileTransition(obsOf(from, to)); }
function applyPlan(raw: RawState, actions: readonly ServiceAction[]): RawState {
  const next: Record<ServiceId, { running: boolean; env: Record<string, string> }> = {} as never;
  for (const s of SERVICE_IDS) { const c = raw[s] ?? { running: false, env: {} }; next[s] = { running: c.running, env: { ...c.env } }; }
  for (const a of actions) { const svc = next[a.service]; if (a.kind === "set_env" && a.key) svc.env[a.key] = a.value ?? ""; else if (a.kind === "unset_env" && a.key) delete svc.env[a.key]; else if (a.kind === "start") svc.running = true; else if (a.kind === "stop") svc.running = false; }
  return next;
}

// ── A. Model + îngheț ─────────────────────────────────────────────────────────────────────────────────────────
{
  check("A1 launch NEfinalizat", PROFILES.launch.finalized === false && PROFILES.parked.finalized);
  check("A2 mcp auth/base cer requiresEnv + stagingBinding", PROFILES["auth-canary"].services.mcp.requiresEnv && PROFILES["base-canary"].services.mcp.stagingBinding);
  check("A3 worker base: requiresEnv, fără stagingBinding", PROFILES["base-canary"].services["worker-evm"].requiresEnv && PROFILES["base-canary"].services["worker-evm"].stagingBinding === false);
  check("A4 enum-uri + catalog înghețate", Object.isFrozen(SERVICE_IDS) && Object.isFrozen(PROFILE_NAMES) && Object.isFrozen(PROFILES.parked.services.mcp));
  check("A5 NU mai există catalog local de chei required (fără allOf/KeyCheck)", !("allOf" in (PROFILES["base-canary"].services.mcp as object)));
}

// ── B. Frontieră RAW ──────────────────────────────────────────────────────────────────────────────────────────
{
  check("B1 câmp suplimentar → null", parseRawState({ mcp: { running: true, env: {}, x: 1 } }) === null);
  check("B2 target invalid → unknown_profile", (() => { const r = planFromRaw({}, "bogus", caps); return !r.ok && r.reason === "unknown_profile"; })());
  check("B3 stare invalidă → invalid_input", (() => { const r = planFromRaw({ mcp: { running: 1, env: {} } }, "parked", caps); return !r.ok && r.reason === "invalid_input"; })());
}

// ── C. „Poate porni" = VALIDATOR CANONIC pe env EFECTIV (raw ∪ managed) ───────────────────────────────────────
{
  // worker fără ALCHEMY_BASE_WS în raw; profilul base-canary injectează ENABLED_CHAINS=base + PREFLIGHT_MODE=LIVE →
  // validatorul canonic (pe env EFECTIV) cere WS → env_missing. Dovedește: (1) rulăm validatorul complet, (2) pe env efectiv.
  const noWs: RawState = { ...rawMatching("base-canary"), "worker-evm": { running: false, env: { REDIS_URL: "redis://x:6379" } } };
  const b1 = buildObservation(noWs, "base-canary", caps);
  const p1 = b1.ok ? planProfileTransition(b1.observation) : null;
  check("C1 canonic pe env efectiv → env_missing ALCHEMY_BASE_WS", p1 !== null && !p1.admissible && p1.blockers.some((b) => b.kind === "env_missing" && b.service === "worker-evm" && b.key === "ALCHEMY_BASE_WS"));

  // mcp fără SUPABASE_SERVICE_ROLE_KEY → env_missing (cheie boot-required prinsă de validatorul canonic, nu de un subset local).
  const noSvc: RawState = { ...rawMatching("auth-canary"), mcp: { running: true, env: { ...PRECOND.mcp, SUPABASE_SERVICE_ROLE_KEY: "", HEALTH_EXPECT_INDEXER_EVM: "0", HEALTH_EXPECT_SOLANA_WORKER: "0", PH2_RESOURCE_OWNER_AUTHORIZE: "1" } } };
  const b2 = buildObservation(noSvc, "auth-canary", caps);
  const p2 = b2.ok ? planProfileTransition(b2.observation) : null;
  check("C2 mcp fără SERVICE_ROLE_KEY → env_missing", p2 !== null && !p2.admissible && p2.blockers.some((b) => b.kind === "env_missing" && b.key === "SUPABASE_SERVICE_ROLE_KEY"));

  // formă invalidă → env_invalid.
  const badWs: RawState = { ...rawMatching("base-canary"), "worker-evm": { running: false, env: { ALCHEMY_BASE_WS: "http://not-wss", REDIS_URL: "redis://x:6379" } } };
  const b3 = buildObservation(badWs, "base-canary", caps);
  const p3 = b3.ok ? planProfileTransition(b3.observation) : null;
  check("C3 http:// pe WS → env_invalid", p3 !== null && !p3.admissible && p3.blockers.some((b) => b.kind === "env_invalid" && b.key === "ALCHEMY_BASE_WS"));

  // staging prod → unverified.
  const prod: RawState = { ...rawMatching("auth-canary"), mcp: { running: true, env: { ...PRECOND.mcp, NEXT_PUBLIC_SUPABASE_URL: "https://ipeyogz.supabase.co", HEALTH_EXPECT_INDEXER_EVM: "0", HEALTH_EXPECT_SOLANA_WORKER: "0", PH2_RESOURCE_OWNER_AUTHORIZE: "1" } } };
  const b4 = buildObservation(prod, "auth-canary", caps);
  const p4 = b4.ok ? planProfileTransition(b4.observation) : null;
  check("C4 staging prod → staging_unverified", p4 !== null && !p4.admissible && p4.blockers.some((b) => b.kind === "staging_unverified"));
}

// ── D. Capability fail-closed (throw/lipsă/malformat → validation_unavailable, ZERO leak) ─────────────────────
{
  const throwSecret: Caps = { ...caps, validateService: { ...caps.validateService, "worker-evm": () => { throw new Error("boom " + SECRET_WS); } } };
  const r1 = buildObservation(rawMatching("base-canary"), "base-canary", throwSecret);
  check("D1 validator care aruncă → validation_unavailable", !r1.ok && r1.reason === "validation_unavailable");
  check("D2 ZERO leak în rezultat", !JSON.stringify(r1).includes("SUPERSECRET"));
  check("D3 planFromRaw nu aruncă", (() => { const r = planFromRaw(rawMatching("base-canary"), "base-canary", throwSecret); return !r.ok && r.reason === "validation_unavailable"; })());
  const missing: Caps = { ...caps, validateService: { ...caps.validateService, mcp: undefined } };
  check("D4 validator LIPSĂ → validation_unavailable", !buildObservation(rawMatching("auth-canary"), "auth-canary", missing).ok);
  const malformed: Caps = { ...caps, validateService: { ...caps.validateService, mcp: (() => ({ ok: "yes" })) as unknown as (e: Readonly<Record<string, string>>) => EnvValidation } };
  check("D5 retur malformat → validation_unavailable", !buildObservation(rawMatching("auth-canary"), "auth-canary", malformed).ok);
  const stagingThrow: Caps = { ...caps, isStagingSupabase: () => { throw new Error("db"); } };
  check("D6 isStagingSupabase throw → validation_unavailable", !buildObservation(rawMatching("auth-canary"), "auth-canary", stagingThrow).ok);
}

// ── E. Identitate prin WeakSet (spread/relabel → respins) ─────────────────────────────────────────────────────
{
  const genuine = obsOf("base-canary", "base-canary");
  check("E1 observație genuină → funcționează", planProfileTransition(genuine).admissible === true);
  const relabeled = { ...obsOf("auth-canary", "auth-canary"), target: "base-canary" as ProfileName } as Observation;
  const pr = planProfileTransition(relabeled);
  check("E2 spread + relabel (obiect NOU) → invalid_observation", !pr.admissible && pr.blockers.some((b) => b.kind === "invalid_observation"));
  const copy = { ...genuine } as Observation;
  check("E3 orice copie prin spread → invalid_observation (nu-i în registru)", (() => { const p = planProfileTransition(copy); return !p.admissible && p.blockers.some((b) => b.kind === "invalid_observation"); })());
  const fake = { target: "base-canary", services: {} } as unknown as Observation;
  check("E4 obiect fabricat → invalid_observation", (() => { const p = planProfileTransition(fake); return !p.admissible; })());
}

// ── F. Blocat = zero ServiceAction + unknown≠stopped ──────────────────────────────────────────────────────────
{
  const blocked = planTo("base-canary", "launch");
  check("F1 launch → profile_incomplete, fără `actions`", !blocked.admissible && blocked.blockers.some((b) => b.kind === "profile_incomplete") && !("actions" in blocked));
  check("F2 nicio proprietate cu `phase`", Object.values(blocked).every((v) => !(Array.isArray(v) && v.some((x) => x !== null && typeof x === "object" && "phase" in (x as object)))));
  const partial: RawState = { redis: { running: true, env: {} }, mcp: { running: false, env: PRECOND.mcp } };
  const bp = buildObservation(partial, "base-canary", caps);
  const pp = bp.ok ? planProfileTransition(bp.observation) : null;
  check("F3 neobservat → before.running 'unknown' + state_unknown", pp !== null && pp.before["worker-evm"].running === "unknown" && !pp.admissible && pp.blockers.some((b) => b.kind === "state_unknown"));
}

// ── G. Fazare + unset pe gol ──────────────────────────────────────────────────────────────────────────────────
{
  const plan = planTo("parked", "base-canary");
  check("G0 admisibil", plan.admissible === true);
  if (plan.admissible) { const lc = plan.actions.map((a) => a.phase).lastIndexOf("configure"); const fs = plan.actions.findIndex((a) => a.phase === "start"); check("G1 configure < start", fs === -1 || lc < fs); }
  const raw: RawState = { ...rawMatching("auth-canary"), mcp: { running: true, env: { ...PRECOND.mcp, HEALTH_EXPECT_INDEXER_EVM: "0", HEALTH_EXPECT_SOLANA_WORKER: "0", PH2_RESOURCE_OWNER_AUTHORIZE: "1", HEALTH_EXPECTED_CHAINS: "" } } };
  const b = buildObservation(raw, "auth-canary", caps);
  const pl = b.ok ? planProfileTransition(b.observation) : null;
  check("G2 cheie gestionată goală → unset_env (hasOwn)", pl !== null && pl.admissible && pl.actions.some((a) => a.kind === "unset_env" && a.key === "HEALTH_EXPECTED_CHAINS"));
}

// ── H. MATRICE 4×4 ────────────────────────────────────────────────────────────────────────────────────────────
{
  for (const from of PROFILE_NAMES) for (const to of PROFILE_NAMES) {
    const tag = `${from}→${to}`; const plan = planTo(from, to);
    if (to === "launch") { check(`H[${tag}] launch NEaplicabil`, !plan.admissible && !("actions" in plan)); continue; }
    if (!plan.admissible) { check(`H[${tag}] admisibil`, false); continue; }
    check(`H[${tag}] admisibil`, true);
    if (from === to) check(`H[${tag}] noop`, plan.noop === true);
    const applied = applyPlan(rawMatching(from), plan.actions);
    const ok = SERVICE_IDS.every((s) => { const des = PROFILES[to].services[s]; if (applied[s]!.running !== des.running) return false; if (des.running) for (const k of ["HEALTH_EXPECTED_CHAINS", "HEALTH_EXPECT_INDEXER_EVM", "HEALTH_EXPECT_SOLANA_WORKER", "PH2_RESOURCE_OWNER_AUTHORIZE", "ENABLED_CHAINS", "PREFLIGHT_MODE"]) { const want = (des.env as Record<string, string>)[k]; const got = applied[s]!.env[k]; if (want === undefined) { if (got !== undefined) return false; } else if (got !== want) return false; } return true; });
    check(`H[${tag}] apply → profil țintă`, ok);
    const rb = buildObservation(applied, to, caps);
    check(`H[${tag}] replan → noop`, rb.ok && (() => { const rp = planProfileTransition(rb.observation); return rp.admissible && rp.noop; })());
  }
}

// ── I. render + summary + anti-leak ───────────────────────────────────────────────────────────────────────────
{
  const plan = planTo("parked", "base-canary");
  check("I1 render start/configure", formatPlanLines(plan).some((l) => l.includes("[start]")) && formatPlanLines(plan).some((l) => l.includes("[configure]")));
  check("I2 anti-leak render", !formatPlanLines(plan).join("\n").includes("SUPERSECRET"));
  check("I3 summary blocat: admissible false", planSummary(planTo("base-canary", "launch")).admissible === false);
}

// ── J. caps malformat → validation_unavailable, ZERO throw (P2) ──────────────────────────────────────────────
{
  check("J1 caps null → validation_unavailable (fără throw)", !buildObservation(rawMatching("parked"), "parked", null as unknown as Caps).ok);
  check("J2 validateService null → validation_unavailable", !buildObservation(rawMatching("auth-canary"), "auth-canary", { validateService: null, isStagingSupabase: () => true } as unknown as Caps).ok);
  check("J3 isStagingSupabase non-funcție → validation_unavailable", !buildObservation(rawMatching("auth-canary"), "auth-canary", { validateService: {}, isStagingSupabase: 42 } as unknown as Caps).ok);
  const getterBoom = {} as Caps;
  Object.defineProperty(getterBoom, "validateService", { get() { throw new Error("caps boom"); } });
  Object.defineProperty(getterBoom, "isStagingSupabase", { value: () => true });
  check("J4 getter care aruncă la ACCES → validation_unavailable (backstop)", !buildObservation(rawMatching("auth-canary"), "auth-canary", getterBoom).ok);
}

// ── K. planul întors e IMUTABIL după validare (P1) ────────────────────────────────────────────────────────────
{
  const plan = planTo("parked", "base-canary");
  check("K1 plan înghețat", Object.isFrozen(plan));
  check("K2 actions înghețate", plan.admissible && Object.isFrozen(plan.actions));
  check("K3 push pe actions → no-op (lungime neschimbată)", plan.admissible === true && (() => { const n = plan.actions.length; try { (plan.actions as ServiceAction[]).push({ service: "mcp", kind: "stop", phase: "stop", destructive: true, causesRestart: true }); } catch { /* frozen */ } return plan.actions.length === n; })());
  const blocked = planTo("base-canary", "launch");
  check("K4 plan blocat înghețat (blockers + preview)", Object.isFrozen(blocked) && !blocked.admissible && Object.isFrozen(blocked.blockers) && Object.isFrozen(blocked.preview));
}

// ── L. Contractul validatorului (rev6) — testele decisive cerute ─────────────────────────────────────────────
{
  const withMcp = (fn: (e: Readonly<Record<string, string>>) => EnvValidation): Caps => ({ ...caps, validateService: { ...caps.validateService, mcp: fn } });

  // 1. ok:false + problems:[] → validation_unavailable, NICIODATĂ plan verde.
  check("L1 ok:false + problems:[] → validation_unavailable", !buildObservation(rawMatching("auth-canary"), "auth-canary", withMcp(() => ({ ok: false, problems: [] }))).ok);
  // 2. ok:true + problems:[...] → refuz.
  check("L2 ok:true + problems:[X] → validation_unavailable", !buildObservation(rawMatching("auth-canary"), "auth-canary", withMcp(() => ({ ok: true, problems: [{ name: "REDIS_URL", kind: "missing" }] }))).ok);
  // 3. forbidden → blocker DISTINCT + diagnostic corect.
  const forbidCaps = withMcp((env) => { const b = caps.validateService.mcp!(env); return { ok: false, problems: [...b.problems, { name: "MCP_DEV_AUTH_BYPASS", kind: "forbidden" }] }; });
  const bf = buildObservation(rawMatching("auth-canary"), "auth-canary", forbidCaps);
  const pf = bf.ok ? planProfileTransition(bf.observation) : null;
  check("L3 forbidden → env_forbidden pe cheia corectă", pf !== null && !pf.admissible && pf.blockers.some((b) => b.kind === "env_forbidden" && b.key === "MCP_DEV_AUTH_BYPASS"));
  check("L3b render → 'INTERZIS'", pf !== null && formatPlanLines(pf).some((l) => l.includes("INTERZIS")));
  // 4. name cu secret/control → respins + nu apare în render.
  const secretName = buildObservation(rawMatching("auth-canary"), "auth-canary", withMcp(() => ({ ok: false, problems: [{ name: "leak " + SECRET_WS, kind: "missing" }] })));
  check("L4 name cu secret (spații/://) → validation_unavailable", !secretName.ok);
  check("L4b secretul NU apare în rezultat", !JSON.stringify(secretName).includes("SUPERSECRET"));
  check("L4c name cu control-char (\\n) → validation_unavailable", !buildObservation(rawMatching("auth-canary"), "auth-canary", withMcp(() => ({ ok: false, problems: [{ name: "A\nB", kind: "missing" }] }))).ok);

  // 5. Cheie gestionată prezentă în raw, absentă în target → validatorul NU o mai vede (env EFECTIV = post-apply).
  const probe = (env: Readonly<Record<string, string>>): EnvValidation => { const b = caps.validateService.mcp!(env); const problems = [...b.problems]; if (Object.hasOwn(env, "HEALTH_EXPECTED_CHAINS")) problems.push({ name: "HEALTH_EXPECTED_CHAINS", kind: "forbidden" }); return { ok: problems.length === 0, problems }; };
  // base→auth: auth UNSET-uiește HEALTH_EXPECTED_CHAINS → efectiv o exclude → proba NU o vede → admisibil.
  const bUnset = buildObservation(rawMatching("base-canary"), "auth-canary", withMcp(probe));
  check("L5 cheie unset în target → validatorul n-o mai vede → admisibil", bUnset.ok && planProfileTransition(bUnset.observation).admissible === true);
  // parked→base: base SETEAZĂ HEALTH_EXPECTED_CHAINS → efectiv o include → proba o prinde → blocat.
  const bSet = buildObservation(rawMatching("parked"), "base-canary", withMcp(probe));
  const pSet = bSet.ok ? planProfileTransition(bSet.observation) : null;
  check("L5b cheie set în target → validatorul O vede", pSet !== null && !pSet.admissible && pSet.blockers.some((b) => b.kind === "env_forbidden" && b.key === "HEALTH_EXPECTED_CHAINS"));

  // 6. Cheie nouă în profil (absentă în raw) → obligatoriu set_env.
  const pNew = planTo("parked", "base-canary");
  check("L6 cheie nouă în profil → set_env", pNew.admissible && pNew.actions.some((a) => a.kind === "set_env" && a.key === "HEALTH_EXPECTED_CHAINS" && a.value === "base"));

  // 7. Getter care aruncă pe FRONTIERA REALĂ (planFromRaw → parseRawState) → rezultat static, ZERO throw.
  const badRaw = {}; Object.defineProperty(badRaw, "mcp", { enumerable: true, get() { throw new Error("raw boom " + SECRET_WS); } });
  const fr = planFromRaw(badRaw, "auth-canary", caps);
  check("L7 planFromRaw pe raw cu getter care aruncă → invalid_input (fără throw)", !fr.ok && fr.reason === "invalid_input");
  check("L7-leak secretul nu apare", !JSON.stringify(fr).includes("SUPERSECRET"));
  const badEnvRaw: Record<string, unknown> = { mcp: {} };
  Object.defineProperty(badEnvRaw.mcp, "running", { enumerable: true, value: true });
  Object.defineProperty(badEnvRaw.mcp, "env", { enumerable: true, get() { throw new Error("env boom"); } });
  check("L7b planFromRaw pe env-getter care aruncă → invalid_input", (() => { const r = planFromRaw(badEnvRaw, "auth-canary", caps); return !r.ok && r.reason === "invalid_input"; })());
  const throwingProxy = new Proxy({}, { get() { throw new Error("proxy boom " + SECRET_WS); } }) as unknown as Observation;
  const pProxy = planProfileTransition(throwingProxy); // isObservation=false (nu-i în WeakSet), apoi citirea target-ului NU trebuie să arunce
  check("L7c Proxy cu getter care ARUNCĂ → invalid_observation (fără throw)", !pProxy.admissible && pProxy.blockers.some((b) => b.kind === "invalid_observation"));
  check("L7c-leak fără secret", !JSON.stringify(pProxy).includes("SUPERSECRET"));

  // 8. PROVENIENȚĂ: un `name` sintactic-valid dar care NU e cheie a schemei → respins (nu doar regex).
  check("M1 name valid sintactic dar NEcanonic (proveniență) → validation_unavailable", !buildObservation(rawMatching("auth-canary"), "auth-canary", withMcp(() => ({ ok: false, problems: [{ name: "TOTALLY_FAKE_KEY", kind: "missing" }] }))).ok);
  // envKeys lipsă pt. rol → fail-closed.
  const noKeys = { ...caps, envKeys: { ...caps.envKeys, mcp: undefined } } as unknown as Caps;
  check("M2 envKeys lipsă pt. rol → validation_unavailable", !buildObservation(rawMatching("auth-canary"), "auth-canary", noKeys).ok);
}

// ── N. MANAGED_ENV_KEYS derivat: fiecare cheie pe care un profil o setează → set_env (fără drift) ──────────────
{
  const pBase = planTo("parked", "base-canary");
  const allSet = ["HEALTH_EXPECTED_CHAINS", "HEALTH_EXPECT_INDEXER_EVM", "HEALTH_EXPECT_SOLANA_WORKER", "PH2_RESOURCE_OWNER_AUTHORIZE", "ENABLED_CHAINS", "PREFLIGHT_MODE"];
  check("N1 fiecare cheie declarată de base-canary → set_env (derivat, zero drift)", pBase.admissible === true && allSet.every((k) => pBase.actions.some((a) => a.kind === "set_env" && a.key === k)));
}

console.log(failures === 0 ? "\nprofilePlan: ALL GREEN ✅" : `\nprofilePlan: ${failures} FAIL ❌`);
process.exit(failures === 0 ? 0 : 1);
