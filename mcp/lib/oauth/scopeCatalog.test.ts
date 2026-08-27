/**
 * lib/oauth/scopeCatalog.test.ts — PH-2 step 10.5b (catalogul concret de scope-uri: conținut + acoperirea tool-urilor).
 *
 * (a) Self-check pur pe `SERVER_SCOPE_CATALOG`: exact cele 8 scope-uri reale, dedup, `read:all` prezent, fixture-urile
 *     negative (`read:ghost`, `read:secret_not_in_policy`) ABSENTE.
 * (b) Acoperire (cerință cgpt): fiecare scope pe care un TOOL îl poate cere trebuie să existe în catalog — altfel un
 *     grant/refresh l-ar clamp-a la gol (clampScopes = apartenență CONCRETĂ). Verificat GUARD-OF-SOURCE pe
 *     `lib/mcp/scopes.ts` (extragem literalele `read:*` din sursă). Fișierul e în repo-ul real dar NU în sandbox-ul
 *     parțial → citire TOLERANTĂ: dacă lipsește, marcăm skip explicit (acoperirea rulează plin în gate-ul WSL).
 */
import { readFileSync } from "node:fs";
import { SERVER_SCOPE_CATALOG } from "./scopeCatalog";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const EXPECTED = [
  "read:basic", "read:all", "read:market", "read:pipeline",
  "read:pair", "read:safety", "read:reports", "read:positions",
];

function main(): void {
console.log("PH-2 step 10.5b — SERVER_SCOPE_CATALOG (conținut + acoperire tool-uri)");

const cat = SERVER_SCOPE_CATALOG;
const set = new Set(cat);

// ── (a) conținut ──────────────────────────────────────────────────────────────
check("1. ⭐⭐⭐ catalogul conține exact cele 8 scope-uri reale (fără lipsă/în plus)",
  cat.length === EXPECTED.length && EXPECTED.every(s => set.has(s)) && cat.every(s => EXPECTED.includes(s)));
check("2. ⭐⭐ fără duplicate (Set.size === length)", set.size === cat.length);
check("3. ⭐⭐ read:all e MEMBRU CONCRET (semantica wildcard e doar pe entitlement, nu pe policy)", set.has("read:all"));
check("4. ⭐ fiecare granular real e prezent",
  ["read:basic","read:market","read:pipeline","read:pair","read:safety","read:reports","read:positions"].every(s => set.has(s)));

// ── (b) fixture-urile negative NU trebuie să fie în catalog ──────────────────────
check("5. ⭐⭐⭐ read:ghost ABSENT (fixture negativ de test, nu scope real)", !set.has("read:ghost"));
check("6. ⭐⭐⭐ read:secret_not_in_policy ABSENT (fixture negativ)", !set.has("read:secret_not_in_policy"));

// ── (c) acoperire: orice read:* folosit de tool-uri trebuie să fie în catalog ────
let scopesSrc: string | null = null;
try { scopesSrc = readFileSync("lib/mcp/scopes.ts", "utf8"); } catch { scopesSrc = null; }
if (scopesSrc === null) {
  check("7. (skip — lib/mcp/scopes.ts absent în sandbox-ul parțial; acoperirea TOOL_SCOPES rulează în gate-ul WSL)", true);
} else {
  const used = [...new Set((scopesSrc.match(/read:[a-z_]+/g) ?? []))];
  const missing = used.filter(s => !set.has(s));
  check("7. ⭐⭐⭐ toate scope-urile din lib/mcp/scopes.ts (TOOL_SCOPES) există în catalog (0 lipsă → 0 clamp tăcut)",
    used.length > 0 && missing.length === 0);
  if (missing.length > 0) console.log("     lipsă din catalog: " + missing.join(", "));
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
