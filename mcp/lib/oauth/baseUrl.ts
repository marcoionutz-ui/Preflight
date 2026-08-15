/**
 * lib/oauth/baseUrl.ts — U7 (host-header poisoning fix).
 *
 * PUR (fără importuri) → testabil izolat în tsx. Sursa CANONICĂ a originii publice a serverului OAuth.
 *
 * Problema: rutele de metadata (`.well-known/*`, `api/.well-known/*`) și `/auth/callback` construiau
 * `issuer`/`origin` din `x-forwarded-host` — un header CONTROLAT DE CLIENT. Un atacator putea trimite
 * `X-Forwarded-Host: evil.com` → metadata anunța `evil.com/api/oauth/token` → un client care descoperă
 * config-ul era trimis la endpoint-urile atacatorului (exfiltrare de cod/token). Fix: `PUBLIC_BASE_URL`
 * (env, setat de deploy) = sursa canonică; header-ele rămân fallback DOAR pentru dev/compat (fără garanție
 * de securitate acolo — în producție trebuie setat `PUBLIC_BASE_URL`).
 */

/**
 * Validează un issuer/base URL după constrângerile RFC 8414 (OAuth authorization server metadata):
 * http(s) absolut cu host, FĂRĂ query, FĂRĂ fragment, FĂRĂ userinfo (user:pass@). `requireHttps` (PH-8/cgpt):
 * în producție issuer-ul TREBUIE https (http respins); în dev se acceptă și http (ex. http://localhost).
 * Verificările pe protocol/query/fragment/userinfo se fac pe URL-ul PARSAT (deci case-insensitive pe schemă).
 * Întoarce URL-ul normalizat (fără slash trailing) sau `null` dacă nu-i valid.
 */
function validateIssuerUrl(raw: string | undefined | null, opts: { requireHttps: boolean }): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let u: URL;
  try { u = new URL(trimmed); } catch { return null; }
  const isHttps = u.protocol === "https:";
  const isHttp  = u.protocol === "http:";
  if (!isHttps && !isHttp) return null;              // nu javascript:/data:/ftp:/etc.
  if (opts.requireHttps && !isHttps) return null;    // PH-8: producție = doar https (RFC 8414)
  if (u.hostname === "") return null;                // fără host = inutil ca origine
  if (u.search !== "" || u.hash !== "") return null; // RFC 8414: issuer FĂRĂ query & FĂRĂ fragment
  if (u.username !== "" || u.password !== "") return null; // fără userinfo (user:pass@)
  return trimmed.replace(/\/+$/, "");                // fără slash trailing (`${base}/authorize`)
}

/** Normalizare STRUCTURALĂ (env-agnostică) a unui base URL issuer: http SAU https, fără query/fragment/userinfo. */
export function normalizeBaseUrl(raw: string | undefined | null): string | null {
  return validateIssuerUrl(raw, { requireHttps: false });
}

/**
 * Base URL public valid pt. `env` dat: normalizarea structurală + regula de producție (https-only). În producție
 * respinge http/query/fragment/userinfo → `null`; în dev acceptă și http. Sursa adevărului pt. fail-closed.
 */
export function resolvePublicBaseUrl(
  raw: string | undefined | null,
  env: { NODE_ENV?: string | undefined },
): string | null {
  return validateIssuerUrl(raw, { requireHttps: (env.NODE_ENV ?? "") === "production" });
}

/**
 * PH-8: în PRODUCȚIE, `PUBLIC_BASE_URL` lipsă/invalid (incl. http/query/fragment/userinfo — nevalid RFC 8414) =
 * condiție de FAIL-CLOSED — resolver-ul NU cade pe Host-ul controlat de client (host-header poisoning). Decizia e
 * PURĂ (testabilă); efectul (throw) trăiește în `resolveBaseUrl`. `production` strict (Next setează
 * NODE_ENV=production la build de prod); dev/staging fără NODE_ENV=production păstrează fallback-ul pe header.
 */
export function isBaseUrlFailClosed(
  env: { PUBLIC_BASE_URL?: string | undefined; NODE_ENV?: string | undefined },
): boolean {
  return (env.NODE_ENV ?? "") === "production" && resolvePublicBaseUrl(env.PUBLIC_BASE_URL, env) === null;
}

/**
 * Aruncat de `resolveBaseUrl` când, în producție, `PUBLIC_BASE_URL` lipsește/e invalid. Propagat → ruta de
 * metadata/callback răspunde 5xx (REFUZĂ să servească) în loc să anunțe o origine controlabilă de atacator.
 * Fail-closed by default: orice apelant care NU-l prinde tot refuză (nu poate scurge accidental host-ul din request).
 */
export class BaseUrlNotConfiguredError extends Error {
  constructor() {
    super(
      "PUBLIC_BASE_URL lipsă/invalid în producție — refuz fail-closed (altfel host-header poisoning). " +
      "Setează PUBLIC_BASE_URL pe deploy.",
    );
    this.name = "BaseUrlNotConfiguredError";
  }
}

/**
 * Originea publică a serverului OAuth. `PUBLIC_BASE_URL` (env) = canonic → IGNORĂ header-ele → imun la
 * host-header poisoning. Dacă lipsește/invalid:
 *   - în PRODUCȚIE → **fail-closed**: aruncă `BaseUrlNotConfiguredError` (nu servim o origine atacabilă);
 *   - în dev/staging → fallback pe `x-forwarded-host`/`host` (DOAR local/compat, fără garanție de securitate).
 * Fără slash trailing în toate cazurile.
 */
export function resolveBaseUrl(
  headers: { get(name: string): string | null },
  env: { PUBLIC_BASE_URL?: string | undefined; NODE_ENV?: string | undefined },
): string {
  // env-aware: în producție cere https + interzice query/fragment/userinfo (RFC 8414). Verificarea de
  // producție se face AICI, ÎNAINTE de return — un http/query/fragment în prod NU mai scapă ca „valid".
  const configured = resolvePublicBaseUrl(env.PUBLIC_BASE_URL, env);
  if (configured) return configured;

  // PH-8: producție + neconfigurat/nevalid → REFUZĂ (nu cădea pe Host-ul din request = poisonable).
  if ((env.NODE_ENV ?? "") === "production") throw new BaseUrlNotConfiguredError();

  // dev/staging: fallback pe header (fără garanție de securitate — doar local/compat).
  const host  = headers.get("x-forwarded-host") ?? headers.get("host") ?? "";
  const proto = headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}
