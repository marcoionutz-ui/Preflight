/**
 * runReleaseGateLive.mjs — PH-12 12.5c-4 LIVE (dovada REALĂ a întregului release chain, într-un SINGUR runner).
 *
 * NU două gate-uri verzi rulate separat: un runner UNIC deține tot ciclul —
 *   fixture(plan:"starter") → listener loopback → Gate 1 live (login→consent→token→MCP→refresh→rotație `mcp_rotated`)
 *   → captează AT2 (tokenul ROTIT) PRIVAT → Gate 2 live cu AT2 (worker Base WS-live + strict health + tp_worker_snapshot
 *   + tp_health_check/WS + teardown confirmat) → backstop worker → cleanup Redis → cleanup Supabase.
 *
 * ⭐ AT2 (lock Marco): capturat DOAR dintr-un `refresh` valid + `ok`; intră în ledger EXCLUSIV pt. cleanup; intră în
 *   Gate 2 EXCLUSIV ca argument; NU intră în niciun report/excepție/log; `at2Private = undefined` în `finally`.
 * ⭐ SHORT-CIRCUIT = doar verdictul (lock Marco #1): backstop + Redis + Supabase se AȘTEAPTĂ COMPLET chiar dacă Gate 1/2
 *   pică (backstop+Redis în `finally`-ul corpului fixture; Supabase în `finally`-ul lui `runWithGate1Fixture`).
 * ⭐ `workerBackstopOk` SEPARAT de `gate2Ok` (lock Marco #2): `sweepBackstop` dovedește INDEPENDENT că registrul nu mai
 *   ține un grup posibil orfan. `runChain` întoarce cei 6 booleeni; verdictul + prezentarea aparțin stratului 12.5d-1.
 * ⭐ Verdictul se compune ABIA după ce `runWithGate1Fixture` s-a încheiat (cleanup Supabase există doar atunci).
 *
 * ⭐ ARTEFACT (12.5d-2): un SINGUR punct de emitere/exit (entrypoint). `runChain` NU iese/printează; el întoarce booleenii
 *   (sau aruncă static). Entrypoint-ul construiește raportul via 12.5d-1 (`buildReleaseReportFromRaw` → `composeReleaseVerdict`
 *   ca sursă UNICĂ), scrie artefactul JSON versionat ATOMIC (`renderReleaseReportJson`, temp→rename), emite textul uman pe
 *   stderr (`renderReleaseReportText`) și setează `process.exitCode = releaseExitCode(report)` FĂRĂ `process.exit` (stderr se
 *   flush-uiește; procesul iese natural după ce handle-urile sunt eliberate). timeout / config invalid / excepție înainte de
 *   toate semnalele → raport `malformed` ROȘU; scriere de artefact eșuată → exit 1 obligatoriu.
 * ⭐ OWNERSHIP (fix arhitectural cgpt — înlocuiește vechiul `RELEASE_REPORT_JSON` + classify/delete): artefactul trăiește
 *   într-un DIRECTOR FIX deținut de runner (`<cwd>/.release-gate/report.json`), creat cu `mode 0700` și VERIFICAT deținut (uid)
 *   + privat (fără biți group/other), sub un LOCK exclusiv (`.release-gate/.lock`, `O_CREAT|O_EXCL`). Un al doilea run concurent
 *   → refuz; un lock stale (crash) → ștergere manuală. La startup se stampează un placeholder ROȘU în director → crash/kill/
 *   write-fail lasă ROȘU pe disc, NICIODATĂ verde-vechi. Ownership-ul exclusiv închide TOCTOU-ul (delete/write/temp-symlink —
 *   temp scris cu `wx`), concurența și crash-consistency, fără vreo cale arbitrară din env. Primitivele de fișier trăiesc în
 *   `releaseGateArtifact.ts` (typecheck-uit + testat în CI, gate-14; source-guard că `.mjs`-ul le folosește). Artefactul e
 *   re-parsabil de CI/monitor prin `parseReleaseReportJson`.
 *
 * PREREQUISITE (stack local WSL, cost-aware): Docker + Supabase local (:54321) + Redis loopback + MCP dev pe ORIGIN cu
 *   `HEALTH_EXPECTED_CHAINS=base` + `HEALTH_EXPECT_INDEXER_EVM=0` + `HEALTH_EXPECT_SOLANA_WORKER=0`; `ALCHEMY_BASE_WS` setat.
 * .mjs OPT-IN (NU în tsc/eslint/test). Logica testabilă e în `.ts` comise (`releaseGateCompose` + `releaseGateReport` +
 *   `releaseGateArtifact` +
 *   toate leaf-urile canary). Rulează: `set -a; . .env.local; set +a; npx tsx runReleaseGateLive.mjs` din ~/preflight/mcp.
 *   Artefactul: `<cwd>/.release-gate/report.json` (fix). `RELEASE_DEBUG=1` → stderr worker redactat + eroarea de browser Gate 1.
 */

