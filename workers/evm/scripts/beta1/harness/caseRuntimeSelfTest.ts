/**
 * scripts/beta1/harness/caseRuntimeSelfTest.ts — BETA-1, felia 3: controalele PROPRII ale runtime-ului de caz.
 *
 * Rulează `runCase` + corpul controalelor peste un WORKER FALS (`fixtures/fakeWorker.ts`), prin supraveghetorul
 * real, cu câte un defect injectat. Verifică faptul că runtime-ul:
 *   - dă CONTROL_OK pe traseul bun, pentru fiecare tip (V2, V3, V4, quote stabil);
 *   - dă CONTROL_FAILED când swapul nu e înregistrat sau e înregistrat greșit (rezultatul cazului, nu eroare);
 *   - dă HARNESS_ERROR — niciodată CONTROL_FAILED sau „defect reprodus" — când o barieră, o gardă sau o
 *     precondiție nu e îndeplinită.
 *
 * Felia 4 adaugă corpul CAZURILOR DE DEFECT, tot peste workerul fals:
 *   F — fals fidel baseline-ului (are defectele) → DEFECT_REPRODUCED / PARTIAL_OBSERVED;
 *   G — fals „reparat" pentru exact acel defect → DEFECT_NOT_REPRODUCED / PARTIAL_NOT_OBSERVED;
 *   H — barieră, gardă sau montaj neîndeplinite → HARNESS_ERROR, niciodată „reprodus", fără observații;
 *   I — manifestul, definițiile și tabelul de aici sunt coerente (pur);
 *   J — nodul se poartă greșit după verificarea filtrului (martor suprimat, geamăn livrat, livrare forțată
 *       refuzată sau dublată) → HARNESS_ERROR cu motivul EXACT al gărzii testate.
 *
 * TERMINARE NECONFIRMATĂ: dacă supraveghetorul nu poate confirma că un proces de caz și grupul lui nu mai au
 * procese vii, lansatorul OPREȘTE imediat orice lansare următoare, păstrează cazul și PID-ul, iar cleanup-ul
 * mărginit din `finally` oprește procesul rămas și verifică rezultatul. Secțiunea E dovedește acest comportament.
 *
 * NU importă nimic din `src/` și NU exercită workerul real: un rezultat verde aici spune doar că runtime-ul
 * decide corect. Cod de ieșire: 0 = toate controalele au trecut; 3 = altfel.
 */

import path from "node:path";
import { runCaseProcess, verdictFor, pidAlive, groupAlive, type RunnableCase, type SupervisorOptions } from "./supervisor";
import { specProblem, type CaseVerdict, type CaseSpec, type CaseKind, type CaseSection, type Outcome } from "./caseProtocol";
import { CASES } from "../cases/manifest";
import { CONTROLS } from "../cases/controlDefs";
import { DEFECTS } from "../cases/defectDefs";

const FAKE_CASE = path.join(__dirname, "fixtures", "fakeRuntimeCase.ts");
const OPTS: SupervisorOptions = { deadlineMs: 60_000, fixedEnv: { PREFLIGHT_MODE: "LIVE" } };

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failures.push(name); console.log("  ❌ " + name + (detail ? `\n       ${detail}` : "")); }
}

/** Aruncată de lansator: terminarea unui proces de caz nu a putut fi confirmată. Poartă cazul și PID-ul. */
class UnconfirmedTermination extends Error {
  constructor(readonly caseId: string, readonly pid: number | null) {
    super(`terminare neconfirmată pentru cazul ${caseId} (pid ${pid === null ? "necunoscut" : pid}): lansările se opresc`);
    this.name = "UnconfirmedTermination";
  }
}

interface StuckCase { caseId: string; pid: number | null; }
interface CleanupReport { stuck: StuckCase | null; killed: boolean; stillAlive: boolean; ms: number; }

interface Launcher {
  /** Lansează un proces de caz. Refuză (fără să pornească nimic) după o terminare neconfirmată. */
  run(id: string, args: string[], extra?: Partial<SupervisorOptions>, as?: { kind: CaseKind; section: CaseSection }): Promise<CaseVerdict>;
  /** Câte procese a ÎNCERCAT să pornească (apeluri efective la supraveghetor). */
  launches(): number;
  pids(): number[];
  stuck(): StuckCase | null;
  /** Cleanup MĂRGINIT al procesului rămas: SIGKILL pe grup, apoi așteaptă cel mult `boundMs` să nu mai fie viu. */
  cleanup(boundMs?: number): Promise<CleanupReport>;
}

