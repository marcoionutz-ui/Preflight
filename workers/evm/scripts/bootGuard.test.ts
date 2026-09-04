/**
 * scripts/bootGuard.test.ts — PH-12 slice 12.2d (dovadă comportamentală boot-guard worker-evm).
 *
 * Pornește ENTRY-POINT-ul REAL (`src/bootstrap.ts`, ce lansează `npm run start`) într-un PROCES SEPARAT, ASINCRON, IZOLAT:
 *   - env INVALID → iese SPONTAN non-zero ȘI aplicația NU s-a încărcat (marker entry-point ABSENT);
 *   - env cu WARNINGS (valid, `PREFLIGHT_MODE=DEV` → scan-only, fără WS) → se ATINGE entry-point-ul REAL (`Preflight
 *     Worker …`) ȘI procesul RĂMÂNE VIU până la oprirea DELIBERATĂ de test. „Rămâne viu" e dovada de PROGRES: IIFE-ul de
 *     startup NU are `catch`, deci dacă `refreshEthPrice`/`loadMemoryFromRedis` ar arunca, unhandled-rejection ar termina
 *     procesul → nu ar rămâne viu. O ieșire spontană (crash post-marker) PICĂ testul.
 *
 * IZOLARE: `cwd` = TEMP gol, env EXACT, `tsx` LOCAL (fără npx). Redis fake = mini-RESP (ioredis „ready", loadMemory OK).
 * `netGuard` (preload `--import`) interceptează TOT fetch-ul extern (`refreshNativePrices` atinge price-feeds publice) —
 * doar localhost trece. DEV mode → niciun WS deschis. Socket-uri urmărite + curățate; serverele închise în `finally`.
 *
 * Source-guard: `package.json` `start`/`dev` pornesc `bootstrap.ts`; validarea apare TEXTUAL înainte de `import("./index")`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as net from "node:net";
import * as path from "node:path";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const workerDir = process.cwd();
const bootstrapAbs = path.join(workerDir, "src", "bootstrap.ts");
const tsxBin = path.join(workerDir, "..", "..", "node_modules", ".bin", "tsx");
const REAL_ENTRY_MARKER = "Preflight Worker"; // marker top-level al index.ts (bootstrap folosește „[BOOT]")
const BOOT_OK_MARKER = "env valid — pornesc";

if (!existsSync(tsxBin)) {
  console.error(`[test:boot] tsx local negăsit la ${tsxBin} — rulează \`npm install\` la rădăcina monorepo-ului (fără npx).`);
  process.exit(1);
}

const openSockets = new Set<net.Socket>();
function track(sock: net.Socket): void {
  openSockets.add(sock);
  sock.on("close", () => openSockets.delete(sock));
  sock.on("error", () => {});
}

// mini-Redis RESP: destul cât ioredis (enableReadyCheck) să fie „ready" și `loadMemoryFromRedis` să nu arunce.
function parseRespCommand(s: string): { name: string; consumed: number } | null {
  if (s.length === 0 || s[0] !== "*") return null;
  const firstCrlf = s.indexOf("\r\n");
  if (firstCrlf < 0) return null;
  const argc = parseInt(s.slice(1, firstCrlf), 10);
  if (!Number.isFinite(argc)) return null;
  let pos = firstCrlf + 2, name = "";
  for (let i = 0; i < argc; i++) {
    if (s[pos] !== "$") return null;
    const lenEnd = s.indexOf("\r\n", pos);
    if (lenEnd < 0) return null;
    const len = parseInt(s.slice(pos + 1, lenEnd), 10);
    const argStart = lenEnd + 2, argEnd = argStart + len;
    if (s.length < argEnd + 2) return null;
    if (i === 0) name = s.slice(argStart, argEnd).toUpperCase();
    pos = argEnd + 2;
  }
  return { name, consumed: pos };
}
function respReply(name: string): string {
  if (name === "INFO") { const i = "redis_version:7.4.0\r\nloading:0\r\nrole:master\r\n"; return `$${i.length}\r\n${i}\r\n`; } // terminator RESP obligatoriu
  if (name === "PING") return "+PONG\r\n";
  if (name === "GET" || name === "HGET" || name === "GETRANGE" || name === "EVAL" || name === "EVALSHA") return "$-1\r\n";
  if (name === "HGETALL" || name === "ZRANGE" || name === "SMEMBERS" || name === "KEYS" || name === "MGET" || name === "ZPOPMIN") return "*0\r\n";
  if (["ZCARD", "SCARD", "LLEN", "EXISTS", "DEL", "EXPIRE", "ZADD", "SADD", "PUBLISH", "PTTL", "TTL"].includes(name)) return ":0\r\n";
  return "+OK\r\n";
}
function makeRedisFake(): net.Server {
  return net.createServer((sock) => {
    track(sock);
    let acc = "";
    sock.on("data", (chunk) => {
      acc += chunk.toString("latin1");
      let r: ReturnType<typeof parseRespCommand>;
      while ((r = parseRespCommand(acc)) !== null) {
        acc = acc.slice(r.consumed);
        sock.write(Buffer.from(respReply(r.name), "latin1"));
      }
    });
  });
}
function listenDynamic(srv: net.Server): Promise<number> {
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    resolve(typeof addr === "object" && addr ? addr.port : 0);
  }));
}

const NETGUARD_SRC = `
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) ? input.url : String(input);
  if (/^wss?:\\/\\//.test(url) || /^https?:\\/\\/(127\\.0\\.0\\.1|localhost)(:|\\/|$)/.test(url)) return realFetch(input, init);
  console.error("[NETGUARD] cerere externă INTERCEPTATĂ (nu iese în rețea): " + url);
  return new Response(JSON.stringify({ data: {}, result: null }), { status: 200, headers: { "content-type": "application/json" } });
};
console.error("[NETGUARD] activ — doar 127.0.0.1/localhost trece, restul e mock local");
`;

interface RunResult { status: number | null; signal: string | null; out: string; spawnError: Error | null; killRequested: boolean; hardKilled: boolean; }

/**
 * `killRequested` devine true DOAR când testul TRIMITE efectiv SIGTERM (după ce s-a văzut markerul + un mic delay ca
 * startup-ul să pornească loops), NU la simpla detectare a markerului. `hardKilled` = a fost nevoie de SIGKILL (deadline
 * depășit → shutdown-ul NU a răspuns). Așa distingem: oprire solicitată de test (ok) vs. ieșire spontană (crash) vs.
 * atârnare (timeout forțat).
 */
