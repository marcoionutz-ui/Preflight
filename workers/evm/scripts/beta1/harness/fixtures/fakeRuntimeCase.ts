/**
 * scripts/beta1/harness/fixtures/fakeRuntimeCase.ts — BETA-1, felia 3: proces de caz peste WORKERUL FALS.
 *
 * Același `runCase` și același corp de control ca în cazurile reale, dar cu `loadSrc` înlocuit de workerul fals și
 * cu un defect injectat (`--fault=`). Folosit DOAR de `caseRuntimeSelfTest`. Nu spune nimic despre workerul real.
 */

import { runCase } from "../caseRuntime";
import type { CaseSpec } from "../caseProtocol";
import { CONTROLS, controlBody } from "../../cases/controlDefs";
import { loadFakeSrc, FAULTS, type Fault } from "./fakeWorker";

const arg = (name: string): string =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";

const caseId = arg("case");
const faultArg = arg("fault") || "none";
// `--impl=` = id-ul pe care PRETINDE că îl implementează fișierul (implicit cel cerut): pentru controlul „alt caz".
const implId = arg("impl") || caseId;
const def = CONTROLS[arg("control") || "C-V3-BUY"];
const spec: CaseSpec = { id: implId, kind: "control", section: "filter" };

if (faultArg === "hang-ignore-term") {
  // Proces care nu se termină și ignoră semnalele blânde: pentru regresia „terminare neconfirmată" a self-testului.
  // Nu pornește runtime-ul și nu scrie niciun rezultat.
  process.on("SIGTERM", () => { /* ignoră */ });
  process.on("SIGINT",  () => { /* ignoră */ });
  setInterval(() => { /* nu se termină */ }, 1_000);
} else {
  runCase(spec, async (ctx) => {
    if (!def) throw new Error("control necunoscut");
    return controlBody(def, ctx);
  }, {
    loadSrc: () => {
      if (!(FAULTS as readonly string[]).includes(faultArg)) throw new Error(`defect necunoscut: ${faultArg}`);
      return loadFakeSrc(faultArg as Fault);
    },
    // Eroare scrisă DOAR în consolă, exact în fereastra de cleanup (după E, înainte de F).
    selfTestDuringCleanup: faultArg === "cleanup-console-error"
      ? () => { console.log("[WS ERR base] injectat în cleanup"); }
      : undefined,
  });
}
