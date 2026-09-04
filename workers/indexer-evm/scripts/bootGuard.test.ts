/**
 * scripts/bootGuard.test.ts — PH-12 slice 12.2d (dovadă comportamentală boot-guard indexer-evm).
 *
 * Pornește ENTRY-POINT-ul REAL (`src/bootstrap.ts`, exact ce lansează `npm run start`) într-un PROCES SEPARAT, ASINCRON
 * (nu `spawnSync` — event-loop-ul trebuie să ruleze serverele fake în paralel cu copilul), COMPLET IZOLAT, și verifică:
 *   - env INVALID  → proces IESE SPONTAN cu cod NON-ZERO ȘI aplicația NU s-a încărcat (markerul entry-point-ului ABSENT);
 *   - env cu WARNINGS (valid) → se ATINGE entry-point-ul REAL (`[INDEXER] Preflight Indexer EVM …`) ȘI procesul RĂMÂNE
 *     VIU până când TESTUL îl oprește (semnal) — o ieșire SPONTANĂ (crash post-marker, `[INDEXER] Fatal error` + exit 1)
 *     PICĂ testul. Se capturează și `spawn` `error` (nu doar output-ul).
 *
 * IZOLARE (blocker cgpt 12.2d): fără porturi „presupus închise" (indexerul CHIAR ar scrie health într-un Redis real de
 * pe acel port — `infra/health.ts`). Testul pornește SERVERE FAKE locale pe porturi ALOCATE DINAMIC (`listen(0)`): un
 * TCP care absoarbe conexiunile Redis (scrierile de health merg în neant, nu într-un Redis real) + un HTTP care răspunde
 * generic la JSON-RPC. `cwd` = TEMP gol (dotenv.config() n-are `.env`), env EXACT, `tsx` LOCAL (fără `npx`). Cleanup servere.
 *
 * Source-guard: `package.json` `start`/`dev` pornesc `bootstrap.ts`, iar validarea apare TEXTUAL înainte de `import("./index")`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as net from "node:net";
import * as http from "node:http";
import * as path from "node:path";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const workerDir = process.cwd();
const bootstrapAbs = path.join(workerDir, "src", "bootstrap.ts");
const tsxBin = path.join(workerDir, "..", "..", "node_modules", ".bin", "tsx");
const REAL_ENTRY_MARKER = "Preflight Indexer EVM"; // marker al ENTRY-POINT-ului real (`src/index.ts`)
const BOOT_OK_MARKER = "env valid — pornesc";       // marker al bootstrap-ului (dinainte de import — nu ajunge singur)

if (!existsSync(tsxBin)) {
  console.error(`[test:boot] tsx local negăsit la ${tsxBin} — rulează \`npm install\` la rădăcina monorepo-ului (fără npx).`);
  process.exit(1);
}

function listenDynamic(srv: net.Server | http.Server): Promise<number> {
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    resolve(typeof addr === "object" && addr ? addr.port : 0);
  }));
}

interface RunResult { status: number | null; signal: string | null; out: string; spawnError: Error | null; stoppedByTest: boolean; }

/**
 * Pornește bootstrap.ts async, izolat. `killOnMarker`: când markerul apare, procesul e lăsat viu scurt și apoi oprit
 * DELIBERAT de test (SIGTERM) — dacă procesul iese SINGUR înainte (spontan), `stoppedByTest` rămâne false.
 */
