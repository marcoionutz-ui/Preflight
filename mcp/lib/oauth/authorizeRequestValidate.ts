/**
 * lib/oauth/authorizeRequestValidate.ts — PH-2 step 10.3b-iv frunză 4 (validatorul PUR al cererii `/authorize` GET).
 *
 * Frunză pură (zero I/O; registration-ul INJECTAT) → tsx-testabilă. Validează o cerere `/authorize` interactivă ÎNAINTE
 * de a construi tranzacția de consent. Boundary-ul CRITIC (corecția cgpt #3, RFC 6749 §4.1.2.1): `redirect_uri` +
 * `client_id` se validează ÎNTÂI; DOAR după ce `redirect_uri` e TRUSTED (match pe allowlist-ul registration-ului)
 * erorile de request se întorc prin REDIRECT (cu `error`/`state`/`iss`). Un `client_id`/`redirect_uri` netrusted →
 * eroare afișată LOCAL, NICIODATĂ redirect (altfel un link crafted ar trimite un cod/eroare la un redirect al atacatorului).
 *
 * Două etape:
 *   ETAPA 1 (TRUST) → `invalid_client` (LOCAL, fără redirect): client_id prezent; registration găsit + `active` +
 *     ne-expirat + permite `authorization_code`; are `redirect_uris`; `redirect_uri` prezentat ∈ allowlist
 *     (`redirectUriMatchesAny`, exact-match loopback-aware). Orice picare aici = pagină locală.
 *   ETAPA 2 (REQUEST, redirect DEJA trusted) → `error_redirect` (route-ul redirectează cu error+state+iss):
 *     `response_type=code`; PKCE S256 valid (RFC 7636); `resource` valid (RFC 8707); scope-urile cerute ⊆ catalog.
 *   SUCCES → `ok` cu câmpurile derivate pentru `buildAuthzTransaction` (resource canonic, scope-uri validate).
 *
 * NU rezolvă scope-urile față de cont (aia e la consent, `buildAuthGrantAndCodeClaims`) — doar verifică apartenența la
 * catalog. NU aruncă — `{ kind, ... }` total.
 */

import { validateAuthorizeChallenge } from "./pkce";
import { validateResourceIndicator } from "./resource";
import { redirectUriMatchesAny } from "./redirectMatch";
import { isAllowedRegistrationRedirect } from "./registrationRedirectPolicy";

/** Registration-ul necesar la `/authorize` GET (superset față de `RegistrationRef`: + redirect_uris + metadate UI). */
export interface AuthorizeRegistration {
  registration_id:            string;
  client_id:                  string;
  status:                     string;         // "active" | ...
  grant_types:                string[];
  expires_at:                 number | null;  // ms; null = nu expiră
  redirect_uris:              string[];
  client_name:                string | null;  // pt. ecranul de consent (nu validare)
  client_type:                string | null;  // "public" | "confidential" (nu validare)
  token_endpoint_auth_method: string | null;  // pt. consent/audit (nu validare)
}

/** Parametrii bruți din query-ul `/authorize` GET. */
export interface AuthorizeParams {
  client_id:             string;
  redirect_uri:          string;
  response_type:         string;
  scope:                 string;  // space-delimited (poate fi gol)
  code_challenge:        string;
  code_challenge_method: string;
  resource:              string;  // poate fi gol (default-bind canonic)
  state:                 string;  // poate fi gol
}

/** Câmpurile derivate + validate care alimentează `buildAuthzTransaction`. */
export interface ValidatedAuthorizeRequest {
  registration_id:       string;
  client_id:             string;
  redirect_uri:          string;   // trusted (∈ allowlist)
  state:                 string;
  resource:              string;   // canonic (din validateResourceIndicator)
  requested_scopes:      string[]; // ⊆ catalog (posibil gol → rezolvat la consent)
  code_challenge:        string;
  code_challenge_method: string;
}

export type AuthorizeValidation =
  | { kind: "invalid_client";  reason: string }                 // TRUST picat → pagină LOCALĂ, FĂRĂ redirect
  // redirect trusted → route redirectează cu error+state+iss. `redirect_uri`+`state` sunt DEJA validate/trusted și se
  // TRANSPORTĂ aici (cgpt) ca ruta să NU le recitească din query-ul brut la construirea redirectului de eroare.
  | { kind: "error_redirect";  error: string; reason: string; redirect_uri: string; state: string }
  | { kind: "ok";              request: ValidatedAuthorizeRequest };

function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }

/**
 * Validează cererea `/authorize` GET. `registration` = null când `client_id` nu se rezolvă. `nowMs`/`issuer`/
 * `serverPolicy` (catalogul de scope-uri) injectate (pur).
 */
