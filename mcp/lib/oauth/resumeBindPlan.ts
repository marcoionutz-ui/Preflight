/**
 * lib/oauth/resumeBindPlan.ts — PH-2 pas 6 frunză 4b (state machine PUR pt. `/auth/resume`: entry + ladder read/bind).
 *
 * Fluxul login→consent (după handoff-ul din callback): callback-ul a schimbat codul Supabase EXACT o dată și a
 * redirectat (303) la `/auth/resume`. AICI (cerere nouă, sesiune deja stabilită) legăm tranzacția de consent de user.
 * `/auth/resume` NU atinge codul Supabase → un refresh de pagină e retry SIGUR pe outage.
 *
 * Piese PURE (zero I/O; ruta 4c le orchestrează):
 *   1. `planResumeEntry(session)` — cookie DEJA confirmat prezent de rută (fără cookie → dashboard direct, FĂRĂ citire
 *      de sesiune, corecția 1). Anonymous → `/login` (cookie PĂSTRAT: e puntea login↔txn); unavailable → 503 (păstrat);
 *      authenticated → intră în ladder.
 *   2. `classifyReadStep(read, nowMs)` — clasifică un READ (atac 1 SAU re-read) + APLICĂ expirarea pe `found` ÎNAINTE de
 *      orice bind (corecția 2: Redis poate încă avea cheia, dar un blob expirat NU se leagă). DOAR `found`+ne-expirat →
 *      `bind` (=> ruta face I/O de bind). Tipul face IMPOSIBIL de reprezentat un bind pe read absent/unavailable/corupt.
 *   3. `classifyBindStep(bind, allowRetry)` — rezultatul `bindAuthzTxnUser`. `conflict` cu retry permis (atac 1) →
 *      `reread`; fără (atac 2) → `retryable` (fără al treilea retry). Pe `updated`, `resume_ok.txnId` = `bind.txn.txn_id`
 *      (blob-ul CHIAR legat), NU un id extern al apelantului (cgpt P2).
 *   4. `classifyRebind(checked, userId)` — ia DOAR un `CheckedReadStep` (ieșirea `bind` a lui `classifyReadStep`, deci
 *      OBLIGATORIU trecută prin expirare — cgpt P1). DUPĂ re-read pe atacul 2: inspectează legarea CURENTĂ. Același user
 *      a câștigat CAS-ul (tab concurent) → `resume_ok` FĂRĂ alt I/O; alt user → `invalid` (account-switch); încă nelegat
 *      → `bind` (un ultim `bindAuthzTxnUser`).
 *
 * Cookie: se ȘTERGE DOAR pe terminale „consumate" (`resume_ok` / `invalid`); PĂSTRAT pe `retryable` / `login`
 * (`resumeClearsCookie`). Regula lui Marco: succes, dead/corrupt/expired și account-switch → clear; unavailable și
 * conflict-retryable → keep (refresh-ul re-atinge `/auth/resume` în siguranță).
 */

import { isTransactionExpired, type AuthzTransaction } from "./authzTransaction";
import type { SessionState } from "./authorizeGetDecision";
import type { AuthzTxnReadResult, BindAuthzTxnResult } from "../db/authzTxnStoreIo";

// ── terminale + politica de cookie ──────────────────────────────────────────────
/** Felul unui rezultat TERMINAL al fluxului de resume (mapat de rută la efect: cookie + răspuns HTTP). */
export type TerminalKind = "resume_ok" | "invalid" | "retryable" | "login";

/**
 * Cookie-ul de resume se ȘTERGE DOAR pe terminale „consumate": `resume_ok` (txn legată → consent) sau `invalid`
 * (dead/corrupt/expired/account-switch — reluarea acelui txn e imposibilă). PĂSTRAT pe `retryable` (outage → refresh
 * sigur) și `login` (cookie-ul e puntea login↔txn; ștergerea ar rupe reluarea după re-autentificare).
 */
export function resumeClearsCookie(kind: TerminalKind): boolean {
  return kind === "resume_ok" || kind === "invalid";
}

// ── 1) entry (cookie deja prezent) ──────────────────────────────────────────────
export type ResumeEntry =
  | { kind: "proceed"; userId: string }    // authenticated → ladder
  | { kind: "login"; reason: string }      // anonymous → /login (cookie PĂSTRAT)
  | { kind: "retryable"; reason: string }; // session unavailable → 503 (cookie PĂSTRAT)

/**
 * Decizia de intrare, DUPĂ ce ruta a confirmat cookie prezent. Ia DOAR sesiunea (fără cookie → dashboard direct în
 * rută, fără această funcție și fără `getSessionState`, corecția 1).
 */
export function planResumeEntry(session: SessionState): ResumeEntry {
  switch (session.kind) {
    case "authenticated": return { kind: "proceed", userId: session.userId };
    case "anonymous":     return { kind: "login", reason: "not authenticated" };
    case "unavailable":   return { kind: "retryable", reason: "session unavailable" };
    default: { const _exhaustive: never = session; return { kind: "retryable", reason: String(_exhaustive) }; }
  }
}

// ── 2) read step (expirare aplicată ÎNAINTE de bind) ────────────────────────────
export type ReadStep =
  | { kind: "bind"; txn: AuthzTransaction; raw: string } // found + ne-expirat → ruta face bindAuthzTxnUser
  | { kind: "invalid"; reason: string }                  // absent / corrupt / found-dar-expirat
  | { kind: "retryable"; reason: string };               // unavailable

