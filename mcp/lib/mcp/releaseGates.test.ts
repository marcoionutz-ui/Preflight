/**
 * lib/mcp/releaseGates.test.ts — PH-5 (release gates: build PICĂ pe erori; CI acoperă tot; testele sunt CABLATE).
 *
 * varu: „release gates permit livrare neverificată". Guard de sursă pe TREI axe (v2 după cgpt — v1 overclaima):
 *   (a) `next.config.ts` NU mai ignoră erorile TS/ESLint la build (`false`, nu `true`).
 *   (b) WORKFLOW-ul REAL (`.github/workflows/*.yml`) pornește Redis ȘI rulează typecheck + test + lint. (v1 nu citea
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
const wfDir = join(ROOT, ".github/workflows");
const wfFiles = ddNames(wfDir).filter((f: string) => f.endsWith(".yml") || f.endsWith(".yaml"));
const wfTexts = wfFiles.map((f: string) => readFileSync(join(wfDir, f), "utf8"));
const allWf = wfTexts.join("\n---\n");
check("8. exista cel putin un workflow CI in .github/workflows", wfFiles.length > 0);
// markeri verificati pe UNIUNEA workflow-urilor → scoaterea oricaruia din CI pica precis.
check("9. workflow CI porneste serviciul Redis (image: redis)", /image:\s*redis/i.test(allWf));
check("10. workflow CI ruleaza typecheck (npm run typecheck)", /npm run typecheck/.test(allWf));
check("11. workflow CI ruleaza testele (npm run test / npm test)", /npm (run )?test\b/.test(allWf));
check("12. workflow CI ruleaza lint (npm run lint)", /npm run lint/.test(allWf));
// integritate de pipeline: typecheck ȘI test în ACELAȘI workflow (nu împrăștiate în fișiere separate).
check("12b. typecheck + test in ACELASI workflow (o singura pipeline)",
  wfTexts.some((t: string) => /npm run typecheck/.test(t) && /npm (run )?test\b/.test(t)));

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
