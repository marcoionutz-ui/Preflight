/**
 * lib/config/envSchema.ts — PH-12 slice 12.2b-2 (schema env MCP, pe motorul PARTAJAT).
 *
 * Refactorizat pe `@preflight/config-env` (motorul generic pur din 12.2b-1). AICI rămân DOAR:
 *   - specs-urile specifice rolului MCP (`MCP_ENV_FIELDS`);
 *   - prefixele de surplus (`MCP_UNEXPECTED_PREFIXES`);
 *   - validatorul `PUBLIC_BASE_URL` cuplat la `resolvePublicBaseUrl` (boot-check == runtime fail-closed,
 *     de aceea trăiește în MCP, nu în motorul generic — motorul nu depinde de `oauth/baseUrl`).
 * Mecanica (uniune discriminată, field-runner, surplus sortat, validatoare de formă) e importată din motor.
 *
 * 12.2e-2 (inventar opționale): pe lângă cele 5 câmpuri de bază, catalogul acoperă acum și (a) flag-urile de
 * securitate must-be-OFF-in-prod (`MCP_DEV_AUTH_BYPASS`, `QUOTA_INTEGRATION_ALLOW`, `PH4_INTEGRATION_ALLOW` → `forbid`)
 * și (b) opționalele validate-when-present (`HEALTH_WS_ENABLED`, `DEMO_TRUST_XFF` strict 0/1; flag-urile PH-2 via
 * `boolFlag`). Fiecare validator OGLINDEȘTE parserul real din runtime (nu o regulă paralelă). `PORT` NU intră (codul
 * MCP nu-l citește; e al lui Next/Railway).
 *
 * 12.2c-mcp (chain-list): `HEALTH_EXPECTED_CHAINS`/`ENABLED_CHAINS` validate cu `csvKnownTokens` pe vocabularul REAL
 * folosit de `readHealthSignals` — `PREFLIGHT_EVM_CHAINS` + `normalizeChainId` (alias `eth`→`ethereum`; canonic `bsc`).
 * Runtime: `HEALTH_EXPECTED_CHAINS ?? ENABLED_CHAINS ?? "base,arbitrum"` → `parseExpectedChains` (dropă tăcut tokenii
 * necunoscuți). Deci validatorul warn-uiește pe un chain scris greșit (ex. `bnb`/`polygon`) care altfel n-ar fi monitorizat.
 * În plus (selecție efectivă goală): rezolvăm lista EFECTIVĂ cu ACEEAȘI precedență `??` + `parseExpectedChains` REAL; dacă
 * iese goală (override prezent-dar-vid blochează fallback-ul), semnalăm un WARNING — runtime-ul ar da health strict `503`
 * fără chain-uri, dar tăcut. NU `problem` (nu oprim MCP-ul), NU ecouăm valoarea brută.
 */

import {
  validateEnv,
  absoluteUrl,
  redisUrl,
  nonEmpty,
  boolFlag,
  flagMustBeOffInProd,
  csvKnownTokens,
  formatEnvValidation,
  type Validate,
  type FieldSpec,
  type EnvSnapshot,
  type EnvValidation,
  type EnvWarning,
} from "@preflight/config-env";
import { PREFLIGHT_EVM_CHAINS, normalizeChainId } from "@preflight/schema";
import { parseExpectedChains } from "../health/liveness";
import { resolvePublicBaseUrl } from "../oauth/baseUrl";

// Re-export pentru consumatorii care importau aceste tipuri/funcții din envSchema (compat + un singur punct de intrare MCP).
export { formatEnvValidation };
export type { EnvSnapshot, EnvValidation };

/**
 * `PUBLIC_BASE_URL` — ACELAȘI predicat ca runtime (`resolvePublicBaseUrl`, sursa lui `resolveBaseUrl`):
 * boot-check == runtime fail-closed. Nu poate trăi în motorul generic fiindcă motorul nu cunoaște `oauth/baseUrl`.
 */
const publicBaseUrl: Validate = (value, prod) =>
  resolvePublicBaseUrl(value, { NODE_ENV: prod ? "production" : "development" }) === null
    ? "PUBLIC_BASE_URL invalid ca issuer (RFC 8414; https obligatoriu în producție)"
    : null;

