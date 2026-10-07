/**
 * scripts/beta1/cases/positiveControls.ts — BETA-1, felia 3: procesul de caz al CONTROALELOR POZITIVE.
 *
 * Rulează UN control (`--case=<id>`) peste codul REAL al workerului: `runCase` fără nicio opțiune încarcă exclusiv
 * modulele din `src/`. Definițiile și corpul controalelor sunt în `controlDefs.ts`.
 */

import { runCase } from "../harness/caseRuntime";
import type { CaseSpec } from "../harness/caseProtocol";
import { CONTROLS, controlBody } from "./controlDefs";

const caseId = process.argv.find(a => a.startsWith("--case="))?.slice("--case=".length) ?? "";
const def = CONTROLS[caseId];
const spec: CaseSpec = { id: caseId, kind: "control", section: "filter" };
runCase(spec, async (ctx) => {
  if (!def) throw new Error(`caz necunoscut: ${caseId}`);
  return controlBody(def, ctx);
});