function runBootstrap(env: Record<string, string>, opts: { killOnMarker?: string; timeoutMs: number }): Promise<RunResult> {
  const tmp = mkdtempSync(path.join(tmpdir(), "bootguard-"));
  return new Promise<RunResult>((resolve) => {
    const child = spawn(tsxBin, [bootstrapAbs], { cwd: tmp, env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "", stoppedByTest = false, settled = false;
    const finish = (status: number | null, signal: string | null, spawnError: Error | null) => {
      if (settled) return; settled = true;
      clearTimeout(hardTimer);
      rmSync(tmp, { recursive: true, force: true });
      resolve({ status, signal, out, spawnError, stoppedByTest });
    };
    const onData = (d: Buffer) => {
      out += d.toString();
      if (opts.killOnMarker && out.includes(opts.killOnMarker) && !stoppedByTest) {
        stoppedByTest = true;
        setTimeout(() => child.kill("SIGTERM"), 800); // lasă procesul viu 800ms după marker, apoi oprește-l DELIBERAT
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => finish(null, null, err));
    child.on("exit", (status, signal) => finish(status, signal, null));
    const hardTimer = setTimeout(() => { stoppedByTest = true; child.kill("SIGKILL"); }, opts.timeoutMs);
  });
}

async function main(): Promise<void> {
console.log("PH-12 12.2d — boot-guard indexer-evm (dovadă comportamentală, proces separat izolat)");

// Servere FAKE locale (porturi dinamice) — absorb I/O, niciun serviciu real atins.
// CLEANUP (blocker cgpt 12.2d): urmărim socket-urile acceptate + `sock.resume()` (altfel datele NEcitite țin un handle
// deschis), iar în `finally` le DISTRUGEM și AȘTEPTĂM închiderea serverelor — altfel testul poate imprima „13 passed" și
// să NU se termine (event-loop-ul rămâne cu handle-uri vii → exit-ul atârnă).
const openSockets = new Set<net.Socket>();
function track(sock: net.Socket): void {
  openSockets.add(sock);
  sock.on("close", () => openSockets.delete(sock));
  sock.on("error", () => {});
}
const redisFake = net.createServer((sock) => { track(sock); sock.resume(); /* consumă datele Redis (health etc.) */ });
const rpcFake = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    // Răspuns JSON-RPC per-METODĂ, ca parserele reale să nu arunce (eth_getLogs cere ARRAY, nu hex) → mainLoop nu crapă.
    let method = "", id: unknown = 1;
    try { const p = JSON.parse(b) as { method?: string; id?: unknown }; method = p.method ?? ""; id = p.id ?? 1; } catch { /* ignore */ }
    const result: unknown = method === "eth_getLogs" ? [] : "0x1"; // getLogs → batch gol; blockNumber/rest → hex
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
});
rpcFake.on("connection", track); // conexiunile HTTP keep-alive au același risc de handle rămas
const redisPort = await listenDynamic(redisFake);
const rpcPort = await listenDynamic(rpcFake);

try {
  // ── env INVALID → iese SPONTAN non-zero ȘI aplicația NU s-a încărcat ──────────────
  const bad = await runBootstrap({ NODE_ENV: "production" }, { timeoutMs: 20_000 });
  check("1. ⭐⭐⭐ env invalid → IESE SPONTAN cu cod NON-ZERO (nu semnal)", bad.status !== 0 && bad.status !== null && bad.signal === null);
  check("2. ⭐⭐⭐ env invalid → fără eroare de spawn", bad.spawnError === null);
  check("3. ⭐⭐⭐ env invalid → diagnostic FAIL cu câmpurile lipsă (REDIS_URL + ALCHEMY_BASE_RPC)",
    /FAIL/.test(bad.out) && /REDIS_URL/.test(bad.out) && /ALCHEMY_BASE_RPC/.test(bad.out));
  check("4. ⭐⭐⭐ env invalid → modulul APLICAȚIEI NU s-a încărcat (marker entry-point ABSENT)", !bad.out.includes(REAL_ENTRY_MARKER));
  check("5. ⭐⭐ env invalid → mesaj explicit de oprire, fără valori", /configurație env invalidă/.test(bad.out));

  // ── env cu WARNINGS (valid) → atinge entry-point-ul real ȘI RĂMÂNE VIU ────────────
  const warn = await runBootstrap({
    NODE_ENV: "development",
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,          // server fake (dinamic) — health-ul merge aici, nu într-un Redis real
    ALCHEMY_BASE_RPC: `http://127.0.0.1:${rpcPort}/rpc`,   // server fake — RPC-ul nu iese în rețea
    INDEXER_ENABLE_BSC: "treu",                            // typo → warning (exactFlag), NU problem
  }, { killOnMarker: REAL_ENTRY_MARKER, timeoutMs: 15_000 });
  check("6. ⭐⭐⭐ env cu warnings → boot-guard continuă (marker bootstrap prezent)", warn.out.includes(BOOT_OK_MARKER));
  check("7. ⭐⭐⭐ env cu warnings → warning-ul e vizibil (INDEXER_ENABLE_BSC)", /INDEXER_ENABLE_BSC/.test(warn.out));
  check("8. ⭐⭐⭐ env cu warnings → ENTRY-POINT-ul REAL a fost ATINS (marker aplicație prezent)", warn.out.includes(REAL_ENTRY_MARKER));
  // „Oprit de test" = terminat de semnal: `signal` prezent, SAU (tsx wrapper) exit code ≥ 128 (128+signum, ex. 143=SIGTERM).
  // O ieșire SPONTANĂ (exit 0/1 < 128, ex. crash `Fatal error`+exit 1) NU e semnal → picӑ testul.
  const warnKilledBySignal = warn.signal !== null || (warn.status !== null && warn.status >= 128);
  check("9. ⭐⭐⭐ env cu warnings → procesul a RĂMAS VIU până la oprirea DELIBERATĂ de test (semnal, NU ieșire spontană)",
    warn.stoppedByTest === true && warnKilledBySignal);
  check("10. ⭐⭐⭐ env cu warnings → fără crash post-marker / eroare import (Fatal error, ERR_MODULE_NOT_FOUND, spawn error)",
    warn.spawnError === null && !/ERR_MODULE_NOT_FOUND/.test(warn.out) && !/Fatal error/.test(warn.out) && !/pornire eșuată după validare/.test(warn.out));

  // ── source-guard ──────────────────────────────────────────────────────────────────
  const pkg = JSON.parse(readFileSync(path.join(workerDir, "package.json"), "utf8")) as { scripts: Record<string, string> };
  check("11. ⭐⭐⭐ package.json `start` pornește bootstrap.ts (ce lansează Railway `npm run start`)", /bootstrap\.ts/.test(pkg.scripts.start));
  check("12. ⭐⭐⭐ package.json `dev` pornește bootstrap.ts (păstrează `--env-file`)",
    /bootstrap\.ts/.test(pkg.scripts.dev) && /--env-file/.test(pkg.scripts.dev));
  check("13. ⭐⭐⭐ bootstrap.ts: validarea apare TEXTUAL înainte de import(\"./index\") (ordine)", (() => {
    const src = readFileSync(bootstrapAbs, "utf8");
    const vIdx = src.indexOf("validateIndexerEvmEnv(process.env)");
    const iIdx = src.indexOf('import("./index")');
    return vIdx !== -1 && iIdx !== -1 && vIdx < iIdx;
  })());
} finally {
  // Distruge socket-urile RĂMASE (close() oprește doar acceptarea de conexiuni NOI, nu le termină pe cele deschise),
  // apoi AȘTEAPTĂ închiderea efectivă a ambelor servere → event-loop-ul rămâne fără handle-uri → testul se termină.
  for (const sock of openSockets) sock.destroy();
  await Promise.all([
    new Promise<void>((res) => redisFake.close(() => res())),
    new Promise<void>((res) => rpcFake.close(() => res())),
  ]);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

void main();
