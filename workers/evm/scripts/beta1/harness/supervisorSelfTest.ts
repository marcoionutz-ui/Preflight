/**
 * scripts/beta1/harness/supervisorSelfTest.ts — BETA-1, felia 2: controalele supraveghetorului.
 *
 * Rulează supraveghetorul REAL peste procese de caz FALSE (`fixtures/fakeCase.ts`), câte unul pentru fiecare ramură
 * a verdictului, plus tabele pentru părțile pure (validare, agregare, mediu). NU importă nimic din `src/` și NU
 * exercită codul workerului: un rezultat verde aici spune doar că supraveghetorul decide corect.
 *
 * Cod de ieșire: 0 = toate controalele au trecut; 3 = altfel. Fără `process.exit`: procesul trebuie să se termine
 * singur, ceea ce cere ca niciun proces de caz oprit forțat să nu fi rămas în viață.
 */

import path from "node:path";
import {
  validateCaseOutput, summarize, specProblem, serializeCaseResult, CASE_RESULT_SCHEMA, EXIT,
  type CaseSpec, type CaseVerdict, type CaseResult, type CaseKind, type CaseSection, type Outcome,
} from "./caseProtocol";
import {
  runCaseProcess as runCaseProcessRaw, runSuite, verdictFor, buildCaseEnv, pidAlive, groupAlive, scanProcGroup,
  groupAliveFrom, INHERITED_ENV_KEYS, type ProcReader,
  type RunnableCase, type SupervisorOptions, type ProcessOutcome,
} from "./supervisor";

const FAKE = path.join(__dirname, "fixtures", "fakeCase.ts");

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failures.push(name); console.log("  ❌ " + name); }
}

const OPTS: SupervisorOptions = { deadlineMs: 20_000, fixedEnv: { PREFLIGHT_MODE: "LIVE" }, killGraceMs: 3_000 };

const fake = (id: string, kind: CaseKind, section: CaseSection, mode: string, deadlineMs?: number): RunnableCase => ({
  id, kind, section, file: FAKE, args: [`--kind=${kind}`, `--section=${section}`, `--mode=${mode}`], deadlineMs,
});

/** `true` dacă procesul cu acest pid SAU ceva din grupul lui mai e VIU (zombii nu se numără). */
function alive(pid: number | null): boolean {
  return pid !== null && (pidAlive(pid) || groupAlive(pid));
}

/** Toate pid-urile proceselor de caz pornite de acest self-test — verificate EXPLICIT la final. */
const spawnedPids: number[] = [];
const notePid = (pid: number | null | undefined): void => { if (typeof pid === "number") spawnedPids.push(pid); };
async function runCaseProcess(c: RunnableCase, o: SupervisorOptions): Promise<ProcessOutcome> {
  const p = await runCaseProcessRaw(c, o);
  notePid(p.pid);
  return p;
}
const sleep = (ms: number): Promise<void> => new Promise(res => { setTimeout(res, ms); });
async function waitGone(pid: number, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (!alive(pid)) return true; await sleep(25); }
  return !alive(pid);
}

