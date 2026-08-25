/**
 * lib/db/ph2Reads.ts — PH-2 step 10.3b-ii (citiri I/O Supabase pentru fluxul de consimțământ user).
 *
 * WIRING thin (ca `lookupClientById`): `supabaseAdmin` + `.maybeSingle()` (0 rânduri → `data:null, error:null`,
 * distinct de eroare reală) → clasificatorii PURI (`entitlementLookup`/`registrationLookup`) fac discriminarea
 * `found | not_found | unavailable`. Un throw neașteptat (rețea) → `unavailable` (fail-closed, NU „not_found").
 *
 * `select` EXPLICIT pe coloane: garantează că `expires_at` (și restul) sunt CERUTE — dacă lipsesc din rând, clasificatorul
 * le respinge fail-closed. NU folosim `select('*')` ca să nu depindem de forma completă a rândului.
 */

import { supabaseAdmin } from "./supabase-admin";
import { classifyEntitlementLookup, type AccountEntitlementLookup } from "./entitlementLookup";
import { classifyRegistrationLookup, type RegistrationLookup } from "./registrationLookup";

/** Entitlement-ul de cont al unui user (account_entitlements). `not_found` = user fără entitlement; `unavailable` = Supabase jos. */
export async function getAccountEntitlement(userId: string): Promise<AccountEntitlementLookup> {
  try {
    const { data, error } = await supabaseAdmin
      .from("account_entitlements")
      .select("user_id, plan, scopes, rate_limit_per_minute, rate_limit_per_day, status, entitlement_version")
      .eq("user_id", userId)
      .maybeSingle();
    return classifyEntitlementLookup(data, error);
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : "supabase_throw" };
  }
}

/** Registration-ul unui client (oauth_client_registrations), pe `client_id` (unique). `expires_at` cerut EXPLICIT. */
export async function getRegistrationByClientId(clientId: string): Promise<RegistrationLookup> {
  try {
    const { data, error } = await supabaseAdmin
      .from("oauth_client_registrations")
      .select("registration_id, client_id, status, grant_types, expires_at")
      .eq("client_id", clientId)
      .maybeSingle();
    return classifyRegistrationLookup(data, error);
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : "supabase_throw" };
  }
}
