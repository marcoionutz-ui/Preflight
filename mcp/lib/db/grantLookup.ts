/**
 * lib/db/grantLookup.ts — PH-2 step 10.5a (clasificare citire `oauth_grants`, PUR).
 *
 * Mirror al `entitlementLookup`/`registrationLookup`. `grant_id` din tokenul user trebuie rezolvat la un rând
 * `oauth_grants` ca revocarea unui SINGUR consent (status=revoked) să funcționeze — altfel `grant_id` e decorativ
 * (cgpt). Discriminat found/not_found/unavailable, fail-closed:
 *   - `error` (backend jos / query eșuat) → `unavailable` (NU „not_found": grantul poate exista, dar nu-l putem citi).
 *   - `data` null (0 rânduri via `.maybeSingle()`) → `not_found` (grant inexistent → 401).
 *   - `data` undefined (răspuns/adaptor neașteptat) → `unavailable` (fail-closed, NU not_found).
 *   - `data` prezent DAR malformat → `unavailable` (rând necredibil, nu-l tratăm ca found).
 *   - `data` valid → `found`. NB: un grant `revoked` e un rând VALID → `found`; gate-ul „active" e în verificare
 *     (`verifyUserTokenGrant`), nu aici (found ≠ usable, ca la registrationLookup).
 */

import type { OAuthGrant, GrantStatus } from "../oauth/grant";

export type GrantLookup =
  | { status: "found";       grant: OAuthGrant }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isInt(v: unknown): v is number { return typeof v === "number" && Number.isInteger(v); }
function isGrantStatus(v: unknown): v is GrantStatus { return v === "active" || v === "revoked"; }
/** scopes utilizabile: array ne-gol de string-uri ne-goale după trim (aliniat cu SQL arr_clean). */
function isCleanScopes(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(s => typeof s === "string" && s.trim() !== "");
}

/** Guard de formă pt. un rând `oauth_grants` (fail-closed: rând corupt → NU `found`). Acceptă status active SAU revoked. */
export function isOAuthGrantRow(raw: unknown): raw is OAuthGrant {
  if (typeof raw !== "object" || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return isNonEmptyString(o.grant_id)
    && isNonEmptyString(o.registration_id)
    && isNonEmptyString(o.client_id)
    && isNonEmptyString(o.user_id)
    && isNonEmptyString(o.resource)
    && isCleanScopes(o.scopes)
    && isInt(o.entitlement_version) && o.entitlement_version >= 1
    && isGrantStatus(o.status)
    // `created_at` e OBLIGATORIU în `OAuthGrant` (audit/ordonare) — fără el, `found` ar întoarce un `OAuthGrant`
    // type-unsound. Cerem string ne-gol (rândul e persistat cu ISO); lipsă → rând necredibil → unavailable.
    && isNonEmptyString(o.created_at);
}

export function classifyGrantLookup(
  data:  unknown,
  error: { message?: string } | null | undefined,
): GrantLookup {
  if (error)  return { status: "unavailable", reason: error.message ?? "supabase_error" };
  if (data === undefined) return { status: "unavailable", reason: "răspuns neașteptat (data undefined)" };
  if (data === null) return { status: "not_found" };
  if (!isOAuthGrantRow(data)) return { status: "unavailable", reason: "oauth_grants row malformat" };
  return { status: "found", grant: data };
}