/**
 * Un read `found` care A TRECUT deja prin `classifyReadStep` (deci ne-expirat, corecția 2). E singurul input acceptat de
 * `classifyRebind` → face IMPOSIBIL structural ca un txn re-citit să sară peste verificarea de expirare (fix cgpt P1).
 */
export type CheckedReadStep = Extract<ReadStep, { kind: "bind" }>;

/**
 * Clasifică un READ (atac 1 sau re-read). `nowMs` = timestamp-ul cererii; `isTransactionExpired` e fail-closed pe
 * `now`/`expires_at` ne-finite. Un `found` expirat → `invalid` (NU `bind`): nu legăm un blob mort chiar dacă cheia
 * Redis mai trăiește. Doar `found`+ne-expirat produce `bind` — deci un read absent/unavailable/corupt NU poate ajunge
 * niciodată la un pas de bind (stare imposibilă, garantată de tip).
 */
export function classifyReadStep(read: AuthzTxnReadResult, nowMs: number): ReadStep {
  switch (read.status) {
    case "unavailable": return { kind: "retryable", reason: "txn store unavailable" };
    case "absent":      return { kind: "invalid", reason: "transaction absent" };
    case "corrupt":     return { kind: "invalid", reason: "transaction corrupt" };
    case "found":
      if (isTransactionExpired(read.txn, nowMs)) return { kind: "invalid", reason: "transaction expired" };
      return { kind: "bind", txn: read.txn, raw: read.raw };
    default: { const _exhaustive: never = read; return { kind: "invalid", reason: String(_exhaustive) }; }
  }
}

// ── 3) bind step (conflict → reread doar cu retry permis) ───────────────────────
export type BindStep =
  | { kind: "resume_ok"; txnId: string }
  | { kind: "invalid"; reason: string }    // reject (account-switch) / absent / expired
  | { kind: "retryable"; reason: string }  // unavailable; SAU conflict fără retry (atac 2)
  | { kind: "reread" };                    // conflict cu retry permis (atac 1) → re-read + retry O DATĂ

/**
 * Clasifică rezultatul `bindAuthzTxnUser`. `allowRetry` = true DOAR pe primul atac: `conflict` → `reread` (ruta
 * re-citește + reîncearcă o singură dată). Pe al doilea atac (`allowRetry=false`) `conflict` → `retryable` (fără al
 * treilea retry → 503, cookie păstrat; refresh-ul reia). `txnId` pe `resume_ok` e derivat din `bind.txn.txn_id` (blob-ul
 * CHIAR legat), NU dintr-un parametru extern (fix cgpt P2: un id greșit al apelantului ar redirecta la alt txn).
 */
export function classifyBindStep(bind: BindAuthzTxnResult, allowRetry: boolean): BindStep {
  switch (bind.status) {
    case "updated":     return { kind: "resume_ok", txnId: bind.txn.txn_id };
    case "reject":      return { kind: "invalid", reason: "account switch: transaction bound to a different user" };
    case "absent":      return { kind: "invalid", reason: "transaction absent at bind" };
    case "expired":     return { kind: "invalid", reason: "transaction expired at bind" };
    case "unavailable": return { kind: "retryable", reason: "txn store unavailable at bind" };
    case "conflict":    return allowRetry ? { kind: "reread" } : { kind: "retryable", reason: "bind conflict after retry" };
    default: { const _exhaustive: never = bind; return { kind: "retryable", reason: String(_exhaustive) }; }
  }
}

// ── 4) rebind: inspectează legarea după re-read (atac 2) ─────────────────────────
export type RebindStep =
  | { kind: "resume_ok"; txnId: string }                 // deja legat de userId (același user a câștigat CAS)
  | { kind: "invalid"; reason: string }                  // legat de ALT user (account-switch)
  | { kind: "bind"; txn: AuthzTransaction; raw: string }; // încă nelegat → ruta face un ULTIM bindAuthzTxnUser

/**
 * DUPĂ re-read pe atacul 2: ia DOAR un `CheckedReadStep` (ieșirea `bind` a lui `classifyReadStep`) → re-read-ul a trecut
 * OBLIGATORIU prin verificarea de expirare (fix cgpt P1: imposibil de sărit expirarea la re-read). Inspectează
 * `session_user_id` CURENT vs `userId`. Un tab concurent al ACELUIAȘI user a câștigat CAS-ul între read și re-read →
 * `resume_ok` FĂRĂ alt I/O de bind (idempotent). Legat de alt user (non-null ≠ userId) → `invalid` (account-switch,
 * terminal). Încă nelegat (`null`) → `bind` (ruta face un ultim `bindAuthzTxnUser`; al doilea conflict de-acolo → retryable).
 */
export function classifyRebind(checked: CheckedReadStep, userId: string): RebindStep {
  const bound = checked.txn.session_user_id;
  if (bound === userId) return { kind: "resume_ok", txnId: checked.txn.txn_id };
  if (bound === null)   return { kind: "bind", txn: checked.txn, raw: checked.raw };
  return { kind: "invalid", reason: "account switch: transaction bound to a different user" };
}
