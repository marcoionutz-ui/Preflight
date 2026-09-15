/**
 * scripts/canaryMarker.test.ts — PH-12 12.5c-4 (primitiva canonică `canaryRunMarker` + dovada de cablare a AMBILOR writeri).
 *
 * Fix cgpt rev6: testul de integritate din `@preflight/schema` oglindea implementarea (avea propriul `buildMark`), deci un
 * writer putea pierde `canaryRunId` fără ca testul să pice. Aici testăm PRIMITIVA REALĂ (`canaryRunMarker`, care citește
 * `process.env.CANARY_RUN_ID`) direct, ȘI dovedim prin source-guard că AMBII writeri (`state/memory.ts` = worker_snapshot,
 * `pipeline/snapshots.ts` = worker_runtime) o IMPORTĂ și o folosesc prin spread — deci proprietatea (dormant/byte-compat vs.
 * marker exact) se propagă la payloadurile reale dintr-o singură sursă de adevăr.
 *
 * PUR (doar primitiva + citire de fișiere sursă) → rulează în lanțul rapid `npm test`.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { canaryRunMarker } from "../src/lib/canaryMarker";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

// Restaurează env-ul după fiecare manipulare (testul e singur, dar fii curat).
function withEnv(val: string | undefined, fn: () => void): void {
  const prev = process.env.CANARY_RUN_ID;
  if (val === undefined) delete process.env.CANARY_RUN_ID; else process.env.CANARY_RUN_ID = val;
  try { fn(); } finally { if (prev === undefined) delete process.env.CANARY_RUN_ID; else process.env.CANARY_RUN_ID = prev; }
}

function main(): void {
  console.log("PH-12 12.5c-4 — canaryRunMarker (primitiva canonică) + cablarea ambilor writeri");

  // Payloaduri reprezentative (formele reale scrise de writeri, fără marker).
  const baseSnap = { version: "v1", savedAt: 1, memory: {}, poolReserveEth: {} };
  const baseRt   = { chain: "base", wsConnected: true, updatedAt: 1 };

  // ── 1. DORMANT + byte-compat: fără CANARY_RUN_ID → `{}` → spread no-op → payload byte-IDENTIC cu legacy ──
  withEnv(undefined, () => {
    check("1a. ⭐⭐⭐ env absent → canaryRunMarker() === {} (fără câmp)", Object.keys(canaryRunMarker()).length === 0);
    check("1b. ⭐⭐⭐ worker_snapshot byte-IDENTIC cu legacy (spread no-op)",
      JSON.stringify({ ...baseSnap, ...canaryRunMarker() }) === JSON.stringify(baseSnap));
    check("1c. ⭐⭐⭐ worker_runtime byte-IDENTIC cu legacy (spread no-op)",
      JSON.stringify({ ...baseRt, ...canaryRunMarker() }) === JSON.stringify(baseRt));
  });
  withEnv("", () => {
    check("1d. ⭐⭐ CANARY_RUN_ID gol '' → tot `{}` (byte-compat)", Object.keys(canaryRunMarker()).length === 0);
  });

  // ── 2. Prezent → marker EXACT în AMBELE payloaduri ──
  withEnv("wrkDEADBEEF", () => {
    const m = canaryRunMarker();
    check("2a. ⭐⭐⭐ env prezent → {canaryRunId} cu valoarea exactă", "canaryRunId" in m && (m as { canaryRunId: string }).canaryRunId === "wrkDEADBEEF");
    check("2b. ⭐⭐⭐ worker_snapshot poartă canaryRunId exact",
      JSON.parse(JSON.stringify({ ...baseSnap, ...canaryRunMarker() })).canaryRunId === "wrkDEADBEEF");
    check("2c. ⭐⭐⭐ worker_runtime poartă canaryRunId exact",
      JSON.parse(JSON.stringify({ ...baseRt, ...canaryRunMarker() })).canaryRunId === "wrkDEADBEEF");
  });

  // ── 3. CABLARE (source-guard): AMBII writeri importă ȘI folosesc primitiva prin spread ──
  // Fără asta, un writer ar putea reintroduce un `buildMark` local (sau pierde markerul) fără ca testul să pice.
  const workerDir  = process.cwd();
  const snapSrc    = readFileSync(path.join(workerDir, "src", "state", "memory.ts"), "utf8");
  const runtimeSrc = readFileSync(path.join(workerDir, "src", "pipeline", "snapshots.ts"), "utf8");
  const wiredIn = (src: string) =>
    /import\s*\{\s*canaryRunMarker\s*\}\s*from\s*["'][^"']*lib\/canaryMarker["']/.test(src) &&
    /\.\.\.\s*canaryMark\b/.test(src) &&
    /canaryRunMarker\s*\(\s*\)/.test(src);
  check("3a. ⭐⭐⭐ state/memory.ts (worker_snapshot) importă ȘI spread-uiește canaryRunMarker()", wiredIn(snapSrc));
  check("3b. ⭐⭐⭐ pipeline/snapshots.ts (worker_runtime) importă ȘI spread-uiește canaryRunMarker()", wiredIn(runtimeSrc));
  // Anti-regres: niciun writer nu-și mai definește un marker LOCAL (sursă unică de adevăr).
  check("3c. ⭐⭐ niciun `buildMark`/`typeof process.env.CANARY_RUN_ID` local în writeri (o singură sursă)",
    !/buildMark/.test(snapSrc) && !/buildMark/.test(runtimeSrc) &&
    !/process\.env\.CANARY_RUN_ID/.test(snapSrc) && !/process\.env\.CANARY_RUN_ID/.test(runtimeSrc));

  console.log(`\n${passed}/${passed + failed} OK` + (failed ? `  —  ${failed} FAIL` : ""));
  if (failed) process.exit(1);
}

main();