function runBootstrap(env: Record<string, string>, opts: { killAfterMarker?: string; markerDelayMs?: number; timeoutMs: number }): Promise<RunResult> {
  const tmp = mkdtempSync(path.join(tmpdir(), "bootguard-wevm-"));
  const netGuardPath = path.join(tmp, "netGuard.mjs");
  writeFileSync(netGuardPath, NETGUARD_SRC);
  return new Promise<RunResult>((resolve) => {
    const child = spawn(tsxBin, [bootstrapAbs], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? "", ...env, NODE_OPTIONS: `--import ${pathToFileURL(netGuardPath).href}` },
    });
    let out = "", killRequested = false, hardKilled = false, killScheduled = false, settled = false;
    const finish = (status: number | null, signal: string | null, spawnError: Error | null) => {
      if (settled) return; settled = true;
      clearTimeout(hardTimer);
      rmSync(tmp, { recursive: true, force: true });
      resolve({ status, signal, out, spawnError, killRequested, hardKilled });
    };
    const onData = (d: Buffer) => {
      out += d.toString();
      if (opts.killAfterMarker && out.includes(opts.killAfterMarker) && !killScheduled) {
        killScheduled = true;
        setTimeout(() => { killRequested = true; child.kill("SIGTERM"); }, opts.markerDelayMs ?? 800); // oprire SOLICITATĂ la SIGTERM efectiv
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => finish(null, null, err));
    child.on("exit", (status, signal) => finish(status, signal, null));
    const hardTimer = setTimeout(() => { hardKilled = true; child.kill("SIGKILL"); }, opts.timeoutMs);
  });
}

