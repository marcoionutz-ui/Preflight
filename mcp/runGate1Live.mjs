/**
 * runGate1Live.mjs — Gate 1 LIVE runner (opt-in), re-țintit pe staging-ul HTTPS izolat (lotul OAuth staging, partea C;
 * design rev3 §7–§8: „extinde Gate 1, fără runner nou”). Rulează proba automată E0a–E0e, E1–E12, E14.
 *
 * Fluxul vechi (stack local + listener loopback + registration DCR cu redirect loopback) NU mai e valid: politica de
 * redirect pentru clienții `public` acceptă DOAR `CLAUDE_CALLBACKS` (lib/oauth/claudeCallbacks.ts). Proba folosește
 * clientul CIMD FIXAT (provizionat înainte cu `provisionCimdClient --apply`; proba doar VERIFICĂ rândul) și callback-ul
 * claude.ai, iar redirect-ul post-consimțământ e capturat și NU e urmat (nicio cerere nu pleacă spre claude.ai).
 *
 * E .mjs INTENȚIONAT: NU intră în `tsc`/`eslint`/`test` (Playwright nu e dependență comisă — se instalează ad-hoc).
 * Toată logica (izolare, pași, verdicte, raport, cleanup) e în frunze .ts tipate + testate:
 *   lib/mcp/canaryGate1StagingTargets.ts  (vetting + ținte)       lib/mcp/canaryGate1StagingChecks.ts (verdicte)
 *   lib/mcp/canaryGate1Staging.ts         (orchestrator + raport) lib/mcp/canaryGate1StagingIo.ts     (adaptoare)
 *   lib/mcp/canaryGate1StagingBrowser.ts  (Playwright, tipat structural)
 * Aici doar: polyfill WebSocket, vetting timpuriu (înainte de a porni Chromium), launch, deadline, afișare, exit.
 *
 * Login în browser = fluxul PKCE REAL: formularul /signup (signInWithOtp, verifier-ul în cookie-ul contextului) →
 * Send Email Hook-ul de STAGING (mcp/staging/auth_mail_capture.sql) capturează linkul în `staging_auth_mail_capture` →
 * proba îl deschide în ACELAȘI context (`<supabase>/auth/v1/verify?token=pkce_…`) → /auth/callback?code=…. Fără hook
 * activ, preflight-ul se oprește cu `mail_capture_hook_absent` (nu există fallback pe generateLink pentru browser).
 * Setup staging (o dată): SQL-ul de mai sus în SQL Editor-ul proiectului de STAGING + Auth → Hooks → Send Email →
 * Postgres → public.staging_capture_auth_email.
 *
 * Rulează (din mcp/, cu env-ul de STAGING exportat în shell — NU `.env.local`):
 *   npx tsx runGate1Live.mjs
 * Variabile: GATE1_MCP_BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *   GATE1_EXPECT_SUPABASE_REF, REDIS_URL (URL-ul PUBLIC al Redis-ului de staging), GATE1_EXPECT_REDIS_HOST,
 *   GATE1_CIMD_CLIENT_ID; opționale GATE1_CLAUDE_REDIRECT_URI, GATE1_EMAIL_DOMAIN.
 * Browser (o singură dată): `npx playwright@1.63.0 install --with-deps chromium` (ad-hoc, ne-comis).
 * Ieșire: 0 = toți pașii PASS + cleanup ok; 1 = cel puțin un FAIL / cleanup incomplet; 2 = izolare refuzată.
 */

import crypto from "node:crypto";
import ws from "ws";
import { chromium } from "playwright";
import { readStagingProbeConfig, vetStagingProbe, vetProcessEnvBinding, STAGING_VET_MSG, ENV_BINDING_MSG } from "./lib/mcp/canaryGate1StagingTargets.ts";
import { runGate1Staging, renderStagingReport, stagingExitCode } from "./lib/mcp/canaryGate1Staging.ts";
import { makeStagingProbeIo } from "./lib/mcp/canaryGate1StagingIo.ts";

// supabase-js construiește un RealtimeClient la createClient; pe Node < 22 fără WebSocket global aruncă.
if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = ws;

const TAG = "[gate1-staging]";
const RUNNER_DEADLINE_MS = 15 * 60 * 1000;
const log = (line) => console.log(`${TAG} ${line}`);

async function main() {
  // Poarta TARE întâi (înainte de Chromium): aceeași vetare pe care runGate1Staging o re-aplică.
  const cfg = readStagingProbeConfig(process.env);
  const vet = vetStagingProbe(cfg);
  if (!vet.ok) { console.error(`${TAG} isolation FAIL ${vet.code} — ${STAGING_VET_MSG[vet.code]}`); return 2; }
  const bind = vetProcessEnvBinding(process.env, vet.targets, vet.secrets);
  if (!bind.ok) { console.error(`${TAG} isolation FAIL ${bind.code} — ${ENV_BINDING_MSG[bind.code]}`); return 2; }
  log(`țintă vetată: MCP ${vet.targets.origin} | Supabase ref ${vet.targets.supabaseRef} | Redis host ${vet.targets.redisHost}`);

  const browser = await chromium.launch({ headless: true });
  let timedOut = false;
  // Deadline: NU abandonăm work-ul (cleanup-ul din orchestrator trebuie să ruleze). La expirare închidem browserul →
  // pasul activ se deblochează cu eroare → orchestratorul termină lanțurile (blocked) și rulează cleanup-ul DB.
  const deadline = setTimeout(() => { timedOut = true; browser.close().catch(() => {}); }, RUNNER_DEADLINE_MS);
  if (typeof deadline.unref === "function") deadline.unref();

  let report;
  try {
    report = await runGate1Staging(
      cfg,
      (targets, secrets) => makeStagingProbeIo(targets, secrets, { browser }),
      { runId: crypto.randomBytes(8).toString("hex"), processEnv: process.env },
    );
  } finally {
    clearTimeout(deadline);
    await browser.close().catch(() => {});
  }

  for (const line of renderStagingReport(report)) log(line);
  if (timedOut) log("deadline total depășit — browserul a fost închis; cleanup-ul a rulat (vezi linia cleanup)");
  return timedOut ? 1 : stagingExitCode(report);
}

// Un eșec neașteptat → mesaj STATIC (fără e.message: poate conține URL-uri cu tokenuri).
main().then(
  (code) => process.exit(code),
  () => { console.error(`${TAG} eroare internă a runnerului (fail-closed)`); process.exit(1); },
);
