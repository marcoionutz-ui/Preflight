/**
 * lib/mcp/canaryGate1StagingTargets.ts — lotul OAuth staging, partea C (Gate 1 re-țintit pe staging-ul HTTPS izolat).
 *
 * Frunză PURĂ (zero I/O): citește config-ul din `env` (obiect injectat), îl VETEAZĂ și DERIVĂ toate URL-urile probei o
 * singură dată, din origini curate. Doctrina Gate 1 (canaryGate1.ts) se păstrează: izolarea e poarta zero; adaptoarele
 * (fetch / Supabase / Redis / Playwright) se construiesc DOAR din `StagingTargets` vetate, deci nu există pe un config
 * care atinge producția.
 *
 * Plase (toate fail-closed, coduri ÎNCHISE mapate la mesaje statice; nicio valoare din env nu ajunge în mesaj):
 *   1. `assertCanaryIsolation` (releaseGate.ts) — refuză domeniile MCP de producție și proiectul Supabase de producție
 *      (`PROD_MCP_HOSTS`, `PROD_SUPABASE_REFS` — aceeași sursă unică ca restul gate-urilor).
 *   2. Origini curate (fără path/query/fragment) + MCP DOAR `https` non-loopback (staging-ul e public, Railway).
 *   3. Supabase: `https://<ref>.supabase.co` cu `ref === GATE1_EXPECT_SUPABASE_REF` (confirmare pozitivă de operator;
 *      `STAGING_SUPABASE_REFS` din releaseGate e încă gol) și niciodată ref-ul de producție.
 *   4. Chei: anon ≠ service-role; o cheie JWT legacy e decodată (fără verificarea semnăturii — doar plasă de config) și
 *      trebuie să aibă `role` corect ȘI `ref` = ref-ul vetat; o cheie nouă `sb_publishable_` / `sb_secret_` trebuie să
 *      aibă prefixul rolului ei.
 *   5. `REDIS_URL`: schemă `redis:`/`rediss:`, fără ambiguitate, hostname === `GATE1_EXPECT_REDIS_HOST` (pin de
 *      operator). Dovada DINAMICĂ (Redis-ul e chiar cel al staging-ului) vine la E0a: tokenul emis de server trebuie să
 *      existe în acest Redis înainte ca runnerul să scrie ceva acolo (vezi canaryGate1Staging.ts).
 *   6. `client_id` CIMD: URL `https` pe `claude.ai`/`claude.com`, fără query/fragment; redirect = un `CLAUDE_CALLBACKS`.
 *   7. Legătura cu env-ul PROCESULUI (`vetProcessEnvBinding`): bibliotecile de produs pe care proba le refolosește
 *      (`createBetaInvite`, `createOAuthClient`, `issueAuthCode`…) citesc `NEXT_PUBLIC_SUPABASE_URL` /
 *      `SUPABASE_SERVICE_ROLE_KEY` / `REDIS_URL` din `process.env`; trebuie să fie EXACT valorile vetate.
 */

import { assertCanaryIsolation, isProdSupabaseHost } from "./releaseGate";
import { CLAUDE_CALLBACKS } from "../oauth/claudeCallbacks";
import { claudeCimdClientIdLogFields } from "../oauth/cimdDocValidate";

// ────────────────────────────── config (din env) ──────────────────────────────

/** Numele variabilelor de mediu citite de probă (doar numele — valorile nu se afișează niciodată). */
export const STAGING_PROBE_ENV = Object.freeze({
  mcpBaseUrl:         "GATE1_MCP_BASE_URL",
  supabaseUrl:        "NEXT_PUBLIC_SUPABASE_URL",
  supabaseAnonKey:    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  supabaseServiceKey: "SUPABASE_SERVICE_ROLE_KEY",
  expectSupabaseRef:  "GATE1_EXPECT_SUPABASE_REF",
  redisUrl:           "REDIS_URL",
  expectRedisHost:    "GATE1_EXPECT_REDIS_HOST",
  cimdClientId:       "GATE1_CIMD_CLIENT_ID",
  claudeRedirectUri:  "GATE1_CLAUDE_REDIRECT_URI", // opțional; implicit CLAUDE_CALLBACKS[0]
  emailDomain:        "GATE1_EMAIL_DOMAIN",        // opțional; implicit DEFAULT_PROBE_EMAIL_DOMAIN
});

