/**
 * runGate1Live.mjs — PH-12 12.5b-4b LIVE runner (opt-in, reproductibil; rulează cu tsx + playwright ad-hoc).
 *
 * Rulează Gate 1 auth-canary REAL pe stack-ul local (MCP :3000 + Supabase local + Redis). Compune piesele COMISE:
 *   listener loopback → fixtură (adaptor real Supabase, provisioning+cleanup) → runGate1(readiness→authorize→exchange→
 *   MCP→refresh→rotație→MCP) unde `authorize` e driver-ul de browser (Playwright: /authorize→/login→magic link din
 *   Mailpit→consent Approve→callback loopback) → cleanup Redis țintit cu retry bounded (canaryRedisRetry).
 *
 * E .mjs INTENȚIONAT: NU intră în `tsc`/`eslint`/`test` (Playwright NU e dep comisă — se instalează AD-HOC, doctrina
 * 12.3a). Comis ca script OPT-IN reproductibil (nu rulează automat în CI). Logica de retry a cleanup-ului e extrasă în
 * `canaryRedisRetry.ts` (comis + testat opt-in `test:ph12-canary-retry`), ca runnerul să rămână doar cablaj.
 *
 * Rulează (stack local sus): `set -a; . .env.local; set +a; npx tsx runGate1Live.mjs` din ~/preflight/mcp (MCP pe :3000).
 * Instalarea browserului (o singură dată): `npx playwright@1.63.0 install --with-deps chromium` (ad-hoc, ne-comis).
 */

import crypto from "node:crypto";
import { chromium } from "playwright";
import { parseHealthReport, assertReadiness } from "./lib/mcp/releaseGate.ts";
import { runWithGate1Fixture, buildFixtureStoreAfterIsolation } from "./lib/mcp/canaryFixture.ts";
import { makeSupabaseFixtureStore } from "./lib/mcp/canaryFixtureSupabase.ts";
import { startLoopbackCapture } from "./lib/mcp/canaryListener.ts";
import { generatePkcePair, generateState } from "./lib/mcp/canaryPkce.ts";
import { verifyCallback } from "./lib/mcp/canaryCallback.ts";
import { exchangeAuthCode, refreshToken } from "./lib/mcp/canaryTokenClient.ts";
import { listMcpTools } from "./lib/mcp/canaryMcpClient.ts";
import { makeFetchPostForm, makeFetchPostJson } from "./lib/mcp/canaryFetch.ts";
import { runGate1, vetGate1Targets } from "./lib/mcp/canaryGate1.ts";
// 12.5b-5a — cleanup Redis țintit (ledger populat de wrappere pe pași + orchestrator peste port). Dovada post-delete e
// ÎN orchestrator (`runCanaryRedisCleanup` → `redisCleanup.ok` acoperă ștergere + verificare de absență).
import Redis from "ioredis";
import { makeKeyLedger, runCanaryRedisCleanup } from "./lib/mcp/canaryRedisCleanup.ts";
import { runCleanupWithBoundedRetry } from "./lib/mcp/canaryRedisRetry.ts";

const ORIGIN       = process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3000";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:54321";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MAILPIT      = process.env.MAILPIT_URL || "http://127.0.0.1:54324";
const REDIS_URL    = process.env.REDIS_URL || "redis://127.0.0.1:6379";

