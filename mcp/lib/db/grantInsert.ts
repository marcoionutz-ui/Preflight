/**
 * lib/db/grantInsert.ts — PH-2 step 10.3b-v frunză 1 (persistarea grantului în `oauth_grants`: piese PURE).
 *
 * Frunză pură (zero I/O; rezultatele DB injectate) → tsx-testabilă. La consimțământul unui USER pe `/authorize` POST,
 * grantul (`OAuthGrant`, produs de `decideConsentGrant` cu `grant_id` generat/STICKY) trebuie PERSISTAT înainte de a
 * emite codul (corecția cgpt #4: `… → insert grant → issue code → redirect`). Insert-ul e IDEMPOTENT: dacă răspunsul e
 * ambiguu (timeout / duplicate), un read-back cu ACELAȘI `grant_id` NU trebuie să eșueze fals.
 *
 * ⚠️ WIRING (frunza 2 / rută): `grant_id` TREBUIE să fie STICKY/determinist per consimțământ (nu un UUID nou la fiecare
 * POST), altfel read-back-ul idempotent nu se folosește efectiv. Plan: `grant_id` sigilat în `AuthzTransaction` la GET.
 *
 * Piese pure:
 *   - `buildGrantInsertRow` — `OAuthGrant` → rândul `oauth_grants`. `created_at` din grant, EXPLICIT (nu pe DEFAULT-ul
 *     coloanei — ca `secret_rotated_at`).
 *   - `grantRowMatchesGrant` — comparație pe IDENTITATE (imutabilă) pentru read-back. `created_at` comparat SEMANTIC
 *     (ms finit egal — PostgREST poate reda același instant ca `…000Z` sau `…+00:00`; egalitatea de string ar da
 *     `conflict` fals). `status` EXCLUS din identitate (mutabil) — gate-ul de utilizabilitate e SEPARAT în `decide…`.
 *   - `decideGrantInsertOutcome` — verdictul idempotent. „Persistat ≠ utilizabil": DOAR un grant persistat `active` e
 *     succes; un grant `revoked` (chiar dacă e al nostru) → `revoked`, blochează emiterea codului (cgpt).
 */

import type { OAuthGrant } from "../oauth/grant";
import type { GrantLookup } from "./grantLookup";

/** `OAuthGrant` → rândul de inserat în `oauth_grants` (created_at explicit; scopes copiat). */
export function buildGrantInsertRow(grant: OAuthGrant): Record<string, unknown> {
  return {
    grant_id:            grant.grant_id,
    registration_id:     grant.registration_id,
    client_id:           grant.client_id,
    user_id:             grant.user_id,
    resource:            grant.resource,
    scopes:              [...grant.scopes],
    entitlement_version: grant.entitlement_version,
    status:              grant.status,
    created_at:          grant.created_at,
  };
}

/** Același instant temporal? Ambele string-uri parsabile la ms FINIT egal (tolerant la forma ISO/offset). */
function sameInstant(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ta = Date.parse(a), tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

/**
 * True dacă `row` e ACELAȘI grant ca `expected` pe câmpurile de IDENTITATE (imutabile). `status` NU se compară aici
 * (mutabil — gate-ul de utilizabilitate e în `decideGrantInsertOutcome`). `created_at` comparat SEMANTIC (ms), nu ca
 * string. Coloane EXTRA în `row` (id auto, updated_at) ignorate. Scopes: egalitate EXACTĂ ordonată.
 */
export function grantRowMatchesGrant(row: unknown, expected: OAuthGrant): boolean {
  if (typeof row !== "object" || row === null) return false;
  const o = row as Record<string, unknown>;
  if (!Array.isArray(o.scopes)) return false;
  return o.grant_id            === expected.grant_id
      && o.registration_id     === expected.registration_id
      && o.client_id           === expected.client_id
      && o.user_id             === expected.user_id
      && o.resource            === expected.resource
      && o.entitlement_version === expected.entitlement_version
      && sameInstant(o.created_at, expected.created_at)
      && o.scopes.length       === expected.scopes.length
      && o.scopes.every((s, i) => s === expected.scopes[i]);
}

export type InsertGrantResult =
  | { status: "inserted" }                        // rând scris + confirmat = grantul nostru, ACTIV
  | { status: "already_present" }                 // read-back: grantul nostru era deja persistat, ACTIV (idempotent)
  | { status: "revoked";      reason: string }    // grant persistat (al nostru) dar NEactiv → NU emite cod (persistat ≠ utilizabil)
  | { status: "conflict";     reason: string }    // rând inserat/existent DIFERĂ de grant pe identitate (fail-closed)
  | { status: "unavailable";  reason: string };   // DB jos / insert nesigilat / n-a aterizat → 503 (retry)

/** Citește `status` dintr-un rând DB brut (necunoscut) — string sau undefined. */
function rowStatus(row: unknown): unknown {
  return (typeof row === "object" && row !== null) ? (row as Record<string, unknown>).status : undefined;
}

/**
 * Verdictul idempotent PUR. Pe SUCCES verifică rândul întors de `insert().select().single()` = grantul nostru
 * (identitate) ȘI e `active`. Pe EROARE, `readback` (= `getGrantById(grant.grant_id)`) decide. „Persistat ≠ utilizabil":
 * un grant al cărui rând persistat NU e `active` → `revoked` (blochează emiterea), NU `inserted`/`already_present`.
 */
export function decideGrantInsertOutcome(p: {
  insertError: { message?: string } | null | undefined;
  insertData:  unknown;                      // rândul întors pe succes (null/undefined = niciun rând)
  readback:    GrantLookup | null;           // prezent DOAR pe eroare de insert
  expected:    OAuthGrant;
}): InsertGrantResult {
  // ── SUCCES ────────────────────────────────────────────────────────────────────
  if (!p.insertError) {
    if (p.insertData === undefined || p.insertData === null) {
      return { status: "unavailable", reason: "insert fără rând întors (răspuns ambiguu)" };
    }
    if (!grantRowMatchesGrant(p.insertData, p.expected)) {
      return { status: "conflict", reason: "rândul inserat nu se potrivește cu grantul (DB a modificat conținutul)" };
    }
    if (rowStatus(p.insertData) !== "active") {
      return { status: "revoked", reason: "grantul persistat nu e active (persistat ≠ utilizabil)" };
    }
    return { status: "inserted" };
  }

  // ── EROARE → read-back decide idempotența ──────────────────────────────────────
  const rb = p.readback;
  if (!rb || rb.status === "unavailable") {
    return { status: "unavailable", reason: rb && rb.status === "unavailable" ? rb.reason : "read-back indisponibil după eroare de insert" };
  }
  if (rb.status === "not_found") {
    return { status: "unavailable", reason: "insert eșuat, grantul nu s-a persistat (retry)" };
  }
  // rb.status === "found"
  if (!grantRowMatchesGrant(rb.grant, p.expected)) {
    return { status: "conflict", reason: "grant_id există deja cu conținut diferit (colizie)" };
  }
  if (rb.grant.status !== "active") {
    return { status: "revoked", reason: "grantul persistat e revocat (persistat ≠ utilizabil)" };
  }
  return { status: "already_present" };
}
