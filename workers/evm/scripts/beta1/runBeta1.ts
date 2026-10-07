/**
 * scripts/beta1/runBeta1.ts — BETA-1: punctul de intrare al probei.
 *
 * Rulează manifestul prin supraveghetor: un proces per caz, mediu construit de la zero, termen-limită, terminare
 * confirmată. Tipărește raportul pe cele trei secțiuni și iese cu:
 *
 *   0 — experiment valid și toate predicțiile confirmate (NU înseamnă produs sănătos);
 *   2 — controale în regulă, dar cel puțin o predicție contrazisă;
 *   3 — rularea nu dovedește nimic (control eșuat, HARNESS_ERROR, caz nerulat).
 *
 * NU e entrypointul workerului și NU e cablat în `npm test`. Fără rețea în afara nodului local al fiecărui caz.
 */

import { runSuite } from "./harness/supervisor";
import type { CaseSection } from "./harness/caseProtocol";
import { CASES } from "./cases/manifest";

const SECTIONS: Array<[CaseSection, string]> = [
  ["filter",  "Cazuri prin filtrul nodului local"],
  ["forced",  "Livrare forțată (ocolește filtrul; nu dovedește nimic despre filtru sau despre un nod real)"],
  ["partial", "Observații parțiale (nu sunt dovadă cap-coadă)"],
];

async function main(): Promise<void> {
  console.log(`BETA-1 — ${CASES.length} caz(uri). Fiecare rulează în procesul lui.\n`);
  const report = await runSuite(CASES, {
    deadlineMs: 60_000,
    fixedEnv:   { PREFLIGHT_MODE: "LIVE" },
    log:        (line) => { console.log(line); },
  });

  for (const [section, title] of SECTIONS) {
    const vs = report.verdicts.filter(v => v.spec.section === section);
    if (vs.length === 0) continue;
    console.log(`\n== ${title} ==`);
    for (const v of vs) {
      console.log(`${(v.outcome ?? "NOT_RUN").padEnd(22)} ${v.spec.id}`);
      for (const r of v.reasons) console.log(`    - ${r}`);
      if (Object.keys(v.observations).length > 0) console.log(`    observații: ${JSON.stringify(v.observations)}`);
    }
  }

  console.log("");
  if (report.aborted) console.log(`SUITĂ OPRITĂ la cazul ${report.aborted.caseId} (pid ${report.aborted.pid}): terminare neconfirmată.`);
  for (const why of report.summary.invalid) console.log(`invalid: ${why}`);
  console.log(`numărătoare: ${JSON.stringify(report.summary.counts)}`);
  const meaning =
    report.summary.exitCode === 0 ? "experiment valid, predicții confirmate — NU înseamnă produs sănătos, iar BETA-1 rămâne nerezolvat" :
    report.summary.exitCode === 2 ? "controale în regulă, dar cel puțin o predicție contrazisă" :
    "rularea nu dovedește nimic";
  console.log(`cod de ieșire: ${report.summary.exitCode} (${meaning})`);
  process.exitCode = report.summary.exitCode;
}

main().catch((e: unknown) => {
  console.log("runBeta1: excepție — " + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 3;
});
