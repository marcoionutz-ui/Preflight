/**
 * lib/oauth/consentIssuancePlan.ts — PH-2 pas 6 frunză 5a-planner (creierul PUR al POST-ului /consent, în ETAPE).
 *
 * Zero I/O. Ruta face I/O-ul; ACEST modul decide, pas cu pas, ce urmează sau ce terminal se randează — fiecare decider
 * consumă UN outcome deja clasificat (stări imposibile nereprezentabile). Secvența sigilată (frunză 5, Q1):
 *
 *   decideConsentGrant ─┬─ grant  → planPayloadBuild → planAfterInsert → planAfterConsume → redirect(code)
 *                       ├─ denied → planAfterDenyConsume(simple consume) → redirect(access_denied)
 *                       ├─ reject → local_error (FĂRĂ consume — integritatea cererii a picat: CSRF/expirat/session)
 *                       └─ error  → local_error (invariantă post-consent picată)
 *
 * CONTRACTUL DISTRIBUIT (P1, moștenit din 5a-atomic): `unavailable` de la emitere NU garantează că txn e intactă
 * (reply-ul se poate pierde după ce Lua a rulat pe server = AT-MOST-ONCE). Deci pe `unavailable` planner-ul dă 503
 * retryable și NU presupune nimic: la retry ruta reciteste txn → `gone` ⇒ local_error (repornește din client) /
 * `found` ⇒ re-emite. `unavailable` de la INSERT e diferit: consume-ul vine DUPĂ insert, deci txn e sigur NEatinsă
 * acolo → 503 retryable curat.
 */
import type { ConsentGrantOutcome } from "./authorizeConsent";
import type { OAuthGrant } from "./grant";
import type { InsertGrantResult } from "../db/grantInsert";
import type { AuthCodePayload } from "../db/oauthAtomic";
// Tipurile I/O REALE prin `import type` — eliminate la runtime de tsx (NU încarcă redis), dar verificate în AMBELE
// sensuri la typecheck (fără mirror, fără drift într-un singur sens).
import type { ConsumeIssueOutcome } from "../db/oauth-codes";
import type { ConsumeAuthzTxnResult, ClaimActionOutcome } from "../db/authzTxnStoreIo";

/** Contextul de redirect, derivat DOAR din txn (trusted) + origin (iss RFC 9207). Niciodată din query brut. */
export interface ConsentRedirect {
  redirectUri: string;
  state?:      string;
  iss:         string;
}

/** Terminale pe care le randează ruta. `local_error` = pagină locală (fără redirect); `unavailable` = 503 retryable. */
export type ConsentIssuanceOutcome =
  | { kind: "redirect_code";   redirectUri: string; code: string; state?: string; iss: string }
  | { kind: "redirect_denied"; redirectUri: string;               state?: string; iss: string } // ?error=access_denied
  | { kind: "local_error";     error: string; reason: string }
  | { kind: "unavailable";     reason: string };

// ── Etapa 0 (issue ȘI deny): arbitrare atomică ÎNAINTE de orice efect secundar (cursa cross-action) ──
export type ClaimStep =
  | { kind: "proceed" }                                    // won/idempotent → produc efecte (insert/consume)
  | { kind: "terminal"; outcome: ConsentIssuanceOutcome }; // lost/unavailable → nu ating nimic

export function planActionClaim(outcome: ClaimActionOutcome): ClaimStep {
  switch (outcome.status) {
    case "won":
    case "idempotent": return { kind: "proceed" };          // câștigător (sau retry propriu) → efecte sigure
    // PIERDUT: altă acțiune (deny câștigat de un approve concurent sau invers) a produs deja rezultatul → NU emitem,
    // NU consumăm, NU redirectăm (doar câștigătorul conduce clientul). Pagină locală: cererea a fost înlocuită.
    case "lost":        return { kind: "terminal", outcome: { kind: "local_error", error: "access_denied", reason: `acțiune concurentă a câștigat: ${outcome.winner}` } };
    case "unavailable": return { kind: "terminal", outcome: { kind: "unavailable", reason: "arbitrarea acțiunii indisponibilă" } };
  }
}

// ── Etapa 1: după verify+decide ─────────────────────────────────────────────────────────────────────
export type ConsentActionStep =
  | { kind: "issue"; grant: OAuthGrant }                              // approve valid → build+insert+consume
  | { kind: "deny" }                                                  // deny verificat → simple consume + access_denied
  | { kind: "terminal"; outcome: ConsentIssuanceOutcome };            // reject/error → local_error (FĂRĂ consume)

