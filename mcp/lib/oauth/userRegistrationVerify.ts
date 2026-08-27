/**
 * lib/oauth/userRegistrationVerify.ts — PH-2 step 10.5 (verificarea REGISTRATION-ului DCR pentru tokenuri USER, PUR).
 *
 * Frunză pură (zero I/O) — corectează un blocker arhitectural (cgpt): clienții DCR PUBLICI (Claude.ai connector, care
 * emit tokenuri USER prin auth-code) trăiesc în `oauth_client_registrations`, NU în `oauth_clients`. Validarea unui
 * token/refresh USER pe `lookupClientById` (oauth_clients) ar da `not_found` → 401 pentru un client DCR legitim, iar
 * `touchClient` ar scrie tabelul greșit. Deci calea USER verifică REGISTRATION-ul, cu ACEEAȘI semantică pe care o
 * aplică deja `decideConsentGrant` la emiterea grantului (single-source de reguli): status `active`, ne-expirat,
 * `client_id` identic, grant type cerut permis.
 *
 * DOCTRINĂ (verificatorul confirmă identitatea EXPLICIT): NU ne bazăm pe filtrul de query (`.eq("client_id", …)`) — un
 * adaptor defect care întoarce ALT rând ar valida un client greșit. Confirmăm `reg.client_id === clientId` local.
 *
 * NU ia plan / scopes / quota din registration (un shell DCR n-are entitlement de client): astea vin din CONT
 * (`account_entitlements`) prin `verifyUserAccount`. Aici doar poarta „clientul (public) e o înregistrare validă și
 * activă, care mai permite acest grant type".
 *
 * Fail-closed: lookup `unavailable` → `unavailable` (503, retry în apelant); `not_found` / orice check picat → `reject`
 * (401 la resolveAuth / invalid_grant la /token). NU distingem motivele către client (doar reason intern pt. log).
 */

import type { RegistrationLookup } from "../db/registrationLookup";
import type { RegistrationRef } from "./authorizeConsent";

export type UserRegistrationDecision =
  | { ok: true;  registration: RegistrationRef }
  | { ok: false; kind: "unavailable"; reason: string }  // Supabase jos → 503 (retry)
  | { ok: false; kind: "reject";      reason: string }; // registration inexistentă/inactivă/expirată/grant nepermis → 401

/**
 * @param lookup            rezultatul citirii `getRegistrationByClientId` (discriminat found/not_found/unavailable).
 * @param clientId          `client_id` din tokenul/refresh-ul USER (identitatea de confirmat EXPLICIT).
 * @param nowMs             timpul curent în ms (injectat — pur; expirarea se compară strict `> nowMs`).
 * @param requiredGrantType grant type-ul cerut de calea apelantă (`authorization_code` la access, `refresh_token` la rotație).
 */
export function verifyUserRegistration(
  lookup: RegistrationLookup,
  p: { clientId: string; nowMs: number; requiredGrantType: string },
): UserRegistrationDecision {
  if (lookup.status === "unavailable") {
    return { ok: false, kind: "unavailable", reason: "registration lookup unavailable: " + lookup.reason };
  }
  if (lookup.status === "not_found") {
    return { ok: false, kind: "reject", reason: "registration not found (client not registered or removed)" };
  }
  const reg = lookup.registration;

  // Identitate EXPLICITĂ (nu te baza pe filtrul lookup-ului).
  if (reg.client_id !== p.clientId) {
    return { ok: false, kind: "reject", reason: "registration client_id mismatch (wrong row returned)" };
  }
  if (reg.status !== "active") {
    return { ok: false, kind: "reject", reason: `registration status ≠ active (${reg.status})` };
  }
  // Expirare: acceptăm DOAR `expires_at` null (nu expiră) SAU strict în viitor față de `nowMs` (shell DCR expirat = mort).
  if (reg.expires_at !== null && !(reg.expires_at > p.nowMs)) {
    return { ok: false, kind: "reject", reason: "registration expired" };
  }
  if (!reg.grant_types.includes(p.requiredGrantType)) {
    return { ok: false, kind: "reject", reason: `registration does not allow grant type ${p.requiredGrantType}` };
  }

  return { ok: true, registration: reg };
}
