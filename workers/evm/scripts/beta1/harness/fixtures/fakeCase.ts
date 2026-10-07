/**
 * scripts/beta1/harness/fixtures/fakeCase.ts — BETA-1, felia 2: proces de caz FALS, pentru controalele
 * supraveghetorului. Nu exercită nimic din worker; doar se poartă cum îi cere `--mode=`.
 *
 * Citește `--case=<id>`, `--kind=`, `--section=`, `--mode=`. Modurile acoperă fiecare ramură a verdictului.
 */

import { spawn } from "node:child_process";
import { serializeCaseResult, CASE_RESULT_SCHEMA, type CaseResult, type CaseKind, type CaseSection, type Outcome } from "../caseProtocol";

const arg = (name: string): string | null =>
  process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const caseId  = arg("case") ?? "";
const kind    = (arg("kind") ?? "control") as CaseKind;
const section = (arg("section") ?? "filter") as CaseSection;
const mode    = arg("mode") ?? "confirm";

const CONFIRM: Record<CaseKind, Outcome> = { control: "CONTROL_OK", defect: "DEFECT_REPRODUCED", partial: "PARTIAL_OBSERVED" };
const DENY:    Record<CaseKind, Outcome> = { control: "CONTROL_FAILED", defect: "DEFECT_NOT_REPRODUCED", partial: "PARTIAL_NOT_OBSERVED" };

const result = (over: Partial<CaseResult> = {}): CaseResult => ({
  schema: CASE_RESULT_SCHEMA, caseId, kind, section, outcome: CONFIRM[kind], reasons: [], observations: {}, ...over,
});
const emit = (r: unknown): void => { process.stdout.write(typeof r === "string" ? r : serializeCaseResult(r as CaseResult)); };

switch (mode) {
  case "confirm":        emit(result()); break;
  case "deny":           emit(result({ outcome: DENY[kind], reasons: ["predicția nu s-a produs (fals)"] })); break;
  case "harness-error":  emit(result({ outcome: "HARNESS_ERROR", reasons: ["barieră expirată (fals)"], observations: { swapsRecorded: 0, logsSent: 1 } })); break;
  case "deny-no-reason": emit(result({ outcome: DENY[kind], reasons: [] })); break;
  case "env":            emit(result({ observations: { envKeys: Object.keys(process.env).sort() } })); break;
  case "no-output":      break;
  case "two-lines":      emit(result()); emit(result()); break;
  case "noise-then-json": emit("zgomot pe stdout\n"); emit(result()); break;
  case "invalid-json":   emit("{nu e json\n"); break;
  case "not-object":     emit("[1,2,3]\n"); break;
  case "wrong-case":     emit(result({ caseId: "ALT-CAZ" })); break;
  case "wrong-kind":     emit(result({ kind: kind === "control" ? "defect" : "control" })); break;
  case "wrong-section":  emit(result({ section: section === "filter" ? "forced" : "filter" })); break;
  case "cross-outcome":  emit(result({ outcome: kind === "control" ? "DEFECT_REPRODUCED" : "CONTROL_OK" })); break;
  case "unknown-outcome": emit(JSON.stringify({ ...result(), outcome: "PROBABLY_FINE" }) + "\n"); break;
  case "extra-field":    emit(JSON.stringify({ ...result(), verdict: "ok" }) + "\n"); break;
  case "missing-field": {
    const r: Record<string, unknown> = { ...result() };
    delete r.observations;
    emit(JSON.stringify(r) + "\n");
    break;
  }
  case "wrong-schema":   emit(JSON.stringify({ ...result(), schema: "beta1-case/0" }) + "\n"); break;
  case "exit-nonzero":   emit(result()); process.exitCode = 1; break;
  case "exit-3-valid":   emit(result()); process.exitCode = 3; break;
  case "self-signal":    emit(result()); process.kill(process.pid, "SIGTERM"); break;
  case "hang":           emit(result()); setInterval(() => { /* nu se termină */ }, 1_000); break;
  case "hang-silent":    setInterval(() => { /* nu se termină, fără rezultat */ }, 1_000); break;
  case "hang-ignore-term":
    process.on("SIGTERM", () => { /* ignoră */ });
    process.on("SIGINT",  () => { /* ignoră */ });
    setInterval(() => { /* nu se termină */ }, 1_000);
    break;
  case "flood": {
    // FINIT: ~4 MiB, apoi proces terminat normal. Dacă plafonul supraveghetorului n-ar fi aplicat, cazul se
    // încheie singur și controlul eșuează cu nume — nu prin epuizarea memoriei.
    const chunk = "x".repeat(65_535) + "\n";
    let left = 64;
    const pump = (): void => {
      while (left > 0) { left--; if (!process.stdout.write(chunk)) { process.stdout.once("drain", pump); return; } }
    };
    pump();
    break;
  }
  case "observe":
    emit(result({ observations: { requestedFilter: { topics: [["0xaa"]] }, logsSent: 2, logsReceived: 2, swapsRecorded: 1 } }));
    break;
  case "orphan": {
    // Lasă un proces în GRUPUL cazului și iese normal, cu rezultat valid: supraveghetorul trebuie să-l găsească.
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    g.unref();
    process.stderr.write(`ORPHAN_PID=${g.pid}\n`);
    emit(result());
    break;
  }
  case "short-child": {
    // Copil în grupul cazului care se închide SINGUR la scurt timp după părinte (ca serviciul esbuild al tsx).
    const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: "ignore" });
    g.unref();
    process.stderr.write(`SHORT_PID=${g.pid}\n`);
    emit(result());
    break;
  }
  case "throw":          throw new Error("excepție la pornirea cazului (fals)");
  default:               throw new Error(`mod necunoscut: ${mode}`);
}
