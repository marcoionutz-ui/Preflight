/**
 * lib/oauth/registrationGate.ts — PH-2 pas 6 (poarta PURĂ de registration pentru fluxul de consent, sursă UNICĂ).
 *
 * Extras din `decideConsentGrant` (10.3a) ca ȘI `buildConsentView` (5c-i) să aplice EXACT aceleași porți de registration.
 * Altfel ecranul de consent ar putea promite un client pe care POST-ul îl respinge — sau, mai rău, un registration al
 * ALTUI client ar furniza un `client_name` înșelător deși `client_id` + codul aparțin clientului din tranzacție.
 *
 * Verifică (identic cu POST): registration OBLIGATORIE, `registration_id` + `client_id` = cele sigilate în tranzacție,
 * status `active`, `expires_at` null SAU strict `> nowMs` (un shell DCR expirat nu autorizează), `authorization_code`
 * în `grant_types`. `nowMs` INJECTAT (pur). Acceptă orice formă cu aceste câmpuri (RegistrationRef sau superset-ul
 * `AuthorizeRegistration` cu metadate UI) — structural, fără cuplare la un singur tip.
 */

/** Câmpurile de registration relevante pentru poartă (RegistrationRef și AuthorizeRegistration le satisfac structural). */
export interface RegistrationGateFields {
  registration_id: string;
  client_id:       string;
  status:          string;         // "active" | "revoked" | "suspended"
  grant_types:     string[];       // trebuie să includă "authorization_code"
  expires_at:      number | null;  // ms; null = nu expiră
}

/** Legătura sigilată în tranzacție cu care se confruntă registration-ul. */
export interface RegistrationTxnBinding {
  registration_id: string;
  client_id:       string;
}

export type RegistrationGateResult = { ok: true } | { ok: false; reason: string };

/**
 * Poarta de registration, fail-closed. `null` → respins (registration OBLIGATORIE). Ordine identică cu cea inline din
 * `decideConsentGrant` (mesaje păstrate pentru paritate). Return `{ok:true}` DOAR când registration e non-null ȘI trece
 * toate porțile — deci un caller poate trata registration ca validă după `ok`.
 */
export function checkRegistrationBinding(
  registration: RegistrationGateFields | null,
  txn:          RegistrationTxnBinding,
  nowMs:        number,
): RegistrationGateResult {
  if (!registration) return { ok: false, reason: "clientul nu are registration (oauth_client_registrations)" };
  if (registration.registration_id !== txn.registration_id) {
    return { ok: false, reason: "registration ≠ cea sigilată în tranzacție (registration_id mismatch)" };
  }
  if (registration.client_id !== txn.client_id) {
    return { ok: false, reason: "registration nu aparține clientului tranzacției (client_id mismatch)" };
  }
  if (registration.status !== "active") {
    return { ok: false, reason: `registration status ≠ active (${registration.status})` };
  }
  // Expirare: acceptăm doar `expires_at` null SAU strict în viitor față de `nowMs`.
  if (registration.expires_at !== null && !(registration.expires_at > nowMs)) {
    return { ok: false, reason: "registration expirată" };
  }
  if (!registration.grant_types.includes("authorization_code")) {
    return { ok: false, reason: "registration nu permite authorization_code" };
  }
  return { ok: true };
}
