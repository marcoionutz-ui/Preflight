/** P1 real-module acceptance: run explicitly in WSL, not a worker entrypoint. */
import { resolve } from "node:path";
import { runSuite, type RunnableCase } from "./harness/supervisor";

async function main(): Promise<void> {
  const file = resolve("scripts/beta1/cases/noPriceCases.ts");
  const cases: RunnableCase[] = [];
  for (const suffix of ["POSITIVE", "MISSING"]) for (const kind of ["V2", "V3", "V4"]) {
    cases.push({ id: "P1-" + kind + "-" + suffix, kind: "control", section: "filter", file });
  }
  // rev2 (cgpt P2): rutele care NU au voie să crească contorul — no-quote (V4, preț tot absent) și LP fără preț.
  for (const extra of ["P1-V4-NOQUOTE", "P1-V3-LP-MISSING"]) cases.push({ id: extra, kind: "control", section: "filter", file });
  const report = await runSuite(cases, { deadlineMs: 20_000, fixedEnv: { PREFLIGHT_MODE: "LIVE", ENABLED_CHAINS: "base" }, log: console.log });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.summary.exitCode;
}
main().catch(e => { console.error(e); process.exitCode = 3; });