/**
 * Toggle runtime pe care codul MCP îl compară STRICT cu `0`/`1` (NU un bool permisiv):
 *   - `HEALTH_WS_ENABLED` — `readHealthSignals`: WS dezactivat DOAR pe `"0"` (orice altceva → ON);
 *   - `DEMO_TRUST_XFF`    — `demoCache`: XFF de încredere DOAR pe `"1"` (orice altceva → OFF).
 * `boolFlag` generic ar accepta `"true"`/`"false"`, pe care runtime-ul le interpretează IMPLICIT (invers de intenție) —
 * atenționare cgpt la 12.2e-1. Deci oglindim EXACT vocabularul runtime-ului: prezent și ≠ `0`/`1` → warning
 * (nu crapă boot-ul), ca un `DEMO_TRUST_XFF=true` pus din greșeală să fie VIZIBIL, nu tratat tăcut ca OFF.
 *
 * BYTE-EXACT, FĂRĂ trim (fix cgpt 12.2e-2): runtime-ul compară `process.env.X` BRUT (`!== "0"` / `=== "1"`), deci
 * `" 0 "`/`" 1 "` (cu spații) NU se potrivesc la runtime → un trim aici ar aproba tăcut o valoare pe care runtime-ul
 * o interpretează invers. Comparăm valoarea exact cum o vede runtime-ul. (`present` filtrează deja whitespace-only.)
 */
const strictZeroOne = (label: string): Validate => (value) =>
  value === "0" || value === "1"
    ? null
    : `${label} — runtime recunoaște DOAR 0/1 byte-exact (spații/altă valoare → interpretat implicit)`;

/**
 * Câmpurile MCP. OBLIGATORII (azi cu `process.env.X!` → crash criptic la primul request dacă lipsesc):
 * cele patru chei Supabase/Redis. `PUBLIC_BASE_URL` obligatoriu DOAR în prod (anti-poisoning; confirmat lipsă
 * la recon PH-12 → fluxul resource-owner ar arunca fail-closed în prod).
 */
export const MCP_ENV_FIELDS: readonly FieldSpec[] = [
  // ── OBLIGATORII (azi `process.env.X!` → crash criptic la primul request dacă lipsesc) ──
  { name: "NEXT_PUBLIC_SUPABASE_URL",      required: () => true,     validate: absoluteUrl("NEXT_PUBLIC_SUPABASE_URL") },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", required: () => true,     validate: nonEmpty },
  { name: "SUPABASE_SERVICE_ROLE_KEY",     required: () => true,     validate: nonEmpty },
  { name: "REDIS_URL",                     required: () => true,     validate: redisUrl() },
  { name: "PUBLIC_BASE_URL",               required: (prod) => prod, validate: publicBaseUrl },

  // ── SECURITATE (decizie Marco 2026-09-02): flag de dev/bypass truthy în prod → `problem` `forbidden` (boot crapă). ──
  // `MCP_DEV_AUTH_BYPASS` e deja ignorat de runtime în prod (`resolveDevBypass`); `*_INTEGRATION_ALLOW` sunt DOAR opt-in de
  // test (nu runtime). Boot-check-ul e defense-in-depth: face un flag lăsat aprins în prod ZGOMOTOS, nu tăcut-ignorat.
  { name: "MCP_DEV_AUTH_BYPASS",     required: () => false, forbid: flagMustBeOffInProd("MCP_DEV_AUTH_BYPASS") },
  { name: "QUOTA_INTEGRATION_ALLOW", required: () => false, forbid: flagMustBeOffInProd("QUOTA_INTEGRATION_ALLOW") },
  { name: "PH4_INTEGRATION_ALLOW",   required: () => false, forbid: flagMustBeOffInProd("PH4_INTEGRATION_ALLOW") },

  // ── OPȚIONALE validate-when-present (prezent + formă greșită → warning, NU crapă). Fiecare oglindește parserul REAL. ──
  // Toggle-uri strict 0/1 (vezi `strictZeroOne` — parseriale runtime `=== "1"` / `!== "0"`, NU bool permisiv).
  { name: "HEALTH_WS_ENABLED", required: () => false, validate: strictZeroOne("HEALTH_WS_ENABLED") },
  { name: "DEMO_TRUST_XFF",    required: () => false, validate: strictZeroOne("DEMO_TRUST_XFF") },
  // Flag-uri PH-2 (parsere cu set truthy/falsy recunoscut): present + token bool NErecunoscut → warning. Prinde typo-ul
  // care la runtime cade tăcut OFF (`PH2_RESOURCE_OWNER_AUTHORIZE`) sau fail-closed (`PH2_REJECT_LEGACY_AUTHCODE`).
  { name: "PH2_RESOURCE_OWNER_AUTHORIZE", required: () => false, validate: boolFlag },
  { name: "PH2_REJECT_LEGACY_AUTHCODE",   required: () => false, validate: boolFlag },
  // Chain-list (health expected chains): AMBELE consultate de `readHealthSignals` (HEALTH_EXPECTED_CHAINS ?? ENABLED_CHAINS
  // ?? default) prin `parseExpectedChains` cu ACELAȘI vocabular. Token de chain necunoscut → warning (dropat tăcut la runtime).
  { name: "HEALTH_EXPECTED_CHAINS", required: () => false, validate: csvKnownTokens("HEALTH_EXPECTED_CHAINS", PREFLIGHT_EVM_CHAINS, normalizeChainId) },
  { name: "ENABLED_CHAINS",         required: () => false, validate: csvKnownTokens("ENABLED_CHAINS", PREFLIGHT_EVM_CHAINS, normalizeChainId) },
] as const;

