/**
 * scripts/followAdmission.test.ts — BETA-1 / M1–M2 (design `BETA1_M12_FIX_DESIGN.md` rev2, §5.2): gardă de SURSĂ.
 *
 * Citește `src/pipeline/scan.ts` ca TEXT (nu-l importă: scan.ts aduce Redis/Supabase/rețea în graf) și cere:
 *   G1. `v3PoolMap.set(` și `v4PoolMap.set(` apar în tot fișierul EXACT o dată fiecare, ambele în `admitToPoolMaps`;
 *   G2. `admitToPoolMaps` aplică `poolMapKindFor` și șterge markerul routing-only;
 *   G3. `rebuildPoolMaps` face re-add-ul prin `admitToPoolMaps(p)` (o dată) și nu mai scrie direct în hărți;
 *   G4. `runFollowRefresh` cheamă `admitToPoolMaps(pool)` EXACT o dată, DUPĂ ultima ramură `if (!pool)` și ÎNAINTEA
 *       singurului `processPool(`;
 *   G5. `admitToPoolMaps(` are exact două apeluri (rebuild + follow-refresh), în afara definiției;
 *   G6. `poolMapRebuild.ts` exportă `poolMapKindFor`.
 * Gărzile sunt funcții pure peste text; regresiile R1–R5 le aplică pe variante ALTERATE ale sursei reale și cer să pice
 * (o gardă care nu pică pe sursa stricată nu dovedește nimic). Comportamentul real e dovedit de harness-ul A2 (WSL).
 */
import fs from "node:fs";
import path from "node:path";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name + (detail ? ` — ${detail}` : "")); }
}

const SCAN = fs.readFileSync(path.join(__dirname, "..", "src", "pipeline", "scan.ts"), "utf8");
const REBUILD = fs.readFileSync(path.join(__dirname, "..", "src", "pipeline", "poolMapRebuild.ts"), "utf8");

const occurrences = (s: string, needle: string): number => s.split(needle).length - 1;

/** Corpul unei funcții de nivel superior: de la `function <nume>(` până la primul `\n}` de la începutul unei linii. */
function bodyOf(src: string, name: string): string | null {
  const re = new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const end = src.indexOf("\n}\n", m.index + 1);
  return end < 0 ? null : src.slice(m.index, end + 2);
}

