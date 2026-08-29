/**
 * lib/db/authorizeRegistrationLookup.ts — PH-2 step 10.3b-iv frunză 5 (clasificare citire registration pt. /authorize GET, PUR).
 *
 * Leaf PUR (doar `import type`) → mapper + clasificator testabili în tsx (ca `registrationLookup.ts`). Query-ul I/O
 * (`getAuthorizeRegistration`) e în `ph2Reads.ts`. Mapează un rând `oauth_client_registrations` la `AuthorizeRegistration`
 * (superset față de `RegistrationRef`: + `redirect_uris` + metadate UI), forma INJECTATĂ în `validateAuthorizeRequest`.
 *
 * GARANȚIE DE FORMĂ (nit cgpt): validatorul promite „nu aruncă", presupunând că `grant_types`/`redirect_uris`/`status`
 * sunt deja bine-tipate runtime. Acest mapper e cel care O IMPUNE, fail-closed:
 *   - securitate-relevant (folosit la TRUST): `registration_id`/`client_id`/`status` string ne-gol; `grant_types` +
 *     `redirect_uris` = `string[]`; `expires_at` = null EXPLICIT / ISO parsabil→ms / number; coloană LIPSĂ sau tip
 *     greșit → `null` mapare (rând corupt → `unavailable`), NU un shell „veșnic valid" / fără redirecturi.
 *   - metadate DOAR-display (`client_name`/`client_type`/`token_endpoint_auth_method`): coerce la `string | null`
 *     (non-string → null) — nu-s folosite la validare, deci nu pică rândul.
 */

import type { AuthorizeRegistration } from "../oauth/authorizeRequestValidate";

export type AuthorizeRegistrationLookup =
  | { status: "found";       registration: AuthorizeRegistration }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isStringArray(v: unknown): v is string[] { return Array.isArray(v) && v.every(s => typeof s === "string"); }
function asStringOrNull(v: unknown): string | null { return typeof v === "string" ? v : null; }

/** Parsează `expires_at`: null EXPLICIT → null; ISO string parsabil → ms; number finit → ca atare; altfel `undefined` (corupt). */
function parseExpiresAt(o: Record<string, unknown>): number | null | undefined {
  if (!("expires_at" in o)) return undefined;      // coloană LIPSĂ → corupt (nu „nu expiră")
  if (o.expires_at === null) return null;          // DOAR null explicit = nu expiră
  if (o.expires_at === undefined) return undefined; // prezent ca undefined → corupt
  if (typeof o.expires_at === "string") {
    const ms = Date.parse(o.expires_at);
    return Number.isNaN(ms) ? undefined : ms;      // ISO invalid → corupt
  }
  if (typeof o.expires_at === "number" && Number.isFinite(o.expires_at)) return o.expires_at;
  return undefined;
}

/**
 * Mapează un rând `oauth_client_registrations` (select extins) la `AuthorizeRegistration` sau `null` (rând corupt,
 * fail-closed). `redirect_uris` TREBUIE prezent + `string[]` (coloană lipsă / null / ne-array → null: nu putem trusta
 * niciun redirect fără allowlist-ul înregistrat).
 */
export function mapAuthorizeRegistrationRow(raw: unknown): AuthorizeRegistration | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  if (!isNonEmptyString(o.registration_id)) return null;
  if (!isNonEmptyString(o.client_id))       return null;
  if (!isNonEmptyString(o.status))          return null;
  if (!isStringArray(o.grant_types))        return null;

  const expires_at = parseExpiresAt(o);
  if (expires_at === undefined) return null; // coloană lipsă / ISO invalid / tip greșit → corupt

  if (!("redirect_uris" in o) || !isStringArray(o.redirect_uris)) return null; // fără allowlist înregistrat → corupt

  return {
    registration_id:            o.registration_id,
    client_id:                  o.client_id,
    status:                     o.status,
    grant_types:                o.grant_types,
    expires_at,
    redirect_uris:              o.redirect_uris,
    client_name:                asStringOrNull(o.client_name),
    client_type:                asStringOrNull(o.client_type),
    token_endpoint_auth_method: asStringOrNull(o.token_endpoint_auth_method),
  };
}

/** Discriminare NF4 (ca `classifyRegistrationLookup`): error→unavailable; undefined→unavailable; null→not_found; rând malformat→unavailable; valid→found. */
export function classifyAuthorizeRegistrationLookup(
  data:  unknown,
  error: { message?: string } | null | undefined,
): AuthorizeRegistrationLookup {
  if (error) return { status: "unavailable", reason: error.message ?? "supabase_error" };
  if (data === undefined) return { status: "unavailable", reason: "răspuns neașteptat (data undefined)" };
  if (data === null) return { status: "not_found" };
  const reg = mapAuthorizeRegistrationRow(data);
  if (!reg) return { status: "unavailable", reason: "oauth_client_registrations row malformat (authorize select)" };
  return { status: "found", registration: reg };
}