import crypto from "node:crypto";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import Redis from "ioredis";
import { runWithGate1Fixture, buildFixtureStoreAfterIsolation } from "./lib/mcp/canaryFixture.ts";
import { makeSupabaseFixtureStore } from "./lib/mcp/canaryFixtureSupabase.ts";
import { startLoopbackCapture } from "./lib/mcp/canaryListener.ts";
import { generatePkcePair, generateState } from "./lib/mcp/canaryPkce.ts";
import { verifyCallback } from "./lib/mcp/canaryCallback.ts";
import { exchangeAuthCode, refreshToken } from "./lib/mcp/canaryTokenClient.ts";
import { listMcpTools } from "./lib/mcp/canaryMcpClient.ts";
import { makeFetchPostForm, makeFetchPostJson } from "./lib/mcp/canaryFetch.ts";
import { runGate1, vetGate1Targets } from "./lib/mcp/canaryGate1.ts";
import { makeKeyLedger, runCanaryRedisCleanup } from "./lib/mcp/canaryRedisCleanup.ts";
import { runCleanupWithBoundedRetry } from "./lib/mcp/canaryRedisRetry.ts";
import { runGate2 } from "./lib/mcp/canaryGate2.ts";
import { makeGate2Steps, sweepBackstop, DEFAULT_STOP_TIMING } from "./lib/mcp/canaryGate2Steps.ts";
import { stopManagedProcess, realStopTimers } from "./lib/mcp/canaryWorkerProcess.ts";
import { buildReleaseReportFromRaw, renderReleaseReportText, renderReleaseReportJson, releaseExitCode } from "./lib/mcp/releaseGateReport.ts";
import { ensureOwnedPrivateDir, acquireLock, releaseLock, writeArtifactAtomic, demoteArtifactOnCleanupFailure } from "./lib/mcp/releaseGateArtifact.ts";
import { assertMailpitLoopback, assertMagicLinkBoundToSupabase, reconcileReadiness, readGenBaseline, makeGenerationBarrier, assertBaselineAdmissible, startGate2IfBaselineAdmissible } from "./lib/mcp/canaryReleaseSteps.ts";
import { REDIS_KEYS } from "@preflight/schema"; // chei oficiale worker_runtime/worker_snapshot (bariera de generație)

const ORIGIN       = process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3000";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MAILPIT      = process.env.MAILPIT_URL || "http://127.0.0.1:54324";
let   MAILPIT_ORIGIN = MAILPIT; // înlocuit cu ORIGINEA canonică validată de assertMailpitLoopback (nu valoarea brută)
const REDIS_URL    = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const ALCHEMY_WS   = process.env.ALCHEMY_BASE_WS || "";
const DEBUG_ON     = process.env.RELEASE_DEBUG === "1"; // byte-exact
// ── Artefact de release-gate: DIRECTOR FIX deținut de runner + lock exclusiv (înlocuiește vechiul RELEASE_REPORT_JSON +
//    classify/delete). Dir sub cwd (deținut de operator), creat de noi cu mode 0700; TOATE operațiile pe artefact stau ÎN el,
//    sub lock → ownership exclusiv pe durata run-ului: închide TOCTOU-ul de path arbitrar (delete/write/temp-symlink),
//    concurența (al doilea run refuză) și crash-consistency (placeholder roșu la startup → niciodată verde-vechi).
const GATE_DIR = path.resolve(process.cwd(), ".release-gate");
const ARTIFACT = path.join(GATE_DIR, "report.json"); // artefactul JSON versionat (re-parsabil de CI/monitor prin parseReleaseReportJson)
const LOCK     = path.join(GATE_DIR, ".lock");        // lock exclusiv (pid); un lock STALE dintr-un crash se șterge manual

