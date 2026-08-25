/**
 * lib/oauth/refreshPayloadModel.ts — PH-2 step 10.4a (payload-ul STOCAT de REFRESH pentru user, formă discriminată, PUR).
 *
 * Frunză pură (zero I/O, doar `import`/`import type`) → tsx-testabilă. Analog cu `tokenPayloadModel.ts`, dar pentru
 * REFRESH tokens. Fluxul auth-code al unui USER (Claude.ai connector) emite un access token USER + un refresh USER;
 * refresh-ul trebuie să poarte IDENTITATEA (`user_id`/`grant_id`/`entitlement_version`), NU `credential_version`:
 * la rotație (10.5) validitatea se re-verifică pe CONT (entitlement_version / grant revocat / status), nu pe rotația
 * secretului clientului (clientul e public, fără secret). Simetric cu `UserTokenPayload` (care la fel INTERZICE
 * `credential_version`).
 *
 * Forma CLIENT de refresh (`RefreshPayload` din `oauthAtomic`) rămâne NEATINSĂ — subject_kind ABSENT = client (legacy +
 * cele emise azi de auth-code client-shaped). Aici DOAR ADĂUGĂM forma user, aditiv, ca să nu spargem niciun caller
 * existent (ruta /token, `oauth-refresh.ts`). Discriminatorul `parseStoredRefresh` rutează pe `subject_kind` și
 * dovedește că formele NU se ciocnesc (un blob user nu trece drept client și invers).
 *
 * Split DRAFT / STOCAT (ca la token): `family_id` se generează la emiterea atomică (`consumeCodeAndIssueWithRefresh`),
 * deci `buildUserRefreshDraft` produce tot în afară de `family_id`, iar `finalizeUserRefreshPayload` îl adaugă. Un
 * refresh user STOCAT fără `family_id` ar fi nerevocabil → interzis (guard-ul cere family_id ne-gol pe forma stocată).
 *
 * Fail-closed: fiecare formă cere câmpurile ei ȘI interzice `credential_version`; un blob care nu se potrivește exact
 * → `null` (apelantul îl tratează ca refresh invalid → invalid_grant). Builder-ele VALIDEAZĂ runtime + aruncă (mai
 * bine 500 la emitere decât să stocăm un refresh pe care rotația l-ar respinge).
 */

import { isRefreshPayload, type RefreshPayload } from "../db/oauthAtomic";

/** Alias explicit pentru forma CLIENT de refresh (subject_kind absent). Nedefinită aici — trăiește în `oauthAtomic`. */
export type ClientRefreshPayload = RefreshPayload;

/** DRAFT de refresh USER (înainte de emitere) — TOT în afară de `family_id` (adăugat la emiterea atomică). */
export interface UserRefreshDraft {
  subject_kind:        "user";
  client_id:           string;   // clientul (public) prin care a fost emis — Claude.ai connector
  user_id:             string;
  grant_id:            string;
  entitlement_version: number;
  scopes:              string[];
  audience:            string;   // OBLIGATORIU (PH-3: lanțul de access token-uri e legat de resursă)
  issued_at:           number;
  // FĂRĂ family_id (se adaugă la emitere) — FĂRĂ credential_version (validitatea = grant/entitlement, nu secretul).
}

/** Refresh USER STOCAT = draft + `family_id` OBLIGATORIU (revocabil prin familia PH-4). */
export interface UserRefreshPayload extends UserRefreshDraft {
  family_id:           string;
}

/** Orice refresh stocat: client (existent) SAU user (nou). Discriminat pe `subject_kind`. */
export type AnyRefreshPayload = ClientRefreshPayload | UserRefreshPayload;

// ── guards de FORMĂ ─────────────────────────────────────────────────────────
function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isStringArray(v: unknown): v is string[] { return Array.isArray(v) && v.every(s => typeof s === "string"); }
function isFiniteNumber(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v); }
/** entitlement_version valid = întreg finit ≥ 1 (backfill pornește de la 1; 0/negativ/NaN/fracționar = suspect). */
function isValidVersion(v: unknown): v is number { return typeof v === "number" && Number.isInteger(v) && v >= 1; }

