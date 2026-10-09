/**
 * scripts/beta1/harness/fixtures/fakeRuntimeCase.ts — BETA-1, felia 3: proces de caz peste WORKERUL FALS.
 *
 * Același `runCase` și același corp de control ca în cazurile reale, dar cu `loadSrc` înlocuit de workerul fals și
 * cu un defect injectat (`--fault=`). Folosit DOAR de `caseRuntimeSelfTest`. Nu spune nimic despre workerul real.
 */

import { runCase } from "../caseRuntime";
import type { LocalNode } from "../localNode";
import type { CaseSpec } from "../caseProtocol";
import { CONTROLS, controlBody } from "../../cases/controlDefs";
import { DEFECTS, defectBody } from "../../cases/defectDefs";
import { loadFakeSrc, FAULTS, type Fault } from "./fakeWorker";

const arg = (name: string): string =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";

const caseId = arg("case");
const faultArg = arg("fault") || "none";
// `--impl=` = id-ul pe care PRETINDE că îl implementează fișierul (implicit cel cerut): pentru controlul „alt caz".
const implId = arg("impl") || caseId;
// `--defect=<id>` rulează corpul unui CAZ DE DEFECT (felia 4); altfel `--control=<id>` rulează un control pozitiv.
const defectId = arg("defect");
const defect = defectId && Object.prototype.hasOwnProperty.call(DEFECTS, defectId) ? DEFECTS[defectId] : undefined;
const def = CONTROLS[arg("control") || "C-V3-BUY"];
const spec: CaseSpec = defect
  ? { id: implId, kind: defect.kind, section: defect.section }
  : { id: implId, kind: "control", section: "filter" };

/**
 * `--tamper=` (felia 4): nodul se poartă greșit DUPĂ capturarea și verificarea filtrului. Workerul nu se schimbă.
 *   suppress-witness — martorul cazului nu e trimis, deși filtrul l-ar accepta;
 *   deliver-twin     — geamănul negativ (topic străin) e trimis ca log OBIȘNUIT, pe subscripția activă;
 *   forced-inactive  — nodul raportează toate subscripțiile ca inactive;
 *   forced-missing   — un log forțat nu e trimis deloc;
 *   forced-double    — un log forțat e trimis de două ori.
 */
const TAMPERS = ["", "suppress-witness", "deliver-twin", "forced-inactive", "forced-missing", "forced-double"] as const;
const tamperArg = arg("tamper");

function tamperNode(node: LocalNode): LocalNode {
  if (!defect || defect.shape !== "deliver") throw new Error("--tamper cere un caz de defect cu livrare");
  const hashOf = (role: "witness" | "twin"): string => {
    const o = defect.offered.find(x => x.role === role);
    if (!o) throw new Error(`cazul nu are ${role}`);
    return o.log.transactionHash;
  };
  // Cadre trimise efectiv prin `forceSend`, dar prezentate în evidență ca loguri obișnuite (geamănul livrat).
  const relabeled = new Set<string>();
  const t: LocalNode = { ...node };
  if (tamperArg === "suppress-witness") {
    const w = hashOf("witness");
    t.offerLogs = (logs) => node.offerLogs(logs.filter(l => l.transactionHash !== w));
  }
  if (tamperArg === "deliver-twin") {
    const tw = hashOf("twin");
    t.offerLogs = (logs) => {
      const n = node.offerLogs(logs);
      const twin = logs.find(l => l.transactionHash === tw);
      const active = node.subscriptions().find(s => s.active);
      if (!twin || !active) throw new Error("deliver-twin: geamăn sau subscripție activă lipsă");
      node.forceSend(twin, active.subId);
      relabeled.add(tw);
      return n + 1;
    };
    t.sent = () => node.sent().map(f => (f.kind === "forced-log" && f.marker !== null && relabeled.has(f.marker) ? { ...f, kind: "log" as const } : f));
  }
  if (tamperArg === "forced-inactive") t.subscriptions = () => node.subscriptions().map(s => ({ ...s, active: false }));
  if (tamperArg === "forced-missing")  t.forceSend = () => { /* nu trimite nimic */ };
  if (tamperArg === "forced-double")   t.forceSend = (log, subId) => { node.forceSend(log, subId); node.forceSend(log, subId); };
  return t;
}

if (faultArg === "hang-ignore-term") {
  // Proces care nu se termină și ignoră semnalele blânde: pentru regresia „terminare neconfirmată" a self-testului.
  // Nu pornește runtime-ul și nu scrie niciun rezultat.
  process.on("SIGTERM", () => { /* ignoră */ });
  process.on("SIGINT",  () => { /* ignoră */ });
  setInterval(() => { /* nu se termină */ }, 1_000);
} else {
  runCase(spec, async (ctx) => {
    if (defectId) {
      if (!defect) throw new Error("caz de defect necunoscut");
      return defectBody(defect, ctx);
    }
    if (!def) throw new Error("control necunoscut");
    return controlBody(def, ctx);
  }, {
    loadSrc: () => {
      if (!(FAULTS as readonly string[]).includes(faultArg)) throw new Error(`defect necunoscut: ${faultArg}`);
      if (!(TAMPERS as readonly string[]).includes(tamperArg)) throw new Error(`alterare de nod necunoscută: ${tamperArg}`);
      return loadFakeSrc(faultArg as Fault);
    },
    selfTestNodeTamper: tamperArg ? tamperNode : undefined,
    // Eroare scrisă DOAR în consolă, exact în fereastra de cleanup (după E, înainte de F).
    selfTestDuringCleanup: faultArg === "cleanup-console-error"
      ? () => { console.log("[WS ERR base] injectat în cleanup"); }
      : undefined,
  });
}