const alive = (pid: number): boolean => pidAlive(pid) || groupAlive(pid);

function makeLauncher(): Launcher {
  const pids: number[] = [];
  let launches = 0;
  let stuck: StuckCase | null = null;
  return {
    async run(id, args, extra = {}, as = { kind: "control", section: "filter" }) {
      if (stuck !== null) throw new UnconfirmedTermination(stuck.caseId, stuck.pid);
      launches++;
      const spec: CaseSpec = { id, kind: as.kind, section: as.section };
      const c: RunnableCase = { ...spec, file: FAKE_CASE, args };
      const p = await runCaseProcess(c, { ...OPTS, ...extra });
      if (p.pid !== null) pids.push(p.pid);
      if (p.unreaped) {
        stuck = { caseId: id, pid: p.pid };
        throw new UnconfirmedTermination(id, p.pid);
      }
      return verdictFor(spec, p);
    },
    launches: () => launches,
    pids: () => [...pids],
    stuck: () => stuck,
    async cleanup(boundMs = 3_000) {
      const t0 = Date.now();
      if (stuck === null || stuck.pid === null) return { stuck, killed: false, stillAlive: false, ms: 0 };
      const pid = stuck.pid;
      let killed = false;
      try { process.kill(-pid, "SIGKILL"); killed = true; } catch { /* grupul nu mai există */ }
      try { process.kill(pid, "SIGKILL"); killed = true; } catch { /* procesul nu mai există */ }
      while (alive(pid) && Date.now() - t0 < boundMs) await new Promise<void>(res => { setTimeout(res, 25); });
      return { stuck, killed, stillAlive: alive(pid), ms: Date.now() - t0 };
    },
  };
}

/** Lansatorul rulării principale (secțiunile A–D). */
const L = makeLauncher();
const run = (id: string, args: string[]): Promise<CaseVerdict> => L.run(id, args);

/** Felul și secțiunea fiecărui caz de defect — repetate aici (ca în manifest), NU citite din definiții. */
const DEFECT_SPECS: Record<string, { kind: CaseKind; section: CaseSection }> = {
  "M1": { kind: "defect", section: "filter" }, "M2": { kind: "defect", section: "filter" },
  "D1": { kind: "defect", section: "filter" }, "T1": { kind: "defect", section: "filter" },
  "T1-LP": { kind: "defect", section: "filter" }, "T2": { kind: "defect", section: "filter" },
  "P1": { kind: "defect", section: "filter" },
  "M1-FORCED": { kind: "defect", section: "forced" }, "T1-FORCED": { kind: "defect", section: "forced" },
  "X1": { kind: "partial", section: "partial" },
};
/** Rulează corpul unui caz de defect peste workerul fals, cu defectul injectat (`none` = fals fidel baseline-ului). */
const runDefect = (id: string, fault: string, tamper = ""): Promise<CaseVerdict> =>
  L.run(id, [`--defect=${id}`, `--fault=${fault}`, ...(tamper ? [`--tamper=${tamper}`] : [])], {}, DEFECT_SPECS[id]);

const why = (v: CaseVerdict): string => `${v.outcome}: ${v.reasons.join(" | ").slice(0, 300)}`;