async function main(): Promise<void> {
console.log("PH-12 12.2d — boot-guard worker-evm (dovadă comportamentală, proces separat izolat)");

const redisFake = makeRedisFake();
const redisPort = await listenDynamic(redisFake);

try {
  // ── env INVALID → iese spontan non-zero, aplicația NU se încarcă ──
  const bad = await runBootstrap({ NODE_ENV: "production" }, { timeoutMs: 20_000 });
  check("1. ⭐⭐⭐ env invalid → IESE SPONTAN cu cod NON-ZERO (nu semnal)", bad.status !== 0 && bad.status !== null && bad.signal === null);
  check("2. ⭐⭐⭐ env invalid → fără eroare de spawn", bad.spawnError === null);
  check("3. ⭐⭐⭐ env invalid → diagnostic FAIL cu câmpul lipsă (REDIS_URL)", /FAIL/.test(bad.out) && /REDIS_URL/.test(bad.out));
  check("4. ⭐⭐⭐ env invalid → modulul APLICAȚIEI NU s-a încărcat (marker entry-point ABSENT)", !bad.out.includes(REAL_ENTRY_MARKER));
  check("5. ⭐⭐ env invalid → mesaj explicit de oprire, fără valori", /configurație env invalidă/.test(bad.out));

  // ── env cu WARNINGS (valid, DEV mode → scan-only) → atinge entry-point-ul real ȘI rămâne viu ──
  const warn = await runBootstrap({
    NODE_ENV: "development",
    PREFLIGHT_MODE: "DEV",                       // wsEnabled=false → niciun WS deschis (scan-only)
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    ENABLED_CHAINS: "base,polygon",              // polygon necunoscut → warning (csvKnownTokens); base rămâne activ
  }, { killAfterMarker: REAL_ENTRY_MARKER, markerDelayMs: 1500, timeoutMs: 15_000 });
  check("6. ⭐⭐⭐ env cu warnings → boot-guard continuă (marker bootstrap prezent)", warn.out.includes(BOOT_OK_MARKER));
  check("7. ⭐⭐⭐ env cu warnings → warning-ul e vizibil (ENABLED_CHAINS)", /ENABLED_CHAINS/.test(warn.out));
  check("8. ⭐⭐⭐ env cu warnings → ENTRY-POINT-ul REAL a fost ATINS (marker aplicație prezent)", warn.out.includes(REAL_ENTRY_MARKER));
  // PH-13: worker-evm are handler SIGTERM care salvează memoria și iese cu 0. Deci „viu până la oprirea solicitată" =
  // testul A CERUT oprirea (killRequested, adică a văzut markerul + a trimis SIGTERM), NU a fost nevoie de SIGKILL forțat
  // (hardKilled=false, deci nu a atârnat), și ieșirea e fie shutdown-graceful (0), fie prin semnal/≥128 — dar NICIODATĂ
  // exit 1 (care ar fi crash / unhandled-rejection din IIFE-ul de startup fără catch). Ieșire spontană ⇒ killRequested
  // rămâne false (nu am apucat să trimitem SIGTERM) ⇒ pică.
  const warnGracefulStop = warn.killRequested === true && warn.hardKilled === false
    && warn.status !== 1
    && (warn.status === 0 || warn.signal === "SIGTERM" || (warn.status !== null && warn.status >= 128));
  check("9. ⭐⭐⭐ env cu warnings → procesul a RĂMAS VIU până la oprirea SOLICITATĂ de test, apoi shutdown ordonat (NU ieșire spontană, NU exit 1, NU atârnare)",
    warnGracefulStop);
  check("9b. ⭐⭐⭐ env cu warnings → shutdown-ul PH-13 a rulat DUPĂ restaurarea Redis (loops pornite: `intervale oprite: N>0`)",
    /\[SHUTDOWN\] intervale oprite: [1-9]/.test(warn.out));
  check("10. ⭐⭐⭐ env cu warnings → fără crash post-marker / eroare import (ERR_MODULE_NOT_FOUND, unhandled, spawn error)",
    warn.spawnError === null && !/ERR_MODULE_NOT_FOUND/.test(warn.out) && !/pornire eșuată după validare/.test(warn.out));
  check("10c. ⭐⭐⭐ izolare rețea: netGuard-ul e ACTIV în copil (price-feeds interceptate, nu ies în rețea)", /\[NETGUARD\] activ/.test(warn.out));

  // ── source-guard ──────────────────────────────────────────────────────────────────
  const pkg = JSON.parse(readFileSync(path.join(workerDir, "package.json"), "utf8")) as { scripts: Record<string, string> };
  check("11. ⭐⭐⭐ package.json `start` pornește bootstrap.ts (ce lansează Railway `npm run start`)", /bootstrap\.ts/.test(pkg.scripts.start));
  check("12. ⭐⭐⭐ package.json `dev` pornește bootstrap.ts (păstrează `--env-file`)",
    /bootstrap\.ts/.test(pkg.scripts.dev) && /--env-file/.test(pkg.scripts.dev));
  check("13. ⭐⭐⭐ bootstrap.ts: validarea apare TEXTUAL înainte de import(\"./index\") (ordine)", (() => {
    const src = readFileSync(bootstrapAbs, "utf8");
    const vIdx = src.indexOf("validateWorkerEvmEnv(process.env)");
    const iIdx = src.indexOf('import("./index")');
    return vIdx !== -1 && iIdx !== -1 && vIdx < iIdx;
  })());
} finally {
  for (const sock of openSockets) sock.destroy();
  await new Promise<void>((res) => redisFake.close(() => res()));
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

void main();