export const DEFAULT_PROBE_EMAIL_DOMAIN = "gate1-probe.preflight-staging.test";

export interface StagingProbeConfig {
  mcpBaseUrl:         string;
  supabaseUrl:        string;
  supabaseAnonKey:    string;
  supabaseServiceKey: string;
  expectSupabaseRef:  string;
  redisUrl:           string;
  expectRedisHost:    string;
  cimdClientId:       string;
  claudeRedirectUri?: string;
  emailDomain?:       string;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

/** Citește config-ul din `env` (fără trim/normalizare — vetting-ul decide). Valori absente rămân `undefined`. */
export function readStagingProbeConfig(env: EnvLike): Partial<StagingProbeConfig> {
  const e = STAGING_PROBE_ENV;
  return {
    mcpBaseUrl:         env[e.mcpBaseUrl],
    supabaseUrl:        env[e.supabaseUrl],
    supabaseAnonKey:    env[e.supabaseAnonKey],
    supabaseServiceKey: env[e.supabaseServiceKey],
    expectSupabaseRef:  env[e.expectSupabaseRef],
    redisUrl:           env[e.redisUrl],
    expectRedisHost:    env[e.expectRedisHost],
    cimdClientId:       env[e.cimdClientId],
    claudeRedirectUri:  env[e.claudeRedirectUri],
    emailDomain:        env[e.emailDomain],
  };
}

// ────────────────────────────── ținte vetate ──────────────────────────────

/** Toate URL-urile probei, derivate din originile vetate. Fără secrete (cheile stau în `StagingSecrets`). */
export interface StagingTargets {
  origin:            string; // originea MCP de staging (https)
  mcpUrl:            string; // `${origin}/api/mcp`
  resource:          string; // == mcpUrl (RFC 8707)
  healthUrl:         string;
  tokenUrl:          string;
  authorizeUrl:      string; // `${origin}/authorize` (GET resource-owner)
  startPath:         string; // `/api/oauth/authorize/start`
  consentPath:       string; // `/api/oauth/authorize/consent`
  prmUrl:            string; // `${origin}/.well-known/oauth-protected-resource`
  asMetadataUrl:     string; // RFC 8414: issuer fără path → `${origin}/.well-known/oauth-authorization-server`
  inviteUrl:         string; // `${origin}/signup/invite`
  callbackUrl:       string; // `${origin}/auth/callback`
  dashboardUrl:      string;
  supabaseUrl:       string; // origine `https://<ref>.supabase.co`
  supabaseRef:       string;
  restUrl:           string; // `${supabaseUrl}/rest/v1`
  redisUrl:          string; // exact valoarea vetată (aceeași ca `process.env.REDIS_URL`)
  redisHost:         string;
  cimdClientId:      string;
  claudeRedirectUri: string;
  emailDomain:       string;
}

/** Secretele vetate — trec DOAR în adaptoare; nu se loghează și nu intră în raport. */
export interface StagingSecrets {
  anonKey:    string;
  serviceKey: string;
}

export type StagingVetCode =
  | "config_missing"
  | "isolation_refused"
  | "mcp_origin_unclean"
  | "mcp_not_https"
  | "mcp_loopback"
  | "supabase_origin_unclean"
  | "supabase_not_https"
  | "supabase_host_unexpected"
  | "supabase_ref_mismatch"
  | "supabase_prod"
  | "keys_identical"
  | "anon_key_wrong_role"
  | "service_key_wrong_role"
  | "key_ref_mismatch"
  | "redis_url_invalid"
  | "redis_host_mismatch"
  | "cimd_client_id_invalid"
  | "redirect_uri_not_claude"
  | "email_domain_invalid";

export const STAGING_VET_MSG: Readonly<Record<StagingVetCode, string>> = Object.freeze({
  config_missing:           "config incomplet: lipsește cel puțin o variabilă obligatorie (vezi STAGING_PROBE_ENV)",
  isolation_refused:        "izolare: assertCanaryIsolation a refuzat ținta (producție / ambiguu / schemă / credențiale)",
  mcp_origin_unclean:       "GATE1_MCP_BASE_URL nu e o origine curată (fără path/query/fragment)",
  mcp_not_https:            "GATE1_MCP_BASE_URL trebuie să fie https (staging public)",
  mcp_loopback:             "GATE1_MCP_BASE_URL e loopback — proba țintește staging-ul public, nu stack-ul local",
  supabase_origin_unclean:  "NEXT_PUBLIC_SUPABASE_URL nu e o origine curată",
  supabase_not_https:       "NEXT_PUBLIC_SUPABASE_URL trebuie să fie https",
  supabase_host_unexpected: "NEXT_PUBLIC_SUPABASE_URL nu e de forma https://<ref>.supabase.co",
  supabase_ref_mismatch:    "ref-ul Supabase ≠ GATE1_EXPECT_SUPABASE_REF (confirmarea operatorului)",
  supabase_prod:            "Supabase-ul țintă e proiectul de PRODUCȚIE — refuz",
  keys_identical:           "cheia anon și cheia service-role sunt identice — config greșit",
  anon_key_wrong_role:      "NEXT_PUBLIC_SUPABASE_ANON_KEY nu e o cheie anon/publishable",
  service_key_wrong_role:   "SUPABASE_SERVICE_ROLE_KEY nu e o cheie service_role/secret",
  key_ref_mismatch:         "o cheie Supabase (JWT) aparține altui proiect decât ref-ul vetat",
  redis_url_invalid:        "REDIS_URL lipsă/neparsabil/schemă greșită (cere redis: sau rediss:)",
  redis_host_mismatch:      "hostname-ul din REDIS_URL ≠ GATE1_EXPECT_REDIS_HOST (pinul operatorului)",
  cimd_client_id_invalid:   "GATE1_CIMD_CLIENT_ID nu e un URL https pe claude.ai/claude.com fără query/fragment",
  redirect_uri_not_claude:  "GATE1_CLAUDE_REDIRECT_URI nu e unul dintre CLAUDE_CALLBACKS",
  email_domain_invalid:     "GATE1_EMAIL_DOMAIN invalid (cere un domeniu simplu, litere mici)",
});

export type StagingVetResult =
  | { ok: true;  targets: StagingTargets; secrets: StagingSecrets }
  | { ok: false; code: StagingVetCode };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SUPABASE_REF_RE = /^[a-z0-9]{8,40}$/;
const EMAIL_DOMAIN_RE = /^(?=.{4,100}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v === v.trim();
}

/** Origine curată → `u.origin` + hostname lowercased; altfel null. */
function cleanOrigin(raw: string): { origin: string; host: string; protocol: string } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username !== "" || u.password !== "") return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  if (u.search !== "" || u.hash !== "") return null;
  return { origin: u.origin, host: u.hostname.toLowerCase(), protocol: u.protocol };
}