/** I. Manifestul, definițiile și tabelul de aici spun același lucru (pur: nu pornește niciun proces). */
function manifestConsistency(): void {
  console.log("I. manifestul și definițiile cazurilor sunt coerente");
  const ids = CASES.map(c => c.id);
  check("I1. manifestul nu are id-uri duplicate și nicio specificație incoerentă", new Set(ids).size === ids.length && CASES.every(c => specProblem(c) === null));
  const controls = CASES.filter(c => c.kind === "control");
  check("I2. controalele din manifest sunt exact cele definite (10), toate în «filter», în același fișier",
    controls.length === 10 && JSON.stringify(controls.map(c => c.id).sort()) === JSON.stringify(Object.keys(CONTROLS).sort())
      && controls.every(c => c.section === "filter" && c.file.endsWith("positiveControls.ts")));
  const defects = CASES.filter(c => c.kind !== "control");
  check("I3. cazurile de defect din manifest sunt exact cele definite (10), cu același fel și aceeași secțiune",
    defects.length === 10 && JSON.stringify(defects.map(c => c.id).sort()) === JSON.stringify(Object.keys(DEFECTS).sort())
      && defects.every(c => DEFECTS[c.id]?.kind === c.kind && DEFECTS[c.id]?.section === c.section && c.file.endsWith("defectCases.ts")));
  check("I4. tabelul acestui self-test coincide cu definițiile",
    JSON.stringify(Object.keys(DEFECT_SPECS).sort()) === JSON.stringify(Object.keys(DEFECTS).sort())
      && Object.entries(DEFECT_SPECS).every(([id, sp]) => DEFECTS[id].kind === sp.kind && DEFECTS[id].section === sp.section));
  const by = (section: CaseSection): string[] => defects.filter(c => c.section === section).map(c => c.id);
  check("I5. secțiunile nu se amestecă: 7 prin filtru, 2 forțate, 1 parțial (X1, singurul de fel «partial»)",
    by("filter").length === 7 && JSON.stringify(by("forced")) === '["M1-FORCED","T1-FORCED"]' && JSON.stringify(by("partial")) === '["X1"]'
      && defects.filter(c => c.kind === "partial").length === 1);
  check("I6. fiecare caz de defect numește un control pereche care există în manifest (X1: niciunul)",
    Object.entries(DEFECTS).every(([id, d]) => id === "X1" || controls.some(c => c.id === d.pairedControl)));
}

