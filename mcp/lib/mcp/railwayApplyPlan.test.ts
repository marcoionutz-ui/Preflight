/**
 * lib/mcp/railwayApplyPlan.test.ts — PH-12 12.6 leaf 2c-1: teste HERMETICE pt. apply-planner-ul PUR + poarta de confirmare.
 *
 * Planuri GENUINE construite via leaf-1 `planFromRaw` (caps fake + raw-uri de mână) + planuri FABRICATE respinse pe PROVENIENȚĂ.
 * Acoperă: admisibil non-distructiv → program fără confirmare; distructiv → poarta (target + set exact); blocat → not_admissible;
 * noop → program gol; FABRICAT (secret/start+stop/phase/dup/spread/Proxy) → unregistered_plan; confirmare normalizată defensiv;
 * ordine re-derivată; imutabilitate; renderer capability-bound (program fabricat NU se reflectă).
 */

import { planApply, formatApplyProgram, applySummary, isGenuineProgram, type ApplyConfirmation, type ApplyStep, type ApplyProgram } from "./railwayApplyPlan";
import { planFromRaw, SERVICE_IDS } from "./profilePlan";
import type { Caps, ServiceEnvValidator, ServiceId, ProfileName, TransitionPlan, AdmissiblePlan } from "./profilePlan";

let passed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }
function reasonOf(r: ReturnType<typeof planApply>): string { return r.ok ? "<ok>" : r.reason; }

// ── Caps fake (validatoare ok, staging verificat) ────────────────────────────────────────────────────────────────
function okCaps(): Caps {
  const validateService: Partial<Record<ServiceId, ServiceEnvValidator>> = {};
  const envKeys: Partial<Record<ServiceId, readonly string[]>> = {};
  for (const r of SERVICE_IDS) { validateService[r] = () => ({ ok: true, problems: [] }); envKeys[r] = []; }
  return { validateService, envKeys, isStagingSupabase: () => true };
}

// ── Raw-uri (TOATE cele 5 servicii prezente → fără state_unknown) ─────────────────────────────────────────────────
type Raw = Record<string, { running: boolean; env: Record<string, string> }>;
function svcAll(running: boolean): Raw { const o: Raw = {}; for (const s of SERVICE_IDS) o[s] = { running, env: {} }; return o; }
const ALL_RUNNING: Raw = svcAll(true);
const ALL_PARKED: Raw = (() => { const o = svcAll(false); o["redis"] = { running: true, env: {} }; return o; })();

function planOf(raw: Raw, target: ProfileName): TransitionPlan {
  const r = planFromRaw(raw, target, okCaps());
  if (!r.ok) throw new Error(`setup: planFromRaw a eșuat pt. ${target}: ${r.reason}`);
  return r.plan; // GENUIN (înregistrat de profilePlan)
}
const STOPS_PARKED: ServiceId[] = ["mcp", "worker-evm", "indexer-evm", "solana-worker"];

