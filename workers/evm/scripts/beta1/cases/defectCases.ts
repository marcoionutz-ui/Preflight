/**
 * scripts/beta1/cases/defectCases.ts — BETA-1, felia 4: procesul de caz al CAZURILOR DE DEFECT.
 *
 * Rulează UN caz (`--case=<id>`) peste codul REAL al workerului: `runCase` fără nicio opțiune încarcă exclusiv
 * modulele din `src/`. Definițiile și corpul cazurilor sunt în `defectDefs.ts`.
 *
 * Felul și secțiunea raportate vin din definiție și trebuie să coincidă cu manifestul (verificat de supraveghetor).
 * Un id necunoscut dă HARNESS_ERROR.
 */

import { runCase } from "../harness/caseRuntime";
import type { CaseSpec } from "../harness/caseProtocol";
import { DEFECTS, defectBody } from "./defectDefs";

const caseId = process.argv.find(a => a.startsWith("--case="))?.slice("--case=".length) ?? "";
const def = Object.prototype.hasOwnProperty.call(DEFECTS, caseId) ? DEFECTS[caseId] : undefined;
// Pentru un id necunoscut nu există fel/secțiune de raportat: rămâne „defect/filter", iar corpul aruncă.
const spec: CaseSpec = { id: caseId, kind: def?.kind ?? "defect", section: def?.section ?? "filter" };
runCase(spec, async (ctx) => {
  if (!def) throw new Error(`caz necunoscut: ${caseId}`);
  return defectBody(def, ctx);
});