async function main(): Promise<void> {
  manifestConsistency();
  console.log("A. traseul bun, pe fiecare tip");
  for (const control of ["C-V2-BUY", "C-V2-SELL", "C-V3-BUY", "C-V3-SELL", "C-V4-BUY", "C-V4-SELL", "C-STABLE-BUY", "C-STABLE-SELL", "D1-CONTROL", "P1-CONTROL"]) {
    const v = await run(control, [`--control=${control}`, "--fault=none"]);
    check(`A. ${control} peste workerul fals → CONTROL_OK, terminare confirmată`, v.outcome === "CONTROL_OK" && v.diagnostics?.terminationConfirmed === true && v.observations.swapsRecorded === 1, why(v));
  }

  console.log("B. swap neînregistrat sau înregistrat greșit → CONTROL_FAILED");
  const failed: Array<[string, string, string]> = [
    ["B1", "no-record",      "swapuri înregistrate: 0"],
    ["B2", "flip-direction", "direcție înregistrată"],
    ["B3", "double-record",  "swapuri înregistrate: 2"],
  ];
  for (const [n, fault, expect] of failed) {
    const v = await run("C-V3-BUY", ["--control=C-V3-BUY", `--fault=${fault}`]);
    check(`${n}. ${fault} → CONTROL_FAILED cu motivul așteptat`, v.outcome === "CONTROL_FAILED" && v.reasons.some(r => r.includes(expect)), why(v));
  }

  console.log("C. barieră, gardă sau precondiție neîndeplinită → HARNESS_ERROR (niciodată CONTROL_FAILED)");
  const harness: Array<[string, string, string]> = [
    ["C1", "handler-throws",   "[WS ERR"],
    ["C2", "async-handler",    "activeJobCount()"],
    ["C3", "leaked-interval",  "E4."],
    ["C4", "import-timer",     "timer creat la import"],
    ["C5", "import-fetch",     "fetch la import"],
    ["C6", "other-port",       "E1."],
    ["C7", "never-subscribes", "exact o cerere eth_subscribe"],
    ["C8", "starts-entrypoint", "entrypointul workerului"],
  ];
  for (const [n, fault, expect] of harness) {
    const v = await run("C-V3-BUY", ["--control=C-V3-BUY", `--fault=${fault}`]);
    const expectedOutcome: Outcome = "HARNESS_ERROR";
    check(`${n}. ${fault} → HARNESS_ERROR cu motivul așteptat, fără observații`, v.outcome === expectedOutcome && v.reasons.some(r => r.includes(expect)) && Object.keys(v.observations).length === 0, why(v));
    check(`${n}b. ${fault}: procesul s-a terminat singur, cu cod 0 și un rezultat valid`, v.diagnostics?.code === 0 && v.diagnostics.signal === null && !v.diagnostics.timedOut && v.diagnostics.terminationConfirmed, why(v));
  }
  {
    // Fișierul implementează alt caz decât cel cerut de supraveghetor.
    const v = await run("C-V3-BUY", ["--control=C-V3-BUY", "--fault=none", "--impl=C-V2-BUY"]);
    check("C9. fișier pornit pentru alt caz decât cel implementat → HARNESS_ERROR", v.outcome === "HARNESS_ERROR", why(v));
  }
  {
    const v = await run("C-V3-BUY", ["--control=C-V3-BUY", "--fault=nu-exista"]);
    check("C10. încărcarea modulelor aruncă → HARNESS_ERROR, cu rezultat scris și cod 0", v.outcome === "HARNESS_ERROR" && v.reasons.some(r => r.includes("defect necunoscut")) && v.diagnostics?.code === 0, why(v));
  }

  console.log("C'. erori TÂRZII, apărute doar în consolă sau imposibil de observat → HARNESS_ERROR, fără observații");
  const late: Array<[string, string, string, string]> = [
    ["C11", "cleanup-console-error",       "după cleanup: linie [WS ERR",                    "eroare doar în consolă, în timpul cleanup-ului"],
    ["C12", "before-exit-console-error",   "la terminare: linie [WS ERR",                    "eroare doar în consolă, la beforeExit"],
    ["C13", "before-exit-transport-error", "la terminare: eroare de transport WS",           "eroare de transport doar în consolă, la beforeExit"],
    ["C14", "exit-listener",               "G3.",                                            "ascultător de exit înregistrat de codul încărcat"],
  ];
  for (const [n, fault, expect, what] of late) {
    const v = await run("C-V3-BUY", ["--control=C-V3-BUY", `--fault=${fault}`]);
    check(`${n}. ${what} → HARNESS_ERROR cu motivul așteptat, fără observații`, v.outcome === "HARNESS_ERROR" && v.reasons.some(r => r.includes(expect)) && Object.keys(v.observations).length === 0, why(v));
    check(`${n}b. ${fault}: e SINGURUL motiv (fără el cazul ar fi fost CONTROL_OK), proces terminat singur cu cod 0`, v.reasons.length === 1 && v.diagnostics?.code === 0 && v.diagnostics.signal === null && !v.diagnostics.timedOut && v.diagnostics.terminationConfirmed, why(v));
  }

  await defectCases();

  console.log("D. procese rămase");
  const all = [...new Set(L.pids())];
  const survivors = all.filter(alive);
  check(`D1. niciunul dintre cele ${all.length} procese de caz nu mai e viu`, all.length === EXPECTED_PROCESSES && survivors.length === 0, `procese: ${all.length}, așteptate ${EXPECTED_PROCESSES}`);
  check("D2. lansatorul principal nu a întâlnit nicio terminare neconfirmată", L.stuck() === null);
  for (const pid of survivors) { try { process.kill(-pid, "SIGKILL"); } catch { /* deja oprit */ } }

  await unconfirmedRegression();
}

/** A 10 + B 3 + C 10 + C' 4 + F 10 + G 11 + H 9 + J 7. */
const EXPECTED_PROCESSES = 64;

/**
 * F–H. Corpul CAZURILOR DE DEFECT (felia 4), peste workerul fals:
 *   F — fals fidel baseline-ului (are defectele) → predicția se confirmă;
 *   G — fals „reparat" pentru exact acel defect → predicția NU se confirmă (altfel „reprodus" ar fi verde fals);
 *   H — barieră, gardă sau montaj neîndeplinite → HARNESS_ERROR, NICIODATĂ „reprodus", fără observații.
 */
