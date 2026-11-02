/**
 * scripts/beta1/harness/fixtures/fakeAdmissionCase.ts — BETA-1, treapta 2: proces de caz A2-* peste WORKERUL FALS.
 *
 * Același `runCase` și același corp (`admissionBody`) ca în cazurile reale, dar cu `loadSrc` înlocuit de workerul
 * fals al admiterii și cu un defect injectat (`--fault=`, eventual compus `a+b`). `--tamper=deliver-twin`: nodul trimite geamănul negativ ca
 * log obișnuit pe o subscripție activă, DUPĂ verificarea filtrelor (garda geamănului). Folosit DOAR de
 * `admissionSelfTest`. Nu spune nimic despre workerul real.
 */

import { runCase } from "../caseRuntime";
import type { LocalNode } from "../localNode";
import type { CaseSpec } from "../caseProtocol";
import { ADMISSION_DEFS, admissionBody } from "../../cases/admissionDefs";
import { loadFakeAdmissionSrc, parseA2Faults } from "./fakeAdmissionWorker";

const arg = (name: string): string =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";

const caseId = arg("case");
const faultArg = arg("fault") || "none";
const tamperArg = arg("tamper");
const def = Object.prototype.hasOwnProperty.call(ADMISSION_DEFS, caseId) ? ADMISSION_DEFS[caseId] : undefined;
const spec: CaseSpec = { id: caseId, kind: def?.kind ?? "defect", section: def?.section ?? "filter" };

function tamperNode(node: LocalNode): LocalNode {
  if (tamperArg !== "deliver-twin" || !def) throw new Error(`alterare de nod necunoscută: ${tamperArg}`);
  const twinHash = def.target.twin.transactionHash;
  const relabeled = new Set<string>();
  const t: LocalNode = { ...node };
  t.offerLogs = (logs) => {
    const n = node.offerLogs(logs);
    const twin = logs.find(l => l.transactionHash === twinHash);
    if (!twin) return n;
    const active = node.subscriptions().find(s => s.active);
    if (!active) throw new Error("deliver-twin: nicio subscripție activă");
    node.forceSend(twin, active.subId);
    relabeled.add(twinHash);
    return n + 1;
  };
  t.sent = () => node.sent().map(f => (f.kind === "forced-log" && f.marker !== null && relabeled.has(f.marker) ? { ...f, kind: "log" as const } : f));
  return t;
}

runCase(spec, async (ctx) => {
  if (!def) throw new Error(`caz necunoscut: ${caseId}`);
  return admissionBody(def, ctx);
}, {
  loadSrc: () => {
    if (!parseA2Faults(faultArg)) throw new Error(`defect necunoscut: ${faultArg}`);   // M12 rev2: și combinații `a+b`
    return loadFakeAdmissionSrc(faultArg);
  },
  selfTestNodeTamper: tamperArg ? tamperNode : undefined,
});