// Cleanup-ul Redis se conectează la ACELAȘI Redis pe care-l folosește serverul local. Plasă anti-prod simetrică cu
// izolarea MCP/Supabase: refuzăm orice REDIS_URL non-loopback (nu atingem un Redis de staging/prod la teardown).
function isLoopbackRedis(u) {
  let url; try { url = new URL(u); } catch { return false; }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") return false;
  const h = url.hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

const log   = (...a) => console.log("[gate1-live]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Anti-leak la log/debug: un URL OAuth poate purta secrete în query/hash (`code`, `token_hash`, `access_token`). Pentru
// orice log de URL păstrăm DOAR origin+path; `redactSecrets` curăță query/hash din orice string (ex. mesaje de eroare
// Playwright care includ URL-ul navigat după magic link → ar scurge codul/tokenul).
function safeUrl(u) { try { const x = new URL(u); return x.origin + x.pathname; } catch { return "(url ilizibil)"; } }
function redactSecrets(s) { try { return String(s).replace(/([?#])[^\s"'<>]*/g, "$1…"); } catch { return "(ilizibil)"; } }

// fix cgpt (P1): fetch MĂRGINIT cu AbortController — deadline-ul acoperă ȘI citirea BODY-ului, nu doar sosirea
// headerelor. NU curățăm timerul când `fetch()` întoarce Response-ul (body-ul/`res.json()` se citesc ulterior și pot
// atârna — exact bug-ul reparat în canaryFetch). Patch-uim `json`/`text` să curețe timerul DUPĂ ce body-ul e citit;
// dacă nimeni nu citește body-ul, timerul (unref) abortează la deadline. Întoarce un Response REAL (Supabase-happy).
function boundedFetch(timeoutMs = 15000) {
  return async (input, init = {}) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    if (typeof t.unref === "function") t.unref();
    const res = await fetch(input, { ...init, signal: ctrl.signal });
    const clear = () => clearTimeout(t);
    const origJson = res.json.bind(res);
    const origText = res.text.bind(res);
    res.json = async () => { try { return await origJson(); } finally { clear(); } };
    res.text = async () => { try { return await origText(); } finally { clear(); } };
    return res;
  };
}
const bfetch = boundedFetch(15000);
const RUNNER_DEADLINE_MS = 240000; // deadline TOTAL al runner-ului (peste timeout-urile per-pas)
let timedOut = false;              // setat de deadline-ul din main; citit de handler-ul de la baza fișierului

if (!SERVICE_ROLE) { console.error("SUPABASE_SERVICE_ROLE_KEY lipsă — ai făcut `set -a; . .env.local; set +a`?"); process.exit(2); }

// ── Mailpit: găsește magic link-ul pentru email (poll) ──
async function fetchMagicLink(email) {
  const q = encodeURIComponent(`to:"${email}"`);
  for (let i = 0; i < 40; i++) {
    try {
      const res = await bfetch(`${MAILPIT}/api/v1/search?query=${q}`);
      if (res.ok) {
        const j = await res.json();
        const m = (j.messages || [])[0];
        if (m && m.ID) {
          const full = await bfetch(`${MAILPIT}/api/v1/message/${m.ID}`);
          if (full.ok) {
            const fj = await full.json();
            const link = extractVerify((fj.HTML || "") + "\n" + (fj.Text || ""));
            if (link) return link;
          }
        }
      }
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error("magic link negăsit în Mailpit după ~20s");
}
function extractVerify(body) {
  const d = body.replace(/&amp;/g, "&").replace(/=\r?\n/g, ""); // dez-escape HTML + quoted-printable soft breaks
  const m = d.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]*/i)
        || d.match(/https?:\/\/[^\s"'<>]*[?&](?:token|token_hash|code)=[^\s"'<>]*/i);
  return m ? m[0] : null;
}

function mapAuthzReason(reason) {
  if (/malformed/i.test(reason))      return "malformed";
  if (/state mismatch/i.test(reason)) return "state_mismatch";
  if (/iss/i.test(reason))            return "iss_mismatch";
  return "callback_error";
}
function mapMcp(r) {
  if (r.ok) return { ok: true };
  if (r.stage === "transport") return { ok: false, code: "transport" };
  if (r.stage === "parse")     return { ok: false, code: "bad_shape" };
  if (r.stage === "jsonrpc")   return { ok: false, code: "protocol_error" };
  if (r.status === 401 || r.status === 403) return { ok: false, code: "unauthorized" };
  if (r.status === 429) return { ok: false, code: "rate_limited" };
  return { ok: false, code: "unavailable" };
}

// Retry-ul bounded (clasificare tranzitoriu/structural) trăiește în `canaryRedisRetry.ts` (comis + testat). Aici doar
// îl cablăm la o rulare reală de cleanup pe portul Redis + ledgerul curent, cu log/backoff între încercări.
function cleanupRedisBounded(port, ledger, maxAttempts = 3) {
  return runCleanupWithBoundedRetry(
    () => runCanaryRedisCleanup(port, ledger, ledger.recordFamilyId),
    { maxAttempts, onRetry: (i) => { log(`redis-cleanup: încercarea ${i} tranzitorie (unavailable/proof/reziduu), retry…`); return sleep(500); } },
  );
}

async function main() {
  // fix cgpt (P1): poarta TARE întâi. `vetGate1Targets` = izolare anti-prod + ORIGINE CURATĂ (fără path/query/fragment)
  // + derivare endpoint-uri. Construim store-ul și logăm EXCLUSIV din `targets` vetate — provisioning-ul nu poate rula
  // pe o origine murdară înainte de vetting. `runGate1` primește ACELEAȘI origini curate (re-vetează idempotent).
  const rawCfg = { mcpBaseUrl: ORIGIN, supabaseUrl: SUPABASE_URL };
  const vet = vetGate1Targets(rawCfg);
  if (!vet.ok) { console.error("izolare/țintă respinsă de plasa anti-prod"); process.exit(2); }
  const targets0 = vet.targets;
  const cleanCfg = { mcpBaseUrl: targets0.mcpOrigin, supabaseUrl: targets0.supabaseUrl };

  const built = buildFixtureStoreAfterIsolation(cleanCfg, (url) => makeSupabaseFixtureStore(url, SERVICE_ROLE, { fetch: bfetch }));
  if (!built.ok) { console.error("construirea store-ului respinsă de plasa anti-prod"); process.exit(2); }
  const store = built.store;
  log("izolat OK → MCP", targets0.mcpOrigin, "| Supabase", targets0.supabaseUrl);

  // Port Redis pt. cleanup țintit (loopback-guard anti-prod). Adaptor trivial peste ioredis: null→not_found,
  // count≥1→deleted, count 0→not_found, throw→unavailable. Doar get/del pe cheie specifică (fără scan/flush).
  if (!isLoopbackRedis(REDIS_URL)) { console.error("REDIS_URL non-loopback — cleanup-ul refuză să atingă un Redis ne-local"); process.exit(2); }
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
  const redisPort = {
    get: async (key) => { try { const v = await redis.get(key); return v === null ? { status: "not_found" } : { status: "found", value: v }; } catch { return { status: "unavailable" }; } },
    del: async (key) => { try { const n = await redis.del(key); return n >= 1 ? { status: "deleted" } : { status: "not_found" }; } catch { return { status: "unavailable" }; } },
  };

  const listener = await startLoopbackCapture({ timeoutMs: 120000 });
  log("listener pe", listener.redirectUri);

  const runId   = "live" + crypto.randomBytes(6).toString("hex");
  const browser = await chromium.launch({ headless: true });
  const postForm = makeFetchPostForm();
  const postJson = makeFetchPostJson();

  // Ledger populat de wrappere pe pași: authorize→cod, exchange/refresh→access+refresh. runGate1 rămâne token-free în
  // retur; secretele sunt capturate AICI. Hoistat în scope-ul main → accesibil ȘI de backstop-ul din finally (deadline).
  const ledger = makeKeyLedger();
  let outcome, redisCleanup = null;

  // Deadline: NU abandonează work-ul (un `Promise.race` ar lăsa cleanup-ul Supabase din finally-ul lui
  // runWithGate1Fixture neterminat — fix cgpt). La expirare marchează `timedOut` + face TEARDOWN la browser/listener →
  // pasul activ (bounded) se deblochează cu eroare → finally-urile interne rulează (Redis apoi Supabase). Așteptăm apoi
  // work-ul să se încheie COMPLET (fără race), abia apoi închidem Redis. Transporturile HTTP sunt deja bounded (bfetch).
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    browser.close().catch(() => {});
    try { listener.close(); } catch {}
  }, RUNNER_DEADLINE_MS);
  if (typeof deadlineTimer.unref === "function") deadlineTimer.unref();

  try {
    outcome = await runWithGate1Fixture(store, { redirectUri: listener.redirectUri, runId }, async (handle) => {
      log("fixtură OK → user", handle.userId, "| client", handle.clientId, "| scopes", handle.scopes.join(","));
      try {
      return await runGate1(cleanCfg, (targets) => {
        const base = ({
        readiness: async () => {
          try {
            const res = await bfetch(targets.healthUrl);
            const parsed = parseHealthReport(await res.json());
            if (!parsed) return { ok: false, code: "malformed" };
            return assertReadiness(parsed).ok ? { ok: true } : { ok: false, code: "not_ready" };
          } catch { return { ok: false, code: "unreachable" }; }
        },
        authorize: async () => {
          const pkce  = generatePkcePair();
          const state = generateState();
          const url = `${targets.authorizeUrl}?` + new URLSearchParams({
            response_type: "code", client_id: handle.clientId, redirect_uri: handle.redirectUri,
            scope: handle.scopes.join(" "), state, code_challenge: pkce.challenge,
            code_challenge_method: "S256", resource: targets.resource,
          }).toString();
          const ctx  = await browser.newContext();
          const page = await ctx.newPage();
          const cbPromise = listener.waitForCallback();
          try {
            log("→ GET /authorize");
            await page.goto(url, { waitUntil: "domcontentloaded" });
            log("  ajuns pe:", safeUrl(page.url()));
            // Așteaptă HIDRATAREA înainte de a atinge inputul controlat: altfel React resetează valoarea completată la ""
            // (și un click pre-hidratare face native-submit → reload). networkidle + confirmare că valoarea a prins.
            await page.waitForLoadState("networkidle").catch(() => {});
            await page.waitForSelector("#email", { timeout: 15000 });
            await page.fill("#email", handle.email);
            await page.waitForFunction(
              (v) => { const el = document.querySelector("#email"); return !!el && el.value === v; },
              handle.email, { timeout: 8000 },
            ).catch(() => {});
            if ((await page.inputValue("#email")) !== handle.email) await page.fill("#email", handle.email); // re-fill defensiv post-hidratare
            log("  email completat, trimit magic link…");
            await page.click("button[type=submit]");
            await page.waitForSelector("text=Check your email", { timeout: 20000 });
            log("  magic link trimis, aștept în Mailpit…");
            const magic = await fetchMagicLink(handle.email);
            log("  magic link obținut ✓"); // fix cgpt (P1): NU logăm URL-ul (e credential)
            await page.goto(magic, { waitUntil: "domcontentloaded" });
            log("  după magic link, pe:", safeUrl(page.url()));
            await page.waitForSelector("button[value=approve]", { timeout: 15000 });
            await page.click("button[value=approve]");
            log("  consent Approve → aștept callback loopback…");
            const parsed = await cbPromise;
            const v = verifyCallback(parsed, { expectedState: state, issuer: targets.mcpOrigin });
            if (!v.ok) { const code = mapAuthzReason(v.reason); log("  verifyCallback FAIL:", code); return { ok: false, code }; }
            log("  cod OAuth capturat ✓");
            return { ok: true, bundle: { code: v.code, redirectUri: handle.redirectUri, codeVerifier: pkce.verifier } };
          } catch (err) {
            // GATE1_DEBUG: printează eroarea REALĂ de browser + salvează screenshot pt. context. Default → opac.
            if (process.env.GATE1_DEBUG) {
              try { console.error("[gate1-live][DEBUG] authorize error:", redactSecrets(err && err.message ? err.message : String(err))); } catch {}
              try { console.error("[gate1-live][DEBUG] pagina curentă:", safeUrl(page.url())); } catch {}
              try { await page.screenshot({ path: "/tmp/gate1-fail.png", fullPage: true }); console.error("[gate1-live][DEBUG] screenshot → /tmp/gate1-fail.png"); } catch {}
            }
            return { ok: false, code: "browser_failed" };
          } finally {
            await ctx.close();
          }
        },
        exchange: (bundle) => exchangeAuthCode(postForm, { tokenEndpoint: targets.tokenUrl, clientId: handle.clientId, resource: targets.resource }, bundle),
        mcpProbe: async (accessToken) => mapMcp(await listMcpTools(postJson, { mcpEndpoint: targets.mcpUrl }, { accessToken })),
        refresh:  (rt) => refreshToken(postForm, { tokenEndpoint: targets.tokenUrl, clientId: handle.clientId, resource: targets.resource }, { refreshToken: rt }),
        });
        // Wrappere: capturează secretele în ledger DOAR pe succes (nu schimbă contractul pașilor).
        return {
          readiness: base.readiness,
          authorize: async () => { const o = await base.authorize(); if (o && o.ok) ledger.recordAuthCode(o.bundle.code); return o; },
          exchange:  async (b) => { const r = await base.exchange(b); if (r && r.ok) { ledger.recordAccessToken(r.accessToken); ledger.recordRefreshToken(r.refreshToken); } return r; },
          mcpProbe:  base.mcpProbe,
          refresh:   async (rt) => { const r = await base.refresh(rt); if (r && r.ok) { ledger.recordAccessToken(r.accessToken); ledger.recordRefreshToken(r.refreshToken); } return r; },
        };
      });
      } finally {
        // finally INTERIOR: cleanup Redis țintit + dovadă post-delete + retry BOUNDED pe tranzitorii, ÎNAINTE de Supabase.
        redisCleanup = await cleanupRedisBounded(redisPort, ledger, 3);
        log("redis-cleanup:", JSON.stringify(redisCleanup));
      }
    });
  } finally {
    clearTimeout(deadlineTimer);
    // Backstop (rar): dacă cleanup-ul interior n-a rulat (ex. provisioning a eșuat înainte de body), asigură Redis curat
    // (idempotent + retry-safe → sigur chiar dacă a rulat deja). Apoi închide resursele necondiționat.
    if (!redisCleanup) {
      try { redisCleanup = await cleanupRedisBounded(redisPort, ledger, 3); log("redis-cleanup (backstop):", JSON.stringify(redisCleanup)); } catch {}
    }
    await browser.close().catch(() => {});
    try { listener.close(); } catch {}
    try { redis.disconnect(); } catch {}
  }

  // Deadline: work-ul S-A încheiat complet mai sus (ambele cleanup-uri au rulat), abia acum raportăm expirarea.
  if (timedOut) {
    console.error("❌ runner: deadline total depășit — teardown transporturi; cleanup-urile au rulat.", "redis:", JSON.stringify(redisCleanup));
    process.exit(1);
  }

  if (!outcome.ok && outcome.phase === "provision") {
    console.error("❌ PROVISION FAIL:", outcome.stage, "—", outcome.reason, "| cleanup:", JSON.stringify(outcome.cleanup));
    process.exit(1);
  }
  if (!outcome.ok && outcome.phase === "cleanup") {
    console.error("❌ CLEANUP a lăsat reziduu:", JSON.stringify(outcome.cleanup), "| report:", JSON.stringify(outcome.result));
    process.exit(1);
  }
  log("cleanup Supabase:", JSON.stringify(outcome.cleanup));
  const report = outcome.result;
  const redisClean = !!(redisCleanup && redisCleanup.ok);
  if (!report.ok) { console.error("❌ GATE 1 FAIL @", report.stage, "—", report.reason); process.exit(1); }
  if (!redisClean) {
    console.error("❌ Gate 1 verde DAR cleanup Redis incomplet (ștergere SAU dovadă de absență):", JSON.stringify(redisCleanup));
    process.exit(1);
  }
  log("✅ GATE 1 VERDE + Redis curat (AT1/AT2, RT1/RT2, familie, cod dovedite absente):", report.stages.join(" → "));
  process.exit(0);
}

// Deadline-ul e gestionat ÎN main (teardown transporturi + așteptarea COMPLETĂ a work-ului → ambele cleanup-uri termină,
// fără abandonare de promise). Aici doar mapăm un eșec neașteptat la un mesaj STATIC (fără `e.name`/`e.message`).
main().catch(() => {
  console.error(timedOut
    ? "❌ runner: deadline total depășit (cleanup-urile au rulat în finally)"
    : "❌ runner: eroare internă (vezi log-urile de pas pentru context)");
  process.exit(1);
});