/** Decodează payload-ul unui JWT (base64url JSON), FĂRĂ verificarea semnăturii. Non-JWT → null. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const obj: unknown = JSON.parse(json);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Verifică rolul unei chei Supabase. JWT legacy → `role` exact + `ref` (dacă e prezent) = ref-ul vetat. Cheie nouă →
 * prefixul rolului. Orice altă formă → refuz (nu ghicim). Întoarce `ok` / `wrong_role` / `ref_mismatch`.
 */
export function classifySupabaseKey(key: string, want: "anon" | "service", ref: string): "ok" | "wrong_role" | "ref_mismatch" {
  const claims = decodeJwtClaims(key);
  if (claims) {
    const role = claims.role;
    if (role !== (want === "anon" ? "anon" : "service_role")) return "wrong_role";
    if (claims.ref !== undefined && claims.ref !== ref) return "ref_mismatch";
    return "ok";
  }
  if (want === "anon") return key.startsWith("sb_publishable_") ? "ok" : "wrong_role";
  return key.startsWith("sb_secret_") ? "ok" : "wrong_role";
}

/** `REDIS_URL` → hostname lowercased, DOAR pe schemă redis/rediss, fără path dincolo de `/<db>`. Altfel null. */
export function redisHostOf(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "" || host.endsWith(".")) return null;
  if (u.search !== "" || u.hash !== "") return null;
  if (!/^\/?\d{0,2}$/.test(u.pathname)) return null;
  return host;
}

