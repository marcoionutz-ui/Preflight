/**
 * scripts/dotenvIsolation.integration.ts — PH-12 12.5c-4 (dovadă comportamentală: izolarea `.env` la spawn-ul worker-ului canary).
 *
 * CONTEXT (fix cgpt P1 rev4): allowlist-ul de env al Gate 2 (`buildWorkerBaseEnv`) scoate orice secret MCP/Supabase din
 * env-ul copilului. DAR `src/bootstrap.ts` + `src/index.ts` cheamă `dotenv.config()` DUPĂ spawn, care citește
 * `process.cwd()/.env` și ar RE-adăuga secrete pe care allowlist-ul le-a scos (ex. un `workers/evm/.env` local). Fix:
 * runnerul de release-gate pornește workerul cu `tsx` LOCAL (căi ABSOLUTE) dintr-un cwd TEMP GOL → `dotenv.config()` nu
 * găsește niciun `.env`. Acest test DOVEDEȘTE mecanismul, pe ENTRY-POINT-ul REAL (`src/bootstrap.ts`):
 *   - CONTROL (cwd = temp CU `.env` ce conține `SUPABASE_SERVICE_ROLE_KEY=<SENTINEL>`): sonda vede SENTINEL-ul →
 *     `service_role_visible=true`. Dovedește că `dotenv.config()` E VIU și chiar citește `cwd/.env` (vulnerabilitatea reală).
 *   - IZOLAT (cwd = temp GOL, fără `.env`): sonda NU vede SENTINEL-ul → `service_role_visible=false`. Dovedește că un cwd
 *     gol (ce folosește runnerul) neutralizează RE-adăugarea — chiar dacă un `workers/evm/.env` ar exista, NU e `cwd/.env`.
 *
 * IZOLARE (model `bootGuard.test.ts`): `cwd` injectat, env EXACT, `tsx` LOCAL (fără npx), Redis fake mini-RESP, `netGuard`
 * (preload) interceptează fetch-ul extern (DEV atinge price-feeds). SONDA (preload) citește `process.env` DUPĂ ce
 * `dotenv.config()` a rulat (setTimeout) și raportează un marker STATIC (boolean), niciodată valoarea secretului.
 *
 * CABLAT în gate (fix cgpt rev5): scriptul `test:ph12-dotenv-isolation` din `workers/evm/package.json` (înlănțuit și în
 * `npm test`-ul workspace-ului, lângă `test:boot`) → CI nu poate omite această proprietate de securitate. Rulare directă
 * din `workers/evm`: `npm run test:ph12-dotenv-isolation` (sau `-w @preflight/worker-evm` din rădăcină). `tsx` LOCAL, fără `npx`.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import * as net from "node:net";
import * as path from "node:path";
import { awaitProcessOutcome, sweepBackstop, runStagedWithConfirm, isCleanExit, type ProcOutcome, type BackstopEntry } from "./boundedProcess";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const workerDir    = process.cwd();
const bootstrapAbs = path.join(workerDir, "src", "bootstrap.ts");
const tsxBin       = path.join(workerDir, "..", "..", "node_modules", ".bin", "tsx");
const PROBE_MARKER = "[ENVPROBE] service_role_visible=";
const SENTINEL     = "SVC_ROLE_SENTINEL_deadbeefcafe"; // valoare FALSĂ, doar pt. detecție; NU un secret real

if (!existsSync(tsxBin)) {
  console.error(`[test:dotenv] tsx local negăsit la ${tsxBin} — rulează \`npm install\` la rădăcina monorepo-ului (fără npx).`);
  process.exit(1);
}

// ── scaffolding rețea (identic ca bootGuard: Redis fake + netGuard) ──
const openSockets = new Set<net.Socket>();
function track(sock: net.Socket): void { openSockets.add(sock); sock.on("close", () => openSockets.delete(sock)); sock.on("error", () => {}); }

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
  if (name === "INFO") { const i = "redis_version:7.4.0\r\nloading:0\r\nrole:master\r\n"; return `$${i.length}\r\n${i}\r\n`; }
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
      while ((r = parseRespCommand(acc)) !== null) { acc = acc.slice(r.consumed); sock.write(Buffer.from(respReply(r.name), "latin1")); }
    });
  });
}
function listenDynamic(srv: net.Server): Promise<number> {
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => { const addr = srv.address(); resolve(typeof addr === "object" && addr ? addr.port : 0); }));
}

const NETGUARD_SRC = `
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) ? input.url : String(input);
  if (/^wss?:\\/\\//.test(url) || /^https?:\\/\\/(127\\.0\\.0\\.1|localhost)(:|\\/|$)/.test(url)) return realFetch(input, init);
  return new Response(JSON.stringify({ data: {}, result: null }), { status: 200, headers: { "content-type": "application/json" } });
};
`;
// SONDA: după ce `dotenv.config()` (bootstrap + index) a rulat, citește process.env și raportează un BOOLEAN static.
// setTimeout(1200ms) > timpul până index.ts își face `dotenv.config()`-ul. NICIODATĂ valoarea secretului în output.
const PROBE_SRC = `
setTimeout(() => {
  const v = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const visible = typeof v === "string" && v.indexOf("SENTINEL") !== -1;
  console.error("${PROBE_MARKER}" + visible);
}, 1200);
`;

interface RunResult { out: string; sawProbe: boolean; visible: boolean | null; outcome: ProcOutcome; }

// Registru EXTERIOR de procese cu LATCH (fix cgpt rev7 #2 + rev8-2): fiecare copil spawnat e urmărit ca `sweepBackstop` să
// confirme dispariția (lider reap-uit + grup dispărut). Confirmarea se face IMEDIAT după fiecare rulare (înainte de
// următorul spawn) → intrarea e latch-uită și NU mai e sondată/semnalată la sweep-ul global (fără fereastră de reutilizare PGID).
const registry: BackstopEntry[] = [];

/**
 * Rulează entry-point-ul real cu sonda de env; teardown MĂRGINIT în două faze prin `awaitProcessOutcome`. Copilul e spawnat
 * `detached` (lider de grup) → `backstopKill` poate face SIGKILL de process-GROUP. Dacă `exit` nu vine ori kill-ul e
 * absorbit, `await`-ul se rezolvă mărginit — testul NU atârnă. `preloadDir` se curăță în `finally` (backstop de resurse,
 * independent de teardown-ul copilului).
 */
