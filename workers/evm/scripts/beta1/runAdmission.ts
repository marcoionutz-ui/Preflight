/**
 * scripts/beta1/runAdmission.ts — BETA-1, treapta 2: punctul de intrare al probei de ADMITERE REALĂ.
 *
 * Rulează cele cinci cazuri A2-* prin supraveghetor (un proces per caz, mediu construit de la zero, termen,
 * terminare confirmată): întâi controalele (A2-S-V3, A2-S-V4, A2-D5), apoi cazurile de defect (A2-F-V3, A2-F-V4),
 * numai dacă toate controalele sunt CONTROL_OK. Mediul fix (design §3): `PREFLIGHT_MODE=LIVE`, `ENABLED_CHAINS=base`,
 * `DISCOVERY_SOURCE=gecko`; fără `REDIS_URL`, `TELEGRAM_*`, `GOPLUS_API_KEY` (nimic nu se moștenește în afara
 * `INHERITED_ENV_KEYS`).
 *
 * Cod de ieșire: 0 = experiment valid, predicții baseline confirmate (NU înseamnă produs sănătos; BETA-1 rămâne
 * deschis); 2 = cel puțin o predicție contrazisă; 3 = rularea nu dovedește nimic.
 *
 * Rulat EXPLICIT în WSL, NU e în `npm test` și NU e entrypointul workerului.
 */

import path from "node:path";
import { runSuite, type RunnableCase } from "./harness/supervisor";
import { ADMISSION_IDS, ADMISSION_DEFS } from "./cases/admissionDefs";

export const ADMISSION_FILE = path.join(__dirname, "cases", "admissionCases.ts");
export const ADMISSION_ENV = { PREFLIGHT_MODE: "LIVE", ENABLED_CHAINS: "base", DISCOVERY_SOURCE: "gecko" } as const;

export const ADMISSION_CASES: RunnableCase[] = ADMISSION_IDS.map((id): RunnableCase => ({
  id, kind: ADMISSION_DEFS[id].kind, section: ADMISSION_DEFS[id].section, file: ADMISSION_FILE,
}));

async function main(): Promise<void> {
  console.log(`BETA-1 / treapta 2 — ${ADMISSION_CASES.length} caz(uri) de admitere reală. Fiecare rulează în procesul lui.\n`);
  const report = await runSuite(ADMISSION_CASES, {
    deadlineMs: 60_000, fixedEnv: { ...ADMISSION_ENV }, log: (line) => { console.log(line); },
  });
  console.log("");
  for (const v of report.verdicts) {
    console.log(`${(v.outcome ?? "NOT_RUN").padEnd(22)} ${v.spec.id}`);
    for (const r of v.reasons) console.log(`    - ${r}`);
    if (Object.keys(v.observations).length > 0) console.log(`    observații: ${JSON.stringify(v.observations)}`);
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

if (require.main === module) {
  main().catch((e: unknown) => {
    console.log("runAdmission: excepție — " + (e instanceof Error ? e.message : String(e)));
    process.exitCode = 3;
  });
}