async function defectCases(): Promise<void> {
  const noObs = (v: CaseVerdict): boolean => Object.keys(v.observations).length === 0;

  console.log("F. cazuri de defect peste workerul fals fidel baseline-ului → predicția se confirmă");
  const confirm: Array<[string, Outcome, (o: Record<string, unknown>) => boolean]> = [
    ["M1",        "DEFECT_REPRODUCED", o => o.swapsRecorded === 0 && o.logsSent === 1 && JSON.stringify(o.requestKinds) === '["v2"]'],
    ["M2",        "DEFECT_REPRODUCED", o => o.requestsSeen === 0 && o.logsSent === 0 && o.swapsRecorded === 0],
    ["D1",        "DEFECT_REPRODUCED", o => o.logsSent === 1 && o.logsReceived === 1 && o.swapsRecorded === 0 && o.metadataSource === "dexscreener"],
    ["T1",        "DEFECT_REPRODUCED", o => o.logsSent === 0 && o.swapsRecorded === 0 && JSON.stringify(o.absentTopicsFoundInFilter) === "[]"],
    ["T1-LP",     "DEFECT_REPRODUCED", o => o.logsSent === 1 && o.logsReceived === 1 && o.swapsRecorded === 0 && o.lpEventsRecorded === 1],
    ["T2",        "DEFECT_REPRODUCED", o => o.logsSent === 1 && o.swapsRecorded === 0 && JSON.stringify(o.absentTopicsFoundInFilter) === "[]"],
    ["P1",        "DEFECT_REPRODUCED", o => o.logsSent === 1 && o.logsReceived === 1 && o.swapsRecorded === 0 && o.priceEth === null],
    ["M1-FORCED", "DEFECT_REPRODUCED", o => o.forcedSent === 1 && o.forcedReceived === 1 && o.swapsRecorded === 0 && typeof o.forcedNote === "string"],
    ["T1-FORCED", "DEFECT_REPRODUCED", o => o.forcedSent === 1 && o.forcedReceived === 1 && o.swapsRecorded === 0 && typeof o.forcedNote === "string"],
    ["X1",        "PARTIAL_OBSERVED",  o => o.dexTypeFromIndexer === "V3" && o.inV3Dexes === false && typeof o.notVerified === "string"],
  ];
  for (const [id, outcome, obsOk] of confirm) {
    const v = await runDefect(id, "none");
    check(`F. ${id} → ${outcome}, cu observațiile așteptate și terminare confirmată`,
      v.outcome === outcome && v.reasons.length === 0 && obsOk(v.observations) && v.diagnostics?.terminationConfirmed === true && v.diagnostics.code === 0,
      why(v) + " " + JSON.stringify(v.observations).slice(0, 400));
  }

  console.log("G. același caz peste un fals REPARAT pentru acel defect → predicția NU se confirmă");
  const deny: Array<[string, string, Outcome, string]> = [
    ["M1",        "fixed-map-route",      "DEFECT_NOT_REPRODUCED", "nu apare în nicio cerere de tip v2"],
    ["M1",        "never-subscribes",     "DEFECT_NOT_REPRODUCED", "cereri eth_subscribe: 0"],
    ["M2",        "fixed-v4-route",       "DEFECT_NOT_REPRODUCED", "poolId-ul APARE"],
    ["D1",        "fixed-ds-quote",       "DEFECT_NOT_REPRODUCED", "swapuri înregistrate: 1"],
    ["T1",        "fixed-pancake-topic",  "DEFECT_NOT_REPRODUCED", "A FOST trimis prin filtru"],
    ["T1-LP",     "fixed-pancake-topic",  "DEFECT_NOT_REPRODUCED", "ESTE în filtrul cerut"],
    ["T2",        "fixed-solidly-topic",  "DEFECT_NOT_REPRODUCED", "A FOST trimis prin filtru"],
    ["P1",        "fixed-price-fallback", "DEFECT_NOT_REPRODUCED", "swapuri înregistrate: 1"],
    ["M1-FORCED", "fixed-map-route",      "HARNESS_ERROR",         "montaj:"],
    ["T1-FORCED", "fixed-pancake-topic",  "DEFECT_NOT_REPRODUCED", "swapuri înregistrate: 1"],
    ["X1",        "fixed-v3-dexes",       "PARTIAL_NOT_OBSERVED",  "V3_DEXES CONȚINE"],
  ];
  for (const [id, fault, outcome, expect] of deny) {
    const v = await runDefect(id, fault);
    check(`G. ${id} + ${fault} → ${outcome} cu motivul așteptat`,
      v.outcome === outcome && v.reasons.some(r => r.includes(expect)) && v.diagnostics?.terminationConfirmed === true && v.diagnostics.code === 0
        && (outcome === "HARNESS_ERROR" ? noObs(v) : !noObs(v)),
      why(v));
  }

  console.log("H. barieră, gardă sau montaj neîndeplinite într-un caz de defect → HARNESS_ERROR, niciodată «reprodus»");
  const errors: Array<[string, string, string]> = [
    ["M1", "handler-throws",            "[WS ERR"],            // martorul aruncă în handler; wsFlow rămâne gol ca la defect
    ["D1", "handler-throws",            "[WS ERR"],            // swapul aruncă în handler; „neînregistrat" ar fi verde fals
    ["P1", "async-handler",             "activeJobCount()"],
    ["T1", "never-subscribes",          "montaj:"],
    ["T2", "import-timer",              "timer creat la import"],
    ["M2", "other-port",                "E1."],
    ["X1", "import-fetch",              "fetch la import"],
    ["P1", "before-exit-console-error", "la terminare: linie [WS ERR"],
  ];
  for (const [id, fault, expect] of errors) {
    const v = await runDefect(id, fault);
    check(`H. ${id} + ${fault} → HARNESS_ERROR cu motivul așteptat, fără observații`,
      v.outcome === "HARNESS_ERROR" && v.reasons.some(r => r.includes(expect)) && noObs(v) && v.diagnostics?.terminationConfirmed === true && v.diagnostics.code === 0,
      why(v));
  }
  {
    const v = await L.run("M1", ["--defect=NU-EXISTA", "--fault=none"], {}, DEFECT_SPECS["M1"]);
    check("H. caz de defect necunoscut → HARNESS_ERROR", v.outcome === "HARNESS_ERROR" && noObs(v), why(v));
  }

  // J. Nodul se poartă greșit DUPĂ capturarea și verificarea filtrului; workerul fals e cel fidel baseline-ului.
  // Se cere motivul EXACT al gărzii testate: o altă gardă, redundantă, nu trebuie să poată ține locul ei.
  console.log("J. martor, geamăn și livrare forțată provocate direct în nod → HARNESS_ERROR cu motivul exact al gărzii");
  const tampered: Array<[string, string, string]> = [
    ["M1",        "suppress-witness", "martorul nu a fost trimis exact o dată prin filtru"],
    ["T2",        "suppress-witness", "martorul nu a fost trimis exact o dată prin filtru"],
    ["D1",        "deliver-twin",     "geamănul negativ (topic străin) a fost trimis de nod"],
    ["P1",        "deliver-twin",     "geamănul negativ (topic străin) a fost trimis de nod"],
    ["M1-FORCED", "forced-inactive",  "deliverForced pe o subscripție care nu e activă la nod"],
    ["M1-FORCED", "forced-missing",   ": trimis de 0 ori (se cere exact o dată)"],
    ["T1-FORCED", "forced-double",    ": trimis de 2 ori (se cere exact o dată)"],
  ];
  for (const [id, tamper, expect] of tampered) {
    const v = await runDefect(id, "none", tamper);
    check(`J. ${id} + ${tamper} → HARNESS_ERROR cu motivul exact, singurul, fără observații`,
      v.outcome === "HARNESS_ERROR" && v.reasons.length === 1 && v.reasons[0].includes(expect) && noObs(v)
        && v.diagnostics?.terminationConfirmed === true && v.diagnostics.code === 0,
      why(v));
  }
}

