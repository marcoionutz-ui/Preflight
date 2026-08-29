/**
 * lib/oauth/authorizeGetDecision.ts — PH-2 pas 6 frunză 1 (decizia PURĂ a GET `/authorize`).
 *
 * Frunză pură (zero I/O; lookup registration + sesiune + citire txn INJECTATE ca stări discriminate) → tsx-testabilă.
 * Orchestrează modul GET `/authorize`, distingând EXPLICIT (cgpt):
 *   - **initial**: cererea vine cu parametrii OAuth. Se validează query-ul intern (`validateAuthorizeRequest`, pasul 4)
 *     DUPĂ ce se elimină outage-urile (registration lookup / sesiune `unavailable` → 503, NU convertite în invalid_client
 *     / login). Pe succes → `create_and_consent` (sesiune) / `create_and_login` (anonim). UUID/CSRF = WIRING.
 *   - **resume**: cererea vine cu DOAR `txn_id`. Se citește EXCLUSIV tranzacția stocată — nimic reconstruit, nicio txn
 *     nouă. `render_consent` DOAR pentru txn găsită + NEexpirată + legată de EXACT userul sesiunii curente.
 *
 * DOUĂ STĂRI LOAD-BEARING (cgpt):
 *   1. `SessionState` discriminat — `authenticated | anonymous | unavailable`. Un outage Supabase NU devine „anonim →
 *      login" (ar transforma un 503 într-un redirect greșit); `unavailable` → 503 retryable, separat.
 *   2. `error_redirect` transportă `redirect_uri`+`state` deja trusted (din validator) → ruta NU le recitește din
 *      query-ul brut. `unavailable` (registration lookup / sesiune / citire txn jos) rămâne 503 SEPARAT.
 * Fără detalii de cookie/transport (frunza 2). NU aruncă.
 */

import { isTransactionExpired, type AuthzTransaction } from "./authzTransaction";
import { validateAuthorizeRequest, type AuthorizeParams, type ValidatedAuthorizeRequest } from "./authorizeRequestValidate";
import type { AuthorizeRegistrationLookup } from "../db/authorizeRegistrationLookup";
import type { AuthzTxnReadResult } from "../db/authzTxnStoreIo";

/** Starea sesiunii Supabase — `unavailable` (outage) ≠ `anonymous` (fără sesiune). */
export type SessionState =
  | { kind: "authenticated"; userId: string }
  | { kind: "anonymous" }
  | { kind: "unavailable" };

export type AuthorizeGetDecision =
  | { kind: "create_and_consent"; request: ValidatedAuthorizeRequest; userId: string }
  | { kind: "create_and_login";   request: ValidatedAuthorizeRequest }
  | { kind: "render_consent";     txn: AuthzTransaction }
  | { kind: "error_local";        reason: string }
  // redirect trusted → error+state+iss. `redirect_uri`+`state` transportate din validator (nu recitite din query brut).
  | { kind: "error_redirect";     error: string; reason: string; redirect_uri: string; state: string }
  | { kind: "unavailable";        reason: string };

export type AuthorizeGetInput =
  | {
      mode:         "initial";
      params:       AuthorizeParams;
      registration: AuthorizeRegistrationLookup;   // found / not_found / unavailable
      session:      SessionState;
      issuer:       string;
      serverPolicy: readonly string[];
      nowMs:        number;
    }
  | {
      mode:    "resume";
      txnRead: AuthzTxnReadResult;
      session: SessionState;
      nowMs:   number;
    };

/** Decide outcome-ul GET `/authorize`. Vezi contractul din header. */
export function decideAuthorizeGetOutcome(p: AuthorizeGetInput): AuthorizeGetDecision {
  if (p.mode === "initial") {
    // Outage-uri ÎNAINTE de validare — NU le colapsăm în invalid_client / login (cgpt): un lookup registration jos ar
    // deveni fals „client necunoscut", iar o sesiune indisponibilă ar deveni fals „anonim → login".
    if (p.registration.status === "unavailable") return { kind: "unavailable", reason: "registration lookup indisponibil (Supabase jos)" };
    if (p.session.kind === "unavailable")        return { kind: "unavailable", reason: "citirea sesiunii indisponibilă (Supabase jos)" };

    const registration = p.registration.status === "found" ? p.registration.registration : null;
    const v = validateAuthorizeRequest({ params: p.params, registration, issuer: p.issuer, serverPolicy: p.serverPolicy, nowMs: p.nowMs });
    if (v.kind === "invalid_client") return { kind: "error_local", reason: v.reason };
    if (v.kind === "error_redirect") return { kind: "error_redirect", error: v.error, reason: v.reason, redirect_uri: v.redirect_uri, state: v.state };
    // v.kind === "ok"
    if (p.session.kind === "authenticated") return { kind: "create_and_consent", request: v.request, userId: p.session.userId };
    return { kind: "create_and_login", request: v.request }; // anonymous
  }

  // mode === "resume": citește DOAR txn-ul stocat. Redis jos → 503 înainte de a ne uita la sesiune.
  const r = p.txnRead;
  if (r.status === "unavailable") return { kind: "unavailable", reason: "citirea tranzacției indisponibilă (Redis jos)" };
  if (r.status === "absent")      return { kind: "error_local", reason: "tranzacție inexistentă / expirată / deja consumată" };
  if (r.status === "corrupt")     return { kind: "error_local", reason: "tranzacție coruptă" };

  // r.status === "found"
  const txn = r.txn;
  if (isTransactionExpired(txn, p.nowMs))                return { kind: "error_local", reason: "tranzacție expirată" };
  if (typeof txn.session_user_id !== "string" || txn.session_user_id.length === 0)
                                                        return { kind: "error_local", reason: "tranzacție nelegată la resume (bind-ul se face în callback)" };
  if (p.session.kind === "unavailable")                 return { kind: "unavailable", reason: "citirea sesiunii indisponibilă (Supabase jos)" };
  if (p.session.kind === "anonymous")                   return { kind: "error_local", reason: "fără sesiune la resume" };
  if (p.session.userId !== txn.session_user_id)         return { kind: "error_local", reason: "sesiunea curentă ≠ userul legat în tranzacție (logout/account-switch)" };

  return { kind: "render_consent", txn };
}