/**
 * Prefixe care aparțin rolurilor de WORKER, NU MCP. Prezența lor pe MCP = env ne-separat pe rol (recon PH-12
 * finding #6; confirmat de cod: MCP NU citește `ALCHEMY_*`/`INDEXER_*`). NU oprește boot-ul — doar `warning`.
 */
export const MCP_UNEXPECTED_PREFIXES: readonly string[] = ["ALCHEMY_", "INDEXER_"] as const;

/**
 * Lista EFECTIVĂ de chain-uri așteptate de health, rezolvată cu EXACT precedența runtime-ului (`readHealthSignals`):
 * `HEALTH_EXPECTED_CHAINS ?? ENABLED_CHAINS ?? "base,arbitrum"` → `parseExpectedChains` (parserul REAL din `liveness`,
 * cu ACELAȘI vocabular `PREFLIGHT_EVM_CHAINS` + `normalizeChainId`). `??` prinde DOAR null/undefined: un override PREZENT
 * dar vid (`""`/whitespace/`",,"`) BLOCHEAZĂ fallback-ul → `parseExpectedChains("")` → `[]`. Ambele absente → default.
 */
function effectiveExpectedChains(env: EnvSnapshot): string[] {
  const raw = env.HEALTH_EXPECTED_CHAINS ?? env.ENABLED_CHAINS ?? "base,arbitrum";
  return parseExpectedChains(raw, PREFLIGHT_EVM_CHAINS, normalizeChainId);
}

/**
 * Validează env-ul pentru rolul MCP. Discriminat: `ok:true` (+ warnings) sau `ok:false` (+ problems + warnings).
 *
 * 12.2c-mcp (selecție efectivă goală): pe lângă câmpuri, semnalăm cazul în care lista EFECTIVĂ de chain-uri iese GOALĂ
 * deși câmpurile trec (ex. `HEALTH_EXPECTED_CHAINS=""` peste un `ENABLED_CHAINS=base` valid — `??` lasă `""` să blocheze
 * fallback-ul). La runtime asta dă `expectedChains=[]`: fără evaluare per-chain și strict health `503`, dar TĂCUT. Corect
 * aici e WARNING (o config suspectă), NU `problem` — nu oprim MCP-ul și nu inventăm un flag nou. Mesajul NU ecouă valoarea
 * brută (anti-leak). Ambele absente → default `base,arbitrum` (≠ gol) → fără avertisment.
 */
export function validateMcpEnv(env: EnvSnapshot): EnvValidation {
  const base = validateEnv("mcp", MCP_ENV_FIELDS, MCP_UNEXPECTED_PREFIXES, env);
  if (effectiveExpectedChains(env).length > 0) return base;
  const emptySelection: EnvWarning = {
    name: "HEALTH_EXPECTED_CHAINS",
    detail:
      "selecție efectivă de chain-uri goală (override prezent-dar-vid blochează fallback-ul) — " +
      "health ar raporta 0 chain-uri așteptate (strict 503). Setează un chain valid sau lasă variabila NEdefinită pentru default.",
  };
  return { ...base, warnings: [...base.warnings, emptySelection] };
}