/**
 * E. Regresie: terminare NECONFIRMATĂ în self-test. Lansator separat, cu oprirea forțată INERTĂ (cusătura de test
 * a supraveghetorului) și un proces care nu se termină. Dovedește: zero procese pornite după, cazul și PID-ul
 * păstrate, procesul rămas tratat de cleanup-ul mărginit.
 */
async function unconfirmedRegression(): Promise<void> {
  console.log("E. terminare neconfirmată în self-test → lansările se opresc, procesul rămas e tratat");
  const T = makeLauncher();
  const inert: Partial<SupervisorOptions> = { deadlineMs: 1_500, killGraceMs: 1_000, killImpl: () => { /* inert */ } };
  let report: CleanupReport | null = null;
  try {
    let first: unknown = null;
    try { await T.run("C-V3-BUY", ["--control=C-V3-BUY", "--fault=hang-ignore-term"], inert); }
    catch (e) { first = e; }
    const stuck = T.stuck();
    check("E1. terminare neconfirmată → lansatorul aruncă UnconfirmedTermination, nu întoarce un verdict", first instanceof UnconfirmedTermination);
    check("E2. cazul și PID-ul sunt păstrate", stuck !== null && stuck.caseId === "C-V3-BUY" && stuck.pid !== null && first instanceof UnconfirmedTermination && first.pid === stuck.pid && first.caseId === "C-V3-BUY");
    check("E3. procesul CHIAR mai există (oprirea forțată a fost inertă)", stuck !== null && stuck.pid !== null && pidAlive(stuck.pid));

    const launchesBefore = T.launches(), pidsBefore = T.pids().length;
    const refused: unknown[] = [];
    for (const control of ["C-V2-BUY", "C-V3-BUY", "C-V4-BUY"]) {
      // Fără cusătura inertă: dacă lansatorul AR porni procesul, acesta ar rula normal și ar fi numărat.
      try { await T.run(control, [`--control=${control}`, "--fault=none"]); refused.push(null); }
      catch (e) { refused.push(e); }
    }
    check("E4. toate lansările următoare sunt refuzate cu aceeași eroare (același caz, același PID)",
      refused.length === 3 && refused.every(e => e instanceof UnconfirmedTermination && e.caseId === "C-V3-BUY" && e.pid === stuck?.pid));
    check("E5. ZERO procese pornite după terminarea neconfirmată (număr de lansări și de PID-uri neschimbat)",
      T.launches() === launchesBefore && launchesBefore === 1 && T.pids().length === pidsBefore && pidsBefore === 1,
      `lansări ${launchesBefore}→${T.launches()}, pid-uri ${pidsBefore}→${T.pids().length}`);
  } finally {
    report = await T.cleanup();
  }
  check("E6. cleanup-ul mărginit din finally a oprit procesul rămas", report.stuck !== null && report.killed && !report.stillAlive && report.ms < 3_000, JSON.stringify(report));
  const pid = report.stuck?.pid ?? null;
  check("E7. după cleanup nu mai există procese vii ale cazului (pid și grup)", pid !== null && !pidAlive(pid) && !groupAlive(pid));
  {
    const empty = await makeLauncher().cleanup();
    check("E8. cleanup fără proces rămas → nu oprește nimic", empty.stuck === null && !empty.killed && !empty.stillAlive);
  }
}