/**
 * Poarta zero a probei de staging. Ordinea: prezența config-ului → `assertCanaryIsolation` → origini → Supabase (ref
 * pin + anti-prod) → chei → Redis (pin) → CIMD/redirect → domeniul de email. Întoarce ținte + secrete sau un cod închis.
 */
export function vetStagingProbe(cfg: Partial<StagingProbeConfig> | null | undefined): StagingVetResult {
  if (!cfg) return { ok: false, code: "config_missing" };
  const required = [
    cfg.mcpBaseUrl, cfg.supabaseUrl, cfg.supabaseAnonKey, cfg.supabaseServiceKey,
    cfg.expectSupabaseRef, cfg.redisUrl, cfg.expectRedisHost, cfg.cimdClientId,
  ];
  if (!required.every(nonEmpty)) return { ok: false, code: "config_missing" };
  const c = cfg as StagingProbeConfig;

  const iso = assertCanaryIsolation({ mcpBaseUrl: c.mcpBaseUrl, supabaseUrl: c.supabaseUrl });
  if (!iso.ok) return { ok: false, code: "isolation_refused" };

  const mcp = cleanOrigin(c.mcpBaseUrl);
  if (!mcp) return { ok: false, code: "mcp_origin_unclean" };
  if (mcp.protocol !== "https:") return { ok: false, code: "mcp_not_https" };
  if (LOOPBACK.has(mcp.host)) return { ok: false, code: "mcp_loopback" };

  const sb = cleanOrigin(c.supabaseUrl);
  if (!sb) return { ok: false, code: "supabase_origin_unclean" };
  if (sb.protocol !== "https:") return { ok: false, code: "supabase_not_https" };
  if (isProdSupabaseHost(sb.host)) return { ok: false, code: "supabase_prod" };
  const m = /^([a-z0-9]+)\.supabase\.co$/.exec(sb.host);
  if (!m) return { ok: false, code: "supabase_host_unexpected" };
  const ref = m[1];
  if (!SUPABASE_REF_RE.test(c.expectSupabaseRef) || ref !== c.expectSupabaseRef) return { ok: false, code: "supabase_ref_mismatch" };

  if (c.supabaseAnonKey === c.supabaseServiceKey) return { ok: false, code: "keys_identical" };
  const anon = classifySupabaseKey(c.supabaseAnonKey, "anon", ref);
  if (anon === "wrong_role") return { ok: false, code: "anon_key_wrong_role" };
  if (anon === "ref_mismatch") return { ok: false, code: "key_ref_mismatch" };
  const svc = classifySupabaseKey(c.supabaseServiceKey, "service", ref);
  if (svc === "wrong_role") return { ok: false, code: "service_key_wrong_role" };
  if (svc === "ref_mismatch") return { ok: false, code: "key_ref_mismatch" };

  const redisHost = redisHostOf(c.redisUrl);
  if (redisHost === null) return { ok: false, code: "redis_url_invalid" };
  if (redisHost !== c.expectRedisHost.toLowerCase()) return { ok: false, code: "redis_host_mismatch" };

  const cimd = claudeCimdClientIdLogFields(c.cimdClientId);
  let cimdUrl: URL | null = null;
  try { cimdUrl = new URL(c.cimdClientId); } catch { cimdUrl = null; }
  if (!cimd || !cimdUrl || cimdUrl.search !== "" || cimdUrl.hash !== "" || cimdUrl.username !== "" || cimdUrl.password !== "") {
    return { ok: false, code: "cimd_client_id_invalid" };
  }

  const redirect = c.claudeRedirectUri === undefined ? CLAUDE_CALLBACKS[0] : c.claudeRedirectUri;
  if (!CLAUDE_CALLBACKS.includes(redirect)) return { ok: false, code: "redirect_uri_not_claude" };

  const emailDomain = c.emailDomain === undefined ? DEFAULT_PROBE_EMAIL_DOMAIN : c.emailDomain;
  if (!EMAIL_DOMAIN_RE.test(emailDomain)) return { ok: false, code: "email_domain_invalid" };

  const origin = mcp.origin;
  const mcpUrl = `${origin}/api/mcp`;
  return {
    ok: true,
    targets: {
      origin,
      mcpUrl,
      resource:          mcpUrl,
      healthUrl:         `${origin}/api/health`,
      tokenUrl:          `${origin}/api/oauth/token`,
      authorizeUrl:      `${origin}/authorize`,
      startPath:         "/api/oauth/authorize/start",
      consentPath:       "/api/oauth/authorize/consent",
      prmUrl:            `${origin}/.well-known/oauth-protected-resource`,
      asMetadataUrl:     `${origin}/.well-known/oauth-authorization-server`,
      inviteUrl:         `${origin}/signup/invite`,
      callbackUrl:       `${origin}/auth/callback`,
      dashboardUrl:      `${origin}/dashboard`,
      supabaseUrl:       sb.origin,
      supabaseRef:       ref,
      restUrl:           `${sb.origin}/rest/v1`,
      redisUrl:          c.redisUrl,
      redisHost,
      cimdClientId:      c.cimdClientId,
      claudeRedirectUri: redirect,
      emailDomain,
    },
    secrets: { anonKey: c.supabaseAnonKey, serviceKey: c.supabaseServiceKey },
  };
}