export function planConsentAction(decision: ConsentGrantOutcome): ConsentActionStep {
  switch (decision.kind) {
    case "grant":  return { kind: "issue", grant: decision.grant };
    case "denied": return { kind: "deny" };
    // reject = integritatea cererii a picat (CSRF/expirat/account-switch) → pagină locală, NU redirect (cerere posibil forjată).
    case "reject": return { kind: "terminal", outcome: { kind: "local_error", error: "access_denied", reason: decision.reason } };
    // error = invariantă post-consent picată (registration/cont) → local (conservator; nu emitem, nu redirectăm cu cod).
    case "error":  return { kind: "terminal", outcome: { kind: "local_error", error: "server_error",  reason: decision.reason } };
  }
}

// ── Etapa 2a (issue): după buildUserAuthCodePayload (pur, ÎNAINTE de orice I/O) ──────────────────────
export type PayloadBuildStep =
  | { kind: "insert"; payload: AuthCodePayload }
  | { kind: "terminal"; outcome: ConsentIssuanceOutcome };

export function planPayloadBuild(build: { ok: true; payload: AuthCodePayload } | { ok: false; error: string }): PayloadBuildStep {
  // Duce payload-ul VALIDAT mai departe (ruta nu-l mai ține separat → „stări imposibile nereprezentabile" ține complet).
  if (build.ok) return { kind: "insert", payload: build.payload };
  // Mix-up txn↔grant sau blob invalid: nimic scris încă → local_error, txn intactă.
  return { kind: "terminal", outcome: { kind: "local_error", error: "server_error", reason: build.error } };
}

// ── Etapa 2b (issue): după insertGrant (idempotent) ─────────────────────────────────────────────────
export type AfterInsertStep =
  | { kind: "consume" }
  | { kind: "terminal"; outcome: ConsentIssuanceOutcome };

export function planAfterInsert(insert: InsertGrantResult): AfterInsertStep {
  switch (insert.status) {
    case "inserted":
    case "already_present": return { kind: "consume" };                                    // grant persistat + ACTIV → emite
    case "revoked":  return { kind: "terminal", outcome: { kind: "local_error", error: "access_denied", reason: insert.reason } };
    case "conflict": return { kind: "terminal", outcome: { kind: "local_error", error: "server_error",  reason: insert.reason } };
    // consume-ul vine DUPĂ → txn sigur NEatinsă aici → 503 retryable curat (spre deosebire de unavailable-ul de la emitere).
    case "unavailable": return { kind: "terminal", outcome: { kind: "unavailable", reason: insert.reason } };
  }
}

// ── Etapa 2c (issue): după consumeAuthzTxnAndIssueCode (ATOMIC) ──────────────────────────────────────
export function planAfterConsume(outcome: ConsumeIssueOutcome, redirect: ConsentRedirect): ConsentIssuanceOutcome {
  switch (outcome.status) {
    case "issued":
      return { kind: "redirect_code", redirectUri: redirect.redirectUri, code: outcome.code, state: redirect.state, iss: redirect.iss };
    case "gone":
      // txn a dispărut înainte de emitere (consumată de concurent / expirată) → nimic de emis; repornește din client.
      return { kind: "local_error", error: "invalid_grant", reason: "tranzacția a dispărut înainte de emitere — repornește autorizarea" };
    case "unavailable":
      // STARE INCERTĂ (P1/AT-MOST-ONCE): codul POATE fi fost emis (reply pierdut) SAU txn intactă. NU presupune nimic → 503.
      return { kind: "unavailable", reason: "emitere cod indisponibilă (stare incertă: txn poate fi consumată) — retry" };
  }
}

// ── Etapa 3 (deny): după simple consume al txn ──────────────────────────────────────────────────────
export function planAfterDenyConsume(outcome: ConsumeAuthzTxnResult, redirect: ConsentRedirect): ConsentIssuanceOutcome {
  switch (outcome) {
    case "consumed":
      return { kind: "redirect_denied", redirectUri: redirect.redirectUri, state: redirect.state, iss: redirect.iss };
    case "gone":
      // txn consumată de concurent (posibil un approve în alt tab a emis cod) → fail-closed: local, NU access_denied contradictoriu.
      return { kind: "local_error", error: "invalid_grant", reason: "tranzacția a dispărut la deny (consumată de concurent) — repornește" };
    case "unavailable":
      return { kind: "unavailable", reason: "invalidarea tranzacției (deny) indisponibilă — retry" };
  }
}
