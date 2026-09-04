/**
 * scripts/bootGuard.test.ts — PH-12 slice 12.2d (dovadă comportamentală boot-guard indexer-solana).
 *
 * Pornește ENTRY-POINT-ul REAL (`src/bootstrap.ts`, ce lansează `npm run start`) într-un PROCES SEPARAT, ASINCRON,
 * COMPLET IZOLAT, și verifică:
 *   - env INVALID (grupuri Redis/RPC goale) → iese SPONTAN NON-ZERO ȘI aplicația NU s-a încărcat (marker entry-point ABSENT);
 *   - env cu WARNINGS (valid) → se ATINGE entry-point-ul REAL (`[SOLANA] indexer-solana …`) ȘI procesul RĂMÂNE VIU până
 *     la oprirea DELIBERATĂ de test — o ieșire spontană (crash `[SOLANA] fatal:` + exit 1) PICĂ testul.
 *
 * IZOLARE: `cwd` = TEMP gol, env EXACT, `tsx` LOCAL (fără npx). Servere FAKE pe porturi DINAMICE: un mini-Redis RESP
 * (răspunde INFO/PING/GET/ZCARD/... ca ioredis să fie „ready" și `main` să treacă de `getRedis`/pairsCount) + un HTTP
 * JSON-RPC Solana (getVersion/getSlot). Socket-uri urmărite + `resume()` + în `finally` distruse și serverele închise
 * (altfel testul poate imprima verde și să NU se termine). Bootstrap-ul și `index.ts` rămân reale.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
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
const REAL_ENTRY_MARKER = "[SOLANA] indexer-solana"; // marker al ENTRY-POINT-ului real (index.ts main); bootstrap folosește „[BOOT]"
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

// ── mini-Redis RESP: destul cât ioredis (enableReadyCheck) să fie „ready" și comenzile app să nu arunce ──
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
    if (s.length < argEnd + 2) return null; // comandă incompletă → așteaptă mai multe date
    if (i === 0) name = s.slice(argStart, argEnd).toUpperCase();
    pos = argEnd + 2;
  }
  return { name, consumed: pos };
}
function respReply(name: string): string {
  // Bulk string RESP: `$<len>\r\n<len bytes>\r\n` — terminatorul `\r\n` DUPĂ payload e OBLIGATORIU (fără el ioredis
  // așteaptă 2 bytes în plus și comanda următoare, ex. ZCARD, se blochează → startup-ul nu ajunge la „redis OK").
  if (name === "INFO") { const i = "redis_version:7.4.0\r\nloading:0\r\nrole:master\r\n"; return `$${i.length}\r\n${i}\r\n`; }
  if (name === "PING") return "+PONG\r\n";
  if (name === "GET" || name === "HGET" || name === "GETRANGE" || name === "EVAL" || name === "EVALSHA") return "$-1\r\n";
  if (name === "HGETALL" || name === "ZRANGE" || name === "SMEMBERS" || name === "KEYS" || name === "MGET" || name === "ZPOPMIN") return "*0\r\n";
  if (["ZCARD", "SCARD", "LLEN", "EXISTS", "DEL", "EXPIRE", "ZADD", "SADD", "PUBLISH", "PTTL", "TTL"].includes(name)) return ":0\r\n";
  return "+OK\r\n"; // SET/HSET/CONFIG/CLIENT/SELECT/etc.
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
function makeRpcFake(): http.Server {
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      let method = "", id: unknown = 1;
      try { const p = JSON.parse(b) as { method?: string; id?: unknown }; method = p.method ?? ""; id = p.id ?? 1; } catch { /* ignore */ }
      const result: unknown =
        method === "getVersion" ? { "solana-core": "1.18.0" } :
        method === "getSlot" ? 1 :
        method === "getHealth" ? "ok" : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  srv.on("connection", track);
  // WS: Solana derivă `ws://…` din RPC-ul HTTP pentru subscripții (`web3.js` onLogs). Facem handshake-ul (altfel clientul
  // ar retry-ui/arunca) și ținem conexiunea VIE, ignorând frame-urile — WS-ul nu iese în rețea, iar `main` nu crapă pe el.
  srv.on("upgrade", (req, socket) => {
    track(socket as net.Socket);
    const key = (req.headers["sec-websocket-key"] as string | undefined) ?? "";
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", () => { /* ignoră subscripțiile; ține conexiunea vie */ });
    socket.on("error", () => {});
  });
  return srv;
}
function listenDynamic(srv: net.Server | http.Server): Promise<number> {
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    resolve(typeof addr === "object" && addr ? addr.port : 0);
  }));
}

interface RunResult { status: number | null; signal: string | null; out: string; spawnError: Error | null; stoppedByTest: boolean; }

/**
 * Preload (node `--import`) injectat în PROCESUL COPIL: patch-uiește `globalThis.fetch` ca NICIO cerere externă să nu
 * iasă în rețea. Startup-ul solana face fetch la oracle SOL/USD + smoke-test Jupiter, la URL-uri PUBLICE independente de
 * `SOLANA_RPC_URL` (blocker cgpt 12.2d). Doar `127.0.0.1`/`localhost` (serverele fake) trec; restul → răspuns mock local.
 */
const NETGUARD_SRC = `
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) ? input.url : String(input);
  if (/^wss?:\\/\\//.test(url) || /^https?:\\/\\/(127\\.0\\.0\\.1|localhost)(:|\\/|$)/.test(url)) return realFetch(input, init);
  console.error("[NETGUARD] cerere externă INTERCEPTATĂ (nu iese în rețea): " + url);
  return new Response(JSON.stringify({ data: {}, prices: {}, tokens: [] }), { status: 200, headers: { "content-type": "application/json" } });
};
console.error("[NETGUARD] activ — doar 127.0.0.1/localhost trece, restul e mock local");
`;

