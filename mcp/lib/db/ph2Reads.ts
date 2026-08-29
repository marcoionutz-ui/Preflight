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
import { classifyAuthorizeRegistrationLookup, type AuthorizeRegistrationLookup } from "./authorizeRegistrationLookup";
import { classifyGrantLookup, type GrantLookup } from "./grantLookup";

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

/**
 * PH-2 step 10.3b-iv: registration-ul EXTINS pentru `/authorize` GET (fluxul interactiv de consent). Față de
 * `getRegistrationByClientId` (care citește doar câmpurile de protocol), cere EXPLICIT ȘI `redirect_uris` (allowlist-ul
 * pe care `validateAuthorizeRequest` îl impune ÎNAINTE de a trusta redirectul) + metadatele de ecran de consent
 * (`client_name`/`client_type`/`token_endpoint_auth_method`). Clasificatorul pur (`authorizeRegistrationLookup`) impune
 * forma `AuthorizeRegistration` fail-closed → validatorul primește mereu un rând bine-tipat (nit cgpt). `select` explicit:
 * o coloană omisă e tratată drept corupt de mapper, NU „lipsă benignă".
 */
export async function getAuthorizeRegistration(clientId: string): Promise<AuthorizeRegistrationLookup> {
  try {
    const { data, error } = await supabaseAdmin
      .from("oauth_client_registrations")
      .select("registration_id, client_id, status, grant_types, expires_at, redirect_uris, client_name, client_type, token_endpoint_auth_method")
      .eq("client_id", clientId)
      .maybeSingle();
    return classifyAuthorizeRegistrationLookup(data, error);
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : "supabase_throw" };
  }
}

/**
 * PH-2 step 10.5 (rework cgpt DCR): `last_used_at` pt. un client DCR se scrie pe REGISTRATION (oauth_client_registrations),
 * NU pe `oauth_clients` (unde un shell DCR public nici nu există). Analog cu `touchClient`, fire-and-forget: query
 * builder-ul Supabase e doar PromiseLike (fără `.catch`), deci two-arg `.then(onFulfilled, onRejected)`. Eșecul e
 * doar logat — nu blochează auth-ul.
 */
export function touchRegistration(clientId: string): void {
  supabaseAdmin
    .from("oauth_client_registrations")
    .update({ last_used_at: new Date().toISOString() })
    .eq("client_id", clientId)
    .then(
      () => {},
      (err: unknown) => console.error("[OAUTH] touchRegistration failed:", err),
    );
}

/**
 * Grantul de consimțământ după `grant_id` (oauth_grants), pentru validarea unui token USER în `resolveAuth`
 * (PH-2 step 10.5a). `grant_id` din tokenul user TREBUIE rezolvat la un rând ca revocarea unui SINGUR consent
 * (status=revoked) să conteze — altfel `grant_id` e decorativ (cgpt). `not_found` = grant inexistent → 401;
 * `unavailable` = Supabase jos → 503 (NU 401 — grantul poate exista). `created_at` cerut EXPLICIT (altfel `found`
 * ar întoarce un `OAuthGrant` type-unsound); un `revoked` e rând valid → `found`, gate-ul `active` e în verify.
 */
export async function getGrantById(grantId: string): Promise<GrantLookup> {
  try {
    const { data, error } = await supabaseAdmin
      .from("oauth_grants")
      .select("grant_id, registration_id, client_id, user_id, resource, scopes, entitlement_version, status, created_at")
      .eq("grant_id", grantId)
      .maybeSingle();
    return classifyGrantLookup(data, error);
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : "supabase_throw" };
  }
}
