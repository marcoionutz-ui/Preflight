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
 * Felia D1: A și B includ controalele `D1-DS-*` — falsul urmează produsul REPARAT, iar `ds-quote-unreadable`
 * reproduce comportamentul de dinainte de fix → CONTROL_FAILED. B8–B10 provoacă direct verificările LP (procent,
 * sens, rezervă de montaj); B11–B13 provoacă verificările GLOBALE (swap tăcut pe alt chain, linie de swap pe alt
 * chain, eveniment LP pe altă pereche). D1 e retras și nu mai e rulat (I7, I8).
 *
 * Felia T1: A include controalele `C-PANCAKE-*` — falsul urmează produsul REPARAT (topicul Pancake în filtru și în
 * handler, regula exactă de 448 hex, kind `v3`). K provoacă fiecare verificare a controalelor Pancake: comportamentul
 * vechi (`pancake-unsupported`), efecte laterale pe alt chain / altă pereche, marcaj per-kind lipsă, livrare dublă,
 * semn negat, câmp `swapVariant` lipsă → CONTROL_FAILED cu motivul exact; decodorul care aruncă → `[WS ERR` →
 * HARNESS_ERROR (regula existentă a runtime-ului, neschimbată), iar o rulare cu el e invalidă (cod 3). T1, T1-LP și
 * T1-FORCED sunt retrase (I8, I9) și nu mai sunt rulate.
 *
 * Felia T2: A include cele nouă controale `C-AERO-*` (Aerodrome clasic pe ruta V2; falsul urmează produsul reparat:
 * dispatch sigur înaintea operațiilor pe date, decodare strictă, kind `v2`). L provoacă fiecare verificare a lor:
 * comportamentul vechi (`aero-unsupported`: 8 controale pică pe filtru, iar LP-ADD rămâne verde), parsare permisivă pe
 * surplus (Burn și Swap), dispatch după `data.slice(2)` (date ne-șir → `[WS ERR` → HARNESS_ERROR), Burn netratat /
 * inversat / linie fără sufix, kind nemapat, intrări-ieșiri inversate, `swapVariant` lipsă, efecte laterale, livrare
 * dublă, decodor care aruncă. T2 e retras (I8, I10); rândurile lui din H sunt mutate pe P1 și M2, cel din J eliminat.
 *
 * Felia V4L: A include `C-V4-LIQ` (falsul reparat: filtrul V4 `[Swap V4, ModifyLiquidity]`, kind `v4`, ramura scrie
 * doar linia `[V4 LIQ]`). N provoacă separat fiecare verificare: comportamentul vechi (topicul greșit), filtrul cu
 * ambele topicuri, linia lipsă / dublată / greșită, marcajul lipsă, swap sau LP înregistrat, linie de swap sau LP,
 * livrare dublă; ramura care aruncă → `[WS ERR` → HARNESS_ERROR. Niciun caz nu e retras (I8 neschimbat, I11).
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
import { specProblem, summarize, type CaseVerdict, type CaseSpec, type CaseKind, type CaseSection, type Outcome } from "./caseProtocol";
import { CASES } from "../cases/manifest";
import { CONTROLS } from "../cases/controlDefs";
import { DEFECTS, ACTIVE_DEFECT_IDS } from "../cases/defectDefs";

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

/**
 * Felul și secțiunea fiecărui caz de defect ACTIV — repetate aici (ca în manifest), NU citite din definiții.
 * Retrase, deci absente de aici și nerulate: D1 (marker `BETA1-D1-FIX`); T1, T1-LP, T1-FORCED (`BETA1-T1-FIX`);
 * T2 (`BETA1-T2-FIX`).
 */