async function runWorker(env: Record<string, string>, cwd: string, timeoutMs: number): Promise<RunResult> {
  const preloadDir   = mkdtempSync(path.join(tmpdir(), "dotenviso-pre-"));
  const netGuardPath = path.join(preloadDir, "netGuard.mjs");
  const probePath    = path.join(preloadDir, "envProbe.mjs");
  writeFileSync(netGuardPath, NETGUARD_SRC);
  writeFileSync(probePath, PROBE_SRC);
  const nodeOptions = `--import ${pathToFileURL(probePath).href} --import ${pathToFileURL(netGuardPath).href}`;
  const child = spawn(tsxBin, [bootstrapAbs], { cwd, detached: true, env: { PATH: process.env.PATH ?? "", ...env, NODE_OPTIONS: nodeOptions } });
  registry.push({ child, teardownConfirmed: false }); // urmărit pt. backstop-ul cu latch
  let out = "", killScheduled = false;
  const onData = (d: Buffer) => {
    out += d.toString();
    // Oprire GRAȚIOASĂ după ce sonda a raportat: SIGTERM (worker-evm are handler PH-13 → exit ordonat cu 0).
    if (out.includes(PROBE_MARKER) && !killScheduled) { killScheduled = true; setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 300); }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  try {
    // deadline TARE (SIGKILL) + reap mărginit → rezultat garantat, niciodată atârnare.
    const outcome = await awaitProcessOutcome(child, { deadlineMs: timeoutMs, reapGraceMs: 3000, killSignal: "SIGKILL" });
    const m = out.match(/\[ENVPROBE\] service_role_visible=(true|false)/);
    return { out, sawProbe: m !== null, visible: m ? m[1] === "true" : null, outcome };
  } finally {
    rmSync(preloadDir, { recursive: true, force: true }); // backstop de resurse — INDIFERENT de teardown-ul copilului
  }
}

