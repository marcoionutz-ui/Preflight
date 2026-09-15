/**
 * lib/mcp/canaryReleaseSteps.test.ts — PH-12 12.5c-4 (helper-e pure ale runnerului compus, hermetic).
 */
import {
  assertMailpitLoopback, assertMagicLinkBoundToSupabase, reconcileReadiness,
  parseWorkerStamp, assertGenerationAdvanced,
  parseRunMarker, assertRunIdentity, assertGenerationBarrier,
  assertBaselineAdmissible, startGate2IfBaselineAdmissible,
  boundedGet, readGenBaseline, makeGenerationBarrier,
  type GenStamp, type GenPair, type GenConn,
} from "./canaryReleaseSteps";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

console.log("PH-12 12.5c-4 — canaryReleaseSteps (mailpit + magic-link binding, readiness, generație post-spawn)");

// health body valid pt. reconcileReadiness.
function healthBody(o: { status?: string; httpStatus?: number; redisOk?: boolean; webOk?: boolean } = {}): unknown {
  return {
    status: o.status ?? "ok", httpStatus: o.httpStatus ?? 200, scope: "mcp-web",
    checks: {
      web:    { ok: o.webOk   ?? true },
      redis:  { ok: o.redisOk ?? true },
      worker: { ok: true },
      ws:     { ok: true },
    },
  };
}
const val = (ms: number): GenStamp => ({ kind: "value", ms });

// ── builders raw pt. bariera de generație/identitate ──
const RK = "preflight:worker_runtime:base";
const SK = "preflight:worker_snapshot:base:latest";
const runtimeRaw = (o: { updatedAt?: number; canaryRunId?: string } = {}): string =>
  JSON.stringify({ chain: "base", wsConnected: true, updatedAt: o.updatedAt ?? 200, ...(o.canaryRunId !== undefined ? { canaryRunId: o.canaryRunId } : {}) });
const snapshotRaw = (o: { savedAt?: number; canaryRunId?: string } = {}): string =>
  JSON.stringify({ version: "v1", savedAt: o.savedAt ?? 200, memory: {}, poolReserveEth: {}, ...(o.canaryRunId !== undefined ? { canaryRunId: o.canaryRunId } : {}) });

const hang = (): Promise<string | null> => new Promise<string | null>(() => { /* niciodată */ });
const rej  = (): Promise<string | null> => Promise.reject(new Error("conn_err"));

function makeFakeConn(opts: { runtime: () => Promise<string | null>; snapshot: () => Promise<string | null> }): { conn: GenConn; keys: string[]; dc: () => boolean } {
  let disconnected = false;
  const keys: string[] = [];
  const conn: GenConn = {
    get: (k: string) => { keys.push(k); return k.includes("worker_runtime") ? opts.runtime() : opts.snapshot(); },
    disconnect: () => { disconnected = true; },
  };
  return { conn, keys, dc: () => disconnected };
}

