/**
 * scripts/beta1/cases/admissionCases.ts — BETA-1, treapta 2: procesul de caz al ADMITERII REALE.
 *
 * Rulează UN caz A2-* (`--case=<id>`) peste codul REAL al workerului. `importScan` adaugă `src/pipeline/scan` la
 * modulele încărcate DUPĂ gărzi, în faza `import` (verificată: fără timere, fetch sau conexiuni la import). Definițiile
 * și corpul sunt în `admissionDefs.ts`. Un id necunoscut dă HARNESS_ERROR.
 */

import { runCase } from "../harness/caseRuntime";
import type { CaseSpec } from "../harness/caseProtocol";
import { ADMISSION_DEFS, admissionBody } from "./admissionDefs";

const caseId = process.argv.find(a => a.startsWith("--case="))?.slice("--case=".length) ?? "";
const def = Object.prototype.hasOwnProperty.call(ADMISSION_DEFS, caseId) ? ADMISSION_DEFS[caseId] : undefined;
const spec: CaseSpec = { id: caseId, kind: def?.kind ?? "defect", section: def?.section ?? "filter" };
runCase(spec, async (ctx) => {
  if (!def) throw new Error(`caz necunoscut: ${caseId}`);
  return admissionBody(def, ctx);
}, { importScan: true });
