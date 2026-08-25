/**
 * lib/db/entitlementLookup.ts — PH-2 step 10.3b-ii (clasificare citire account_entitlements, PUR).
 *
 * Leaf PUR (doar `import type`) → clasificatorul + validatorul de rând-s testabili în tsx fără Supabase (ca
 * `clientLookup.ts`). Query-ul I/O (`getAccountEntitlement`) e în `ph2Reads.ts`. Discriminăm ca NF4:
 *   - `error` prezent (backend jos / query eșuat) → `unavailable` (NU „not_found"): contul poate exista, dar nu-l
 *     putem citi → /authorize răspunde fail-closed, nu „cont inexistent".
 *   - `data` null (0 rânduri, via `.maybeSingle()`) → `not_found`.
 *   - `data` prezent DAR malformat (tip greșit / status necunoscut / scopes goale) → `unavailable` (corupt, nu-l
 *     tratăm ca `found` cu date în care nu putem avea încredere). Gate-ul de „usable" (status active) e în consent.
 *   - `data` prezent + valid → `found`.
 */

import type { AccountEntitlement, EntitlementStatus } from "../oauth/entitlement";

export type AccountEntitlementLookup =
  | { status: "found";       entitlement: AccountEntitlement }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isInt(v: unknown): v is number { return typeof v === "number" && Number.isInteger(v); }
function isStatus(v: unknown): v is EntitlementStatus { return v === "active" || v === "suspended" || v === "revoked"; }
/** scopes utilizabile: array ne-gol de string-uri ne-goale după trim (aliniat cu constraint-ul SQL arr_clean). */
function isCleanScopes(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(s => typeof s === "string" && s.trim() !== "");
}

/** Guard de formă pt. un rând account_entitlements (fail-closed: rând corupt → NU `found`). */
export function isAccountEntitlementRow(raw: unknown): raw is AccountEntitlement {
  if (typeof raw !== "object" || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return isNonEmptyString(o.user_id)
    && isNonEmptyString(o.plan)
    && isCleanScopes(o.scopes)
    && isInt(o.rate_limit_per_minute) && o.rate_limit_per_minute >= -1
    && isInt(o.rate_limit_per_day)    && o.rate_limit_per_day    >= -1
    && isStatus(o.status)
    && isInt(o.entitlement_version)   && o.entitlement_version   >= 1;
}

export function classifyEntitlementLookup(
  data:  unknown,
  error: { message?: string } | null | undefined,
): AccountEntitlementLookup {
  if (error)  return { status: "unavailable", reason: error.message ?? "supabase_error" };
  // `.maybeSingle()` dă `null` pe 0 rânduri; `undefined` = răspuns/adaptor neașteptat → fail-closed `unavailable`.
  if (data === undefined) return { status: "unavailable", reason: "răspuns neașteptat (data undefined)" };
  if (data === null) return { status: "not_found" };
  if (!isAccountEntitlementRow(data)) return { status: "unavailable", reason: "account_entitlements row malformat" };
  return { status: "found", entitlement: data };
}