main()
  .catch((e: unknown) => { failures.push("excepție în caseRuntimeSelfTest: " + (e instanceof Error ? e.message : String(e))); })
  .then(async () => {
    // Cleanup MĂRGINIT al lansatorului principal: rulează pe orice cale (și după o excepție prinsă mai sus).
    const r = await L.cleanup();
    if (r.stuck !== null) {
      failures.push(`terminare neconfirmată în rularea principală: caz ${r.stuck.caseId}, pid ${String(r.stuck.pid)} — lansările s-au oprit după ${L.launches()} procese`);
      console.log(`  proces rămas (caz ${r.stuck.caseId}, pid ${String(r.stuck.pid)}): ${r.stillAlive ? "ÎNCĂ VIU după cleanup-ul mărginit" : "oprit de cleanup"} în ${r.ms} ms`);
      if (r.stillAlive) failures.push(`procesul rămas ${String(r.stuck.pid)} e încă viu după cleanup-ul mărginit`);
    }
  })
  .catch((e: unknown) => { failures.push("cleanup: " + (e instanceof Error ? e.message : String(e))); })
  .finally(() => {
    console.log(`\n${passed} trecute, ${failures.length} eșuate`);
    for (const f of failures) console.log("  - " + f);
    console.log(failures.length === 0
      ? "caseRuntimeSelfTest: OK. Validează DOAR runtime-ul de caz, peste un worker FALS; nu spune nimic despre workerul real sau despre BETA-1."
      : "caseRuntimeSelfTest: EȘEC");
    process.exitCode = failures.length === 0 ? 0 : 3;
  });