async function main(): Promise<void> {
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// A. GENUIN non-distructiv (parked→auth-canary): set_env×3 + start mcp, fără confirmare
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const plan = planOf(ALL_PARKED, "auth-canary");
  assert(plan.admissible === true, "A0: setup auth-canary admisibil");
  const r = planApply(plan);
  assert(r.ok === true, `A1: apply-plan ok fără confirmare (non-distructiv) — ${reasonOf(r)}`);
  if (r.ok) {
    const p = r.program;
    assert(p.target === "auth-canary", "A2: target propagat");
    assert(p.requiresConfirmation === false && p.stops.length === 0, "A3: fără stopuri → fără confirmare");
    assert(p.noop === false, "A4: nu-i noop");
    const s = applySummary(p);
    assert(s.valid === true && s.setEnv === 3 && s.starts === 1 && s.stops === 0 && s.unsetEnv === 0, "A5: summary valid: 3 set_env + 1 start (mcp)");
    const startIdx = p.steps.findIndex((x) => x.kind === "start");
    const lastCfg = Math.max(...p.steps.map((x, i) => (x.kind === "set_env" || x.kind === "unset_env" ? i : -1)));
    assert(startIdx > lastCfg, "A6: start DUPĂ toate set_env (configure→start)");
    assert(p.steps.every((x) => x.service === "mcp"), "A7: toți pașii pe mcp");
    assert(isGenuineProgram(p) === true, "A8: program emis = GENUIN (înregistrat)");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// B. GENUIN DISTRUCTIV (all-running→parked): 4 stopuri → poarta de confirmare
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const plan = planOf(ALL_RUNNING, "parked");
  assert(plan.admissible === true && (plan as AdmissiblePlan).requiresConfirmation === true, "B0: setup parked distructiv");

  assert(reasonOf(planApply(plan)) === "confirmation_required", "B1: fără confirmare → confirmation_required");
  assert(reasonOf(planApply(plan, { target: "base-canary", confirmedStops: STOPS_PARKED })) === "confirmation_mismatch", "B2: target confirmare greșit → mismatch");
  assert(reasonOf(planApply(plan, { target: "parked", confirmedStops: ["mcp", "worker-evm"] })) === "confirmation_mismatch", "B3: set incomplet → mismatch");
  assert(reasonOf(planApply(plan, { target: "parked", confirmedStops: [...STOPS_PARKED, "redis"] })) === "confirmation_mismatch", "B4: set cu extra (redis) → mismatch");

  const r = planApply(plan, { target: "parked", confirmedStops: ["solana-worker", "mcp", "indexer-evm", "worker-evm"] });
  assert(r.ok === true, `B5: set corect (ordine diferită) → ok — ${reasonOf(r)}`);
  if (r.ok) {
    const p = r.program;
    assert(p.requiresConfirmation === true, "B6: requiresConfirmation true");
    assert(p.steps.length === 4 && p.steps.every((x) => x.kind === "stop" && x.destructive === true), "B7: 4 pași stop distructivi");
    assert(JSON.stringify([...p.stops]) === JSON.stringify(["indexer-evm", "mcp", "solana-worker", "worker-evm"]), "B8: p.stops sortat determinist");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// C. GENUIN BLOCAT (launch nefinalizat) → not_admissible
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const plan = planOf(ALL_RUNNING, "launch");
  assert(plan.admissible === false, "C0: launch → BlockedPlan");
  assert(reasonOf(planApply(plan)) === "not_admissible", "C1: plan blocat → not_admissible");
  assert(reasonOf(planApply(plan, { target: "launch", confirmedStops: [] })) === "not_admissible", "C2: confirmare irelevantă pe plan blocat");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// D. GENUIN NOOP (parked→parked) → ok cu program gol
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const plan = planOf(ALL_PARKED, "parked");
  assert(plan.admissible === true && (plan as AdmissiblePlan).noop === true, "D0: parked→parked noop");
  const r = planApply(plan);
  assert(r.ok === true, `D1: noop → ok fără confirmare — ${reasonOf(r)}`);
  if (r.ok) {
    assert(r.program.noop === true && r.program.steps.length === 0, "D2: program gol, noop");
    assert(r.program.requiresConfirmation === false && r.program.stops.length === 0, "D3: fără confirmare");
    assert(formatApplyProgram(r.program).some((l) => l.includes("nicio mutație")), "D4: render marchează noop");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// E. PROVENIENȚĂ — orice plan FABRICAT e respins cu `unregistered_plan` ÎNAINTE de a privi acțiunile (validarea structurală
//    NU dovedește proveniența). Include atacurile decisive: secret arbitrar, start+stop, phase greșit, duplicat, spread, Proxy.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const before = {} as never; const after = {} as never;
  const mk = (actions: unknown, target = "parked", extra: Record<string, unknown> = {}): TransitionPlan =>
    ({ admissible: true, target, before, after, actions, noop: false, requiresConfirmation: false, ...extra } as unknown as TransitionPlan);

  // non-obiecte / forme
  assert(reasonOf(planApply(null as unknown as TransitionPlan)) === "unregistered_plan", "E1: null → unregistered_plan");
  assert(reasonOf(planApply({ admissible: "yes" } as unknown as TransitionPlan)) === "unregistered_plan", "E2: obiect inventat → unregistered_plan");

  // DECISIV — set_env cu SECRET arbitrar: fabricatul e respins → secretul NU ajunge într-un program
  const secret = mk([{ service: "mcp", kind: "set_env", phase: "configure", key: "RAILWAY_TOKEN", value: "SECRET-LEAK-abc123", destructive: false, causesRestart: false }]);
  const rSecret = planApply(secret);
  assert(reasonOf(rSecret) === "unregistered_plan", "E3: plan fabricat cu set_env(secret) → unregistered_plan");
  assert(!rSecret.ok, "E3b: fabricatul NU produce program (secretul nu se propagă)");

  // DECISIV — start+stop pe același serviciu (contradictoriu)
  assert(reasonOf(planApply(mk([
    { service: "mcp", kind: "start", phase: "start", destructive: false, causesRestart: true },
    { service: "mcp", kind: "stop", phase: "stop", destructive: true, causesRestart: true },
  ]))) === "unregistered_plan", "E4: fabricat start+stop pe mcp → unregistered_plan");

  // DECISIV — phase greșit (set_env marcat phase 'start')
  assert(reasonOf(planApply(mk([{ service: "mcp", kind: "set_env", phase: "start", key: "K", value: "v", destructive: false, causesRestart: false }]))) === "unregistered_plan", "E5: fabricat phase greșit → unregistered_plan");

  // DECISIV — acțiuni duplicate
  assert(reasonOf(planApply(mk([
    { service: "mcp", kind: "set_env", phase: "configure", key: "K", value: "v", destructive: false, causesRestart: false },
    { service: "mcp", kind: "set_env", phase: "configure", key: "K", value: "v", destructive: false, causesRestart: false },
  ]))) === "unregistered_plan", "E6: fabricat duplicat → unregistered_plan");

  // DECISIV — target contradictoriu (bogus)
  assert(reasonOf(planApply(mk([], "bogus"))) === "unregistered_plan", "E7: fabricat target necunoscut → unregistered_plan");

  // DECISIV — SPREAD al unui plan GENUIN (relabel/copie) → obiect NOU, absent din registru
  const genuine = planOf(ALL_PARKED, "auth-canary");
  const spread = { ...(genuine as object) } as unknown as TransitionPlan;
  assert(reasonOf(planApply(spread)) === "unregistered_plan", "E8: spread al unui plan genuin → unregistered_plan (identitate, nu formă)");

  // DECISIV — Proxy ostil ca plan (getteri care aruncă) → unregistered_plan, FĂRĂ throw
  const proxy = new Proxy({}, { get() { throw new Error("boom"); } }) as unknown as TransitionPlan;
  let threw = false;
  let pr = "";
  try { pr = reasonOf(planApply(proxy)); } catch { threw = true; }
  assert(!threw && pr === "unregistered_plan", "E9: Proxy ostil ca plan → unregistered_plan, fără throw");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// F. (INVERSAT) — un plan fabricat, chiar dacă e „bine format" și în ordine arbitrară, TREBUIE respins (nu re-sortat & aplicat)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const before = {} as never; const after = {} as never;
  const unordered = [
    { service: "indexer-evm", kind: "stop", phase: "stop", destructive: true, causesRestart: true },
    { service: "mcp", kind: "start", phase: "start", destructive: false, causesRestart: true },
    { service: "worker-evm", kind: "unset_env", phase: "configure", key: "K", destructive: false, causesRestart: false },
    { service: "redis", kind: "set_env", phase: "configure", key: "K", value: "v", destructive: false, causesRestart: false },
  ];
  const fabricated = { admissible: true, target: "parked", before, after, actions: unordered, noop: false, requiresConfirmation: true } as unknown as TransitionPlan;
  const r = planApply(fabricated, { target: "parked", confirmedStops: ["indexer-evm"] });
  assert(!r.ok && r.reason === "unregistered_plan", "F1: plan fabricat (chiar cu confirmare corectă) → REFUZAT (unregistered_plan)");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// G. render anti-leak + imutabilitate (pe program GENUIN)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const plan = planOf(ALL_RUNNING, "parked");
  const r = planApply(plan, { target: "parked", confirmedStops: STOPS_PARKED });
  assert(r.ok === true, `G0: setup ok — ${reasonOf(r)}`);
  if (r.ok) {
    const out = formatApplyProgram(r.program);
    assert(out[0].startsWith("APPLY (profil țintă: parked)"), "G1: header APPLY");
    assert(out.some((l) => l.includes("DISTRUCTIV")), "G2: marchează stopurile distructive");
    assert(out.some((l) => l.includes("CONFIRMARE necesară")), "G3: linie de confirmare cu setul de stopuri");
    let threw = false;
    try { (r.program.steps as ApplyStep[]).push({ service: "mcp", kind: "start", destructive: false, causesRestart: true }); } catch { threw = true; }
    assert(threw && r.program.steps.length === 4, "G4: program.steps IMUTABIL (push aruncă, lungime neschimbată)");
    assert(Object.isFrozen(r.program) && Object.isFrozen(r.program.steps), "G5: program + steps înghețate");
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// H. confirmare normalizată DEFENSIV (pe plan GENUIN distructiv): membru non-serviciu / ne-array / Proxy care aruncă → mismatch, NU throw
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const plan = planOf(ALL_RUNNING, "parked");
  assert(reasonOf(planApply(plan, { target: "parked", confirmedStops: ["mcp", "worker-evm", "indexer-evm", "ghost"] } as unknown as ApplyConfirmation)) === "confirmation_mismatch", "H1: confirmedStops cu non-serviciu → mismatch");
  assert(reasonOf(planApply(plan, { target: "parked", confirmedStops: "mcp" } as unknown as ApplyConfirmation)) === "confirmation_mismatch", "H2: confirmedStops ne-array → mismatch");

  // Proxy ostil ca CONFIRMARE (getteri care aruncă) → mismatch, fără throw
  const badConf = new Proxy({}, { get() { throw new Error("boom"); } }) as unknown as ApplyConfirmation;
  let threw = false; let res = "";
  try { res = reasonOf(planApply(plan, badConf)); } catch { threw = true; }
  assert(!threw && res === "confirmation_mismatch", "H3: Proxy ostil ca confirmare → mismatch, fără throw");

  // strict-structural: null → required (absent), NU mismatch
  assert(reasonOf(planApply(plan, null as unknown as ApplyConfirmation)) === "confirmation_required", "H4: confirmare null → confirmation_required (absent)");
  // duplicate în confirmedStops (chiar dacă set-ul acoperă) → mismatch EXPLICIT (nu ne bazăm pe lungime)
  assert(reasonOf(planApply(plan, { target: "parked", confirmedStops: ["mcp", "mcp", "worker-evm", "indexer-evm", "solana-worker"] } as unknown as ApplyConfirmation)) === "confirmation_mismatch", "H5: confirmedStops cu duplicate → mismatch");
  // target ne-ProfileName (număr) → mismatch
  assert(reasonOf(planApply(plan, { target: 42, confirmedStops: STOPS_PARKED } as unknown as ApplyConfirmation)) === "confirmation_mismatch", "H6: target ne-ProfileName → mismatch");
  // confirmare obiect-array (Array.isArray) → mismatch (structură ne-conformă)
  assert(reasonOf(planApply(plan, ([] as unknown) as ApplyConfirmation)) === "confirmation_mismatch", "H7: confirmare = array → mismatch");

  // H8 — proprietăți MOȘTENITE (de pe prototip) → mismatch (Object.keys own-enumerable = [] → cheile lipsesc)
  const inherited = Object.create({ target: "parked", confirmedStops: STOPS_PARKED }) as ApplyConfirmation;
  assert(reasonOf(planApply(plan, inherited)) === "confirmation_mismatch", "H8: confirmare cu proprietăți moștenite → mismatch");

  // H9 — GETTER care returnează valori CORECTE → mismatch (accesor, nu own DATA-property)
  const withGetter = {} as Record<string, unknown>;
  Object.defineProperty(withGetter, "target", { enumerable: true, get() { return "parked"; } });
  Object.defineProperty(withGetter, "confirmedStops", { enumerable: true, value: STOPS_PARKED });
  assert(reasonOf(planApply(plan, withGetter as unknown as ApplyConfirmation)) === "confirmation_mismatch", "H9: confirmare cu getter (valori corecte) → mismatch (accesor)");

  // H10 — cheie SUPLIMENTARĂ → mismatch (set exact de chei)
  assert(reasonOf(planApply(plan, { target: "parked", confirmedStops: STOPS_PARKED, extra: 1 } as unknown as ApplyConfirmation)) === "confirmation_mismatch", "H10: confirmare cu cheie suplimentară → mismatch");

  // H11 — DOVADĂ de COPIE: confirmedStops = Proxy-array care NUMĂRĂ citirile per index; validarea corectă citește fiecare index
  //       EXACT o dată (spread → copie), apoi lucrează pe copie. O implementare fără copie ar reciti indexurile de mai multe ori.
  const reads: Record<string, number> = {};
  const base = ["mcp", "worker-evm", "indexer-evm", "solana-worker"];
  const counting = new Proxy(base, { get(t, prop, r) { if (typeof prop === "string" && /^\d+$/.test(prop)) reads[prop] = (reads[prop] ?? 0) + 1; return Reflect.get(t, prop, r); } });
  const rCopy = planApply(plan, { target: "parked", confirmedStops: counting as unknown as ServiceId[] });
  assert(rCopy.ok === true, `H11a: confirmare cu Proxy-array valid → ok — ${reasonOf(rCopy)}`);
  assert(base.every((_, i) => (reads[String(i)] ?? 0) === 1), `H11b: fiecare index citit EXACT o dată (copie înainte de validare) — ${JSON.stringify(reads)}`);

  // H12 — cheie Symbol suplimentară → mismatch (Reflect.ownKeys o prinde; Object.keys ar rata-o)
  const withSym: Record<string | symbol, unknown> = { target: "parked", confirmedStops: STOPS_PARKED };
  withSym[Symbol("x")] = 1;
  assert(reasonOf(planApply(plan, withSym as unknown as ApplyConfirmation)) === "confirmation_mismatch", "H12: cheie Symbol suplimentară → mismatch");

  // H13 — cheie non-enumerable suplimentară → mismatch (Reflect.ownKeys o prinde; Object.keys ar rata-o)
  const withNonEnum: Record<string, unknown> = { target: "parked", confirmedStops: STOPS_PARKED };
  Object.defineProperty(withNonEnum, "hidden", { enumerable: false, value: 1 });
  assert(reasonOf(planApply(plan, withNonEnum as unknown as ApplyConfirmation)) === "confirmation_mismatch", "H13: cheie non-enumerable suplimentară → mismatch");

  // H14 — prototip CUSTOM cu câmpurile corecte OWN → mismatch (cheile trec, dar prototipul nu-i Object.prototype/null)
  const customProto = { foo: 1 };
  const withProto = Object.assign(Object.create(customProto), { target: "parked", confirmedStops: STOPS_PARKED });
  assert(reasonOf(planApply(plan, withProto as unknown as ApplyConfirmation)) === "confirmation_mismatch", "H14: prototip custom cu câmpuri own corecte → mismatch");

  // H15 — Proxy cu `get` care ARUNCĂ, dar descriptori DATA valizi → ok, `get` NEinvocat (citim din descriptor, nu prin acces)
  const backing = { target: "parked", confirmedStops: STOPS_PARKED };
  let getInvoked = false;
  const px = new Proxy(backing, { get() { getInvoked = true; throw new Error("get must not run"); } });
  const rPx = planApply(plan, px as unknown as ApplyConfirmation);
  assert(rPx.ok === true && getInvoked === false, `H15: Proxy cu get care aruncă + descriptori data valizi → ok, get NEinvocat — ${reasonOf(rPx)}, getInvoked=${getInvoked}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// I. renderer + summary CAPABILITY-BOUND: un program FABRICAT nu se reflectă (anti-leak) și nu se numără
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
{
  const fabricated = { target: "parked", steps: [{ service: "mcp", kind: "set_env", key: "K", value: "SECRET-LEAK-render", destructive: false, causesRestart: false }], stops: [], requiresConfirmation: false, noop: false } as unknown as ApplyProgram;
  assert(isGenuineProgram(fabricated) === false, "I0: program fabricat NU e genuin");
  const out = formatApplyProgram(fabricated);
  assert(out.length === 1 && out[0].includes("neînregistrat") && out[0].includes("refuzat"), "I1: renderer refuză programul fabricat (linie statică)");
  assert(!out.join("\n").includes("SECRET-LEAK-render"), "I2: renderer NU reflectă valoarea injectată (anti-leak)");
  const s = applySummary(fabricated);
  assert(s.valid === false && s.noop === false && s.setEnv === 0 && s.starts === 0 && s.stops === 0 && s.unsetEnv === 0, "I3: summary pe program fabricat → valid:false, NU noop (fail-closed, nu benign)");
}

if (fails.length > 0) {
  console.error(`railwayApplyPlan.test: ${fails.length} EȘUAT / ${passed} ok`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`railwayApplyPlan.test: ${passed}/${passed} ok`);
}

main().catch((e) => { console.error("railwayApplyPlan.test: EXCEPȚIE", e); process.exit(1); });
