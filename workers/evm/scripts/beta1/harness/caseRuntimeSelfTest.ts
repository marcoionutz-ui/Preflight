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
 * TERMINARE NECONFIRMATĂ: dacă supraveghetorul nu poate confirma că un proces de caz și grupul lui nu mai au
 * procese vii, lansatorul OPREȘTE imediat orice lansare următoare, păstrează cazul și PID-ul, iar cleanup-ul
 * mărginit din `finally` oprește procesul rămas și verifică rezultatul. Secțiunea E dovedește acest comportament.
 *
 * NU importă nimic din `src/` și NU exercită workerul real: un rezultat verde aici spune doar că runtime-ul
 * decide corect. Cod de ieșire: 0 = toate controalele au trecut; 3 = altfel.
 */

import path from "node:path";
import { runCaseProcess, verdictFor, pidAlive, groupAlive, type RunnableCase, type SupervisorOptions } from "./supervisor";
import type { CaseVerdict, Outcome } from "./caseProtocol";

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
  run(id: string, args: string[], extra?: Partial<SupervisorOptions>): Promise<CaseVerdict>;
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
    async run(id, args, extra = {}) {
      if (stuck !== null) throw new UnconfirmedTermination(stuck.caseId, stuck.pid);
      launches++;
      const c: RunnableCase = { id, kind: "control", section: "filter", file: FAKE_CASE, args };
      const p = await runCaseProcess(c, { ...OPTS, ...extra });
      if (p.pid !== null) pids.push(p.pid);
      if (p.unreaped) {
        stuck = { caseId: id, pid: p.pid };
        throw new UnconfirmedTermination(id, p.pid);
      }
      return verdictFor({ id, kind: "control", section: "filter" }, p);
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

const why = (v: CaseVerdict): string => `${v.outcome}: ${v.reasons.join(" | ").slice(0, 300)}`;

async function main(): Promise<void> {
  console.log("A. traseul bun, pe fiecare tip");
  for (const control of ["C-V2-BUY", "C-V2-SELL", "C-V3-BUY", "C-V3-SELL", "C-V4-BUY", "C-V4-SELL", "C-STABLE-BUY", "C-STABLE-SELL"]) {
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

  console.log("D. procese rămase");
  const all = [...new Set(L.pids())];
  const survivors = all.filter(alive);
  check(`D1. niciunul dintre cele ${all.length} procese de caz nu mai e viu`, all.length >= 24 && survivors.length === 0);
  check("D2. lansatorul principal nu a întâlnit nicio terminare neconfirmată", L.stuck() === null);
  for (const pid of survivors) { try { process.kill(-pid, "SIGKILL"); } catch { /* deja oprit */ } }

  await unconfirmedRegression();
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