export type EnvBindingCode = "env_supabase_url_mismatch" | "env_service_key_mismatch" | "env_redis_url_mismatch";

export const ENV_BINDING_MSG: Readonly<Record<EnvBindingCode, string>> = Object.freeze({
  env_supabase_url_mismatch: "process.env.NEXT_PUBLIC_SUPABASE_URL ≠ Supabase-ul vetat (bibliotecile de produs ar lovi alt proiect)",
  env_service_key_mismatch:  "process.env.SUPABASE_SERVICE_ROLE_KEY ≠ cheia vetată",
  env_redis_url_mismatch:    "process.env.REDIS_URL ≠ Redis-ul vetat",
});

/**
 * Bibliotecile de produs refolosite de probă citesc env-ul PROCESULUI (supabase-admin la încărcare, getRedis leneș).
 * Înainte de a le importa (dinamic), env-ul trebuie să fie EXACT cel vetat. Comparația pe Supabase e pe origine.
 */
export function vetProcessEnvBinding(env: EnvLike, t: StagingTargets, s: StagingSecrets): { ok: true } | { ok: false; code: EnvBindingCode } {
  const raw = env.NEXT_PUBLIC_SUPABASE_URL;
  const o = typeof raw === "string" ? cleanOrigin(raw) : null;
  if (!o || o.origin !== t.supabaseUrl) return { ok: false, code: "env_supabase_url_mismatch" };
  if (env.SUPABASE_SERVICE_ROLE_KEY !== s.serviceKey) return { ok: false, code: "env_service_key_mismatch" };
  if (env.REDIS_URL !== t.redisUrl) return { ok: false, code: "env_redis_url_mismatch" };
  return { ok: true };
}