const DEFECT_SPECS: Record<string, { kind: CaseKind; section: CaseSection }> = {
  "M1": { kind: "defect", section: "filter" }, "M2": { kind: "defect", section: "filter" },
  "P1": { kind: "defect", section: "filter" },
  "M1-FORCED": { kind: "defect", section: "forced" },
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
  check("I2. controalele din manifest sunt exact cele definite (27), toate în «filter», în același fișier",
    controls.length === 27 && JSON.stringify(controls.map(c => c.id).sort()) === JSON.stringify(Object.keys(CONTROLS).sort())
      && controls.every(c => c.section === "filter" && c.file.endsWith("positiveControls.ts")));
  const defects = CASES.filter(c => c.kind !== "control");
  check("I3. cazurile de defect din manifest sunt exact cele ACTIVE (5), cu același fel și aceeași secțiune",
    defects.length === 5 && JSON.stringify(defects.map(c => c.id).sort()) === JSON.stringify([...ACTIVE_DEFECT_IDS].sort())
      && defects.every(c => DEFECTS[c.id]?.kind === c.kind && DEFECTS[c.id]?.section === c.section && c.file.endsWith("defectCases.ts")));
  check("I4. tabelul acestui self-test coincide cu definițiile ACTIVE",
    JSON.stringify(Object.keys(DEFECT_SPECS).sort()) === JSON.stringify([...ACTIVE_DEFECT_IDS].sort())
      && Object.entries(DEFECT_SPECS).every(([id, sp]) => DEFECTS[id].kind === sp.kind && DEFECTS[id].section === sp.section));
  const by = (section: CaseSection): string[] => defects.filter(c => c.section === section).map(c => c.id);
  check("I5. secțiunile nu se amestecă: 3 prin filtru, 1 forțat (M1-FORCED), 1 parțial (X1, singurul de fel «partial»)",
    by("filter").length === 3 && JSON.stringify(by("forced")) === '["M1-FORCED"]' && JSON.stringify(by("partial")) === '["X1"]'
      && defects.filter(c => c.kind === "partial").length === 1);
  check("I6. fiecare caz de defect activ numește un control pereche care există în manifest (X1: niciunul)",
    ACTIVE_DEFECT_IDS.every(id => id === "X1" || controls.some(c => c.id === DEFECTS[id].pairedControl)));
  const d1 = DEFECTS["D1"];
  check("I7. D1 e retras cu markerul stabil, lipsește din manifest și din tabel, iar înlocuitorii lui sunt controale în manifest",
    d1?.retired?.marker === "BETA1-D1-FIX" && !ids.includes("D1") && !("D1" in DEFECT_SPECS) && !ACTIVE_DEFECT_IDS.includes("D1")
      && d1.retired.replacedBy.length === 2 && d1.retired.replacedBy.every(r => controls.some(c => c.id === r)));
  check("I8. cazurile retrase sunt exact D1, T1, T1-LP, T1-FORCED și T2",
    JSON.stringify(Object.keys(DEFECTS).filter(id => DEFECTS[id].retired !== undefined).sort()) === '["D1","T1","T1-FORCED","T1-LP","T2"]');
  const t1Ids = ["T1", "T1-LP", "T1-FORCED"];
  const pancakeControls = ["C-PANCAKE-BUY", "C-PANCAKE-SELL"];
  check("I9. T1, T1-LP și T1-FORCED sunt retrase cu markerul stabil BETA1-T1-FIX, lipsesc din manifest și din tabel; T1 și T1-FORCED sunt înlocuite de C-PANCAKE-BUY/SELL (în manifest), T1-LP fără înlocuitor",
    t1Ids.every(id => DEFECTS[id]?.retired?.marker === "BETA1-T1-FIX" && !ids.includes(id) && !(id in DEFECT_SPECS) && !ACTIVE_DEFECT_IDS.includes(id))
      && ["T1", "T1-FORCED"].every(id => JSON.stringify(DEFECTS[id].retired?.replacedBy) === JSON.stringify(pancakeControls))
      && JSON.stringify(DEFECTS["T1-LP"].retired?.replacedBy) === "[]"
      && [...pancakeControls, "C-PANCAKE-SHORT"].every(c => controls.some(m => m.id === c)));
  const t2 = DEFECTS["T2"];
  check("I10. T2 e retras cu markerul stabil BETA1-T2-FIX, lipsește din manifest și din tabel, e înlocuit de C-AERO-BUY/SELL; toate cele 9 C-AERO-* sunt în manifest",
    t2?.retired?.marker === "BETA1-T2-FIX" && !ids.includes("T2") && !("T2" in DEFECT_SPECS) && !ACTIVE_DEFECT_IDS.includes("T2")
      && JSON.stringify(t2.retired.replacedBy) === '["C-AERO-BUY","C-AERO-SELL"]'
      && AERO_IDS.every(c => controls.some(m => m.id === c)));
  const v4l = CONTROLS["C-V4-LIQ"];
  check("I11. C-V4-LIQ e în manifest, pe kind v4 (admis în v4PoolMap), cu lista exactă a filtrului și linia diagnostică exactă; geamănul are alt transactionHash",
    controls.some(m => m.id === "C-V4-LIQ") && v4l?.kind === "v4" && v4l.admit === "v4"
      && Array.isArray(v4l.strict?.topics0) && v4l.strict?.topics0?.length === 2 && typeof v4l.strict?.diagLine === "string"
      && v4l.strict.diagLine.startsWith("[V4 LIQ] ") && v4l.linePrefix === v4l.strict.diagLine && v4l.expected === undefined && v4l.lp === undefined
      && v4l.twin.transactionHash !== v4l.swap.transactionHash);
}

const AERO_IDS = ["C-AERO-BUY", "C-AERO-SELL", "C-AERO-SHORT", "C-AERO-SWAP-LONG", "C-AERO-SWAP-NONSTRING",
  "C-AERO-LP-ADD", "C-AERO-LP-REMOVE", "C-AERO-BURN-LONG", "C-AERO-BURN-NONSTRING"];

