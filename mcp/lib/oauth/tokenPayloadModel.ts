/**
 * lib/oauth/tokenPayloadModel.ts — PH-2 step 10 (payload-ul STOCAT de token: forme discriminate, PUR).
 *
 * Frunză pură (zero I/O, doar `import type`) → tsx-testabilă. Modelul de identitate PH-2 are TREI forme STOCATE +
 * un DRAFT pre-emitere:
 *   - USER stocat (`UserTokenPayload`): `subject_kind="user"` + `user_id`/`grant_id`/`entitlement_version`/`client_id`.
 *     `audience` ȘI `family_id` OBLIGATORII — un access token user trebuie să fie (a) legat de resursă (PH-3:
 *     `tokenAudienceValid` cere audience, altfel 401) și (b) REVOCABIL prin familie (PH-4: revocarea grantului
 *     ajunge la access token). NU poartă `credential_version` (validitatea = grant/familie, nu secretul clientului).
 *   - USER draft (`UserTokenDraft`): forma de dinainte de emitere — `family_id` se generează în
 *     `consumeCodeAndIssueWithRefresh` (Lua), deci draftul are TOT în afară de `family_id`. `finalizeUserTokenPayload`
 *     adaugă familia → forma stocată. (Separarea evită să declarăm „valid" un token stocat fără familie.)
 *   - CLIENT nou (`ClientTokenPayload`): `subject_kind="client"` + `credential_version` + `audience` OBLIGATORIU;
 *     M2M NU are refresh → FĂRĂ `family_id` (interzis). Emis de client_credentials.
 *   - CLIENT legacy (`LegacyClientTokenPayload`): FĂRĂ `subject_kind` — tokenurile deja emise (dinainte de step 10).
 *     `audience`/`family_id` OPȚIONALE (grandfather: tokenurile auth-code de azi sunt client-shaped CU family_id;
 *     cele pre-PH-3 pot fi fără audience). Compat IZOLATĂ explicit — nu relaxează contractul formelor NOI.
 *
 * Fail-closed (ca `subjectClaims`): fiecare formă cere câmpurile ei ȘI interzice claim-urile celeilalte; un blob care
 * nu se potrivește exact uneia → `null` (apelantul îl tratează ca token invalid, 401). Wiring în 10.4/10.5.
 */

export interface UserTokenDraft {
  subject_kind:        "user";
  user_id:             string;
  grant_id:            string;
  entitlement_version: number;
  client_id:           string;
  scopes:              string[];
  issued_at:           number;
  audience:            string; // OBLIGATORIU (cunoscut la emitere; PH-3 cere audience)
  // FĂRĂ family_id — adăugat la emiterea atomică; FĂRĂ credential_version — validitatea e pe grant/familie.
}

export interface UserTokenPayload extends UserTokenDraft {
  family_id:           string; // STOCAT: OBLIGATORIU (revocabil prin familia PH-4)
}

export interface ClientTokenPayload {
  subject_kind:        "client";
  client_id:           string;
  scopes:              string[];
  issued_at:           number;
  credential_version:  string; // OBLIGATORIU — rotația secretului invalidează tokenul
  audience:            string; // OBLIGATORIU pe formele NOI
  // FĂRĂ family_id (M2M nu are refresh) — FĂRĂ câmpuri user.
}

export interface LegacyClientTokenPayload {
  subject_kind?:       undefined; // absent = legacy (dinainte de step 10)
  client_id:           string;
  scopes:              string[];
  issued_at:           number;
  credential_version:  string;
  audience?:           string;    // OPȚIONAL (grandfather pre-PH-3)
  family_id?:          string;    // OPȚIONAL (tokenurile auth-code de azi sunt client-shaped CU family_id)
}

export type StoredTokenPayload = UserTokenPayload | ClientTokenPayload | LegacyClientTokenPayload;

// ── guards de FORMĂ ─────────────────────────────────────────────────────────
function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isStringArray(v: unknown): v is string[] { return Array.isArray(v) && v.every(s => typeof s === "string"); }
function isFiniteNumber(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v); }
/** entitlement_version valid = întreg finit ≥ 1 (backfill pornește de la 1; 0/negativ/NaN = suspect). */
function isValidVersion(v: unknown): v is number { return typeof v === "number" && Number.isInteger(v) && v >= 1; }
function optNonEmptyString(v: unknown): boolean { return v === undefined || isNonEmptyString(v); }

/** Câmpuri comune user (folosit de draft ȘI stocat); nu verifică family_id. */
function hasValidUserCore(o: Record<string, unknown>): boolean {
  // Claim EXCLUSIV client interzis pe un token user (uniune strictă, protecție la migrare).
  if (o.credential_version !== undefined) return false;
  return o.subject_kind === "user"
    && isNonEmptyString(o.user_id)
    && isNonEmptyString(o.grant_id)
    && isValidVersion(o.entitlement_version)
    && isNonEmptyString(o.client_id)
    && isStringArray(o.scopes)
    && isFiniteNumber(o.issued_at)
    && isNonEmptyString(o.audience); // OBLIGATORIU
}

/** DRAFT user: core valid, FĂRĂ family_id (se adaugă la emitere). */
export function isUserTokenDraft(v: unknown): v is UserTokenDraft {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return hasValidUserCore(o) && o.family_id === undefined;
}