export function validateAuthorizeRequest(p: {
  params:       AuthorizeParams;
  registration: AuthorizeRegistration | null;
  issuer:       string;
  serverPolicy: readonly string[];
  nowMs:        number;
}): AuthorizeValidation {
  const { params: q, registration: reg } = p;

  // ── ETAPA 1 — TRUST (orice picare → invalid_client LOCAL, FĂRĂ redirect) ──────────
  if (!isNonEmptyString(q.client_id)) return { kind: "invalid_client", reason: "client_id lipsă" };
  if (!reg)                            return { kind: "invalid_client", reason: "client necunoscut (registration inexistent)" };
  if (reg.client_id !== q.client_id)  return { kind: "invalid_client", reason: "registration nu aparține client_id-ului cerut" };
  if (reg.status !== "active")        return { kind: "invalid_client", reason: `registration status ≠ active (${reg.status})` };
  if (reg.expires_at !== null && !(reg.expires_at > p.nowMs)) return { kind: "invalid_client", reason: "registration expirată" };
  if (!reg.grant_types.includes("authorization_code"))       return { kind: "invalid_client", reason: "registration nu permite authorization_code" };
  if (!Array.isArray(reg.redirect_uris) || reg.redirect_uris.length === 0) {
    return { kind: "invalid_client", reason: "niciun redirect_uri înregistrat pentru client" };
  }
  // ALLOWLIST POZITIV (cgpt) ÎNAINTE de match: `redirectUriMatchesAny` se sprijină doar pe denylist-ul U7
  // (`isSafeRedirectUri`), care lasă să treacă `ftp:`/`ws:`/`mailto:`/scheme custom fără reverse-domain. Un rând
  // legacy/corupt cu `redirect_uris: ["ftp://…"]` ar face un `redirect_uri` identic „trusted". Cerem întâi allowlist-ul
  // pozitiv de înregistrare (`isAllowedRegistrationRedirect`: https / http-loopback / custom reverse-domain) pe URI-ul
  // PREZENTAT, apoi match-ul pe allowlist. Orice picare → invalid_client LOCAL (NU redirect).
  if (!isNonEmptyString(q.redirect_uri)
      || !isAllowedRegistrationRedirect(q.redirect_uri)
      || !redirectUriMatchesAny(reg.redirect_uris, q.redirect_uri)) {
    return { kind: "invalid_client", reason: "redirect_uri nu e permis de politică sau nu se potrivește cu allowlist-ul înregistrat" };
  }

  // ── ETAPA 2 — REQUEST (redirect_uri DEJA trusted → erori prin redirect) ───────────
  // `redirect_uri` e trusted (a trecut etapa 1); `state` e cel prezentat. Le transportăm în FIECARE error_redirect.
  const trustedRedirect = q.redirect_uri;
  const trustedState    = typeof q.state === "string" ? q.state : "";
  if (q.response_type !== "code") {
    return { kind: "error_redirect", error: "unsupported_response_type", reason: `response_type ≠ code (${q.response_type})`, redirect_uri: trustedRedirect, state: trustedState };
  }
  const pkce = validateAuthorizeChallenge(q.code_challenge, q.code_challenge_method);
  if (!pkce.ok) {
    return { kind: "error_redirect", error: "invalid_request", reason: `PKCE invalid: ${pkce.reason}`, redirect_uri: trustedRedirect, state: trustedState };
  }
  const rv = validateResourceIndicator(q.resource, p.issuer);
  if (rv.status === "invalid_target") {
    return { kind: "error_redirect", error: "invalid_target", reason: rv.reason, redirect_uri: trustedRedirect, state: trustedState };
  }
  // Scope: apartenență la catalog (rezolvarea față de cont e la consent). Scope-urile cerute care nu-s în catalog → invalid_scope.
  const requested = q.scope.split(/\s+/).map(s => s.trim()).filter(s => s.length > 0);
  const policy = new Set(p.serverPolicy);
  const unknown = requested.filter(s => !policy.has(s));
  if (unknown.length > 0) {
    return { kind: "error_redirect", error: "invalid_scope", reason: `scope necunoscut: ${unknown.join(", ")}`, redirect_uri: trustedRedirect, state: trustedState };
  }

  // ── SUCCES ────────────────────────────────────────────────────────────────────────
  return {
    kind: "ok",
    request: {
      registration_id:       reg.registration_id,
      client_id:             q.client_id,
      redirect_uri:          q.redirect_uri,
      state:                 typeof q.state === "string" ? q.state : "",
      resource:              rv.resource,
      requested_scopes:      requested,
      code_challenge:        q.code_challenge,
      code_challenge_method: q.code_challenge_method,
    },
  };
}