async function main(): Promise<void> {
  manifestConsistency();
  console.log("A. traseul bun, pe fiecare tip");
  for (const control of ["C-V2-BUY", "C-V2-SELL", "C-V3-BUY", "C-V3-SELL", "C-V4-BUY", "C-V4-SELL", "C-STABLE-BUY", "C-STABLE-SELL", "D1-CONTROL", "P1-CONTROL", "D1-DS-BUY", "D1-DS-SELL"]) {
    const v = await run(control, [`--control=${control}`, "--fault=none"]);
    check(`A. ${control} peste workerul fals → CONTROL_OK, terminare confirmată`, v.outcome === "CONTROL_OK" && v.diagnostics?.terminationConfirmed === true && v.observations.swapsRecorded === 1, why(v));
  }
  // Felia D1: controalele LP — exact un eveniment LP, zero swapuri; la retragere, rezerva de montaj e 20 ETH.
  for (const [control, isAdd] of [["D1-DS-LP-ADD", true], ["D1-DS-LP-REMOVE", false]] as const) {
    const v = await run(control, [`--control=${control}`, "--fault=none"]);
    const lp = v.observations.lpRecorded as Array<{ isAdd: boolean; ethAmount: number }> | undefined;
    check(`A. ${control} peste workerul fals → CONTROL_OK, un eveniment LP (${isAdd ? "adăugare" : "retragere"}), zero swapuri`,
      v.outcome === "CONTROL_OK" && v.diagnostics?.terminationConfirmed === true && v.observations.swapsRecorded === 0
        && v.observations.lpEventsRecorded === 1 && Array.isArray(lp) && lp[0].isAdd === isAdd
        && (isAdd || v.observations.reserveEth === 20), why(v));
  }

  // Felia T1: controalele Pancake — marcaj per-kind (nemarcat înainte, marcat după), verificări globale.
  for (const control of ["C-PANCAKE-BUY", "C-PANCAKE-SELL"]) {
    const v = await run(control, [`--control=${control}`, "--fault=none"]);
    const o = v.observations;
    check(`A. ${control} peste workerul fals → CONTROL_OK, base:v3 marcat doar după livrare, un swap pe toate cheile, linia cu swapVariant`,
      v.outcome === "CONTROL_OK" && v.diagnostics?.terminationConfirmed === true && o.swapsRecorded === 1
        && o.kindMarkedBefore === false && o.kindMarkedAfter === true && o.swapReceived === 1
        && o.swapsAllKeys === 1 && o.lpEventsAllKeys === 0 && o.swapLogLinesAllChains === 1 && o.lpLogLines === 0 && o.lineFieldLines === 1, why(v));
  }
  {
    const v = await run("C-PANCAKE-SHORT", ["--control=C-PANCAKE-SHORT", "--fault=none"]);
    const o = v.observations;
    check("A. C-PANCAKE-SHORT peste workerul fals → CONTROL_OK: trimis și primit o dată, base:v3 marcat, nimic înregistrat nicăieri",
      v.outcome === "CONTROL_OK" && v.diagnostics?.terminationConfirmed === true && o.logsSent === 1 && o.swapReceived === 1
        && o.kindMarkedBefore === false && o.kindMarkedAfter === true && o.swapsRecorded === 0 && o.swapsAllKeys === 0
        && o.lpEventsAllKeys === 0 && o.swapLogLinesAllChains === 0 && o.lpLogLines === 0, why(v));
  }
  // Felia T2: controalele Aerodrome peste workerul fals reparat.
  const kindOk = (o: Record<string, unknown>): boolean => o.kindMarkedBefore === false && o.kindMarkedAfter === true && o.swapReceived === 1;
  for (const control of ["C-AERO-BUY", "C-AERO-SELL"]) {
    const v = await run(control, [`--control=${control}`, "--fault=none"]);
    const o = v.observations;
    check(`A. ${control} peste workerul fals → CONTROL_OK, base:v2 marcat doar după livrare, un swap pe toate cheile, linia cu swapVariant=aerodrome-classic`,
      v.outcome === "CONTROL_OK" && v.diagnostics?.terminationConfirmed === true && o.swapsRecorded === 1 && kindOk(o)
        && o.swapsAllKeys === 1 && o.lpEventsAllKeys === 0 && o.swapLogLinesAllChains === 1 && o.lpLogLines === 0 && o.lineFieldLines === 1, why(v));
  }
  for (const control of ["C-AERO-SHORT", "C-AERO-SWAP-LONG", "C-AERO-SWAP-NONSTRING", "C-AERO-BURN-LONG", "C-AERO-BURN-NONSTRING"]) {
    const v = await run(control, [`--control=${control}`, "--fault=none"]);
    const o = v.observations;
    check(`A. ${control} peste workerul fals → CONTROL_OK: trimis și primit o dată, base:v2 marcat, nimic înregistrat nicăieri`,
      v.outcome === "CONTROL_OK" && v.diagnostics?.terminationConfirmed === true && o.logsSent === 1 && kindOk(o)
        && o.swapsAllKeys === 0 && o.lpEventsAllKeys === 0 && o.swapLogLinesAllChains === 0 && o.lpLogLines === 0, why(v));
  }
  for (const [control, isAdd, eth] of [["C-AERO-LP-ADD", true, 1], ["C-AERO-LP-REMOVE", false, 2]] as const) {
    const v = await run(control, [`--control=${control}`, "--fault=none"]);
    const o = v.observations;
    const lp = o.lpRecorded as Array<{ isAdd: boolean; ethAmount: number }> | undefined;
    check(`A. ${control} peste workerul fals → CONTROL_OK: un eveniment LP (${isAdd ? "adăugare" : "retragere"}, ${eth} ETH), zero swapuri, linia exactă întreagă`,
      v.outcome === "CONTROL_OK" && v.diagnostics?.terminationConfirmed === true && kindOk(o) && o.lpEventsRecorded === 1
        && Array.isArray(lp) && lp[0].isAdd === isAdd && lp[0].ethAmount === eth && o.lpEventsAllKeys === 1 && o.swapsAllKeys === 0
        && o.swapLogLinesAllChains === 0 && o.lpLogLines === 1 && o.exactLpLines === 1 && (isAdd || o.reserveEth === 20), why(v));
  }

  // Felia V4L: rutarea diagnostică — linia exactă, nimic înregistrat, geamănul cu topicul vechi refuzat de filtru.
  {
    const v = await run("C-V4-LIQ", ["--control=C-V4-LIQ", "--fault=none"]);
    const o = v.observations;
    const twin = o.twinDelivery as { sent?: number } | undefined;
    check("A. C-V4-LIQ peste workerul fals → CONTROL_OK: trimis și primit o dată, geamănul trimis de 0 ori, base:v4 marcat doar după, o singură linie [V4 LIQ] (exactă), nimic înregistrat nicăieri",
      v.outcome === "CONTROL_OK" && v.diagnostics?.terminationConfirmed === true && o.logsSent === 1 && twin?.sent === 0 && kindOk(o)
        && o.diagLines === 1 && o.exactDiagLines === 1 && o.swapsAllKeys === 0 && o.lpEventsAllKeys === 0
        && o.swapLogLinesAllChains === 0 && o.lpLogLines === 0, why(v));
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
  // Felia D1: falsul cu metadate DexScreener NECITIBILE (comportamentul de dinainte de fix) → controalele D1-DS pică.
  const unreadable: Array<[string, string, string]> = [
    ["B4", "D1-DS-BUY",       "swapuri înregistrate: 0"],
    ["B5", "D1-DS-SELL",      "swapuri înregistrate: 0"],
    ["B6", "D1-DS-LP-ADD",    "evenimente LP înregistrate: 0"],
    ["B7", "D1-DS-LP-REMOVE", "evenimente LP înregistrate: 0"],
  ];
  for (const [n, control, expect] of unreadable) {
    const v = await run(control, [`--control=${control}`, "--fault=ds-quote-unreadable"]);
    check(`${n}. ${control} + ds-quote-unreadable → CONTROL_FAILED cu motivul așteptat`, v.outcome === "CONTROL_FAILED" && v.reasons.some(r => r.includes(expect)), why(v));
  }
  // Verificările LP, provocate direct: procent greșit (doar linia îl poartă) și sens inversat → CONTROL_FAILED;
  // rezervă lipsă → montaj neîndeplinit → HARNESS_ERROR, fără observații.
  {
    const v = await run("D1-DS-LP-REMOVE", ["--control=D1-DS-LP-REMOVE", "--fault=lp-percent-off"]);
    check("B8. D1-DS-LP-REMOVE + lp-percent-off → CONTROL_FAILED pe linia exactă (procentul)", v.outcome === "CONTROL_FAILED" && v.reasons.length === 1 && v.reasons[0].includes("linii LP în consolă"), why(v));
  }
  {
    const v = await run("D1-DS-LP-ADD", ["--control=D1-DS-LP-ADD", "--fault=lp-flip-side"]);
    check("B9. D1-DS-LP-ADD + lp-flip-side → CONTROL_FAILED cu sensul LP", v.outcome === "CONTROL_FAILED" && v.reasons.some(r => r.includes("sens LP înregistrat")), why(v));
  }
  // Verificările GLOBALE ale controalelor LP, fiecare provocată separat, cu motivul ei exact și singur.
  const sideEffects: Array<[string, string, string, string]> = [
    ["B11", "D1-DS-LP-ADD",    "lp-extra-swap-silent", "swapuri înregistrate în wsFlow, pe toate cheile: 1"],
    ["B12", "D1-DS-LP-REMOVE", "lp-extra-swap-line",   "linii de swap în consolă, pe toate chain-urile: 1"],
    ["B13", "D1-DS-LP-ADD",    "lp-extra-lp-silent",   "evenimente LP pe toate cheile: 2"],
  ];
  for (const [n, control, fault, expect] of sideEffects) {
    const v = await run(control, [`--control=${control}`, `--fault=${fault}`]);
    check(`${n}. ${control} + ${fault} → CONTROL_FAILED cu motivul exact, singurul`,
      v.outcome === "CONTROL_FAILED" && v.reasons.length === 1 && v.reasons[0].includes(expect), why(v));
  }
  {
    const v = await run("D1-DS-LP-REMOVE", ["--control=D1-DS-LP-REMOVE", "--fault=lp-no-reserve"]);
    check("B10. D1-DS-LP-REMOVE + lp-no-reserve → HARNESS_ERROR (montaj: rezerva), fără observații",
      v.outcome === "HARNESS_ERROR" && v.reasons.some(r => r.includes("rezerva pool-ului")) && Object.keys(v.observations).length === 0, why(v));
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

  await pancakeInjections();
  await aeroInjections();
  await v4lInjections();
  await defectCases();

  console.log("D. procese rămase");
  const all = [...new Set(L.pids())];
  const survivors = all.filter(alive);
  check(`D1. niciunul dintre cele ${all.length} procese de caz nu mai e viu`, all.length === EXPECTED_PROCESSES && survivors.length === 0, `procese: ${all.length}, așteptate ${EXPECTED_PROCESSES}`);
  check("D2. lansatorul principal nu a întâlnit nicio terminare neconfirmată", L.stuck() === null);
  for (const pid of survivors) { try { process.kill(-pid, "SIGKILL"); } catch { /* deja oprit */ } }

  await unconfirmedRegression();
}

/** A 27 + B 13 + C 10 + C' 4 + K 15 + L 27 + N 12 + F 5 + G 6 + H 9 + J 5. */
const EXPECTED_PROCESSES = 133;

/**
 * N. Felia V4L: fiecare verificare a controlului `C-V4-LIQ`, provocată separat peste workerul fals, cu motivul EXACT
 * și unic (design `BETA1_V4L_FIX_DESIGN.md` rev2, §6). Lipsa sau dublarea liniei, lipsa marcajului și efectele
 * suplimentare se invalidează fiecare prin propria injecție. Excepție: ramura care aruncă produce o linie `[WS ERR`
 * → HARNESS_ERROR (regula existentă a runtime-ului), iar rularea care o conține e invalidă (cod 3).
 */
async function v4lInjections(): Promise<void> {
  console.log("N. controlul V4 ModifyLiquidity: injecții → CONTROL_FAILED cu motivul exact; ramura care aruncă → HARNESS_ERROR");
  const exactly = (v: CaseVerdict, reasons: string[]): boolean => v.outcome === "CONTROL_FAILED" && JSON.stringify(v.reasons) === JSON.stringify(reasons);
  const diag = (all: number, exact: number): string => `linii [V4 LIQ] în consolă: ${all}, dintre care identice cu linia exactă așteptată ${exact} (se cere exact 1 și 1)`;
  const cases: Array<[string, string, string[]]> = [
    ["N1", "v4l-old-topic", ["topicul de swap lipsește din poziția 0 a filtrului"]],
    ["N2", "v4l-both-topics", ["poziția 0 a filtrului V4 nu e exact lista așteptată"]],
    ["N3", "v4l-line-missing", [diag(0, 0)]],
    ["N4", "v4l-line-dup", [diag(2, 2)]],
    ["N5", "v4l-line-wrong", [diag(1, 0)]],
    ["N6", "v4l-kind-unmapped", ["wsLastMessageAtByKind nu a fost marcat pentru base:v4"]],
    ["N7", "v4l-records-swap", ["swapuri înregistrate în wsFlow, pe toate cheile: 1 (se cer 0)"]],
    ["N8", "v4l-records-lp", ["evenimente LP pe toate cheile: 1 (se cer 0)"]],
    ["N9", "v4l-swap-line", ["linii de swap în consolă, pe toate chain-urile: 1 (se cer 0)"]],
    ["N10", "v4l-lp-line", ["linii LP în consolă, pe toate chain-urile: 1 (se cer 0)"]],
  ];
  for (const [n, fault, reasons] of cases) {
    const v = await run("C-V4-LIQ", ["--control=C-V4-LIQ", `--fault=${fault}`]);
    check(`${n}. C-V4-LIQ + ${fault} → CONTROL_FAILED, singurul motiv: ${reasons[0]}`, exactly(v, reasons), why(v));
  }
  {
    const v = await run("C-V4-LIQ", ["--control=C-V4-LIQ", "--fault=none", "--tamper=duplicate-delivery"]);
    check("N11. C-V4-LIQ + livrare dublă → CONTROL_FAILED, exact motivele de trimitere, recepție și linie dublată",
      exactly(v, ["logul controlului nu a fost trimis exact o dată prin filtru", "logul controlului nu a fost primit exact o dată de worker", diag(2, 2)]), why(v));
  }
  {
    const WS_ERR = "înainte de închidere: linie [WS ERR în captura de consolă";
    const v = await run("C-V4-LIQ", ["--control=C-V4-LIQ", "--fault=v4l-throws"]);
    check("N12. C-V4-LIQ + v4l-throws → HARNESS_ERROR, singurul motiv: [WS ERR, fără observații, cod 0, terminare confirmată",
      v.outcome === "HARNESS_ERROR" && JSON.stringify(v.reasons) === JSON.stringify([WS_ERR]) && Object.keys(v.observations).length === 0
        && v.diagnostics?.code === 0 && v.diagnostics.signal === null && !v.diagnostics.timedOut && v.diagnostics.terminationConfirmed, why(v));
    const sm = summarize([v]);
    check("N12b. o rulare care conține acest HARNESS_ERROR e invalidă: cod 3", sm.exitCode === 3 && sm.invalid.includes("C-V4-LIQ: HARNESS_ERROR"), JSON.stringify(sm));
  }
}

/**
 * L. Felia T2: fiecare verificare a controalelor Aerodrome, provocată separat peste workerul fals, cu motivul EXACT
 * (design `BETA1_T2_FIX_DESIGN.md` rev3, §5.2). Excepții: dispatch-ul nesigur și decodorul care aruncă produc o linie
 * `[WS ERR` → HARNESS_ERROR (regula existentă a runtime-ului), iar rularea care îl conține e invalidă (cod 3).
 */
async function aeroInjections(): Promise<void> {
  console.log("L. controalele Aerodrome: injecții → CONTROL_FAILED cu motivul exact; dispatch nesigur / decodor care aruncă → HARNESS_ERROR");
  const exactly = (v: CaseVerdict, reasons: string[]): boolean => v.outcome === "CONTROL_FAILED" && JSON.stringify(v.reasons) === JSON.stringify(reasons);
  const FILTER = "topicul de swap lipsește din poziția 0 a filtrului";
  const WS_ERR = "înainte de închidere: linie [WS ERR în captura de consolă";
  for (const control of AERO_IDS.filter(c => c !== "C-AERO-LP-ADD")) {
    const v = await run(control, [`--control=${control}`, "--fault=aero-unsupported"]);
    check(`L1. ${control} + aero-unsupported (comportamentul vechi) → CONTROL_FAILED, singurul motiv: topicul lipsește din filtru`, exactly(v, [FILTER]), why(v));
  }
  {
    const v = await run("C-AERO-LP-ADD", ["--control=C-AERO-LP-ADD", "--fault=aero-unsupported"]);
    check("L2. C-AERO-LP-ADD + aero-unsupported → CONTROL_OK: controlul Mint nu depinde de fix", v.outcome === "CONTROL_OK", why(v));
  }
  const exact: Array<[string, string, string, string[]]> = [
    ["L3", "C-AERO-BURN-LONG", "aero-burn-legacy-fallback",
      ["evenimente LP pe toate cheile: 1 (se cer 0)", "linii LP în consolă, pe toate chain-urile: 1 (se cer 0)"]],
    ["L4", "C-AERO-SWAP-LONG", "aero-swap-legacy-fallback",
      ["swapuri înregistrate în wsFlow, pe toate cheile: 1 (se cer 0)", "linii de swap în consolă, pe toate chain-urile: 1 (se cer 0)"]],
    ["L8", "C-AERO-LP-REMOVE", "aero-lp-line-suffix-missing",
      ["linii LP în consolă: 1, dintre care identice cu linia exactă așteptată 0 (se cere exact 1 și 1)"]],
    ["L9", "C-AERO-BUY", "aero-kind-unmapped", ["wsLastMessageAtByKind nu a fost marcat pentru base:v2"]],
    ["L9", "C-AERO-LP-REMOVE", "aero-kind-unmapped", ["wsLastMessageAtByKind nu a fost marcat pentru base:v2"]],
    ["L11", "C-AERO-BUY", "aero-variant-missing", ["linia de swap nu conține câmpul swapVariant=aerodrome-classic"]],
    ["L12", "C-AERO-SHORT", "aero-side-swap-other-chain", ["swapuri înregistrate în wsFlow, pe toate cheile: 1 (se cer 0)"]],
    ["L12", "C-AERO-SHORT", "aero-side-lp-other-pair", ["evenimente LP pe toate cheile: 1 (se cer 0)"]],
    ["L12", "C-AERO-SHORT", "aero-side-swap-line", ["linii de swap în consolă, pe toate chain-urile: 1 (se cer 0)"]],
    ["L12", "C-AERO-SHORT", "aero-side-lp-line", ["linii LP în consolă, pe toate chain-urile: 1 (se cer 0)"]],
  ];
  for (const [n, control, fault, reasons] of exact) {
    const v = await run(control, [`--control=${control}`, `--fault=${fault}`]);
    check(`${n}. ${control} + ${fault} → CONTROL_FAILED cu exact motivele așteptate`, exactly(v, reasons), why(v));
  }
  const includes: Array<[string, string, string, string]> = [
    ["L6", "C-AERO-LP-REMOVE", "aero-burn-unhandled", "evenimente LP înregistrate: 0 (se cere exact 1)"],
    ["L7", "C-AERO-LP-REMOVE", "aero-burn-as-add", "sens LP înregistrat: adăugare"],
    ["L10", "C-AERO-BUY", "aero-in-out-swapped", "direcție înregistrată: SELL"],
  ];
  for (const [n, control, fault, reason] of includes) {
    const v = await run(control, [`--control=${control}`, `--fault=${fault}`]);
    check(`${n}. ${control} + ${fault} → CONTROL_FAILED cu motivul „${reason}”`, v.outcome === "CONTROL_FAILED" && v.reasons.includes(reason), why(v));
  }
  for (const control of ["C-AERO-SWAP-NONSTRING", "C-AERO-BURN-NONSTRING"]) {
    const v = await run(control, [`--control=${control}`, "--fault=aero-unsafe-dispatch"]);
    check(`L5. ${control} + aero-unsafe-dispatch (Aerodrome tratat după data.slice) → HARNESS_ERROR, singurul motiv: [WS ERR, fără observații, cod 0`,
      v.outcome === "HARNESS_ERROR" && JSON.stringify(v.reasons) === JSON.stringify([WS_ERR]) && Object.keys(v.observations).length === 0
        && v.diagnostics?.code === 0 && v.diagnostics.terminationConfirmed, why(v));
  }
  const SENT = "logul controlului nu a fost trimis exact o dată prin filtru";
  const RECEIVED = "logul controlului nu a fost primit exact o dată de worker";
  {
    const v = await run("C-AERO-SHORT", ["--control=C-AERO-SHORT", "--fault=none", "--tamper=duplicate-delivery"]);
    check("L13. C-AERO-SHORT + livrare dublă → CONTROL_FAILED, exact motivele de trimitere și recepție", exactly(v, [SENT, RECEIVED]), why(v));
  }
  {
    const v = await run("C-AERO-LP-REMOVE", ["--control=C-AERO-LP-REMOVE", "--fault=none", "--tamper=duplicate-delivery"]);
    check("L13. C-AERO-LP-REMOVE + livrare dublă → CONTROL_FAILED, cu motivele de trimitere și recepție",
      v.outcome === "CONTROL_FAILED" && v.reasons.includes(SENT) && v.reasons.includes(RECEIVED), why(v));
  }
  {
    const v = await run("C-AERO-SHORT", ["--control=C-AERO-SHORT", "--fault=aero-throws"]);
    check("L14. C-AERO-SHORT + aero-throws → HARNESS_ERROR, singurul motiv: [WS ERR, fără observații, cod 0, terminare confirmată",
      v.outcome === "HARNESS_ERROR" && JSON.stringify(v.reasons) === JSON.stringify([WS_ERR]) && Object.keys(v.observations).length === 0
        && v.diagnostics?.code === 0 && v.diagnostics.signal === null && !v.diagnostics.timedOut && v.diagnostics.terminationConfirmed, why(v));
    const sm = summarize([v]);
    check("L14b. o rulare care conține acest HARNESS_ERROR e invalidă: cod 3", sm.exitCode === 3 && sm.invalid.includes("C-AERO-SHORT: HARNESS_ERROR"), JSON.stringify(sm));
  }
}

/**
 * K. Felia T1: fiecare verificare a controalelor Pancake, provocată separat peste workerul fals, cu motivul EXACT
 * (design `BETA1_T1_FIX_DESIGN.md` rev3, §4.1). Excepție: decodorul care aruncă produce o linie `[WS ERR` →
 * HARNESS_ERROR, regula existentă a runtime-ului (neschimbată), iar rularea care îl conține e invalidă (cod 3).
 */
async function pancakeInjections(): Promise<void> {
  console.log("K. controalele Pancake: injecții → CONTROL_FAILED cu motivul exact; decodor care aruncă → HARNESS_ERROR");
  const exactly = (v: CaseVerdict, reasons: string[]): boolean => v.outcome === "CONTROL_FAILED" && JSON.stringify(v.reasons) === JSON.stringify(reasons);
  const FILTER = "topicul de swap lipsește din poziția 0 a filtrului";
  for (const control of ["C-PANCAKE-BUY", "C-PANCAKE-SELL", "C-PANCAKE-SHORT"]) {
    const v = await run(control, [`--control=${control}`, "--fault=pancake-unsupported"]);
    check(`K1. ${control} + pancake-unsupported (comportamentul vechi) → CONTROL_FAILED, singurul motiv: topicul lipsește din filtru`, exactly(v, [FILTER]), why(v));
  }
  const single: Array<[string, string, string, string]> = [
    ["K2", "C-PANCAKE-SHORT", "short-swap-other-chain",      "swapuri înregistrate în wsFlow, pe toate cheile: 1 (se cer 0)"],
    ["K3", "C-PANCAKE-SHORT", "short-lp-other-pair",         "evenimente LP pe toate cheile: 1 (se cer 0)"],
    ["K4", "C-PANCAKE-SHORT", "short-swap-line-other-chain", "linii de swap în consolă, pe toate chain-urile: 1 (se cer 0)"],
    ["K5", "C-PANCAKE-SHORT", "short-lp-line-other-chain",   "linii LP în consolă, pe toate chain-urile: 1 (se cer 0)"],
    ["K6", "C-PANCAKE-SHORT", "pancake-kind-unmapped",       "wsLastMessageAtByKind nu a fost marcat pentru base:v3"],
    ["K7", "C-PANCAKE-BUY",   "pancake-kind-unmapped",       "wsLastMessageAtByKind nu a fost marcat pentru base:v3"],
    ["K8", "C-PANCAKE-BUY",   "buy-extra-swap-other-chain",  "swapuri înregistrate în wsFlow, pe toate cheile: 2 (se cere exact 1, cel al perechii controlului)"],
    ["K9", "C-PANCAKE-BUY",   "buy-variant-missing",         "linia de swap nu conține câmpul swapVariant=pancake-v3"],
  ];
  for (const [n, control, fault, reason] of single) {
    const v = await run(control, [`--control=${control}`, `--fault=${fault}`]);
    check(`${n}. ${control} + ${fault} → CONTROL_FAILED cu motivul exact, singurul`, exactly(v, [reason]), why(v));
  }
  {
    const v = await run("C-PANCAKE-BUY", ["--control=C-PANCAKE-BUY", "--fault=buy-sign-negated"]);
    check("K10. C-PANCAKE-BUY + buy-sign-negated → CONTROL_FAILED cu direcția înregistrată SELL",
      v.outcome === "CONTROL_FAILED" && v.reasons.includes("direcție înregistrată: SELL"), why(v));
  }
  const SENT = "logul controlului nu a fost trimis exact o dată prin filtru";
  const RECEIVED = "logul controlului nu a fost primit exact o dată de worker";
  {
    const v = await run("C-PANCAKE-SHORT", ["--control=C-PANCAKE-SHORT", "--fault=none", "--tamper=duplicate-delivery"]);
    check("K11. C-PANCAKE-SHORT + livrare dublă → CONTROL_FAILED, exact motivele de trimitere și recepție", exactly(v, [SENT, RECEIVED]), why(v));
  }
  {
    const v = await run("C-PANCAKE-BUY", ["--control=C-PANCAKE-BUY", "--fault=none", "--tamper=duplicate-delivery"]);
    check("K12. C-PANCAKE-BUY + livrare dublă → CONTROL_FAILED, cu motivele de trimitere și recepție",
      v.outcome === "CONTROL_FAILED" && v.reasons.includes(SENT) && v.reasons.includes(RECEIVED), why(v));
  }
  {
    const v = await run("C-PANCAKE-SHORT", ["--control=C-PANCAKE-SHORT", "--fault=pancake-throws"]);
    check("K13. C-PANCAKE-SHORT + pancake-throws → HARNESS_ERROR, singurul motiv: linia [WS ERR (regula runtime-ului), fără observații",
      v.outcome === "HARNESS_ERROR" && JSON.stringify(v.reasons) === JSON.stringify(["înainte de închidere: linie [WS ERR în captura de consolă"])
        && Object.keys(v.observations).length === 0, why(v));
    check("K13b. pancake-throws: procesul de caz s-a terminat singur, cu cod 0 (rezultat valid serializat), terminare confirmată",
      v.diagnostics?.code === 0 && v.diagnostics.signal === null && !v.diagnostics.timedOut && v.diagnostics.terminationConfirmed, why(v));
    const s = summarize([v]);
    check("K13c. o rulare care conține acest HARNESS_ERROR e invalidă: cod 3",
      s.exitCode === 3 && s.invalid.includes("C-PANCAKE-SHORT: HARNESS_ERROR"), JSON.stringify(s));
  }
}

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
    ["P1",        "DEFECT_REPRODUCED", o => o.logsSent === 1 && o.logsReceived === 1 && o.swapsRecorded === 0 && o.priceEth === null],
    ["M1-FORCED", "DEFECT_REPRODUCED", o => o.forcedSent === 1 && o.forcedReceived === 1 && o.swapsRecorded === 0 && typeof o.forcedNote === "string"],
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
    ["P1",        "fixed-price-fallback", "DEFECT_NOT_REPRODUCED", "swapuri înregistrate: 1"],
    ["M1-FORCED", "fixed-map-route",      "HARNESS_ERROR",         "montaj:"],
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
    ["P1", "handler-throws",            "[WS ERR"],            // (T2: mutat de pe T2, retras) logul P1 e livrat → handlerul aruncă pe el
    ["P1", "async-handler",             "activeJobCount()"],
    ["M1-FORCED", "never-subscribes",   "montaj:"],
    ["M2", "import-timer",              "timer creat la import"],  // (T2: mutat de pe T2, retras)
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
    ["P1",        "deliver-twin",     "geamănul negativ (topic străin) a fost trimis de nod"],
    ["M1-FORCED", "forced-inactive",  "deliverForced pe o subscripție care nu e activă la nod"],
    ["M1-FORCED", "forced-missing",   ": trimis de 0 ori (se cere exact o dată)"],
    ["M1-FORCED", "forced-double",    ": trimis de 2 ori (se cere exact o dată)"],
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
