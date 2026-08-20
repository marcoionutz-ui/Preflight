/**
 * lib/oauth/subjectClaims.ts — PH-2a (subiectul tokenului: uniune discriminată strict, PUR).
 *
 * Zero I/O → testabil izolat în tsx. Marco #2: tokenurile Preflight au DOUĂ tipuri de subiect, care NU trebuie
 * confundate niciodată de `resolveAuth`/quota:
 *   - `subject_kind="user"`  (auth-code / interactive) → `user_id` + `grant_id` + `entitlement_version` + `client_id`.
 *     Entitlement + quota se rezolvă pe CONT (via grant).
 *   - `subject_kind="client"` (client_credentials / M2M) → `client_id` + `credential_version`. FĂRĂ user/grant.
 *     Entitlement + quota se rezolvă CLIENT-scoped.
 * `parseTokenSubject` e fail-closed: orice `subject_kind` necunoscut sau câmp lipsă/greșit tipat → `null` (nu cade
 * accidental pe celălalt path).
 */

export type SubjectKind = "user" | "client";

export interface UserSubject {
  subject_kind:        "user";
  user_id:             string;
  grant_id:            string;
  entitlement_version: number;
  client_id:           string;
}

export interface ClientSubject {
  subject_kind:       "client";
  client_id:          string;
  credential_version: string;
}

export type TokenSubject = UserSubject | ClientSubject;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** `entitlement_version` valid = întreg finit ≥ 1 (backfill pornește de la 1; 0/negativ/NaN = suspect → invalid). */
function isValidVersion(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

export function buildUserSubject(p: {
  user_id: string; grant_id: string; entitlement_version: number; client_id: string;
}): UserSubject {
  return { subject_kind: "user", user_id: p.user_id, grant_id: p.grant_id, entitlement_version: p.entitlement_version, client_id: p.client_id };
}

export function buildClientSubject(p: { client_id: string; credential_version: string }): ClientSubject {
  return { subject_kind: "client", client_id: p.client_id, credential_version: p.credential_version };
}

export function isUserSubject(s: unknown): s is UserSubject {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Record<string, unknown>;
  // Claims EXCLUSIVE ramurii client sunt INTERZISE pe un user subject (cgpt: uniune strictă, protecție la migrare).
  if (o.credential_version !== undefined) return false;
  return o.subject_kind === "user"
    && isNonEmptyString(o.user_id)
    && isNonEmptyString(o.grant_id)
    && isValidVersion(o.entitlement_version)
    && isNonEmptyString(o.client_id);
}

export function isClientSubject(s: unknown): s is ClientSubject {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Record<string, unknown>;
  // Claims EXCLUSIVE ramurii user sunt INTERZISE pe un client subject (un M2M nu poartă user/grant/entitlement).
  if (o.user_id !== undefined || o.grant_id !== undefined || o.entitlement_version !== undefined) return false;
  return o.subject_kind === "client"
    && isNonEmptyString(o.client_id)
    && isNonEmptyString(o.credential_version);
}

/**
 * Parsează un subiect de token dintr-un payload necunoscut, FAIL-CLOSED. Discriminează pe `subject_kind`; orice altă
 * valoare, sau un câmp lipsă/greșit tipat pentru forma respectivă → `null`. Nu „ghicește" tipul: un obiect care nu e
 * nici user valid, nici client valid nu devine tacit celălalt.
 */
export function parseTokenSubject(raw: unknown): TokenSubject | null {
  if (typeof raw !== "object" || raw === null) return null;
  const kind = (raw as Record<string, unknown>).subject_kind;
  if (kind === "user")   return isUserSubject(raw)   ? raw : null;
  if (kind === "client") return isClientSubject(raw) ? raw : null;
  return null; // subject_kind necunoscut/absent → fail-closed
}