/** STOCAT user: core valid + family_id OBLIGATORIU. */
export function isUserTokenPayload(v: unknown): v is UserTokenPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return hasValidUserCore(o) && isNonEmptyString(o.family_id);
}

/** CLIENT nou: subject_kind="client", credential_version + audience OBLIGATORII, FĂRĂ familie, FĂRĂ câmpuri user. */
export function isClientTokenPayload(v: unknown): v is ClientTokenPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.user_id !== undefined || o.grant_id !== undefined || o.entitlement_version !== undefined) return false;
  if (o.family_id !== undefined) return false; // M2M nu are familie — interzis explicit
  return o.subject_kind === "client"
    && isNonEmptyString(o.client_id)
    && isStringArray(o.scopes)
    && isFiniteNumber(o.issued_at)
    && isNonEmptyString(o.credential_version)
    && isNonEmptyString(o.audience); // OBLIGATORIU pe formele noi
}

/** CLIENT legacy: FĂRĂ subject_kind; credential_version obligatoriu; audience/family_id OPȚIONALE; fără câmpuri user. */
export function isLegacyClientTokenPayload(v: unknown): v is LegacyClientTokenPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.subject_kind !== undefined) return false; // orice subject_kind → NU e legacy
  if (o.user_id !== undefined || o.grant_id !== undefined || o.entitlement_version !== undefined) return false;
  return isNonEmptyString(o.client_id)
    && isStringArray(o.scopes)
    && isFiniteNumber(o.issued_at)
    && isNonEmptyString(o.credential_version)
    && optNonEmptyString(o.audience)
    && optNonEmptyString(o.family_id);
}

/**
 * Interpretează un payload STOCAT (deja JSON-parsed) ca una din cele trei forme, FAIL-CLOSED. Discriminare pe
 * `subject_kind`: "user"→formă user stocată; "client"→formă client nouă; absent→formă client legacy; altă valoare→null.
 */
export function parseStoredTokenPayload(v: unknown): StoredTokenPayload | null {
  if (typeof v !== "object" || v === null) return null;
  const kind = (v as Record<string, unknown>).subject_kind;
  if (kind === "user")   return isUserTokenPayload(v)         ? v : null;
  if (kind === "client") return isClientTokenPayload(v)       ? v : null;
  if (kind === undefined) return isLegacyClientTokenPayload(v) ? v : null;
  return null; // subject_kind necunoscut → fail-closed
}

/**
 * PH-2 step 10 (semantica de CONSUM): cere `resolveAuth` verificarea rotației secretului (`credential_version`)?
 * DA pentru client/legacy (secretul clientului îl invalidează); NU pentru user (validitatea = grant/familie).
 */
export function tokenRequiresCredentialVersion(p: StoredTokenPayload): boolean {
  return p.subject_kind !== "user";
}

// ── buildere (pentru emitere, slice 10.4) ───────────────────────────────────
// Builder-ele VALIDEAZĂ runtime ieșirea (nu doar tipul static): un tip promis ≠ o valoare validă (ex. `family_id`
// gol trece la tip dar cade la guard). La granița de emitere aruncăm fail-closed dacă rezultatul nu-i valid, ca să
// NU se stocheze niciodată un payload pe care `resolveAuth` l-ar respinge (mai bine 500 la emitere decât token mort).

/** DRAFT user (fără family_id) — family_id se adaugă la emiterea atomică via `finalizeUserTokenPayload`. Aruncă pe input invalid. */
export function buildUserTokenDraft(p: {
  user_id: string; grant_id: string; entitlement_version: number; client_id: string;
  scopes: string[]; issued_at: number; audience: string;
}): UserTokenDraft {
  const draft = {
    subject_kind: "user" as const,
    user_id: p.user_id, grant_id: p.grant_id, entitlement_version: p.entitlement_version, client_id: p.client_id,
    scopes: p.scopes, issued_at: p.issued_at, audience: p.audience,
  };
  if (!isUserTokenDraft(draft)) throw new Error("buildUserTokenDraft: draft invalid (user_id/grant_id/entitlement_version/client_id/audience obligatorii)");
  return draft;
}

/** Finalizează un draft user cu familia generată la emitere → forma STOCATĂ. Aruncă dacă `family_id` e gol (nerevocabil). */
export function finalizeUserTokenPayload(draft: UserTokenDraft, family_id: string): UserTokenPayload {
  const stored = { ...draft, family_id };
  if (!isUserTokenPayload(stored)) throw new Error("finalizeUserTokenPayload: payload invalid (family_id obligatoriu, ne-gol)");
  return stored;
}

/** CLIENT nou (client_credentials) — audience obligatoriu, fără familie. Aruncă pe input invalid. */
export function buildClientTokenPayload(p: {
  client_id: string; scopes: string[]; issued_at: number; credential_version: string; audience: string;
}): ClientTokenPayload {
  const payload = {
    subject_kind: "client" as const,
    client_id: p.client_id, scopes: p.scopes, issued_at: p.issued_at,
    credential_version: p.credential_version, audience: p.audience,
  };
  if (!isClientTokenPayload(payload)) throw new Error("buildClientTokenPayload: payload invalid (client_id/credential_version/audience obligatorii)");
  return payload;
}
