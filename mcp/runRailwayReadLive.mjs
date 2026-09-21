/**
 * runRailwayReadLive.mjs — PH-12 12.6 leaf 2b-3 LIVE runner (opt-in, READ-ONLY, reproductibil; rulează cu tsx).
 *
 * Citește starea REALĂ a proiectului Preflight de pe Railway (GraphQL v2, DOAR de citire) și tipărește un PREVIEW de plan
 * pentru un profil-țintă. Compune piesele COMISE: transport real (`makeRailwayTransport`) → client (`readRailwaySnapshot`) →
 * model (`mapRailwaySnapshotToRawState`) → planner (`planFromRaw` + `bindRoleCaps`) → render (`formatLiveResult`).
 *
 * ⚠️ ZERO MUTAȚIE: nu pornește/oprește servicii, nu scrie env, nu aplică nimic. Doar citește + plănuiește un preview.
 * E .mjs INTENȚIONAT: NU intră în `tsc`/`eslint`/`test` (rulează live, atinge Railway real). Opt-in, ne-automat.
 * Codul de exit vine din `liveExitCode` (sursă unică testată): 0 DOAR pt. plan ADMISIBIL; blocat / eșec de stadiu → 1; uzaj → 2.
 *
 * Tokenul + UUID-urile vin DIN ENV (nu se comit în repo):
 *   RAILWAY_TOKEN            — Project-Access-Token (header `Project-Access-Token`; NICIODATĂ tipărit)
 *   RAILWAY_PROJECT_ID       — UUID proiect
 *   RAILWAY_ENVIRONMENT_ID   — UUID environment (`production`)
 *   RAILWAY_SVC_REDIS / _MCP / _WORKER_EVM / _INDEXER_EVM / _SOLANA — UUID per serviciu
 *
 * `commandSource` per rol e DERIVAT din catalogul canonic (`SERVICE_CROSSCHECK`) → se potrivește garantat cu modelul.
 *
 * Rulează (din ~/preflight/mcp):
 *   set -a; . .env.railway.readonly; set +a; npx tsx runRailwayReadLive.mjs <profil>
 * unde <profil> ∈ {parked, auth-canary, base-canary, launch} (default: parked). `.env.railway.readonly` = fișier LOCAL
 * ne-comis cu tokenul + UUID-urile.
 */

import { makeRailwayTransport, readRailwaySnapshot } from "./lib/mcp/railwayReadClient.ts";
import { SERVICE_CROSSCHECK } from "./lib/mcp/railwayReadModel.ts";
import { SERVICE_IDS, PROFILE_NAMES } from "./lib/mcp/profilePlan.ts";
import { bindRoleCaps } from "./lib/mcp/profileCaps.ts";
import { readLiveState, formatLiveResult, liveExitCode } from "./lib/mcp/railwayReadLive.ts";

const EXIT = Object.freeze({ ADMISSIBLE: 0, NOT_ADMISSIBLE: 1, USAGE: 2 }); // coduri numite — o singură cale de exit
const DEADLINE_MS = 60_000; // buget global dur pt. întreaga citire (evită agățarea runnerului)

const SVC_ENV = {
  redis: "RAILWAY_SVC_REDIS",
  mcp: "RAILWAY_SVC_MCP",
  "worker-evm": "RAILWAY_SVC_WORKER_EVM",
  "indexer-evm": "RAILWAY_SVC_INDEXER_EVM",
  "solana-worker": "RAILWAY_SVC_SOLANA",
};

/**
 * Eșec de uzaj: NU face `process.exit` aici (exit-ul e o SINGURĂ cale, la capăt). Aruncă un sentinel; mesajul e STATIC
 * (nume de câmp / lista permisă), niciodată o valoare de input reflectată.
 */
class UsageError extends Error {}
function usageFail(message) { throw new UsageError(message); }

function requireEnv(name) {
  const v = process.env[name];
  if (typeof v !== "string" || v.length === 0) usageFail(`lipsă env: ${name}`); // numele e static/al nostru, nu input reflectat
  return v;
}

function buildManifest() {
  const serviceIds = {};
  const commandSource = {};
  for (const role of SERVICE_IDS) {
    serviceIds[role] = requireEnv(SVC_ENV[role]);
    commandSource[role] = SERVICE_CROSSCHECK[role].commandSource; // DERIVAT din catalog → potrivire garantată
  }
  return {
    projectId: requireEnv("RAILWAY_PROJECT_ID"),
    environmentId: requireEnv("RAILWAY_ENVIRONMENT_ID"),
    serviceIds,
    commandSource,
  };
}

async function main() {
  // Validare target ÎNAINTE de orice echo — pe eșec, mesaj STATIC (listează profilele permise), FĂRĂ valoarea brută din argv.
  const target = process.argv[2] ?? "parked";
  if (!PROFILE_NAMES.includes(target)) usageFail(`profil necunoscut (permise: ${PROFILE_NAMES.join(", ")})`);

  const token = requireEnv("RAILWAY_TOKEN");
  const manifest = buildManifest();

  const transport = makeRailwayTransport({ token }); // endpoint fix, redirect:error, timeout, corp mărginit, anti-leak
  const readSnapshot = (m, o) => readRailwaySnapshot(transport, m, o);
  const caps = bindRoleCaps();

  // target e acum un membru VALIDAT din PROFILE_NAMES → safe de afișat.
  console.log(`[railway-read-live] citesc starea live (READ-ONLY) pentru profilul „${target}"…`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS); // deadline global
  let result;
  try {
    result = await readLiveState(readSnapshot, manifest, target, caps, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  for (const line of formatLiveResult(result)) console.log(line);
  console.log("[railway-read-live] gata — ZERO mutații efectuate.");
  return liveExitCode(result); // NU face exit aici — întoarce codul; sursă unică: 0 doar pt. plan admisibil
}

// ── SINGURA cale de exit ─────────────────────────────────────────────────────────────────────────────────────────
// `main` întoarce codul (nu face exit); uzaj/eroare → cod, tipărit STATIC. Setăm `process.exitCode`, NU exit-ul dur:
// exit-ul dur sincron poate trunchia stdout/stderr nedrenat (ex. când e redirecționat/piped). Aici lăsăm event-loop-ul să
// dreneze natural — nu mai există handle-uri active (timer-ul e curățat, cererea s-a încheiat) → Node iese cu acest cod.
let exitCode = EXIT.NOT_ADMISSIBLE;
try {
  exitCode = await main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`[railway-read-live] ${err.message}`); // mesaj STATIC construit de noi, fără input reflectat
    exitCode = EXIT.USAGE;
  } else {
    // Anti-leak: nu tipărim eroarea brută (poate purta detalii de mediu); doar un marker generic.
    console.error("[railway-read-live] eroare neașteptată la rulare (fără detalii — anti-leak).");
    exitCode = EXIT.NOT_ADMISSIBLE;
  }
}
process.exitCode = exitCode; // drain natural, fără trunchiere de output
