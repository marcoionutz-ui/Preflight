/**
 * scripts/heartbeatWiring.test.ts — PH-12 12.4 leaf 3 GUARD DE SURSĂ (publisher solana-worker).
 *
 * Doctrina „verde pe primitiva pură ≠ producție cablată": `startServiceHeartbeat` e testat pur în @preflight/schema,
 * DAR asta nu dovedește că ENTRY-POINT-ul REAL îl cheamă. Aici verificăm call-site-ul real: import din schema, apel cu
 * rolul corect, SET EX pe TTL-ul DIN write (nu hardcodat), scriere prin `redis` non-null din main. Citește sursa ca
 * TEXT — NU execută index.ts (importuri grele: @solana/web3.js, discovery). Path relativ la ACEST fișier (independent de cwd).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_ROLES } from "@preflight/schema";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const here = (() => { try { return dirname(fileURLToPath(import.meta.url)); } catch { return __dirname; } })();
const src = readFileSync(join(here, "..", "src", "index.ts"), "utf8");

console.log("PH-12 12.4 leaf 3 — heartbeat publisher wiring (solana-worker)");

check("1. ⭐ importă startServiceHeartbeat din @preflight/schema",
  /import\s*\{[^}]*\bstartServiceHeartbeat\b[^}]*\}\s*from\s*["']@preflight\/schema["']/.test(src));
check("2. ⭐ folosește clientul redis din main (getRedis)",
  /const\s+redis\s*=\s*getRedis\(\)/.test(src));
check("3. ⭐⭐⭐ cheamă startServiceHeartbeat(",
  /startServiceHeartbeat\s*\(\s*\{/.test(src));
check("4. ⭐⭐ rolul cablat e 'solana-worker' ȘI e un ServiceRole valid",
  /role\s*:\s*["']solana-worker["']/.test(src) && (SERVICE_ROLES as readonly string[]).includes("solana-worker"));
check("5. ⭐⭐⭐ writeHeartbeat face SET EX pe w.ttlSec DIN write (TTL partajat, nu un 300 hardcodat local)",
  /\.set\(\s*w\.key\s*,\s*w\.value\s*,\s*["']EX["']\s*,\s*w\.ttlSec\s*\)/.test(src));
check("6. ⭐⭐ scrie prin `redis` non-null din main (getRedis aruncă fără URL → nu e nevoie de guard)",
  /writeHeartbeat:\s*\(w\)\s*=>\s*redis\.set\(/.test(src));
check("7. ⭐ NU regresează la TTL/cheie hardcodate local (folosește w.key/w.ttlSec, nu literale)",
  !/EX["']\s*,\s*300\b/.test(src) && !/preflight:service_heartbeat/.test(src));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