async function main(): Promise<void> {
  console.log("PH-12 12.5c-4 — izolare `.env` la spawn worker (cwd temp gol vs. cwd cu .env, entry-point REAL)");

  const redisFake = makeRedisFake();
  const redisPort = await listenDynamic(redisFake);
  const devEnv = { NODE_ENV: "development", PREFLIGHT_MODE: "DEV", REDIS_URL: `redis://127.0.0.1:${redisPort}`, ENABLED_CHAINS: "base" };

  // Ambele cwd sunt directoare TEMP: control-ul primește un `.env` cu SENTINEL, izolatul rămâne GOL.
  const cwdCtrl = mkdtempSync(path.join(tmpdir(), "dotenviso-ctrl-"));
  const cwdIso  = mkdtempSync(path.join(tmpdir(), "dotenviso-iso-"));
  writeFileSync(path.join(cwdCtrl, ".env"), `SUPABASE_SERVICE_ROLE_KEY=${SENTINEL}\n`);

  try {
    // ⭐ fix cgpt rev9-2: rulare STADIALĂ cu poartă de teardown — după CONTROL, sweep imediat; dacă rămâne `unconfirmed`,
    //   IZOLATUL NU se pornește (evită fereastra de reutilizare PGID). `runStagedWithConfirm` semnalează `gateViolated`.
    const staged = await runStagedWithConfirm(
      [
        () => runWorker(devEnv, cwdCtrl, 25_000), // CONTROL: cwd CU .env (SENTINEL) → dotenv îl citește → vizibil
        () => runWorker(devEnv, cwdIso, 25_000),  // IZOLAT: cwd GOL → dotenv nu găsește .env → NEvizibil
      ],
      () => sweepBackstop(registry, { reapGraceMs: 3000 }), // confirmare + LATCH imediat între pași
    );
    if (staged.gateViolated) {
      // Proprietate ÎNCĂLCATĂ: teardown-ul unui worker n-a putut fi confirmat înainte de următorul spawn → roșu PERMANENT
      // (retry-ul global din finally nu schimbă asta). Al doilea worker NU a fost pornit.
      check("0. ⭐⭐⭐ POARTĂ: teardown confirmat ÎNAINTE de următorul spawn (proprietate încălcată → roșu permanent)", false);
      console.error("[teardown] sweep imediat a rămas UNCONFIRMED după worker 1 — al doilea worker NU a fost pornit (fereastră PGID evitată).");
    }
    const ctrl = staged.results[0]; // rulat mereu (primul pas)
    const iso  = staged.results[1]; // undefined dacă poarta a oprit înainte de al doilea spawn
    if (ctrl) {
      check("1. ⭐⭐⭐ CONTROL: cwd cu .env → sonda a raportat (dotenv.config() a rulat pe entry-point-ul real)", ctrl.sawProbe);
      check("2. ⭐⭐⭐ CONTROL: SENTINEL VIZIBIL → dotenv.config() chiar citește cwd/.env (vulnerabilitatea reală)", ctrl.visible === true);
      // ⭐ fix cgpt rev7 #3: teardown STRICT `exit`+cod 0+FĂRĂ semnal (deadline_reaped/unreaped/spawn_error → roșu).
      check("6. ⭐⭐⭐ CONTROL: teardown STRICT curat (exit 0, fără semnal)", isCleanExit(ctrl.outcome));
    }
    if (iso) {
      check("3. ⭐⭐⭐ IZOLAT: cwd gol → sonda a raportat (entry-point real atins)", iso.sawProbe);
      check("4. ⭐⭐⭐ IZOLAT: SENTINEL NEVIZIBIL → cwd gol neutralizează RE-adăugarea via dotenv (FIX-ul)", iso.visible === false);
      check("5. ⭐⭐⭐ contrast decisiv: control vizibil ȘI izolat nevizibil (mecanismul e cwd-ul, nu norocul)",
        !!ctrl && ctrl.visible === true && iso.visible === false);
      check("7. ⭐⭐⭐ IZOLAT: teardown STRICT curat (exit 0, fără semnal)", isCleanExit(iso.outcome));
    }
  } finally {
    // ⭐ fix cgpt rev7 #2 + rev8-2: sweep GLOBAL — reîncearcă EXCLUSIV intrările încă neconfirmate (cele latch-uite sunt
    //   sărite: fără groupProbe/killGroup → niciun PGID străin reutilizat nu e semnalat). Dacă vreuna rămâne neconfirmată,
    //   testul termină ROȘU cu mesaj static (nu pretinde cleanup reușit).
    const sweep = await sweepBackstop(registry, { reapGraceMs: 3000 });
    check("8. ⭐⭐⭐ backstop proces: niciun copil abandonat (toate confirmate moarte, latch respectat)", sweep.unconfirmed === 0);
    if (sweep.unconfirmed > 0) console.error(`[teardown] ${sweep.unconfirmed} proces(e) NECONFIRMATE moarte — cleanup INCOMPLET (roșu, fail-closed).`);
    // backstop de resurse
    for (const sock of openSockets) sock.destroy();
    await new Promise<void>((res) => redisFake.close(() => res()));
    rmSync(cwdCtrl, { recursive: true, force: true });
    rmSync(cwdIso, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} OK` + (failed ? `  —  ${failed} FAIL` : ""));
  if (failed > 0) process.exit(1);
}

void main();