/** Câmpuri comune ale refresh-ului user (folosit de draft ȘI stocat); NU verifică family_id. */
function hasValidUserRefreshCore(o: Record<string, unknown>): boolean {
  // Claim EXCLUSIV client interzis pe un refresh user (uniune strictă; validitatea user NU depinde de secretul clientului).
  if (o.credential_version !== undefined) return false;
  return o.subject_kind === "user"
    && isNonEmptyString(o.client_id)
    && isNonEmptyString(o.user_id)
    && isNonEmptyString(o.grant_id)
    && isValidVersion(o.entitlement_version)
    && isStringArray(o.scopes)
    && isNonEmptyString(o.audience)
    && isFiniteNumber(o.issued_at);
}

/** DRAFT user: core valid, FĂRĂ family_id (se adaugă la emitere). */
export function isUserRefreshDraft(v: unknown): v is UserRefreshDraft {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return hasValidUserRefreshCore(o) && o.family_id === undefined;
}

/** STOCAT user: core valid + family_id OBLIGATORIU (ne-gol). */
export function isUserRefreshPayload(v: unknown): v is UserRefreshPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return hasValidUserRefreshCore(o) && isNonEmptyString(o.family_id);
}

/**
 * Interpretează un blob de refresh STOCAT (deja JSON-parsed sau nu — vezi `parseStoredRefresh`) ca formă client sau
 * user, FAIL-CLOSED. Discriminare pe `subject_kind`: "user"→forma user; absent→forma client (`isRefreshPayload`);
 * orice altă valoare (inclusiv "client") → `null`. Refresh-urile client NU poartă subject_kind, iar M2M/client_credentials
 * NU are refresh — deci "client" explicit e neașteptat → respins.
 */
export function classifyStoredRefresh(v: unknown): AnyRefreshPayload | null {
  if (typeof v !== "object" || v === null) return null;
  const kind = (v as Record<string, unknown>).subject_kind;
  if (kind === "user")    return isUserRefreshPayload(v) ? (v as UserRefreshPayload) : null;
  if (kind === undefined) return isRefreshPayload(v)     ? (v as ClientRefreshPayload) : null;
  return null; // subject_kind necunoscut ("client" inclus) → fail-closed
}

/** Parse safe al blob-ului stocat → formă client/user validă sau `null` (JSON stricat / formă invalidă). */
export function parseStoredRefresh(raw: string): AnyRefreshPayload | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return classifyStoredRefresh(parsed);
}

/** Type-guard util pe uniune: e refresh user? (discriminant îngust pentru caller-ii care ramifică pe identitate). */
export function isUserRefresh(p: AnyRefreshPayload): p is UserRefreshPayload {
  return (p as { subject_kind?: unknown }).subject_kind === "user";
}

// ── buildere (pentru emitere, slice 10.4c) ──────────────────────────────────
// Builder-ele VALIDEAZĂ runtime ieșirea (nu doar tipul static): la granița de emitere aruncăm fail-closed dacă
// rezultatul nu-i valid, ca să NU stocăm niciodată un refresh pe care rotația (10.5) l-ar respinge.

/** DRAFT refresh user (fără family_id) — `family_id` se adaugă la emiterea atomică via `finalizeUserRefreshPayload`. Aruncă pe input invalid. */
export function buildUserRefreshDraft(p: {
  client_id: string; user_id: string; grant_id: string; entitlement_version: number;
  scopes: string[]; audience: string; issued_at: number;
}): UserRefreshDraft {
  const draft = {
    subject_kind: "user" as const,
    client_id: p.client_id, user_id: p.user_id, grant_id: p.grant_id, entitlement_version: p.entitlement_version,
    scopes: p.scopes, audience: p.audience, issued_at: p.issued_at,
  };
  if (!isUserRefreshDraft(draft)) {
    throw new Error("buildUserRefreshDraft: draft invalid (client_id/user_id/grant_id/entitlement_version/audience obligatorii, credential_version interzis)");
  }
  return draft;
}

/** Finalizează un draft refresh user cu familia generată la emitere → forma STOCATĂ. Aruncă dacă `family_id` e gol (nerevocabil). */
export function finalizeUserRefreshPayload(draft: UserRefreshDraft, family_id: string): UserRefreshPayload {
  const stored = { ...draft, family_id };
  if (!isUserRefreshPayload(stored)) {
    throw new Error("finalizeUserRefreshPayload: payload invalid (family_id obligatoriu, ne-gol)");
  }
  return stored;
}
