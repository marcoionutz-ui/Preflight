/**
 * lib/db/registrationLookup.ts — PH-2 step 10.3b-ii (clasificare citire oauth_client_registrations, PUR).
 *
 * Leaf PUR (doar `import type`) → clasificator + mapper testabili în tsx (ca `clientLookup.ts`). Query-ul I/O
 * (`getRegistrationByClientId`) e în `ph2Reads.ts`. Mapează rândul Supabase la `RegistrationRef` (forma cerută de
 * `decideConsentGrant`), convertind `expires_at` din ISO (timestamptz) în MS. Discriminare NF4 (error→unavailable;
 * null→not_found; rând malformat / `expires_at` neparsabil → unavailable; valid→found).
 */

import type { RegistrationRef } from "../oauth/authorizeConsent";

export type RegistrationLookup =
  | { status: "found";       registration: RegistrationRef }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isStringArray(v: unknown): v is string[] { return Array.isArray(v) && v.every(s => typeof s === "string"); }

/**
 * Mapează un rând oauth_client_registrations la `RegistrationRef` sau `null` (rând malformat). `expires_at`:
 *   - `null` EXPLICIT → `null` (nu expiră);
 *   - `undefined`/coloană LIPSĂ → `null` mapare (rând corupt): un query care omite accidental coloana NU trebuie să
 *     facă un shell DCR expirabil „veșnic valid" — fail-closed;
 *   - string ISO parsabil → ms;
 *   - orice altceva (ISO invalid / tip greșit) → `null` mapare (rând corupt, fail-closed).
 * `status` e păstrat ca string (gate-ul `active` e în consent); `grant_types` array de string-uri.
 */
export function mapRegistrationRow(raw: unknown): RegistrationRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.registration_id)) return null;
  if (!isNonEmptyString(o.client_id))       return null;
  if (!isNonEmptyString(o.status))          return null;
  if (!isStringArray(o.grant_types))        return null;
  if (!("expires_at" in o))                 return null; // coloană LIPSĂ → corupt (nu „nu expiră")

  let expires_at: number | null;
  if (o.expires_at === null) {
    expires_at = null; // DOAR null explicit = nu expiră
  } else if (o.expires_at === undefined) {
    return null;       // prezent ca undefined → corupt, fail-closed
  } else if (typeof o.expires_at === "string") {
    const ms = Date.parse(o.expires_at);
    if (Number.isNaN(ms)) return null; // ISO invalid → rând corupt
    expires_at = ms;
  } else if (typeof o.expires_at === "number" && Number.isFinite(o.expires_at)) {
    expires_at = o.expires_at; // deja ms (defensiv)
  } else {
    return null;
  }

  return { registration_id: o.registration_id, client_id: o.client_id, status: o.status, grant_types: o.grant_types, expires_at };
}

export function classifyRegistrationLookup(
  data:  unknown,
  error: { message?: string } | null | undefined,
): RegistrationLookup {
  if (error) return { status: "unavailable", reason: error.message ?? "supabase_error" };
  // `.maybeSingle()` dă `null` pe 0 rânduri; `undefined` = răspuns/adaptor neaș­teptat → fail-closed `unavailable`.
  if (data === undefined) return { status: "unavailable", reason: "răspuns neașteptat (data undefined)" };
  if (data === null) return { status: "not_found" };
  const reg = mapRegistrationRow(data);
  if (!reg) return { status: "unavailable", reason: "oauth_client_registrations row malformat" };
  return { status: "found", registration: reg };
}