function runBootstrap(env: Record<string, string>, opts: { killOnMarker?: string; timeoutMs: number }): Promise<RunResult> {
  const tmp = mkdtempSync(path.join(tmpdir(), "bootguard-sol-"));
  const netGuardPath = path.join(tmp, "netGuard.mjs");
  writeFileSync(netGuardPath, NETGUARD_SRC);
  return new Promise<RunResult>((resolve) => {
    const child = spawn(tsxBin, [bootstrapAbs], {
      cwd: tmp,
      env: { PATH: process.env.PATH ?? "", ...env, NODE_OPTIONS: `--import ${pathToFileURL(netGuardPath).href}` },
    });
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
        setTimeout(() => child.kill("SIGTERM"), 800);
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
console.log("PH-12 12.2d — boot-guard indexer-solana (dovadă comportamentală, proces separat izolat)");

const redisFake = makeRedisFake();
const rpcFake = makeRpcFake();
const redisPort = await listenDynamic(redisFake);
const rpcPort = await listenDynamic(rpcFake);

try {
  // ── env INVALID (grupuri Redis/RPC goale) → iese spontan non-zero, aplicația NU se încarcă ──
  const bad = await runBootstrap({ NODE_ENV: "production" }, { timeoutMs: 20_000 });
  check("1. ⭐⭐⭐ env invalid → IESE SPONTAN cu cod NON-ZERO (nu semnal)", bad.status !== 0 && bad.status !== null && bad.signal === null);
  check("2. ⭐⭐⭐ env invalid → fără eroare de spawn", bad.spawnError === null);
  check("3. ⭐⭐⭐ env invalid → diagnostic FAIL cu grupurile lipsă (REDIS_URL + SOLANA_RPC_URL)",
    /FAIL/.test(bad.out) && /REDIS_URL/.test(bad.out) && /SOLANA_RPC_URL/.test(bad.out));
  check("4. ⭐⭐⭐ env invalid → modulul APLICAȚIEI NU s-a încărcat (marker entry-point ABSENT)", !bad.out.includes(REAL_ENTRY_MARKER));
  check("5. ⭐⭐ env invalid → mesaj explicit de oprire, fără valori", /configurație env invalidă/.test(bad.out));

  // ── env cu WARNINGS (valid) → atinge entry-point-ul real ȘI rămâne viu ──────────────
  const warn = await runBootstrap({
    NODE_ENV: "development",
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    SOLANA_RPC_URL: `http://127.0.0.1:${rpcPort}/rpc`,
    SOLANA_BACKFILL_ENABLED: "treu", // typo → warning (exactFlag), NU problem
  }, { killOnMarker: REAL_ENTRY_MARKER, timeoutMs: 15_000 });
  check("6. ⭐⭐⭐ env cu warnings → boot-guard continuă (marker bootstrap prezent)", warn.out.includes(BOOT_OK_MARKER));
  check("7. ⭐⭐⭐ env cu warnings → warning-ul e vizibil (SOLANA_BACKFILL_ENABLED)", /SOLANA_BACKFILL_ENABLED/.test(warn.out));
  check("8. ⭐⭐⭐ env cu warnings → ENTRY-POINT-ul REAL a fost ATINS (marker aplicație prezent)", warn.out.includes(REAL_ENTRY_MARKER));
  const warnKilledBySignal = warn.signal !== null || (warn.status !== null && warn.status >= 128);
  check("9. ⭐⭐⭐ env cu warnings → procesul a RĂMAS VIU până la oprirea DELIBERATĂ de test (semnal, NU ieșire spontană)",
    warn.stoppedByTest === true && warnKilledBySignal);
  check("10. ⭐⭐⭐ env cu warnings → fără crash post-marker / eroare import (fatal, ERR_MODULE_NOT_FOUND, spawn error)",
    warn.spawnError === null && !/ERR_MODULE_NOT_FOUND/.test(warn.out) && !/\[SOLANA\] fatal:/.test(warn.out) && !/pornire eșuată după validare/.test(warn.out));
  check("10b. ⭐⭐⭐ startup-ul AJUNGE la [SOLANA] redis OK (mini-RESP complet: zcard răspunde, nu se blochează)",
    /\[SOLANA\] redis OK/.test(warn.out));
  check("10c. ⭐⭐⭐ izolare rețea: netGuard-ul e ACTIV în copil (oracle/Jupiter interceptate, nu ies în rețea)",
    /\[NETGUARD\] activ/.test(warn.out));

  // ── source-guard ──────────────────────────────────────────────────────────────────
  const pkg = JSON.parse(readFileSync(path.join(workerDir, "package.json"), "utf8")) as { scripts: Record<string, string> };
  check("11. ⭐⭐⭐ package.json `start` pornește bootstrap.ts (ce lansează Railway `npm run start`)", /bootstrap\.ts/.test(pkg.scripts.start));
  check("12. ⭐⭐⭐ package.json `dev` pornește bootstrap.ts (păstrează `--env-file`)",
    /bootstrap\.ts/.test(pkg.scripts.dev) && /--env-file/.test(pkg.scripts.dev));
  check("13. ⭐⭐⭐ bootstrap.ts: validarea apare TEXTUAL înainte de import(\"./index\") (ordine)", (() => {
    const src = readFileSync(bootstrapAbs, "utf8");
    const vIdx = src.indexOf("validateSolanaEnv(process.env)");
    const iIdx = src.indexOf('import("./index")');
    return vIdx !== -1 && iIdx !== -1 && vIdx < iIdx;
  })());
} finally {
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