/** Toate gărzile G1–G5 peste un text de `scan.ts`. Întoarce lista problemelor (goală = în regulă). */
function guardScan(src: string): string[] {
  const p: string[] = [];
  const admit = bodyOf(src, "admitToPoolMaps");
  const rebuild = bodyOf(src, "rebuildPoolMaps");
  const follow = bodyOf(src, "runFollowRefresh");
  if (!admit) p.push("admitToPoolMaps lipsește");
  if (!rebuild) p.push("rebuildPoolMaps lipsește");
  if (!follow) p.push("runFollowRefresh lipsește");
  if (!admit || !rebuild || !follow) return p;
  // G1
  for (const map of ["v3PoolMap", "v4PoolMap"]) {
    const total = occurrences(src, `${map}.set(`), inAdmit = occurrences(admit, `${map}.set(`);
    if (total !== 1 || inAdmit !== 1) p.push(`G1: ${map}.set( apare de ${total} ori în fișier, de ${inAdmit} ori în admitToPoolMaps (se cere 1 și 1)`);
  }
  // G2
  if (occurrences(admit, "poolMapKindFor(") !== 1) p.push("G2: admitToPoolMaps nu aplică poolMapKindFor exact o dată");
  if (occurrences(admit, "routingOnlyPools.delete(") !== 2) p.push("G2: admitToPoolMaps nu șterge markerul routing-only pe ambele ramuri");
  // G3
  if (occurrences(rebuild, "admitToPoolMaps(p)") !== 1) p.push("G3: rebuildPoolMaps nu face re-add-ul prin admitToPoolMaps(p) exact o dată");
  if (/PoolMap\.set\(/.test(rebuild)) p.push("G3: rebuildPoolMaps scrie direct într-o hartă");
  // G4
  const a = follow.indexOf("admitToPoolMaps(pool)");
  const lastMiss = follow.lastIndexOf("if (!pool)");
  const proc = follow.indexOf("processPool(");
  if (occurrences(follow, "admitToPoolMaps(pool)") !== 1) p.push(`G4: runFollowRefresh cheamă admitToPoolMaps(pool) de ${occurrences(follow, "admitToPoolMaps(pool)")} ori (se cere 1)`);
  if (occurrences(follow, "processPool(") !== 1) p.push("G4: runFollowRefresh nu are exact un apel processPool(");
  if (lastMiss < 0 || !(lastMiss < a && a < proc)) p.push("G4: admitToPoolMaps(pool) nu stă între ultima ramură if (!pool) și processPool(");
  // G5
  const calls = occurrences(src, "admitToPoolMaps(") - occurrences(src, "function admitToPoolMaps(");
  if (calls !== 2) p.push(`G5: admitToPoolMaps( are ${calls} apeluri (se cer 2: rebuild + follow-refresh)`);
  return p;
}

console.log("M1–M2 — admiterea în hărți: gardă de sursă");

const real = guardScan(SCAN);
check("G1–G5 pe scan.ts real: un singur punct de scriere, folosit de rebuild și de follow-refresh înaintea processPool", real.length === 0, real.join("; "));
check("G6. poolMapRebuild.ts exportă poolMapKindFor", /\nexport function poolMapKindFor\(/.test(REBUILD));

// ── Regresii: gărzile TREBUIE să pice pe sursa alterată ─────────────────────────────────────────────────────────
const follow = bodyOf(SCAN, "runFollowRefresh") ?? "";
const admitLine = /\n[^\n]*const admitted = admitToPoolMaps\(pool\);[^\n]*/;
{
  // R1: admiterea mutată DUPĂ processPool.
  const m = admitLine.exec(follow);
  const mutatedFollow = m
    ? follow.replace(m[0], "").replace(/\n(\s*)\/\/ nu suprascrie attentionScore/, `${m[0]}\n$1// nu suprascrie attentionScore`)
    : follow;
  const v = guardScan(SCAN.replace(follow, mutatedFollow));
  check("R1. admiterea mutată după processPool → G4 pică", m !== null && v.some(x => x.startsWith("G4:")), v.join("; "));
}
{
  // R2: admiterea eliminată din follow-refresh (comportamentul de dinainte de fix).
  const v = guardScan(SCAN.replace(follow, follow.replace("admitToPoolMaps(pool)", "null")));
  check("R2. admiterea eliminată din follow-refresh → G4 și G5 pică", v.some(x => x.startsWith("G4:")) && v.some(x => x.startsWith("G5:")), v.join("; "));
}
{
  // R3: o scriere directă în plus, în afara helperului.
  const v = guardScan(SCAN.replace("function rebuildPoolMaps(pools: SourcePool[]): void {", "function rebuildPoolMaps(pools: SourcePool[]): void {\n  for (const x of pools) v3PoolMap.set(x.chain, x.pairAddress, x);"));
  check("R3. scriere directă v3PoolMap.set( în rebuild → G1 și G3 pică", v.some(x => x.startsWith("G1:")) && v.some(x => x.startsWith("G3:")), v.join("; "));
}
{
  // R4: helperul uită să șteargă markerul routing-only pe o ramură.
  const admit = bodyOf(SCAN, "admitToPoolMaps") ?? "";
  const v = guardScan(SCAN.replace(admit, admit.replace("routingOnlyPools.delete(p.chain, p.pairAddress); }", "}")));
  check("R4. helperul nu mai șterge markerul pe o ramură → G2 pică", v.some(x => x.startsWith("G2:")), v.join("; "));
}
{
  // R5: helperul nu mai aplică regula unică (eligibilitate inline).
  const admit = bodyOf(SCAN, "admitToPoolMaps") ?? "";
  const v = guardScan(SCAN.replace(admit, admit.replace("poolMapKindFor(p, V3_DEXES, isBlockedSymbol)", "(p.dexType === \"V4\" ? \"v4\" : \"v3\")")));
  check("R5. helperul fără poolMapKindFor → G2 pică", v.some(x => x.startsWith("G2:")), v.join("; "));
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