async function main(): Promise<void> {
  // ── 1. Mailpit loopback (origine canonică) ──
  {
    const m1 = assertMailpitLoopback("http://127.0.0.1:54324");
    check("M1. ⭐⭐⭐ http loopback → ok + ORIGINE canonică întoarsă", m1.ok && (m1 as { origin: string }).origin === "http://127.0.0.1:54324");
    check("M1b. ⭐⭐ pathname '/' explicit tot origine curată → ok", assertMailpitLoopback("http://127.0.0.1:54324/").ok);
    check("M2. ⭐ https loopback → ok", assertMailpitLoopback("https://localhost:54324").ok);
    check("M3. ⭐⭐⭐ host extern → refuz", !assertMailpitLoopback("http://mailpit.example.com").ok);
    check("M4. ⭐⭐ userinfo → refuz", !assertMailpitLoopback("http://u:p@127.0.0.1:54324").ok);
    check("M5. ⭐ #fragment → refuz", !assertMailpitLoopback("http://127.0.0.1:54324/#x").ok);
    check("M5b. ⭐⭐⭐ PATH → refuz (runnerul concatenează /api/v1)", !assertMailpitLoopback("http://127.0.0.1:54324/foo").ok);
    check("M5c. ⭐⭐⭐ QUERY → refuz", !assertMailpitLoopback("http://127.0.0.1:54324/?x=1").ok);
    check("M6. ⭐ schemă non-http → refuz", !assertMailpitLoopback("ftp://127.0.0.1").ok);
    check("M7. ⭐ gol → refuz", !assertMailpitLoopback("").ok);
  }

  // ── 2. magic-link ↔ Supabase vetat ──
  {
    const sb = "http://127.0.0.1:54321";
    check("L1. ⭐⭐⭐ origine Supabase + /auth/v1/verify → ok", assertMagicLinkBoundToSupabase("http://127.0.0.1:54321/auth/v1/verify?token=X&type=magiclink", sb).ok);
    check("L2. ⭐⭐⭐ ALT host → refuz (posibil alt Supabase/prod)", !assertMagicLinkBoundToSupabase("http://evil.example.com/auth/v1/verify?token=X", sb).ok);
    check("L3. ⭐⭐⭐ pathname ≠ /auth/v1/verify → refuz", !assertMagicLinkBoundToSupabase("http://127.0.0.1:54321/auth/v1/callback?token=X", sb).ok);
    check("L4. ⭐⭐ userinfo → refuz", !assertMagicLinkBoundToSupabase("http://u:p@127.0.0.1:54321/auth/v1/verify?token=X", sb).ok);
    check("L5. ⭐⭐ #fragment → refuz", !assertMagicLinkBoundToSupabase("http://127.0.0.1:54321/auth/v1/verify?token=X#f", sb).ok);
    check("L6. ⭐⭐⭐ schemă/port diferit (origine ≠) → refuz", !assertMagicLinkBoundToSupabase("https://127.0.0.1:54321/auth/v1/verify?token=X", sb).ok);
    check("L7. ⭐ magic link neparsabil → refuz", !assertMagicLinkBoundToSupabase("not a url", sb).ok);
  }

  // ── 3. reconcileReadiness (status mismatch în ambele direcții) ──
  {
    check("R1. ⭐⭐⭐ 200 + corp httpStatus:200 status:ok → ok", reconcileReadiness(200, healthBody({ httpStatus: 200, status: "ok" })).ok);
    const r503 = reconcileReadiness(503, healthBody({ httpStatus: 200, status: "ok" }));
    check("R2. ⭐⭐⭐ 503 real + corp httpStatus:200 → bad_status (cod EXISTENT Gate 1)", !r503.ok && (r503 as { code: string }).code === "bad_status");
    const r200 = reconcileReadiness(200, healthBody({ httpStatus: 503, status: "degraded" }));
    check("R3. ⭐⭐⭐ INVERS: 200 real + corp httpStatus:503 → bad_status", !r200.ok && (r200 as { code: string }).code === "bad_status");
    const rm = reconcileReadiness(200, "not json");
    check("R4. ⭐⭐ corp malformat → malformed", !rm.ok && (rm as { code: string }).code === "malformed");
    const rdown = reconcileReadiness(200, healthBody({ httpStatus: 200, status: "down", redisOk: false }));
    check("R5. ⭐⭐ status down (concordant 200? — down dă httpStatus 200 aici) → not_ready", !rdown.ok && (rdown as { code: string }).code === "not_ready");
    const rredis = reconcileReadiness(200, healthBody({ httpStatus: 200, status: "degraded", redisOk: false }));
    check("R6. ⭐⭐ redis ne-ok → not_ready", !rredis.ok && (rredis as { code: string }).code === "not_ready");
    check("R7. ⭐ 200 + degraded (workeri parcați) → ok (readiness acceptă degraded)", reconcileReadiness(200, healthBody({ httpStatus: 200, status: "degraded" })).ok);
  }

  // ── 4a. parseWorkerStamp ──
  {
    check("S1. ⭐⭐ null → absent", parseWorkerStamp(null, "updatedAt").kind === "absent");
    check("S2. ⭐⭐ non-JSON → invalid", parseWorkerStamp("xyz", "updatedAt").kind === "invalid");
    check("S3. ⭐ câmp lipsă → invalid", parseWorkerStamp("{}", "updatedAt").kind === "invalid");
    check("S4. ⭐ câmp ne-număr → invalid", parseWorkerStamp('{"updatedAt":"x"}', "updatedAt").kind === "invalid");
    check("S5. ⭐ câmp 0/negativ → invalid", parseWorkerStamp('{"updatedAt":0}', "updatedAt").kind === "invalid" && parseWorkerStamp('{"savedAt":-5}', "savedAt").kind === "invalid");
    check("S6. ⭐ array → invalid", parseWorkerStamp("[1,2]", "updatedAt").kind === "invalid");
    const s = parseWorkerStamp('{"savedAt":1788000000000}', "savedAt");
    check("S7. ⭐⭐⭐ valid → value cu ms exact", s.kind === "value" && s.ms === 1788000000000);
  }

  // ── 4b. assertGenerationAdvanced ──
  {
    const adv: GenPair = { runtime: val(200), snapshot: val(200) };
    const base: GenPair = { runtime: val(100), snapshot: val(100) };
    check("G1. ⭐⭐⭐ ambele avansate strict → ok", assertGenerationAdvanced(base, adv).ok);
    check("G2. ⭐⭐⭐ runtime neavansat (egal) → roșu", !assertGenerationAdvanced(base, { runtime: val(100), snapshot: val(200) }).ok);
    check("G3. ⭐⭐⭐ snapshot neavansat → roșu (AMBELE cerute)", !assertGenerationAdvanced(base, { runtime: val(200), snapshot: val(100) }).ok);
    check("G4. ⭐⭐⭐ observat absent → roșu", !assertGenerationAdvanced(base, { runtime: { kind: "absent" }, snapshot: val(200) }).ok);
    check("G5. ⭐⭐⭐ observat invalid → roșu", !assertGenerationAdvanced(base, { runtime: val(200), snapshot: { kind: "invalid" } }).ok);
    check("G6. ⭐⭐⭐ observat unavailable → roșu", !assertGenerationAdvanced(base, { runtime: { kind: "unavailable" }, snapshot: val(200) }).ok);
    check("G7. ⭐⭐⭐ baseline absent + observat valid → ok (a apărut post-spawn)", assertGenerationAdvanced({ runtime: { kind: "absent" }, snapshot: { kind: "absent" } }, adv).ok);
    check("G8. ⭐⭐⭐ baseline INVALID (corupt) → roșu (fail-closed, nu pot stabili pragul)", !assertGenerationAdvanced({ runtime: { kind: "invalid" }, snapshot: val(100) }, adv).ok);
    check("G9. ⭐⭐⭐ baseline UNAVAILABLE → roșu (nu pot stabili pragul, fail-closed)", !assertGenerationAdvanced({ runtime: { kind: "unavailable" }, snapshot: val(100) }, adv).ok);
    check("G10. ⭐⭐ baseline value + observat egal exact → roșu (reziduu)", !assertGenerationAdvanced({ runtime: val(500), snapshot: val(500) }, { runtime: val(500), snapshot: val(501) }).ok);
  }

  // ── 5a. parseRunMarker (identitate din worker_runtime) ──
  {
    check("RM1. ⭐⭐ null → absent", parseRunMarker(null).kind === "absent");
    check("RM2. ⭐⭐⭐ heartbeat fără câmp → absent (writer străin)", parseRunMarker(runtimeRaw()).kind === "absent");
    check("RM3. ⭐ non-JSON → invalid", parseRunMarker("nope").kind === "invalid");
    check("RM4. ⭐ array → invalid", parseRunMarker("[1]").kind === "invalid");
    const m = parseRunMarker(runtimeRaw({ canaryRunId: "wrkZ" }));
    check("RM5. ⭐⭐⭐ câmp prezent → value cu id exact", m.kind === "value" && (m as { runId: string }).runId === "wrkZ");
    check("RM6. ⭐ câmp gol → absent", parseRunMarker(runtimeRaw({ canaryRunId: "" })).kind === "absent");
  }

  // ── 5b. assertRunIdentity ──
  {
    check("ID1. ⭐⭐⭐ expected gol → roșu (config barieră invalidă)", !assertRunIdentity("", { kind: "value", runId: "x" }).ok);
    check("ID2. ⭐⭐⭐ marker absent → roșu", !assertRunIdentity("x", { kind: "absent" }).ok);
    check("ID3. ⭐⭐ marker invalid → roșu", !assertRunIdentity("x", { kind: "invalid" }).ok);
    check("ID4. ⭐⭐⭐ id diferit (alt proces) → roșu", !assertRunIdentity("x", { kind: "value", runId: "y" }).ok);
    check("ID5. ⭐⭐⭐ id egal → ok", assertRunIdentity("x", { kind: "value", runId: "x" }).ok);
  }

  // (assertGenerationBarrier PUR e testat în 5d — identitate pe AMBELE payloaduri.)

  // ── 6a. boundedGet (deadline fără disconnect; abort CU disconnect) ──
  {
    { const f = makeFakeConn({ runtime: hang, snapshot: hang }); let threw = false;
      try { await boundedGet(f.conn, RK, new AbortController().signal, 20); } catch { threw = true; }
      check("B1. ⭐⭐ GET care atârnă → respinge la deadline", threw);
      check("B2. ⭐⭐⭐ timeout NU închide conexiunea (supraviețuiește tick-ul următor)", f.dc() === false); }
    { const f = makeFakeConn({ runtime: hang, snapshot: hang }); const ac = new AbortController();
      const p = boundedGet(f.conn, RK, ac.signal, 5000); setTimeout(() => ac.abort(), 10); let threw = false;
      try { await p; } catch { threw = true; }
      check("B3. ⭐⭐⭐ abort Gate2 → respinge ȘI disconnect (op TERMINAT, nu abandonat)", threw && f.dc() === true); }
    { const f = makeFakeConn({ runtime: hang, snapshot: hang }); const ac = new AbortController(); ac.abort(); let threw = false;
      try { await boundedGet(f.conn, RK, ac.signal, 5000); } catch { threw = true; }
      check("B4. ⭐⭐ semnal deja abortat → respinge imediat + disconnect", threw && f.dc() === true); }
    { const f = makeFakeConn({ runtime: () => Promise.resolve("hello"), snapshot: hang });
      const v = await boundedGet(f.conn, RK, new AbortController().signal, 1000);
      check("B5. ⭐⭐ GET rapid → valoarea, fără disconnect", v === "hello" && f.dc() === false); }
  }

  // ── 5d. assertGenerationBarrier PUR: identitate pe AMBELE payloaduri (fix cgpt rev5) ──
  {
    const b: GenPair = { runtime: val(100), snapshot: val(100) };
    const adv: GenPair = { runtime: val(200), snapshot: val(200) };
    const M = (id: string): { kind: "value"; runId: string } => ({ kind: "value", runId: id });
    check("GBB1. ⭐⭐⭐ ambii markeri = expected + avansare → ok", assertGenerationBarrier("x", M("x"), M("x"), b, adv).ok);
    check("GBB2. ⭐⭐⭐ DECISIV: runtime=x, snapshot ABSENT (writer vechi a avansat savedAt) → roșu", !assertGenerationBarrier("x", M("x"), { kind: "absent" }, b, adv).ok);
    check("GBB3. ⭐⭐⭐ DECISIV: runtime=x, snapshot=ALT id → roșu", !assertGenerationBarrier("x", M("x"), M("y"), b, adv).ok);
    check("GBB4. ⭐⭐⭐ runtime=ALT id (chiar dacă snapshot=x) → roșu (nu doar egalitate între markeri)", !assertGenerationBarrier("x", M("y"), M("x"), b, adv).ok);
    check("GBB5. ⭐⭐⭐ ambii = ACELAȘI alt id (writer străin coerent) → roșu (nu coincid cu expectedRunId)", !assertGenerationBarrier("x", M("z"), M("z"), b, adv).ok);
    check("GBB6. ⭐⭐ ambii = x dar neavansat → roșu (avansare)", !assertGenerationBarrier("x", M("x"), M("x"), b, { runtime: val(100), snapshot: val(200) }).ok);
  }

  // ── 5e. assertBaselineAdmissible (poarta anti-cost pre-spawn) ──
  {
    check("AD1. ⭐⭐⭐ ambele value → admisibil", assertBaselineAdmissible({ runtime: val(1), snapshot: val(1) }).ok);
    check("AD2. ⭐⭐⭐ ambele absent → admisibil (tablă curată)", assertBaselineAdmissible({ runtime: { kind: "absent" }, snapshot: { kind: "absent" } }).ok);
    check("AD3. ⭐⭐ value + absent mixt → admisibil", assertBaselineAdmissible({ runtime: val(1), snapshot: { kind: "absent" } }).ok);
    check("AD4. ⭐⭐⭐ runtime unavailable → INadmisibil", !assertBaselineAdmissible({ runtime: { kind: "unavailable" }, snapshot: val(1) }).ok);
    check("AD5. ⭐⭐⭐ snapshot invalid → INadmisibil", !assertBaselineAdmissible({ runtime: val(1), snapshot: { kind: "invalid" } }).ok);
  }

  // ── 5f. startGate2IfBaselineAdmissible (DECISIV: baseline inadmisibil → ZERO spawn) ──
  {
    { let started = 0; const out = await startGate2IfBaselineAdmissible({ runtime: { kind: "unavailable" }, snapshot: val(1) }, async () => { started++; return "G2"; });
      check("SG1. ⭐⭐⭐ DECISIV: runtime baseline unavailable → start NEchemat (zero makeSteps/spawn) + cod închis",
        out.started === false && out.code === "generation_baseline" && started === 0); }
    { let started = 0; const out = await startGate2IfBaselineAdmissible({ runtime: val(1), snapshot: { kind: "invalid" } }, async () => { started++; return "G2"; });
      check("SG2. ⭐⭐⭐ DECISIV: snapshot baseline invalid → zero spawn", out.started === false && started === 0); }
    { let started = 0; const out = await startGate2IfBaselineAdmissible({ runtime: val(1), snapshot: { kind: "absent" } }, async () => { started++; return "G2"; });
      check("SG3. ⭐⭐⭐ baseline absent/value → start PERMIS (spawn) o singură dată", out.started === true && (out as { result: string }).result === "G2" && started === 1); }
  }

  // ── 6b. readGenBaseline ──
  {
    { const f = makeFakeConn({ runtime: () => Promise.resolve(runtimeRaw({ updatedAt: 150 })), snapshot: () => Promise.resolve(snapshotRaw({ savedAt: 160 })) });
      const b = await readGenBaseline(f.conn, RK, SK, 1000);
      check("BL1. ⭐⭐ baseline citește ambele stamps", b.runtime.kind === "value" && b.snapshot.kind === "value" && (b.runtime as { ms: number }).ms === 150 && (b.snapshot as { ms: number }).ms === 160); }
    { const f = makeFakeConn({ runtime: rej, snapshot: () => Promise.resolve(snapshotRaw({ savedAt: 160 })) });
      const b = await readGenBaseline(f.conn, RK, SK, 1000);
      check("BL2. ⭐⭐⭐ baseline cu GET eșuat → unavailable (fail-closed în aval)", b.runtime.kind === "unavailable"); }
  }

  // ── 6c. makeGenerationBarrier (bariera COMPLETĂ prin poll, identitate pe AMBELE, decisive cgpt) ──
  {
    const baseline: GenPair = { runtime: val(100), snapshot: val(100) };
    const mk = (rt: () => Promise<string | null>, sn: () => Promise<string | null>, runId = "wrkGOOD") => {
      const f = makeFakeConn({ runtime: rt, snapshot: sn });
      return { run: makeGenerationBarrier({ expectedRunId: runId, baseline, conn: f.conn, runtimeKey: RK, snapshotKey: SK, commandTimeoutMs: 40 }), f };
    };
    const live = new AbortController().signal;
    { const { run } = mk(() => Promise.resolve(runtimeRaw({ updatedAt: 200, canaryRunId: "wrkGOOD" })), () => Promise.resolve(snapshotRaw({ savedAt: 200, canaryRunId: "wrkGOOD" })));
      check("GB1. ⭐⭐⭐ ambii markeri corecți + ambele avansate → verde", (await run(live)).ok); }
    { const { run } = mk(() => Promise.resolve(runtimeRaw({ updatedAt: 999, canaryRunId: "wrkGOOD" })), () => Promise.resolve(snapshotRaw({ savedAt: 999 }))); // snapshot fără marker
      check("GB2. ⭐⭐⭐ DECISIV: runtime=curent, snapshot fără marker + avansate → roșu (worker vechi a avansat savedAt)", !(await run(live)).ok); }
    { const { run } = mk(() => Promise.resolve(runtimeRaw({ updatedAt: 999, canaryRunId: "wrkGOOD" })), () => Promise.resolve(snapshotRaw({ savedAt: 999, canaryRunId: "wrkOTHER" })));
      check("GB3. ⭐⭐⭐ DECISIV: runtime=curent, snapshot=alt id → roșu", !(await run(live)).ok); }
    { const { run } = mk(() => Promise.resolve(runtimeRaw({ updatedAt: 999 })), () => Promise.resolve(snapshotRaw({ savedAt: 999, canaryRunId: "wrkGOOD" }))); // runtime fără marker
      check("GB3b. ⭐⭐⭐ runtime fără marker (writer străin) chiar cu snapshot corect → roșu", !(await run(live)).ok); }
    { const { run } = mk(() => Promise.resolve(runtimeRaw({ updatedAt: 100, canaryRunId: "wrkGOOD" })), () => Promise.resolve(snapshotRaw({ savedAt: 200, canaryRunId: "wrkGOOD" })));
      check("GB4. ⭐⭐ ambii id corecți dar runtime neavansat → roșu (avansare)", !(await run(live)).ok); }
    { const { run, f } = mk(hang, hang, "wrkGOOD"); const ac = new AbortController(); const p = run(ac.signal); setTimeout(() => ac.abort(), 10);
      const r = await p;
      check("GB5. ⭐⭐⭐ DECISIV: GET atârnă + abort Gate2 → roșu ȘI conexiune închisă (op terminat)", !r.ok && f.dc() === true); }
    { const { run, f } = mk(() => Promise.resolve(runtimeRaw({ canaryRunId: "wrkGOOD" })), () => Promise.resolve(snapshotRaw({ canaryRunId: "wrkGOOD" })), "wrkGOOD"); const ac = new AbortController(); ac.abort();
      const r = await run(ac.signal);
      check("GB6. ⭐⭐ fereastră deja abortată → roșu + disconnect", !r.ok && f.dc() === true); }
    { const { run } = mk(hang, () => Promise.resolve(snapshotRaw({ savedAt: 200, canaryRunId: "wrkGOOD" })), "wrkGOOD");
      check("GB7. ⭐⭐⭐ runtime atârnat (fără abort) → roșu la deadline (fail-closed, nu verde tăcut)", !(await run(live)).ok); }
  }

  console.log(`\n${passed}/${passed + failed} OK` + (failed ? `  —  ${failed} FAIL` : ""));
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