async function main(): Promise<void> {
  // ── A. Protocol (pur) ────────────────────────────────────────────────────────────────────────────────────
  console.log("A. protocolul de caz (pur)");
  const spec: CaseSpec = { id: "C-V3", kind: "control", section: "filter" };
  const good: CaseResult = { schema: CASE_RESULT_SCHEMA, caseId: "C-V3", kind: "control", section: "filter", outcome: "CONTROL_OK", reasons: [], observations: { sent: 1 } };
  const line = (o: unknown): string => JSON.stringify(o) + "\n";
  const bad = (stdout: string, s: CaseSpec = spec): boolean => validateCaseOutput(stdout, s).ok === false;

  check("A1. rezultat valid acceptat", (() => { const v = validateCaseOutput(serializeCaseResult(good), spec); return v.ok && v.result.outcome === "CONTROL_OK"; })());
  check("A2. stdout gol respins", bad(""));
  check("A3. două linii respinse", bad(serializeCaseResult(good) + serializeCaseResult(good)));
  check("A4. zgomot + rezultat respins", bad("zgomot\n" + serializeCaseResult(good)));
  check("A5. ne-JSON respins", bad("{nu\n"));
  check("A6. JSON care nu e obiect respins", bad("[1]\n") && bad("null\n") && bad('"x"\n'));
  check("A7. alt caz respins", bad(line({ ...good, caseId: "C-V2" })));
  check("A8. fel diferit de manifest respins", bad(line({ ...good, kind: "defect", outcome: "DEFECT_REPRODUCED" })));
  check("A9. secțiune diferită de manifest respinsă", bad(line({ ...good, section: "forced" })));
  check("A10. rezultat în afara enumului respins", bad(line({ ...good, outcome: "PROBABLY_FINE" })) && bad(line({ ...good, outcome: 0 })));
  check("A11. un control nu poate raporta DEFECT_REPRODUCED", bad(line({ ...good, outcome: "DEFECT_REPRODUCED" })));
  check("A12. un caz de defect nu poate raporta CONTROL_OK", bad(line({ ...good, kind: "defect", outcome: "CONTROL_OK" }), { id: "C-V3", kind: "defect", section: "filter" }));
  check("A13. un caz parțial nu poate raporta DEFECT_REPRODUCED", bad(line({ ...good, kind: "partial", section: "partial", outcome: "DEFECT_REPRODUCED" }), { id: "C-V3", kind: "partial", section: "partial" }));
  check("A14. câmp necunoscut respins", bad(line({ ...good, verdict: "ok" })));
  check("A15. câmp lipsă respins", bad(line({ schema: good.schema, caseId: good.caseId, kind: good.kind, section: good.section, outcome: good.outcome, reasons: [] })));
  check("A16. schemă greșită respinsă", bad(line({ ...good, schema: "beta1-case/0" })));
  check("A17. reasons care nu e listă de stringuri respins", bad(line({ ...good, reasons: "x" })) && bad(line({ ...good, reasons: [1] })));
  check("A18. observations care nu e obiect respins", bad(line({ ...good, observations: [] })) && bad(line({ ...good, observations: null })));
  check("A19. rezultat neconfirmator fără motiv respins", bad(line({ ...good, outcome: "CONTROL_FAILED", reasons: [] })) && bad(line({ ...good, outcome: "HARNESS_ERROR", reasons: [] })));
  check("A20. rezultat neconfirmator cu motiv acceptat", validateCaseOutput(line({ ...good, outcome: "CONTROL_FAILED", reasons: ["nimic înregistrat"] }), spec).ok);
  check("A21. specificații incoerente detectate",
    specProblem({ id: "X1", kind: "partial", section: "filter" }) !== null &&
    specProblem({ id: "M1", kind: "defect", section: "partial" }) !== null &&
    specProblem({ id: "C1", kind: "control", section: "forced" }) !== null &&
    specProblem({ id: "rău id", kind: "control", section: "filter" }) !== null &&
    specProblem({ id: "", kind: "control", section: "filter" }) !== null);
  check("A22. specificații coerente acceptate",
    specProblem({ id: "C-V3", kind: "control", section: "filter" }) === null &&
    specProblem({ id: "M1-fortat", kind: "defect", section: "forced" }) === null &&
    specProblem({ id: "X1", kind: "partial", section: "partial" }) === null);

  // ── B. Agregare (pur) ────────────────────────────────────────────────────────────────────────────────────
  console.log("B. agregarea și codul de ieșire (pur)");
  const v = (id: string, kind: CaseKind, section: CaseSection, outcome: Outcome | null, ran = true): CaseVerdict =>
    ({ spec: { id, kind, section }, ran, outcome, reasons: [], observations: {}, diagnostics: null });
  const ctl = v("C", "control", "filter", "CONTROL_OK");
  check("B1. controale OK + defecte reproduse + parțial observat → 0",
    summarize([ctl, v("M1", "defect", "filter", "DEFECT_REPRODUCED"), v("F", "defect", "forced", "DEFECT_REPRODUCED"), v("X1", "partial", "partial", "PARTIAL_OBSERVED")]).exitCode === EXIT.confirmed);
  check("B2. o predicție nereprodusă → 2", summarize([ctl, v("M1", "defect", "filter", "DEFECT_NOT_REPRODUCED")]).exitCode === EXIT.contradicted);
  check("B3. o observație parțială neobservată → 2", summarize([ctl, v("X1", "partial", "partial", "PARTIAL_NOT_OBSERVED")]).exitCode === EXIT.contradicted);
  check("B4. un control eșuat → 3", summarize([v("C", "control", "filter", "CONTROL_FAILED"), v("M1", "defect", "filter", "DEFECT_REPRODUCED")]).exitCode === EXIT.invalid);
  check("B5. un HARNESS_ERROR → 3, chiar cu restul confirmat", summarize([ctl, v("M1", "defect", "filter", "HARNESS_ERROR")]).exitCode === EXIT.invalid);
  check("B6. HARNESS_ERROR are prioritate față de predicția nereprodusă (3, nu 2)", summarize([ctl, v("M1", "defect", "filter", "DEFECT_NOT_REPRODUCED"), v("M2", "defect", "filter", "HARNESS_ERROR")]).exitCode === EXIT.invalid);
  check("B7. niciun caz → 3", summarize([]).exitCode === EXIT.invalid);
  check("B8. fără niciun control pozitiv → 3", summarize([v("M1", "defect", "filter", "DEFECT_REPRODUCED")]).exitCode === EXIT.invalid);
  check("B9. un caz nerulat → 3", summarize([ctl, v("M1", "defect", "filter", null, false)]).exitCode === EXIT.invalid);
  check("B10. numărătoarea ține secțiunile separate", (() => {
    const s = summarize([ctl, v("M1", "defect", "filter", "DEFECT_REPRODUCED"), v("F", "defect", "forced", "DEFECT_REPRODUCED"), v("X1", "partial", "partial", "PARTIAL_OBSERVED")]);
    return s.counts.filter.CONTROL_OK === 1 && s.counts.filter.DEFECT_REPRODUCED === 1 && s.counts.forced.DEFECT_REPRODUCED === 1
      && s.counts.partial.PARTIAL_OBSERVED === 1 && s.counts.partial.DEFECT_REPRODUCED === undefined;
  })());

  // ── C. Mediul de caz (pur) ───────────────────────────────────────────────────────────────────────────────
  console.log("C. mediul de caz");
  {
    const parent = { PATH: "/bin", HOME: "/h", REDIS_URL: "redis://x", ALCHEMY_BASE_WS: "wss://x", RAILWAY_TOKEN: "t", TELEGRAM_BOT_TOKEN: "t", NODE_OPTIONS: "--inspect" };
    const env = buildCaseEnv(parent, "C-V3", { PREFLIGHT_MODE: "LIVE" });
    check("C1. mediul conține doar cheile moștenite permise + cele fixe + id-ul cazului",
      JSON.stringify(Object.keys(env).sort()) === JSON.stringify(["BETA1_CASE_ID", "HOME", "PATH", "PREFLIGHT_MODE"]));
    check("C2. nimic de worker, de secrete sau NODE_OPTIONS nu trece", !("REDIS_URL" in env) && !("ALCHEMY_BASE_WS" in env) && !("RAILWAY_TOKEN" in env) && !("NODE_OPTIONS" in env));
  }

  // ── D. Verdict din rezultatul procesului (pur) ───────────────────────────────────────────────────────────
  console.log("D. verdictul din rezultatul procesului (pur)");
  const po = (over: Partial<ProcessOutcome>): ProcessOutcome => ({
    spawned: true, pid: 1, code: 0, signal: null, timedOut: false, unreaped: false, overflow: false, leftover: false, ms: 1,
    stdout: serializeCaseResult(good), stderrTail: "", ...over,
  });
  const isHarness = (p: ProcessOutcome): boolean => verdictFor(spec, p).outcome === "HARNESS_ERROR";
  check("D1. proces curat cu rezultat valid → rezultatul cazului", verdictFor(spec, po({})).outcome === "CONTROL_OK");
  check("D2. termen depășit → HARNESS_ERROR, chiar cu rezultat valid pe stdout", isHarness(po({ timedOut: true, code: null, signal: "SIGKILL" })));
  check("D3. semnal → HARNESS_ERROR, cu motivul de semnal (nu doar prin codul nul)",
    isHarness(po({ code: null, signal: "SIGTERM" })) && verdictFor(spec, po({ code: null, signal: "SIGTERM" })).reasons[0].includes("semnal SIGTERM"));
  check("D3b. semnal cu cod 0 raportat → tot HARNESS_ERROR", isHarness(po({ code: 0, signal: "SIGTERM" })));
  check("D4. cod ≠ 0 → HARNESS_ERROR, chiar cu rezultat valid", isHarness(po({ code: 1 })) && isHarness(po({ code: 3 })));
  check("D5. nepornit → HARNESS_ERROR", isHarness(po({ spawned: false, code: null })));
  check("D6. stdout peste plafon → HARNESS_ERROR", isHarness(po({ overflow: true })));
  check("D7. terminare neconfirmată → HARNESS_ERROR, cu diagnosticul terminationConfirmed=false",
    isHarness(po({ unreaped: true })) && verdictFor(spec, po({ unreaped: true })).diagnostics?.terminationConfirmed === false);
  check("D8. procese rămase în grupul cazului → HARNESS_ERROR, chiar cu rezultat valid și cod 0",
    isHarness(po({ leftover: true })) && verdictFor(spec, po({ leftover: true })).reasons[0].includes("grupul cazului"));
  check("D9. un rezultat valid își păstrează observațiile și diagnosticul în verdict", (() => {
    const vv = verdictFor(spec, po({}));
    return JSON.stringify(vv.observations) === JSON.stringify({ sent: 1 }) && vv.diagnostics?.terminationConfirmed === true && vv.diagnostics.code === 0;
  })());
  check("D11. un HARNESS_ERROR raportat de CAZ (rezultat valid) nu poartă nici el observații", (() => {
    const vv = verdictFor(spec, po({ stdout: serializeCaseResult({ ...good, outcome: "HARNESS_ERROR", reasons: ["barieră"], observations: { sent: 9 } }) }));
    return vv.outcome === "HARNESS_ERROR" && vv.reasons[0] === "barieră" && JSON.stringify(vv.observations) === "{}";
  })());
  check("D10. un HARNESS_ERROR nu poartă observații (rezultatul nu e de încredere), dar poartă diagnosticul",
    JSON.stringify(verdictFor(spec, po({ code: 1 })).observations) === "{}" && verdictFor(spec, po({ code: 1 })).diagnostics?.code === 1);

  // ── D′. Scanarea grupului de procese (pur, cu `/proc` fals) ───────────────────────────────────────────────
  console.log("D'. scanarea grupului de procese (pur)");
  {
    const SELF = 100, G = 500;
    const err = (code: string): Error => Object.assign(new Error(code), { code });
    const st = (pid: number, comm: string, state: string, pgrp: number): string => `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0 -1 4194304`;
    const reader = (table: Record<string, string | Error>, listErr?: Error): ProcReader => ({
      list: () => { if (listErr) throw listErr; return ["self", "cpuinfo", ...Object.keys(table)]; },
      stat: (pid) => { const v = table[pid]; if (v instanceof Error) throw v; return v; },
    });
    const base = { [String(SELF)]: st(SELF, "node", "R", 100) };
    const scan = (t: Record<string, string | Error>, le?: Error) => scanProcGroup(G, reader({ ...base, ...t }, le), SELF);

    check("P1. membru viu al grupului găsit", (() => { const s = scan({ "501": st(501, "node", "S", G) }); return s.complete && s.live.length === 1 && s.live[0] === 501; })());
    check("P2. zombie și proces mort din grup NU sunt vii", (() => { const s = scan({ "501": st(501, "esbuild", "Z", G), "502": st(502, "x", "X", G) }); return s.complete && s.live.length === 0; })());
    check("P3. procese din alt grup ignorate", (() => { const s = scan({ "501": st(501, "node", "R", 777) }); return s.complete && s.live.length === 0; })());
    check("P4. `comm` cu spații și paranteze e descifrat corect", (() => { const s = scan({ "501": st(501, "a) R 1 9 (b c", "S", G) }); return s.complete && s.live[0] === 501; })());
    check("P5. intrare dispărută între listare și citire (ENOENT/ESRCH) → scanare tot completă", (() => { const s = scan({ "501": err("ENOENT"), "502": err("ESRCH") }); return s.complete && s.live.length === 0; })());
    check("P6. intrare NECITIBILĂ (EACCES) → scanare incompletă", scan({ "501": err("EACCES") }).complete === false);
    check("P7. intrare necitibilă (EPERM / EIO / fără cod) → scanare incompletă", !scan({ "501": err("EPERM") }).complete && !scan({ "501": err("EIO") }).complete && !scan({ "501": new Error("x") }).complete);
    check("P8. stat nedescifrabil → scanare incompletă", !scan({ "501": "501 (node" }).complete && !scan({ "501": "501 (node) S 1" }).complete && !scan({ "501": "501 (node) ?? 1 500" }).complete && !scan({ "501": "501 (node) S 1 abc" }).complete && !scan({ "501": "" }).complete);
    check("P9. `/proc` nelistabil → scanare incompletă", scan({}, err("ENOENT")).complete === false);
    check("P10. propriul proces nevăzut → scanare incompletă (`/proc` nu descrie procesele)", scanProcGroup(G, reader({ "501": st(501, "node", "S", 9) }), SELF).complete === false);
    check("P11. membru viu găsit într-o scanare incompletă rămâne raportat", (() => { const s = scan({ "501": st(501, "node", "S", G), "502": err("EACCES") }); return !s.complete && s.live.length === 1; })());

    let probes = 0;
    const probe = (v: boolean) => () => { probes++; return v; };
    check("P12. scanare completă, fără membri vii → grupul NU are procese vii, fără probă", groupAliveFrom({ complete: true, live: [] }, probe(true)) === false && probes === 0);
    check("P13. membri vii găsiți → are procese vii, indiferent de completitudine", groupAliveFrom({ complete: true, live: [5] }, probe(false)) && groupAliveFrom({ complete: false, live: [5] }, probe(false)) && probes === 0);
    check("P14. scanare INCOMPLETĂ fără membri vii → decide proba cu semnal (da)", groupAliveFrom({ complete: false, live: [] }, probe(true)) === true && probes === 1);
    check("P15. scanare incompletă fără membri vii → decide proba cu semnal (nu)", groupAliveFrom({ complete: false, live: [] }, probe(false)) === false && probes === 2);
    check("P16. pe acest sistem, scanarea reală a `/proc` e completă", (() => { const s = scanProcGroup(-1); return s.complete; })());
  }

  // ── E. Procese reale (cazuri false) ──────────────────────────────────────────────────────────────────────
  console.log("E. supraveghetorul peste procese de caz false");
  const one = async (mode: string, kind: CaseKind = "control", section: CaseSection = "filter", deadlineMs?: number): Promise<{ p: ProcessOutcome; v: CaseVerdict }> => {
    const c = fake("K-1", kind, section, mode, deadlineMs);
    const p = await runCaseProcess(c, OPTS);
    return { p, v: verdictFor({ id: c.id, kind, section }, p) };
  };

  { const { p, v: r } = await one("confirm"); check("E1. caz care confirmă → CONTROL_OK, terminare naturală", r.outcome === "CONTROL_OK" && p.code === 0 && p.signal === null && !p.timedOut); }
  { const { v: r } = await one("deny"); check("E2. control care infirmă → CONTROL_FAILED (rezultatul cazului, nu eroare)", r.outcome === "CONTROL_FAILED"); }
  { const { v: r } = await one("deny", "defect"); check("E3. defect nereprodus → DEFECT_NOT_REPRODUCED", r.outcome === "DEFECT_NOT_REPRODUCED"); }
  { const { v: r } = await one("confirm", "partial", "partial"); check("E4. observație parțială → PARTIAL_OBSERVED", r.outcome === "PARTIAL_OBSERVED"); }
  {
    const { p, v: r } = await one("harness-error");
    check("E5. HARNESS_ERROR raportat de caz e păstrat, cu motivul lui", r.outcome === "HARNESS_ERROR" && r.reasons[0].includes("barieră expirată"));
    check("E5b. cazul a trimis observații, dar verdictul NU le păstrează (HARNESS_ERROR, oricine l-a decis)",
      p.stdout.includes("swapsRecorded") && JSON.stringify(r.observations) === "{}");
  }

  for (const [n, mode] of [
    ["E6", "no-output"], ["E7", "two-lines"], ["E8", "noise-then-json"], ["E9", "invalid-json"], ["E10", "not-object"],
    ["E11", "wrong-case"], ["E12", "wrong-kind"], ["E13", "wrong-section"], ["E14", "cross-outcome"],
    ["E15", "unknown-outcome"], ["E16", "extra-field"], ["E17", "missing-field"], ["E18", "wrong-schema"],
    ["E19", "deny-no-reason"], ["E20", "exit-nonzero"], ["E21", "exit-3-valid"], ["E22", "self-signal"], ["E23", "throw"],
  ] as const) {
    const { p, v: r } = await one(mode);
    check(`${n}. ${mode} → HARNESS_ERROR, fără oprire forțată`, r.outcome === "HARNESS_ERROR" && !p.timedOut);
  }

  {
    const { p, v: r } = await one("hang", "control", "filter", 2_500);
    check("E24. caz agățat DUPĂ ce a scris un rezultat valid → HARNESS_ERROR (termen depășit)", r.outcome === "HARNESS_ERROR" && p.timedOut && r.reasons.some(x => x.includes("termen depășit")));
    check("E25. procesul agățat a fost oprit, și e CONFIRMAT că nu mai are procese vii (pid și grup)", !alive(p.pid) && !p.unreaped && r.diagnostics?.terminationConfirmed === true);
  }
  {
    const { p, v: r } = await one("hang-silent", "control", "filter", 2_500);
    check("E26. caz agățat fără rezultat → HARNESS_ERROR, proces oprit", r.outcome === "HARNESS_ERROR" && p.timedOut && !alive(p.pid));
  }
  {
    const { p, v: r } = await one("hang-ignore-term", "control", "filter", 2_500);
    check("E27. caz care ignoră SIGTERM/SIGINT e totuși oprit (SIGKILL)", r.outcome === "HARNESS_ERROR" && p.timedOut && p.signal === "SIGKILL" && !alive(p.pid));
  }
  {
    const p = await runCaseProcess(fake("K-1", "control", "filter", "flood"), { ...OPTS, maxStdoutBytes: 200_000 });
    const r = verdictFor({ id: "K-1", kind: "control", section: "filter" }, p);
    check("E28. stdout peste plafon → HARNESS_ERROR, proces oprit înainte de termen", r.outcome === "HARNESS_ERROR" && p.overflow && !p.timedOut && !alive(p.pid));
  }
  {
    const p = await runCaseProcess({ id: "K-1", kind: "control", section: "filter", file: path.join(__dirname, "fixtures", "nu-exista.ts") }, OPTS);
    check("E29. fișier de caz inexistent → HARNESS_ERROR", verdictFor({ id: "K-1", kind: "control", section: "filter" }, p).outcome === "HARNESS_ERROR");
  }
  {
    // Cazul iese normal, cu rezultat valid, dar lasă un proces în grupul lui.
    const { p, v: r } = await one("orphan");
    const m = /ORPHAN_PID=(\d+)/.exec(p.stderrTail);
    const orphan = m ? Number(m[1]) : null;
    check("E33. proces rămas în grupul cazului → HARNESS_ERROR, deși cazul a ieșit cu 0 și rezultat valid", r.outcome === "HARNESS_ERROR" && p.leftover && p.code === 0 && !p.timedOut);
    check("E34. procesul rămas a fost oprit și e confirmat că nu mai e viu", orphan !== null && !pidAlive(orphan) && !alive(p.pid) && !p.unreaped);
    notePid(orphan);
  }
  {
    // Copil care se închide singur în răgazul permis: NU e proces rămas, dar faptul că nu mai e viu tot se confirmă.
    const { p, v: r } = await one("short-child");
    const m = /SHORT_PID=(\d+)/.exec(p.stderrTail);
    const short = m ? Number(m[1]) : null;
    check("E34b. copil care se închide singur în răgaz → cazul rămâne CONTROL_OK, fără oprire forțată", r.outcome === "CONTROL_OK" && !p.leftover && !p.unreaped);
    check("E34c. supraveghetorul s-a întors abia când acel copil nu mai era viu", short !== null && !pidAlive(short) && !alive(p.pid));
    notePid(short);
  }
  {
    // Același copil, cu răgaz zero: e socotit proces rămas (răgazul e singurul lucru care îl iartă).
    const p = await runCaseProcess(fake("K-1", "control", "filter", "short-child"), { ...OPTS, groupSettleMs: 0 });
    const r = verdictFor({ id: "K-1", kind: "control", section: "filter" }, p);
    check("E34d. cu răgaz zero, același copil e proces rămas → HARNESS_ERROR", r.outcome === "HARNESS_ERROR" && p.leftover && !alive(p.pid));
  }
  {
    // Oprire forțată INERTĂ (cusătura de test): terminarea nu poate fi confirmată.
    const c = fake("K-1", "control", "filter", "hang-silent", 1_500);
    const p = await runCaseProcess(c, { ...OPTS, killGraceMs: 1_000, killImpl: () => { /* inert */ } });
    const r = verdictFor({ id: "K-1", kind: "control", section: "filter" }, p);
    check("E35. terminare neconfirmată → unreaped, HARNESS_ERROR cu motivul corespunzător", p.unreaped && r.outcome === "HARNESS_ERROR" && r.reasons[0].includes("NU s-a putut confirma"));
    check("E36. procesul CHIAR mai există (supraveghetorul s-a întors fără să-l fi oprit)", p.pid !== null && pidAlive(p.pid));
    if (p.pid !== null) { try { process.kill(-p.pid, "SIGKILL"); } catch { /* deja dispărut */ } }
    check("E37. după oprirea reală, e confirmat că nu mai e viu", p.pid !== null && await waitGone(p.pid, 3_000));
  }
  {
    const p = await runCaseProcess(fake("K-1", "control", "filter", "observe"), OPTS);
    const r = verdictFor({ id: "K-1", kind: "control", section: "filter" }, p);
    check("E38. observațiile validate ale cazului ajung neschimbate în verdict",
      JSON.stringify(r.observations) === JSON.stringify({ requestedFilter: { topics: [["0xaa"]] }, logsSent: 2, logsReceived: 2, swapsRecorded: 1 }));
  }
  {
    // Mediul REAL al procesului de caz: canari puși în mediul părintelui nu au voie să ajungă în copil.
    const CANARIES = ["REDIS_URL", "ALCHEMY_BASE_WS", "ALCHEMY_BASE_RPC", "RAILWAY_TOKEN", "TELEGRAM_BOT_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "GOPLUS_API_KEY", "NODE_OPTIONS_BETA1_CANAR"];
    const saved: Record<string, string | undefined> = {};
    for (const k of CANARIES) { saved[k] = process.env[k]; process.env[k] = "beta1-canar-nu-e-secret"; }
    let keys: string[] = [];
    try {
      const p = await runCaseProcess(fake("K-1", "control", "filter", "env"), OPTS);
      const val = validateCaseOutput(p.stdout, { id: "K-1", kind: "control", section: "filter" });
      if (val.ok && Array.isArray(val.result.observations.envKeys)) keys = val.result.observations.envKeys as string[];
    } finally {
      for (const k of CANARIES) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    const allowed = new Set<string>([...INHERITED_ENV_KEYS, "PREFLIGHT_MODE", "BETA1_CASE_ID"]);
    check("E30. procesul de caz a raportat mediul lui", keys.includes("BETA1_CASE_ID") && keys.includes("PREFLIGHT_MODE"));
    check("E31. niciun canar din mediul părintelui nu a ajuns în copil", keys.length > 0 && CANARIES.every(k => !keys.includes(k)));
    check("E32. mediul copilului conține doar chei permise", keys.length > 0 && keys.every(k => allowed.has(k)));
  }

  // ── F. Rulări complete ───────────────────────────────────────────────────────────────────────────────────
  console.log("F. rulări complete (runSuite)");
  const lines: string[] = [];
  const S: SupervisorOptions = { ...OPTS, log: (l) => { lines.push(l); } };
  {
    const r = await runSuite([
      fake("M1", "defect", "filter", "confirm"), fake("C-V2", "control", "filter", "confirm"), fake("C-V3", "control", "filter", "confirm"),
      fake("M1-fortat", "defect", "forced", "confirm"), fake("X1", "partial", "partial", "confirm"),
    ], S);
    check("F1. totul confirmat → 0", r.summary.exitCode === EXIT.confirmed && r.summary.invalid.length === 0);
    check("F2. raportul păstrează ordinea manifestului", r.verdicts.map(x => x.spec.id).join(",") === "M1,C-V2,C-V3,M1-fortat,X1");
    check("F3. controalele au rulat ÎNAINTEA cazurilor de defect", lines.findIndex(l => l.includes("C-V3")) < lines.findIndex(l => l.includes(" M1 ")));
  }
  {
    const r = await runSuite([fake("C-V3", "control", "filter", "confirm"), fake("M1", "defect", "filter", "deny"), fake("M2", "defect", "filter", "confirm")], S);
    check("F4. o predicție nereprodusă → 2; restul rulează", r.summary.exitCode === EXIT.contradicted && r.verdicts.every(x => x.ran));
  }
  {
    const r = await runSuite([fake("C-V2", "control", "filter", "confirm"), fake("C-V3", "control", "filter", "deny"), fake("M1", "defect", "filter", "confirm"), fake("X1", "partial", "partial", "confirm")], S);
    const m1 = r.verdicts.find(x => x.spec.id === "M1"), x1 = r.verdicts.find(x => x.spec.id === "X1");
    check("F5. un control eșuat → 3", r.summary.exitCode === EXIT.invalid);
    check("F6. cu un control eșuat, cazurile de defect și parțiale NU se rulează", m1?.ran === false && m1.outcome === null && x1?.ran === false);
  }
  {
    const r = await runSuite([fake("C-V3", "control", "filter", "no-output"), fake("M1", "defect", "filter", "confirm")], S);
    check("F7. control cu HARNESS_ERROR → 3 și restul nerulat", r.summary.exitCode === EXIT.invalid && r.verdicts[1].ran === false);
  }
  {
    const r = await runSuite([fake("C-V3", "control", "filter", "confirm"), fake("M1", "defect", "filter", "hang-silent", 2_500), fake("M2", "defect", "filter", "confirm")], S);
    check("F8. termen depășit cu terminare CONFIRMATĂ → 3, dar cazurile următoare rulează", r.summary.exitCode === EXIT.invalid && r.verdicts[1].outcome === "HARNESS_ERROR" && r.verdicts[2].outcome === "DEFECT_REPRODUCED" && r.aborted === null && r.verdicts[1].diagnostics?.terminationConfirmed === true);
    for (const x of r.verdicts) notePid(x.diagnostics?.pid);
  }
  {
    const r = await runSuite([fake("M1", "defect", "filter", "confirm")], S);
    check("F9. manifest fără niciun control → 3, nimic rulat", r.summary.exitCode === EXIT.invalid && r.verdicts[0].ran === false);
  }
  {
    const r = await runSuite([], S);
    check("F10. manifest gol → 3", r.summary.exitCode === EXIT.invalid);
  }
  {
    const r = await runSuite([fake("C-V3", "control", "filter", "confirm"), fake("C-V3", "defect", "filter", "confirm")], S);
    check("F11. id duplicat → 3, toate HARNESS_ERROR, nimic rulat", r.summary.exitCode === EXIT.invalid && r.verdicts.every(x => x.outcome === "HARNESS_ERROR" && x.reasons[0].includes("manifest invalid")));
  }
  {
    const r = await runSuite([fake("C-V3", "control", "filter", "confirm"), fake("X1", "partial", "filter", "confirm")], S);
    check("F12. specificație incoerentă în manifest → 3", r.summary.exitCode === EXIT.invalid && r.verdicts.every(x => x.outcome === "HARNESS_ERROR"));
  }
  {
    // Terminare NECONFIRMATĂ în mijlocul suitei: suita se oprește, nimic nu mai pornește lângă procesul scăpat.
    const r = await runSuite([
      fake("C-V3", "control", "filter", "confirm"), fake("M1", "defect", "filter", "hang-silent", 1_500),
      fake("M2", "defect", "filter", "confirm"), fake("X1", "partial", "partial", "confirm"),
    ], { ...S, killGraceMs: 1_000, killImpl: () => { /* inert */ } });
    const m1 = r.verdicts[1], pid = r.aborted?.pid ?? null;
    check("F13. terminare neconfirmată → suită oprită, cod 3", r.summary.exitCode === EXIT.invalid && r.aborted?.caseId === "M1" && r.summary.invalid.some(x => x.includes("suită oprită")));
    check("F14. cazul vinovat e HARNESS_ERROR cu terminationConfirmed=false", m1.outcome === "HARNESS_ERROR" && m1.diagnostics?.terminationConfirmed === false);
    check("F15. cazurile de după NU au rulat", r.verdicts[2].ran === false && r.verdicts[3].ran === false && r.verdicts[2].reasons[0].includes("suită oprită"));
    check("F16. procesul scăpat chiar mai există când suita se întoarce", pid !== null && pidAlive(pid));
    if (pid !== null) { try { process.kill(-pid, "SIGKILL"); } catch { /* deja dispărut */ } }
    check("F17. după oprirea reală, e confirmat că nu mai e viu", pid !== null && await waitGone(pid, 3_000));
    for (const x of r.verdicts) notePid(x.diagnostics?.pid);
  }
  {
    const r = await runSuite([fake("C-V3", "control", "filter", "observe"), fake("M1", "defect", "filter", "observe")], S);
    check("F18. raportul suitei păstrează observațiile fiecărui caz",
      r.verdicts.every(x => x.observations.logsSent === 2 && x.observations.swapsRecorded === 1) && r.summary.exitCode === EXIT.confirmed);
    for (const x of r.verdicts) notePid(x.diagnostics?.pid);
  }

  // ── G. Niciun proces de caz nu a supraviețuit ─────────────────────────────────────────────────────────────
  // Verificare EXPLICITĂ (semnal 0 pe pid și pe grup). Ieșirea naturală a acestui self-test NU ar dovedi asta:
  // un copil cu `unref()` lasă părintele să se termine.
  console.log("G. procese rămase");
  const survivors = [...new Set(spawnedPids)].filter(pid => alive(pid));
  check(`G1. niciunul dintre cele ${new Set(spawnedPids).size} procese de caz urmărite nu mai e viu`, spawnedPids.length >= 30 && survivors.length === 0);
  if (survivors.length > 0) {
    console.log("     supraviețuitori (opriți acum): " + survivors.join(", "));
    for (const pid of survivors) { try { process.kill(-pid, "SIGKILL"); } catch { /* deja dispărut */ } try { process.kill(pid, "SIGKILL"); } catch { /* deja dispărut */ } }
  }
}

main()
  .catch((e: unknown) => { failures.push("excepție în supervisorSelfTest: " + (e instanceof Error ? e.message : String(e))); })
  .finally(() => {
    console.log(`\n${passed} trecute, ${failures.length} eșuate`);
    for (const f of failures) console.log("  - " + f);
    console.log(failures.length === 0
      ? "supervisorSelfTest: OK. Validează DOAR supraveghetorul; nu spune nimic despre worker sau despre BETA-1."
      : "supervisorSelfTest: EȘEC");
    process.exitCode = failures.length === 0 ? 0 : 3;
  });
