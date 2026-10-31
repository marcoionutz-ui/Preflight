/**
 * lib/mcp/releaseGates.test.ts — PH-5 (release gates: build PICĂ pe erori; CI acoperă tot; testele sunt CABLATE).
 *
 * varu: „release gates permit livrare neverificată". Guard de sursă pe TREI axe (v2 după cgpt — v1 overclaima):
 *   (a) `next.config.ts` NU mai ignoră erorile TS/ESLint la build (`false`, nu `true`).
 *   (b) WORKFLOW-ul AUTOMAT REAL (`.github/workflows/typecheck.yml`, push/PR pe main) pornește Redis ȘI rulează
 *       typecheck + test + lint — ancorat în acel fișier, nu în uniunea workflow-urilor (o copie manuală ar masca). (v1 nu citea
 *       deloc workflow-ul → ar fi rămas verde dacă CI scotea Redis/test/typecheck. cgpt obs. 1.)
 *   (c) FIECARE fișier `*.test.ts` din FIECARE workspace e ACCESIBIL tranzitiv din scriptul agregat `test` al acelui
 *       workspace. `--workspaces --if-present` NU dovedește asta: un `*.test.ts` nou fără intrare în lanțul `test:*`
 *       e sărit tăcut de CI — exact clasa PH-6. (cgpt obs. 2.) Descoperim workspace-urile + fișierele dinamic.
 *
 * cwd = pachetul mcp; repo root = `..`.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const ROOT = "..";
const join = (...p: string[]): string => p.join("/").replace(/\/+/g, "/");

// readdir care nu aruncă (dir inexistent → gol). Tipurile sunt inferate → fără adnotări fragile.
function ddTypes(dir: string) { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
function ddNames(dir: string) { try { return readdirSync(dir); } catch { return []; } }

// walk pentru *.test.ts, sărind node_modules/.next/.git/dist
function walkTests(dir: string): string[] {
  const out: string[] = [];
  for (const e of ddTypes(dir)) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === ".git" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTests(p));
    else if (e.isFile() && e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// rezolvă workspace-urile din glob-urile root (packages/*, workers/*, mcp)
function resolveWorkspaces(): string[] {
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces?: string[] };
  const dirs: string[] = [];
  for (const g of root.workspaces ?? []) {
    if (g.endsWith("/*")) {
      const base = g.slice(0, -2);
      for (const e of ddTypes(join(ROOT, base))) {
        if (e.isDirectory() && existsSync(join(ROOT, base, e.name, "package.json"))) dirs.push(base + "/" + e.name);
      }
    } else if (existsSync(join(ROOT, g, "package.json"))) {
      dirs.push(g);
    }
  }
  return dirs;
}

// fișierele *.test.ts accesibile TRANZITIV din scriptul `test` (urmărind `npm run test:*`)
function reachableFromTest(scripts: Record<string, string>): Set<string> {
  const visited = new Set<string>();
  const files = new Set<string>();
  const stack = ["test"];
  while (stack.length) {
    const name = stack.pop() as string;
    if (visited.has(name)) continue;
    visited.add(name);
    const body = scripts[name];
    if (!body) continue;
    for (const m of body.matchAll(/npm run ([\w:@/.-]+)/g)) stack.push(m[1]);
    for (const m of body.matchAll(/([^\s'"]+\.test\.ts)/g)) files.add(m[1].replace(/^\.\//, ""));
  }
  return files;
}

function main(): void {
console.log("PH-5 — release gates v2 (build fails on errors; CI real; TOATE testele cablate)");

// ── (a) next.config.ts: build gates ON ──
const nextCfg = readFileSync("next.config.ts", "utf8");
check("1. next.config: ignoreBuildErrors NU e true (TS errors sparg build-ul)", !/ignoreBuildErrors:\s*true/.test(nextCfg));
check("2. next.config: ignoreBuildErrors declarat explicit false", /ignoreBuildErrors:\s*false/.test(nextCfg));
check("3. next.config: ignoreDuringBuilds NU e true (lint errors sparg build-ul)", !/ignoreDuringBuilds:\s*true/.test(nextCfg));
check("4. next.config: ignoreDuringBuilds declarat explicit false", /ignoreDuringBuilds:\s*false/.test(nextCfg));

// ── (b) root package.json: typecheck + test pe TOATE workspace-urile ──
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
const rs = rootPkg.scripts ?? {};
check("5. root typecheck ruleaza pe --workspaces", /--workspaces/.test(rs.typecheck ?? ""));
check("6. root test ruleaza pe --workspaces", /--workspaces/.test(rs.test ?? ""));
check("7. root test are --if-present", /--if-present/.test(rs.test ?? ""));

// ── (b') WORKFLOW REAL: Redis + typecheck + test + lint (cgpt obs. 1) ──
// Ancorate în workflow-ul AUTOMAT `typecheck.yml` (cel care rulează la push/PR pe main), NU în uniunea tuturor
// workflow-urilor: un eventual workflow manual (doar `workflow_dispatch`) care copiază pașii ar masca altfel o
// regresie în CI-ul automat (cgpt, P2 la review-ul compatibilității Ubuntu 26.04; acel workflow nu s-a mai adăugat —
// CI-ul rulase deja verde pe ubuntu-26.04 — dar regula rămâne, iar regresiile o exercită cu o copie sintetică).
const wfDir = join(ROOT, ".github/workflows");
const wfFiles = ddNames(wfDir).filter((f: string) => f.endsWith(".yml") || f.endsWith(".yaml"));
check("8. exista cel putin un workflow CI in .github/workflows", wfFiles.length > 0);
const AUTO_WF = "typecheck.yml";
const autoWf = wfFiles.includes(AUTO_WF) ? readFileSync(join(wfDir, AUTO_WF), "utf8") : "";
// Comenzile EXECUTABILE ale unui workflow: valorile `run:` (o linie sau bloc `run: |`/`run: >`), fără comentarii.
// Fiecare comandă e spartă în segmente pe `&&`, `||`, `;` → un marcator cere un SEGMENT exact, nu o mențiune oarecare
// (cgpt, P2 pe rev1: `npm (run )?test\b` găsea și comentariul PH-4 și `npm run test:integration`).
function runSegments(t: string): string[] {
  const lines = t.split("\n");
  const cmds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const head = m[2].trim();
    if (head === "|" || head === ">" || head === "|-" || head === ">-") {
      const ind = m[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") continue;
        if (l.length - l.trimStart().length <= ind) break;
        cmds.push(l.trim());
      }
    } else if (head !== "") {
      cmds.push(head);
    }
  }
  return cmds.filter((c: string) => !c.startsWith("#"))
    .flatMap((c: string) => c.split(/&&|\|\||;/)).map((c: string) => c.trim()).filter((c: string) => c !== "");
}
const hasSeg = (segs: string[], re: RegExp): boolean => segs.some((c: string) => re.test(c));
// Marcatorii pipeline-ului automat, pe UN singur text de workflow → lista problemelor (goală = conform).
function pipelineProblems(t: string): string[] {
  const out: string[] = [];
  const noComments = t.split("\n").filter((l: string) => !/^\s*#/.test(l)).join("\n");
  const segs = runSegments(t);
  if (!/^on:\s*$[\s\S]*?^\s+push:\s*\n\s+branches:\s*\[\s*main\s*\]/m.test(noComments)) out.push("push-main");
  if (!/^\s*image:\s*redis[:\s]/im.test(noComments + "\n")) out.push("redis");
  if (!hasSeg(segs, /^npm run typecheck(\s|$)/)) out.push("typecheck");
  // testele TUTUROR workspace-urilor: exact `npm run test` / `npm test` (fără `-w`/`--workspace`), NU `test:integration`
  if (!hasSeg(segs, /^npm (run )?test$/)) out.push("test");
  if (!hasSeg(segs, /^npm run lint(\s|$)/)) out.push("lint");
  return out;
}
const autoProblems = pipelineProblems(autoWf);
check("9. workflow-ul AUTOMAT " + AUTO_WF + " exista si e citit", autoWf.length > 0);
check("9b. " + AUTO_WF + " ruleaza automat la push pe main", !autoProblems.includes("push-main"));
check("10. " + AUTO_WF + " porneste serviciul Redis (image: redis)", !autoProblems.includes("redis"));
check("11. " + AUTO_WF + " ruleaza typecheck (comanda executabila npm run typecheck)", !autoProblems.includes("typecheck"));
check("12. " + AUTO_WF + " ruleaza testele TUTUROR workspace-urilor (comanda executabila npm run test / npm test)", !autoProblems.includes("test"));
check("12a. " + AUTO_WF + " ruleaza lint (comanda executabila npm run lint)", !autoProblems.includes("lint"));
check("12b. typecheck + test + lint + Redis in ACELASI workflow automat (o singura pipeline)", autoProblems.length === 0);
// Regresii: fiecare element scos din CI-ul AUTOMAT e detectat CHIAR dacă o copie manuală intactă există alături.
// Copia manuală = fișierul real dacă e prezent în repo, altfel o copie sintetică doar-manuală a lui typecheck.yml.
const manualCopy = wfFiles.filter((f: string) => f !== AUTO_WF).map((f: string) => readFileSync(join(wfDir, f), "utf8"))
  .find((t: string) => /workflow_dispatch/.test(t) && /npm run typecheck/.test(t))
  ?? autoWf.replace(/^on:[\s\S]*?(?=^permissions:)/m, "on:\n  workflow_dispatch:\n\n");
// Scoate EXACT un pas (după `- name:`), până la următorul element de listă sau comentariu de aceeași indentare (comentariile
// pasului următor rămân) ori sfârșitul blocului; dacă pasul nu există exact o dată, întoarce textul neschimbat → regresia pică (nu poate fi vidă).
function removeStep(t: string, name: string): string {
  const lines = t.split("\n");
  const hits = lines.map((l: string, i: number) => (l.trim() === "- name: " + name ? i : -1)).filter((i: number) => i >= 0);
  if (hits.length !== 1) return t;
  const start = hits[0];
  const ind = lines[start].length - lines[start].trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    const li = l.length - l.trimStart().length;
    if (l.trim() !== "" && (li < ind || (li === ind && (l.trimStart().startsWith("- ") || l.trimStart().startsWith("#"))))) break;
    end++;
  }
  return lines.slice(0, start).concat(lines.slice(end)).join("\n");
}
const MUTATIONS: Array<[string, (t: string) => string]> = [
  ["typecheck", (t) => removeStep(t, "Typecheck (all workspaces, incl. test files)")],
  ["test",      (t) => removeStep(t, "Test (all workspaces)")],
  ["lint",      (t) => removeStep(t, "Lint mcp")],
  ["redis",     (t) => t.replace(/^(\s*)image:\s*redis[^\n]*$/m, "$1image: postgres:16")],
  ["push-main", (t) => t.replace(/^(\s+)push:\s*\n\s+branches:\s*\[\s*main\s*\]\n/m, "")],
];
check("12c. copia manuala folosita in regresii e intacta (fara probleme de pipeline in afara declansatorului)",
  pipelineProblems(manualCopy).every((x: string) => x === "push-main") && /npm run typecheck/.test(manualCopy));
// Martor pentru „test”: pasul PH-4 (`npm run test:integration`) și mențiunea din comentariu NU țin locul testelor.
const PH4 = "npm run test:integration";
const PH4_COMMENT = "integrarea pe Redis REAL nu e in `npm run test`";
for (const [marker, mutate] of MUTATIONS) {
  const mutated = mutate(autoWf);
  const unionStillOk = pipelineProblems(mutated + "\n---\n" + manualCopy).filter((x: string) => x !== "push-main").length === 0;
  check("12d. regresie: '" + marker + "' scos din " + AUTO_WF + " e detectat cu copia manuala intacta"
    + (marker === "push-main" ? "" : " (uniunea ar fi ramas verde: " + unionStillOk + ")"),
    // exact problemele deja existente în fișierul real + marcatorul scos (o regresie nu „vede” altceva decât ce a scos)
    mutated !== autoWf && JSON.stringify(pipelineProblems(mutated).slice().sort())
      === JSON.stringify(Array.from(new Set([...autoProblems, marker])).sort()));
}
{
  const noTest = removeStep(autoWf, "Test (all workspaces)");
  check("12e. regresie precisa: DOAR pasul de teste scos — integrarea PH-4 si comentariul raman, problema e exact 'test'",
    noTest !== autoWf && noTest.includes(PH4) && noTest.includes(PH4_COMMENT)
      && JSON.stringify(pipelineProblems(noTest)) === JSON.stringify(["test"]));
  check("12f. martor: un workflow care ruleaza DOAR `npm run test:integration` nu trece drept testele tuturor workspace-urilor",
    hasSeg(runSegments(noTest), /^npm run test:integration(\s|$)/) && !hasSeg(runSegments(noTest), /^npm (run )?test$/));
}

// ── (c) FIECARE *.test.ts e accesibil din scriptul agregat `test` al workspace-ului (cgpt obs. 2, clasa PH-6) ──
const workspaces = resolveWorkspaces();
check("13. workspace discovery a gasit >=6 pachete", workspaces.length >= 6);
const unwired: string[] = [];
let totalTestFiles = 0;
for (const ws of workspaces) {
  const wsDir = join(ROOT, ws);
  const pkg = JSON.parse(readFileSync(join(wsDir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const reachable = reachableFromTest(pkg.scripts ?? {});
  const testFiles = walkTests(wsDir).map(p => p.slice(wsDir.length + 1)); // relativ la workspace
  totalTestFiles += testFiles.length;
  for (const tf of testFiles) {
    const base = tf.split("/").pop() as string;
    if (!reachable.has(tf) && !Array.from(reachable).some(r => r.endsWith("/" + base) || r === base)) {
      unwired.push(ws + "/" + tf);
    }
  }
}
check("14. FIECARE *.test.ts e accesibil din `test` (nespate: " + (unwired.join(", ") || "niciunul") + ")", unwired.length === 0);
check("15. guard-ul a scanat >=70 fisiere de test reale (gasite: " + totalTestFiles + ")", totalTestFiles >= 70);

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
