/**
 * scripts/beta1/harness/selfTestRunner.ts — BETA-1, felia 1: rulează selfTest ca procese copil și verifică
 * TERMINAREA, nu doar raportul.
 *
 *   - rularea de bază: cod 0, `ok:true`, terminare naturală în termen;
 *   - fiecare injecție: cod 3, `ok:false`, eșecul așteptat prezent, terminare naturală în termen.
 *
 * „Terminare naturală" = procesul iese singur, fără semnal. Un copil oprit de termenul-limită al runnerului e EȘEC:
 * raportul de eșec fără terminare nu ajunge (exact cazul unei bariere expirate cu socketuri rămase deschise).
 *
 * NU instalează gărzi (pornește procese) și NU importă nimic din `src/`. Cod de ieșire: 0 = totul conform; 3 = altfel.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { INJECTIONS } from "./injections";

const DEADLINE_MS = 30_000;
const SELF_TEST = path.join(__dirname, "selfTest.ts");

interface ChildOutcome {
  code:     number | null;
  signal:   NodeJS.Signals | null;
  timedOut: boolean;
  ms:       number;
  stdout:   string;
}

function runChild(args: string[]): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve) => {
    const started = Date.now();
    // Mediu construit de la zero: doar ce-i trebuie lui node/tsx ca să pornească.
    const env: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"]) {
      const v = process.env[k];
      if (typeof v === "string") env[k] = v;
    }
    const child = spawn(process.execPath, [...process.execArgv, SELF_TEST, ...args], {
      env, stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, DEADLINE_MS);
    child.on("error", () => { /* raportat prin `close` cu cod null */ });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, ms: Date.now() - started, stdout });
    });
  });
}

interface Report { ok?: unknown; inject?: unknown; failed?: unknown; failures?: unknown; }

/** Exact o linie JSON pe stdout; altfel `null` (rezultat lipsă, dublu sau invalid). */
function parseReport(stdout: string): Report | null {
  const lines = stdout.split("\n").filter(l => l.trim() !== "");
  if (lines.length !== 1) return null;
  try {
    const v: unknown = JSON.parse(lines[0]);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Report : null;
  } catch { return null; }
}

async function main(): Promise<void> {
  const problems: string[] = [];
  const row = (name: string, o: ChildOutcome, verdict: string): void => {
    console.log(`${verdict.padEnd(6)} ${name.padEnd(26)} cod=${String(o.code).padEnd(4)} semnal=${String(o.signal).padEnd(7)} ${o.ms}ms`);
  };

  // Rularea de bază.
  {
    const o = await runChild([]);
    const r = parseReport(o.stdout);
    const why: string[] = [];
    if (o.timedOut || o.signal !== null) why.push("nu s-a terminat natural");
    if (o.code !== 0) why.push(`cod ${o.code}, se aștepta 0`);
    if (!r) why.push("raport lipsă/invalid");
    else if (r.ok !== true || r.inject !== null) why.push("raportul nu e ok:true fără injecție");
    row("(bază)", o, why.length ? "EȘEC" : "OK");
    if (why.length) problems.push(`bază: ${why.join("; ")}`);
  }

  // Injecțiile: TREBUIE să eșueze cu motivul injectat ȘI să se termine.
  for (const inj of INJECTIONS) {
    const o = await runChild([`--inject=${inj.name}`]);
    const r = parseReport(o.stdout);
    const why: string[] = [];
    if (o.timedOut || o.signal !== null) why.push("nu s-a terminat natural");
    if (o.code !== 3) why.push(`cod ${o.code}, se aștepta 3`);
    if (!r) why.push("raport lipsă/invalid");
    else {
      if (r.ok !== false) why.push("raportul nu e ok:false");
      if (r.inject !== inj.name) why.push("raportul nu poartă injecția cerută");
      const fs = Array.isArray(r.failures) ? r.failures.filter((x): x is string => typeof x === "string") : [];
      if (!fs.some(f => f.includes(inj.expect))) why.push(`lipsește eșecul așteptat („${inj.expect}")`);
    }
    row(inj.name, o, why.length ? "EȘEC" : "OK");
    if (why.length) problems.push(`${inj.name}: ${why.join("; ")}`);
  }

  console.log("");
  if (problems.length === 0) {
    console.log(`selfTestRunner: OK — bază verde; ${INJECTIONS.length}/${INJECTIONS.length} injecții au eșuat cum trebuie și s-au terminat natural.`);
    console.log("Asta validează DOAR uneltele probei. Nu spune nimic despre worker sau despre BETA-1.");
    process.exitCode = 0;
  } else {
    console.log("selfTestRunner: EȘEC");
    for (const p of problems) console.log("  - " + p);
    process.exitCode = 3;
  }
}

main().catch((e: unknown) => {
  console.log("selfTestRunner: excepție — " + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 3;
});