const log   = (...a) => console.log("[release-live]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const __dirname  = path.dirname(fileURLToPath(import.meta.url));
// ⭐ fix cgpt P1 (rev4): NU pornim workerul cu `npx tsx` din `cwd = workers/evm` — `dotenv.config()` din bootstrap.ts+
//   index.ts citește `process.cwd()/.env` DUPĂ spawn și ar RE-adăuga secrete pe care allowlist-ul le-a scos. Pornim cu
//   `tsx` LOCAL (căi ABSOLUTE, PATH-independent) dintr-un cwd TEMP GOL → `dotenv.config()` nu găsește niciun `.env`
//   (nici `workers/evm/.env`). Exact modelul din `workers/evm/scripts/bootGuard.test.ts`.
const WORKER_DIR     = path.resolve(__dirname, "../workers/evm");
const TSX_BIN        = path.resolve(__dirname, "../node_modules/.bin/tsx");
const BOOTSTRAP_ABS  = path.join(WORKER_DIR, "src", "bootstrap.ts");
// ⭐ fix cgpt P2 (rev5): cwd-ul temp NU se creează la import (înainte de verificările hard) — s-ar scurge `release-wevm-*`
//   în /tmp la orice ieșire/eroare timpurie. Se creează în `main`, DUPĂ toate verificările, SUB try/finally-ul exterior.
const GEN_CMD_TIMEOUT_MS = 3500; // < graceMs (5000) Gate 2 — citirea generației e mărginită sub confirmarea post-abort
const RUNNER_DEADLINE_MS = 540000; // 9 min: Gate 1 (~1-2 min) + Gate 2 (global 300s) + cleanups
let timedOut = false;

function isLoopbackRedis(u) {
  let url; try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") return false;
  const h = url.hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

// fetch mărginit (deadline acoperă ȘI citirea body-ului) — pt. Supabase-happy Response + Mailpit.
function boundedFetch(timeoutMs = 15000) {
  return async (input, init = {}) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    if (typeof t.unref === "function") t.unref();
    const res = await fetch(input, { ...init, signal: ctrl.signal });
    const clear = () => clearTimeout(t);
    const oj = res.json.bind(res), ot = res.text.bind(res);
    res.json = async () => { try { return await oj(); } finally { clear(); } };
    res.text = async () => { try { return await ot(); } finally { clear(); } };
    return res;
  };
}
const bfetch = boundedFetch(15000);

// ── Mailpit magic link (poll) ──
async function fetchMagicLink(email) {
  const q = encodeURIComponent(`to:"${email}"`);
  for (let i = 0; i < 40; i++) {
    try {
      const res = await bfetch(`${MAILPIT_ORIGIN}/api/v1/search?query=${q}`);
      if (res.ok) {
        const j = await res.json();
        const m = (j.messages || [])[0];
        if (m && m.ID) {
          const full = await bfetch(`${MAILPIT_ORIGIN}/api/v1/message/${m.ID}`);
          if (full.ok) { const fj = await full.json(); const link = extractVerify((fj.HTML || "") + "\n" + (fj.Text || "")); if (link) return link; }
        }
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error("magic link negăsit în Mailpit după ~20s");
}
function extractVerify(body) {
  const d = body.replace(/&amp;/g, "&").replace(/=\r?\n/g, "");
  const m = d.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]*/i) || d.match(/https?:\/\/[^\s"'<>]*[?&](?:token|token_hash|code)=[^\s"'<>]*/i);
  return m ? m[0] : null;
}
function mapAuthzReason(reason) {
  if (/malformed/i.test(reason)) return "malformed";
  if (/state mismatch/i.test(reason)) return "state_mismatch";
  if (/iss/i.test(reason)) return "iss_mismatch";
  return "callback_error";
}
function mapMcp(r) {
  if (r.ok) return { ok: true };
  if (r.stage === "transport") return { ok: false, code: "transport" };
  if (r.stage === "parse") return { ok: false, code: "bad_shape" };
  if (r.stage === "jsonrpc") return { ok: false, code: "protocol_error" };
  if (r.status === 401 || r.status === 403) return { ok: false, code: "unauthorized" };
  if (r.status === 429) return { ok: false, code: "rate_limited" };
  return { ok: false, code: "unavailable" };
}
function cleanupRedisBounded(port, ledger, maxAttempts = 3) {
  return runCleanupWithBoundedRetry(
    () => runCanaryRedisCleanup(port, ledger, ledger.recordFamilyId),
    { maxAttempts, onRetry: (i) => { log(`redis-cleanup: încercarea ${i} tranzitorie, retry…`); return sleep(500); } },
  );
}

async function runChain() {
  // Prereq-uri (mutate din top-level): eșec → linie STATICĂ pe stderr + throw; entrypoint-ul emite raport malformed ROȘU.
  // Fără process.exit intermediar — un singur punct de emitere/exit (entrypoint).
  if (!SERVICE_ROLE) { console.error("[release-live] prereq: SUPABASE_SERVICE_ROLE_KEY lipsă — ai făcut `set -a; . .env.local; set +a`?"); throw new Error("prereq"); }
  if (!ALCHEMY_WS)   { console.error("[release-live] prereq: ALCHEMY_BASE_WS lipsă — Gate 2 LIVE ar rula base scan-only (fără date/WS)."); throw new Error("prereq"); }
  { const mp = assertMailpitLoopback(MAILPIT); if (!mp.ok) { console.error("[release-live] prereq: MAILPIT_URL respins:", mp.reason); throw new Error("prereq"); } MAILPIT_ORIGIN = mp.origin; }

  // Poarta TARE: izolare + origini curate (Gate 1). Gate 2 re-vetează intern (inclusiv REDIS loopback).
  const vet = vetGate1Targets({ mcpBaseUrl: ORIGIN, supabaseUrl: SUPABASE_URL });
  if (!vet.ok) { console.error("izolare/țintă respinsă de plasa anti-prod (fail-closed)"); throw new Error("isolation"); }
  const targets0 = vet.targets;
  const cleanCfg = { mcpBaseUrl: targets0.mcpOrigin, supabaseUrl: targets0.supabaseUrl };
  if (!isLoopbackRedis(REDIS_URL)) { console.error("REDIS_URL non-loopback — refuz (anti-prod)"); throw new Error("isolation"); }

  const built = buildFixtureStoreAfterIsolation(cleanCfg, (url) => makeSupabaseFixtureStore(url, SERVICE_ROLE, { fetch: bfetch }));
  if (!built.ok) { console.error("construirea store-ului respinsă de plasa anti-prod"); throw new Error("isolation"); }
  const store = built.store;
  log("izolat OK → MCP", targets0.mcpOrigin, "| Supabase", targets0.supabaseUrl, "| Redis loopback OK");

  const RUNTIME_KEY  = REDIS_KEYS.workerRuntime("base");
  const SNAPSHOT_KEY = REDIS_KEYS.workerSnapshot("base");
  const runId    = "rel" + crypto.randomBytes(6).toString("hex");
  // ⭐ fix cgpt P1 (rev4): id PROASPĂT de identitate a runului, injectat în worker (config închis) → publicat de proces în
  //   worker_runtime/worker_snapshot.canaryRunId. Token opac [A-Za-z0-9] (validat de buildWorkerBaseEnv). NU logat, NU din baseEnv.
  const workerRunId = "wrk" + crypto.randomBytes(12).toString("hex");
  const postForm = makeFetchPostForm();
  const postJson = makeFetchPostJson();
  const clock    = { now: () => performance.now(), sleep };
  const ledger   = makeKeyLedger();
  const registry = [];
  const onSpawn = (proc) => { registry.push({ proc, confirmed: false }); log("worker spawnat pid", proc.pid); };
  const onStopResult = (r) => { const e = registry[registry.length - 1]; if (e) e.confirmed = r.teardownConfirmed; };

  // ⭐ fix cgpt P2 (rev5): TOATE resursele (temp cwd, cele două conexiuni Redis, listenerul, browserul) se ACHIZIȚIONEAZĂ
  //   DUPĂ verificările hard și SUB un SINGUR try/finally exterior. Fiecare handle e `let` (poate rămâne null dacă
  //   achiziția anterioară a aruncat) → finally-ul curăță DOAR ce s-a achiziționat. Niciun `process.exit()` între o
  //   achiziție și instalarea cleanup-ului. Directorul `release-wevm-*` se curăță inclusiv la config invalid / browser /
  //   listener failure (achiziția lor e în try).
  let spawnCwd = null, redis = null, genRedis = null, listener = null, browser = null, deadlineTimer = null;
  let at2Private; // AT2 — privat, pasat DOAR lui Gate 2. Șters în finally.
  let outcome;
  try {
    spawnCwd = mkdtempSync(path.join(tmpdir(), "release-wevm-")); // cwd izolat gol (fără .env) — șters în finally
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
    const redisPort = {
      get: async (key) => { try { const v = await redis.get(key); return v === null ? { status: "not_found" } : { status: "found", value: v }; } catch { return { status: "unavailable" }; } },
      del: async (key) => { try { const n = await redis.del(key); return n >= 1 ? { status: "deleted" } : { status: "not_found" }; } catch { return { status: "unavailable" }; } },
    };
    // ⭐ fix cgpt P2 (rev4): bariera de generație citește pe o conexiune DEDICATĂ, MĂRGINITĂ — `commandTimeout` la nivel
    //   ioredis (< graceMs) + `disconnect` la abort-ul Gate 2 (op-ul e TERMINAT înainte de stop/cleanup, nu abandonat).
    //   enableOfflineQueue = default (true): prima comandă AȘTEAPTĂ conectarea (loopback, ms) în loc să respingă pe un
    //   Redis sănătos dar încă neconectat; deadline-ul rămâne mărginit de commandTimeout + timer-ul nostru.
    genRedis = new Redis(REDIS_URL, { commandTimeout: GEN_CMD_TIMEOUT_MS, maxRetriesPerRequest: 1, lazyConnect: false });
    genRedis.on("error", () => { /* erorile sunt tratate prin respingerea GET-ului mărginit → fail-closed; fără log (anti-zgomot) */ });
    const genConn = { get: (key) => genRedis.get(key), disconnect: () => { try { genRedis.disconnect(); } catch { /* */ } } };

    listener = await startLoopbackCapture({ timeoutMs: 120000 });
    log("listener pe", listener.redirectUri);
    browser = await chromium.launch({ headless: true });
    const launch = {
      // ⭐ fix cgpt P1: `tsx` LOCAL + bootstrap ABSOLUT + cwd TEMP GOL → dotenv.config() nu re-adaugă secrete din vreun `.env`.
      command: TSX_BIN, args: [BOOTSTRAP_ABS], cwd: spawnCwd,
      // baseEnv e filtrat de buildWorkerBaseEnv la ALLOWLIST-ul de infra (niciun secret trece). Config-ul workerului se
      // injectează EXPLICIT: control keys (WS/REDIS/ENABLED_CHAINS/PREFLIGHT_MODE) + config închis (RPC opțional + CANARY_RUN_ID).
      baseEnv: { ...process.env }, alchemyBaseWs: ALCHEMY_WS, canaryRunId: workerRunId,
      ...(process.env.ALCHEMY_BASE_RPC ? { alchemyBaseRpc: process.env.ALCHEMY_BASE_RPC } : {}),
      ...(DEBUG_ON ? { onDebugLine: (line) => console.error("[worker]", line) } : {}),
    };

    // ⭐ fix cgpt P1 (rev5): baseline PRE-spawn cu retry MĂRGINIT — dacă rămâne inadmisibil (invalid/unavailable), NU
    //   pornim workerul (bariera n-ar deveni verde → am arde Alchemy). Citit pe conexiunea dedicată, înainte de startWorker.
    const readAdmissibleBaseline = async () => {
      let last = null;
      for (let i = 0; i < 3; i++) {
        last = await readGenBaseline(genConn, RUNTIME_KEY, SNAPSHOT_KEY, GEN_CMD_TIMEOUT_MS);
        if (assertBaselineAdmissible(last).ok) return last;
        if (i < 2) await sleep(500);
      }
      return last; // inadmisibil după retry → startGate2IfBaselineAdmissible va refuza spawn-ul
    };

    const localDeadlineTimer = setTimeout(() => { timedOut = true; if (browser) browser.close().catch(() => {}); if (listener) { try { listener.close(); } catch {} } }, RUNNER_DEADLINE_MS);
    if (typeof localDeadlineTimer.unref === "function") localDeadlineTimer.unref();
    deadlineTimer = localDeadlineTimer;

    outcome = await runWithGate1Fixture(store, { redirectUri: listener.redirectUri, runId, plan: "starter" }, async (handle) => {
      log("fixtură OK (plan starter) → user", handle.userId, "| client", handle.clientId, "| scopes", handle.scopes.join(","));
      const inner = { gate1Ok: false, at2Captured: false, gate2Ok: false, workerBackstopOk: false, redisCleanupOk: false, gate1: null, gate2: null, sweep: null, redisCleanup: null };
      try {
        // ── GATE 1 (cu wrapper refresh care capturează AT2 privat + în ledger pt. cleanup) ──
        const g1 = await runGate1(cleanCfg, (targets) => {
          const base = ({
            readiness: async () => {
              // ⭐ fix cgpt P1 (status mismatch): concordanță transport↔corp — 503/corp-200 sau 200/corp-503 → roșu.
              try { const res = await bfetch(targets.healthUrl); const body = await res.json().catch(() => null); return reconcileReadiness(res.status, body); }
              catch { return { ok: false, code: "unreachable" }; }
            },
            authorize: async () => {
              const pkce = generatePkcePair(); const state = generateState();
              const url = `${targets.authorizeUrl}?` + new URLSearchParams({ response_type: "code", client_id: handle.clientId, redirect_uri: handle.redirectUri, scope: handle.scopes.join(" "), state, code_challenge: pkce.challenge, code_challenge_method: "S256", resource: targets.resource }).toString();
              const ctx = await browser.newContext(); const page = await ctx.newPage(); const cbPromise = listener.waitForCallback();
              try {
                await page.goto(url, { waitUntil: "domcontentloaded" });
                await page.waitForLoadState("networkidle").catch(() => {});
                await page.waitForSelector("#email", { timeout: 15000 });
                await page.fill("#email", handle.email);
                await page.waitForFunction((v) => { const el = document.querySelector("#email"); return !!el && el.value === v; }, handle.email, { timeout: 8000 }).catch(() => {});
                if ((await page.inputValue("#email")) !== handle.email) await page.fill("#email", handle.email);
                await page.click("button[type=submit]");
                await page.waitForSelector("text=Check your email", { timeout: 20000 });
                const magic = await fetchMagicLink(handle.email);
                // ⭐ fix cgpt P1: magic link-ul acceptat DOAR dacă e legat de Supabase-ul VETAT (origine + /auth/v1/verify).
                const mb = assertMagicLinkBoundToSupabase(magic, cleanCfg.supabaseUrl);
                if (!mb.ok) return { ok: false, code: "magic_link_unbound" };
                await page.goto(magic, { waitUntil: "domcontentloaded" });
                await page.waitForSelector("button[value=approve]", { timeout: 15000 });
                await page.click("button[value=approve]");
                const parsed = await cbPromise;
                const v = verifyCallback(parsed, { expectedState: state, issuer: targets.mcpOrigin });
                if (!v.ok) return { ok: false, code: mapAuthzReason(v.reason) };
                return { ok: true, bundle: { code: v.code, redirectUri: handle.redirectUri, codeVerifier: pkce.verifier } };
              } catch {
                // ⭐ fix cgpt P2: NICIODATĂ err.message/URL în log (poate purta token/cheie). Doar marker static + screenshot local.
                if (DEBUG_ON) { try { await page.screenshot({ path: "/tmp/release-fail.png", fullPage: true }); console.error("[release-live][DEBUG] authorize a eșuat (browser) → /tmp/release-fail.png"); } catch {} }
                return { ok: false, code: "browser_failed" };
              } finally { await ctx.close(); }
            },
            exchange: (bundle) => exchangeAuthCode(postForm, { tokenEndpoint: targets.tokenUrl, clientId: handle.clientId, resource: targets.resource }, bundle),
            mcpProbe: async (accessToken) => mapMcp(await listMcpTools(postJson, { mcpEndpoint: targets.mcpUrl }, { accessToken })),
            refresh:  (rt) => refreshToken(postForm, { tokenEndpoint: targets.tokenUrl, clientId: handle.clientId, resource: targets.resource }, { refreshToken: rt }),
          });
          return {
            readiness: base.readiness,
            authorize: async () => { const o = await base.authorize(); if (o && o.ok) ledger.recordAuthCode(o.bundle.code); return o; },
            exchange:  async (b) => { const r = await base.exchange(b); if (r && r.ok) { ledger.recordAccessToken(r.accessToken); ledger.recordRefreshToken(r.refreshToken); } return r; },
            mcpProbe:  base.mcpProbe,
            // ⭐ AT2: DOAR dintr-un refresh valid+ok → ledger (cleanup) + at2Private (Gate 2). Niciodată în log/report.
            refresh:   async (rt) => { const r = await base.refresh(rt); if (r && r.ok) { ledger.recordAccessToken(r.accessToken); ledger.recordRefreshToken(r.refreshToken); at2Private = r.accessToken; } return r; },
          };
        });
        inner.gate1 = g1; inner.gate1Ok = g1.ok === true;
        log("Gate 1:", g1.ok ? "VERDE (" + g1.stages.join("→") + ")" : "FAIL @ " + g1.stage + " — " + g1.reason);

        // ── AT2 capturat? (doar dacă Gate 1 verde inclusiv mcp_rotated ȘI refresh a produs un access nou) ──
        if (inner.gate1Ok && typeof at2Private === "string" && at2Private.length > 0) {
          inner.at2Captured = true;
          log("AT2 capturat (privat) → baseline generație + Gate 2 …");
          // ⭐ BASELINE generație PRE-spawn (worker_runtime.updatedAt + worker_snapshot.savedAt, chei oficiale, ABSOLUT),
          //    citit pe conexiunea DEDICATĂ mărginită, cu retry. Fără pre-clean — nu alterăm starea observată.
          const genBaseline = await readAdmissibleBaseline();
          // ⭐ fix cgpt P1+P2: bariera e ÎN poll-ul Gate 2 (nu post-hoc). La fiecare tick cere (1) IDENTITATE pe AMBELE
          //    payloaduri — worker_runtime.canaryRunId ȘI worker_snapshot.canaryRunId === workerRunId (ambele heartbeat-uri
          //    sunt ale PROCESULUI pe care acest run l-a pornit, nu ale unui writer străin care doar avansează timestampuri)
          //    ȘI (2) AVANSARE strict a ambelor timestampuri. Citire mărginită + abort-aware. Orice necitibil/neidentificat → roșu.
          const barrier = makeGenerationBarrier({ expectedRunId: workerRunId, baseline: genBaseline, conn: genConn, runtimeKey: RUNTIME_KEY, snapshotKey: SNAPSHOT_KEY, commandTimeoutMs: GEN_CMD_TIMEOUT_MS });
          const checkGeneration = async (sig) => {
            const g = await barrier(sig);
            return g.ok ? { ok: true, reason: "generație+identitate OK post-spawn" } : { ok: false, reason: g.reason };
          };
          // ── GATE 2 cu AT2 (in-process) — DAR gât de admisibilitate a baseline-ului: baseline invalid/unavailable → NU
          //    pornim workerul (ZERO spawn/makeSteps), Gate 2 roșu cu cod închis. absent/value → runGate2 real.
          const g2cfg = { mcpBaseUrl: cleanCfg.mcpBaseUrl, supabaseUrl: cleanCfg.supabaseUrl, redisUrl: REDIS_URL, accessToken: at2Private };
          const gated = await startGate2IfBaselineAdmissible(genBaseline, () =>
            runGate2(g2cfg, (t) => makeGate2Steps({ launch, onSpawn, onStopResult, checkGeneration }, t), clock, { warmupMs: 180000, globalMs: 300000, stopTimeoutMs: 20000, graceMs: 5000 }),
          );
          if (gated.started) {
            const g2 = gated.result;
            inner.gate2 = g2; inner.gate2Ok = g2.ok === true;
            log("Gate 2:", g2.ok ? "VERDE (" + g2.stages.join("→") + ", generație inclusă)" : "FAIL @ " + g2.stage + (g2.probe ? "/" + g2.probe : "") + " — " + g2.reason);
          } else {
            inner.gate2 = { ok: false, stage: "generation", probe: "generation", reason: gated.reason }; inner.gate2Ok = false;
            log("Gate 2 NEPORNIT (baseline inadmisibil → ZERO spawn):", gated.reason);
          }
        } else if (inner.gate1Ok) {
          log("AT2 NECapturat deși Gate 1 verde (rotația n-a produs access nou) — release roșu la at2_capture");
        }
      } catch {
        // ⭐ fix cgpt P2: NICIODATĂ e.message (poate purta token/cheie). Doar marker static (clasă închisă).
        if (DEBUG_ON) { try { console.error("[release-live][DEBUG] corpul release a aruncat (clasă închisă)"); } catch {} }
        // corpul NU propagă — finally curăță; verdictul se compune din ce a avansat
      } finally {
        // ⭐ AȘTEPTĂM COMPLET backstop + Redis, INDIFERENT de Gate 1/2 (lock Marco #1). Supabase = finally-ul wrapper-ului.
        inner.sweep = await sweepBackstop(registry, (proc) => stopManagedProcess(proc, DEFAULT_STOP_TIMING, realStopTimers));
        inner.workerBackstopOk = inner.sweep.orphan === 0;
        if (inner.sweep.swept > 0) log("backstop worker:", JSON.stringify(inner.sweep));
        inner.redisCleanup = await cleanupRedisBounded(redisPort, ledger, 3);
        inner.redisCleanupOk = !!(inner.redisCleanup && inner.redisCleanup.ok);
        log("cleanup Redis:", JSON.stringify(inner.redisCleanup));
      }
      return inner;
    });
  } finally {
    // ⭐ fix cgpt P2 (rev5): curăță DOAR ce s-a achiziționat (fiecare handle poate fi null dacă achiziția a aruncat) —
    //   ruleză inclusiv la config invalid / browser launch failure / listener failure.
    at2Private = undefined; // ⭐ AT2 nu supraviețuiește procesului (lock Marco)
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (browser) await browser.close().catch(() => {});
    if (listener) { try { listener.close(); } catch {} }
    if (redis) { try { redis.disconnect(); } catch {} }
    if (genRedis) { try { genRedis.disconnect(); } catch {} }
    if (spawnCwd) { try { rmSync(spawnCwd, { recursive: true, force: true }); } catch {} }
  }

  // ── Semnale FINALE: abia acum (după wrapper) avem cleanup-ul Supabase. Compunerea raportului + emiterea artefactului
  //    se fac în ENTRYPOINT (un singur punct de emitere/exit) — aici DOAR întoarcem cei 6 booleeni + orphan-ul.
  let inner, supabaseCleanupOk, supaCleanup;
  if (outcome.ok) { inner = outcome.result; supabaseCleanupOk = true; supaCleanup = outcome.cleanup; }
  else if (outcome.phase === "cleanup") { inner = outcome.result; supabaseCleanupOk = false; supaCleanup = outcome.cleanup; }
  else { inner = null; supabaseCleanupOk = false; supaCleanup = outcome.cleanup; log("PROVISION FAIL @", outcome.stage, "—", outcome.reason); } // provisioning a eșuat înainte de corp
  const i = inner || { gate1Ok: false, at2Captured: false, gate2Ok: false, workerBackstopOk: false, redisCleanupOk: false };
  log("cleanup Supabase:", JSON.stringify(supaCleanup));

  // orphan-ul rămâne EXPLICIT prin `workerBackstopOk:false` (parte a raportului); îl întoarcem separat DOAR pentru
  // avertismentul operațional de pe stderr. Cei 6 booleeni sunt sursa unică a verdictului (composeReleaseVerdict via report).
  return {
    parts: {
      gate1Ok: i.gate1Ok, at2Captured: i.at2Captured, gate2Ok: i.gate2Ok,
      workerBackstopOk: i.workerBackstopOk, redisCleanupOk: i.redisCleanupOk, supabaseCleanupOk,
    },
    orphan: (i.sweep && typeof i.sweep.orphan === "number") ? i.sweep.orphan : 0,
  };
}

// ── UNICUL punct de emitere + exit (cgpt): JSON atomic → text uman pe stderr → process.exitCode (FĂRĂ process.exit). ──
//    Primitivele de fișier (dir deținut+privat, lock, scriere atomică) trăiesc în `releaseGateArtifact.ts` (typecheck-uit +
//    testat, gate-14) și sunt IMPORTATE aici (source-guard în test). Fără process.exit ⇒ stderr se flush-uiește; procesul iese
//    natural după ce finally-ul lui runChain a eliberat handle-urile.
function artifactText(report) { return JSON.stringify(renderReleaseReportJson(report), null, 2) + "\n"; }

function emitReport(report, orphan) {
  // La startup s-a stampat un placeholder ROȘU în GATE_DIR (deținut+privat+locked) → o scriere eșuată aici lasă placeholder-ul
  // ROȘU, niciodată verde-vechi. NU ștergem nimic aici (nicio operație distructivă pe calea de emit).
  const wrote = writeArtifactAtomic(GATE_DIR, ARTIFACT, artifactText(report));
  console.error(renderReleaseReportText(report)); // text uman DERIVAT static din hărți înghețate (anti-leak)
  console.error(wrote
    ? "[release-live] artefact JSON scris: " + ARTIFACT
    : "[release-live] ❌ NU am putut scrie artefactul JSON în: " + GATE_DIR + " (rămâne placeholder-ul roșu)");
  if (orphan > 0) console.error("[release-live] ⚠️ grup worker POSIBIL ORFAN după backstop — verifică manual (consumator Alchemy).");
  process.exitCode = wrote ? releaseExitCode(report) : 1;
}

// ── ENTRYPOINT UNIC. runChain NU iese/printează verdictul — întoarce cei 6 booleeni (sau aruncă static). ──
//    Cale normală (succes/eșec) → raport din cei 6 booleeni. timeout / config invalid / excepție înainte de toate semnalele →
//    raport `malformed` ROȘU. Ownership (dir DEȚINUT+PRIVAT + lock exclusiv) via `releaseGateArtifact.ts`. AT2 e șters în
//    finally-ul lui runChain, înaintea acestui catch.
(async () => {
  // 1) Director fix DEȚINUT+PRIVAT + lock exclusiv ÎNAINTE de orice cost Alchemy → ownership exclusiv pe durata run-ului.
  const dir = ensureOwnedPrivateDir(GATE_DIR);
  if (dir !== "ok" && dir !== "created") {
    console.error("[release-live] ❌ " + GATE_DIR + " nu e un director deținut+privat utilizabil (" + dir + ") — refuz (fail-closed).");
    process.exitCode = 1; return;
  }
  const lock = acquireLock(LOCK);
  if (lock.result !== "acquired") {
    if (lock.result === "held")       console.error("[release-live] ❌ un alt run de release-gate e în desfășurare (lock deținut de pid " + (lock.pid ?? "?") + ") — refuz.");
    else if (lock.result === "stale") console.error("[release-live] ❌ lock STALE de release-gate (pid " + (lock.pid ?? "necunoscut") + " nu mai rulează) în " + LOCK + " — șterge-l manual și reia. Refuz (fail-closed).");
    else                              console.error("[release-live] ❌ nu pot crea lock-ul de release-gate în " + GATE_DIR + " — refuz (fail-closed).");
    process.exitCode = 1; return; // NU intrăm în finally (nu deținem lock-ul)
  }
  try {
    // 2) Slate: curăță artefactul anterior (dir DEȚINUT+locked → sigur) + stampează un placeholder ROȘU → crash/kill/write-fail
    //    lasă ROȘU pe disc, niciodată verde-vechi. Placeholder-ul eșuat = dir nescriitor → fail-closed (nu ardem Alchemy).
    try { rmSync(ARTIFACT, { force: true }); } catch { /* best-effort; dir deținut */ }
    if (!writeArtifactAtomic(GATE_DIR, ARTIFACT, artifactText(buildReleaseReportFromRaw(null)))) {
      console.error("[release-live] ❌ nu pot stampila placeholder-ul de artefact în " + GATE_DIR + " — refuz (fail-closed).");
      process.exitCode = 1; return; // finally eliberează lock-ul
    }
    // 3) Run + emit (un singur punct de emitere/exit). Mesaj STATIC (anti-leak) pe excepție.
    try {
      const { parts, orphan } = await runChain();
      emitReport(timedOut ? buildReleaseReportFromRaw(null) : buildReleaseReportFromRaw(parts), orphan);
    } catch {
      console.error("[release-live] ❌ lanț incomplet (prereq/config/excepție/timeout) — raport malformed roșu.");
      emitReport(buildReleaseReportFromRaw(null), 0);
    }
  } finally {
    // fix cgpt P1: un run care NU-și poate elibera lock-ul are cleanup INCOMPLET (lock stale rămas) → NU poate ieși verde,
    //   ȘI artefactul de pe disc (posibil VERDE din emit) trebuie să corespundă. Downgrade la exit 1 + SUPRASCRIU artefactul cu
    //   malformed ROȘU (fallback: ștergere → absență) ca exit-code-ul și artefactul să NU se contrazică.
    if (!releaseLock(LOCK)) {
      console.error("[release-live] ⚠️ nu am putut elibera lock-ul " + LOCK + " — șterge-l manual. Marchez run-ul ca eșuat (exit 1, artefact → roșu).");
      process.exitCode = 1;
      demoteArtifactOnCleanupFailure(GATE_DIR, ARTIFACT, artifactText(buildReleaseReportFromRaw(null)));
    }
  }
})();

