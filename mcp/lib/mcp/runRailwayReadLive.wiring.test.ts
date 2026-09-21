/**
 * lib/mcp/runRailwayReadLive.wiring.test.ts — PH-12 12.6 leaf 2b-3: guard de sursă + syntax pt. runnerul opt-in `.mjs`.
 *
 * Runnerul e .mjs (exclus din tsc/eslint) → altfel ar fi NEprotejat de suită. Aici: (1) `node --check` = validare de SINTAXĂ
 * (parse ESM, fără a executa main sau a atinge Railway); (2) source-guard pe wiring + invariante: exit prin `liveExitCode`
 * (sursă unică), target validat ÎNAINTE de echo (fără reflectarea valorii brute), coduri de exit numite, deadline global.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

let passed = 0;
const fails: string[] = [];
function assert(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }

const MJS = path.resolve(__dirname, "../../runRailwayReadLive.mjs");
const src = readFileSync(MJS, "utf-8");

// ── 1. SINTAXĂ: node --check parsează .mjs-ul (fără execuție) ─────────────────────────────────────────────────────
{
  let ok = true;
  try { execFileSync(process.execPath, ["--check", MJS], { stdio: "pipe" }); }
  catch { ok = false; }
  assert(ok, "1: `node --check` — runnerul parsează ca ESM valid");
}

// ── 2. WIRING: importă piesele comise ────────────────────────────────────────────────────────────────────────────
{
  assert(/import\s*\{[^}]*\bmakeRailwayTransport\b[^}]*\breadRailwaySnapshot\b[^}]*\}\s*from\s*["']\.\/lib\/mcp\/railwayReadClient\.ts["']/.test(src), "2a: import makeRailwayTransport + readRailwaySnapshot din client");
  assert(/import\s*\{[^}]*\bbindRoleCaps\b[^}]*\}\s*from\s*["']\.\/lib\/mcp\/profileCaps\.ts["']/.test(src), "2b: import bindRoleCaps din profileCaps");
  assert(/import\s*\{[^}]*\breadLiveState\b[^}]*\bformatLiveResult\b[^}]*\bliveExitCode\b[^}]*\}\s*from\s*["']\.\/lib\/mcp\/railwayReadLive\.ts["']/.test(src), "2c: import readLiveState + formatLiveResult + liveExitCode din compoziție");
  assert(/import\s*\{[^}]*\bSERVICE_CROSSCHECK\b[^}]*\}\s*from\s*["']\.\/lib\/mcp\/railwayReadModel\.ts["']/.test(src), "2d: import SERVICE_CROSSCHECK (commandSource derivat din catalog)");
  assert(/import\s*\{[^}]*\bSERVICE_IDS\b[^}]*\bPROFILE_NAMES\b[^}]*\}\s*from\s*["']\.\/lib\/mcp\/profilePlan\.ts["']/.test(src), "2e: import SERVICE_IDS + PROFILE_NAMES din profilePlan");
}

// ── 3. EXIT: `main` întoarce liveExitCode(result); codul se SETEAZĂ prin process.exitCode (fără process.exit dur) ───
{
  assert(/return\s+liveExitCode\(\s*result\s*\)/.test(src), "3a: codul de exit provine din liveExitCode(result) (întors de main)");
  assert(!/result\.ok\s*\?\s*0\s*:\s*1/.test(src), "3b: NU re-implementează exit-ul (fără result.ok?0:1)");
  const hardExit = (src.match(/process\.exit\(/g) ?? []).length;
  assert(hardExit === 0, `3c: FĂRĂ process.exit() dur (găsit: ${hardExit}) — evită trunchierea stdout/stderr nedrenat`);
  assert(/process\.exitCode\s*=\s*exitCode/.test(src), "3d: codul se setează prin process.exitCode (drain natural al event-loop-ului)");
}

// ── 4. Target validat ÎNAINTE de echo, fără reflectarea valorii brute ────────────────────────────────────────────
{
  assert(/PROFILE_NAMES\.includes\(\s*target\s*\)/.test(src), "4a: target validat cu PROFILE_NAMES.includes");
  // usageFail-urile NU interpolează valoarea brută (target/argv) — doar nume de câmp statice / lista permisă.
  const usageCalls = src.match(/usageFail\([^;]*\)/g) ?? [];
  assert(usageCalls.length > 0, "4b: există cel puțin un usageFail");
  assert(usageCalls.every((c) => !c.includes("${target}") && !/argv/.test(c)), "4c: usageFail NU reflectă valoarea brută (target/argv)");
  // echo-ul cu ${target} apare DOAR după validare (în console.log, nu în usageExit)
  assert(/console\.log\(`[^`]*\$\{target\}/.test(src), "4d: target afișat DOAR după validare (enum sigur)");
}

// ── 5. Coduri de exit NUMITE + deadline global ──────────────────────────────────────────────────────────────────
{
  assert(/const\s+EXIT\s*=\s*Object\.freeze\(/.test(src), "5a: coduri de exit numite (EXIT = Object.freeze)");
  assert(/new AbortController\(\)/.test(src) && /setTimeout\(\s*\(\)\s*=>\s*[A-Za-z_$][\w$]*\.abort\(\)/.test(src), "5b: deadline global (AbortController + setTimeout→abort)");
  assert(/\{\s*signal:\s*controller\.signal\s*\}/.test(src), "5c: signal-ul global e pasat lui readLiveState (opts)");
  assert(/clearTimeout\(\s*timer\s*\)/.test(src), "5d: timer-ul se curăță în finally");
}

// ── 6. Anti-leak + READ-ONLY ─────────────────────────────────────────────────────────────────────────────────────
{
  // Backstop-ul generic NU ecouă eroarea brută: marker STATIC pt. ne-UsageError.
  assert(/eroare neașteptată la rulare \(fără detalii — anti-leak\)/.test(src), "6a: backstop anti-leak cu marker static");
  // Fără forme brute de leak: `${err}`, `err.stack`, `String(err)`, `err.toString`, `JSON.stringify(err`.
  assert(!/\$\{\s*err\s*\}/.test(src) && !/err\.stack/.test(src) && !/String\(\s*err/.test(src) && !/err\.toString/.test(src) && !/JSON\.stringify\(\s*err/.test(src), "6a2: nu se ecouă eroarea brută (fără ${err}/err.stack/String(err)/toString/stringify)");
  // Singura interpolare de eroare permisă e `err.message` — STATIC prin construcție (UsageError doar din usageFail; vezi 4c).
  const errInterp = src.match(/\$\{\s*err[^}]*\}/g) ?? [];
  assert(errInterp.every((s) => /^\$\{\s*err\.message\s*\}$/.test(s)), `6a3: doar err.message interpolat (static; găsit: ${errInterp.join(" ") || "niciunul"})`);
  assert(!/\b(applyPlan|mutate|serviceInstanceUpdate|deploymentTrigger|environmentStagedCommit|environmentPatchCommit)\b/.test(src), "6b: nicio primitivă de mutație/apply");
  assert(/ZERO mutații/.test(src), "6c: marchează explicit ZERO mutații");
}

if (fails.length > 0) {
  console.error(`runRailwayReadLive.wiring.test: ${fails.length} EȘUAT / ${passed} ok`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`runRailwayReadLive.wiring.test: ${passed}/${passed} ok`);
