/**
 * lib/oauth/authorizeConsent.ts — PH-2 step 10.3a (decizia de GRANT post-consimțământ la /authorize, PURĂ).
 *
 * Frunză pură (zero I/O; tranzacția + lookup-urile INJECTATE ca date) → tsx-testabilă. Aceasta e decizia de FAZA 2
 * (consent POST), NU faza 1 (login gate — ruta redirectează la login când nu-i sesiune). Un grant se produce DOAR
 * după o aprobare VERIFICATĂ, iar `client_id`/`resource`/`requested_scopes`/`user_id` se derivă EXCLUSIV din
 * `AuthzTransaction`-ul validat server-side — NICIODATĂ din parametri reluați din query/form după login (cgpt).
 *
 * Invariante fail-closed (cgpt):
 *   1. Consent VERIFICAT: `verifyConsentSubmission(...).decision === "approve"` — altfel `denied`/`reject`, grant
 *      IMPOSIBIL (nu poate fi ocolit apelând helper-ul direct pentru un user logat).
 *   2. Registration LEGAT de client: `registration.client_id === txn.client_id` (altfel s-ar construi grant cu
 *      registration de la alt client), status `active`, ȘI `authorization_code` în `grant_types`.
 *   3. Cont AL userului tranzacției: `account.user_id === txn.session_user_id`.
 *   4. Scope/user_id/entitlement_version derivate din tranzacție + cont via `buildAuthGrantAndCodeClaims` (10.2).
 */

import { buildAuthGrantAndCodeClaims, type UserAuthCodeClaims } from "./authGrantIssuance";
import { verifyConsentSubmission, type AuthzTransaction } from "./authzTransaction";
import type { OAuthGrant } from "./grant";
import type { AccountEntitlement } from "./entitlement";

/** Referință la registration-ul clientului (din `oauth_client_registrations`), pt. cross-check cu tranzacția. */
export interface RegistrationRef {
  registration_id: string;
  client_id:       string;
  status:          string;         // "active" | "revoked" | "suspended"
  grant_types:     string[];       // trebuie să includă "authorization_code"
  expires_at:      number | null;  // ms; null = nu expiră. Un shell DCR expirat NU e acceptabil chiar dacă e "active".
}

export type ConsentGrantOutcome =
  | { kind: "denied" }                                            // user a dat Deny (verificat) → access_denied
  | { kind: "reject"; reason: string }                            // consent invalid (csrf/expirat/session mismatch)
  | { kind: "error";  reason: string }                            // invariantă post-consent picată (registration/cont)
  | { kind: "grant";  grant: OAuthGrant; claims: UserAuthCodeClaims };

/**
 * Decide GRANT-ul de emis DUPĂ un consent POST. `txn` = tranzacția din store (null dacă lipsă/consumată). Ordine:
 * verifică consent → gate registration → gate cont → construiește grant (scope resolution + claims consistente).
 * `grant_id` provine STICKY din `txn.grant_id` (NU param liber — cgpt: altfel ruta ar putea injecta un UUID nou și
 * read-back-ul idempotent din `insertGrant` n-ar prinde retry-urile). `nowMs` (expiry consent)/`nowIso` (created_at
 * grant) injectate (pur).
 */
export function decideConsentGrant(p: {
  txn:                  AuthzTransaction | null;
  presented:            { txn_id: string; csrf_token: string; action: string };
  currentSessionUserId: string | null;
  registration:         RegistrationRef | null;
  account:              AccountEntitlement | null;
  serverPolicy:         readonly string[];
  nowMs:                number;
  nowIso:               string;
}): ConsentGrantOutcome {
  // 1. Consent VERIFICAT (leaf PH-2a). Doar `approve` deblochează grantul.
  const consent = verifyConsentSubmission(p.txn, p.presented, p.nowMs, p.currentSessionUserId);
  if (consent.decision === "deny")    return { kind: "denied" };
  if (consent.decision !== "approve") return { kind: "reject", reason: consent.reason ?? "consent respins" };

  // După `approve`, `txn` e garantat non-null (verifyConsentSubmission dă reject pe null). Guard defensiv.
  const txn = p.txn;
  if (!txn) return { kind: "reject", reason: "tranzacție lipsă" };

  // 2. Registration: EXACT cea sigilată în tranzacție (nu doar același client), legată de client, activă, ne-expirată,
  //    cu authorization_code permis.
  if (!p.registration) return { kind: "error", reason: "clientul nu are registration (oauth_client_registrations)" };
  if (p.registration.registration_id !== txn.registration_id) {
    return { kind: "error", reason: "registration ≠ cea sigilată în tranzacție (registration_id mismatch)" };
  }
  if (p.registration.client_id !== txn.client_id) {
    return { kind: "error", reason: "registration nu aparține clientului tranzacției (client_id mismatch)" };
  }
  if (p.registration.status !== "active") {
    return { kind: "error", reason: `registration status ≠ active (${p.registration.status})` };
  }
  // Expirare: acceptăm doar `expires_at` null SAU strict în viitor față de `nowMs` (un shell DCR expirat nu autorizează).
  if (p.registration.expires_at !== null && !(p.registration.expires_at > p.nowMs)) {
    return { kind: "error", reason: "registration expirată" };
  }
  if (!p.registration.grant_types.includes("authorization_code")) {
    return { kind: "error", reason: "registration nu permite authorization_code" };
  }

  // 3. Cont AL userului legat în tranzacție.
  if (!p.account) return { kind: "error", reason: "contul nu are entitlement (account_entitlements)" };
  if (p.account.user_id !== txn.session_user_id) {
    return { kind: "error", reason: "entitlement pentru alt user decât tranzacția (mismatch)" };
  }

  // 4. Grant + claims — TOT derivat din tranzacție + cont (nu din parametri liberi). Scope resolution în helper.
  const built = buildAuthGrantAndCodeClaims({
    grant_id:        txn.grant_id,           // STICKY din tranzacție (nu param liber)
    registration_id: p.registration.registration_id,
    client_id:       txn.client_id,          // din tranzacție
    resource:        txn.resource,           // din tranzacție
    requestedScopes: txn.requested_scopes,   // din tranzacție
    serverPolicy:    p.serverPolicy,
    account:         p.account,
    nowIso:          p.nowIso,
  });
  if (!built.ok) return { kind: "error", reason: built.error };
  return { kind: "grant", grant: built.grant, claims: built.claims };
}
