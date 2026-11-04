/**
 * lib/db/entitlementLookup.ts — PH-2 step 10.3b-ii (clasificare citire account_entitlements, PUR).
 *
 * Leaf PUR (doar `import type`) → clasificatorul + validatorul de rând-s testabili în tsx fără Supabase (ca
 * `clientLookup.ts`). Query-ul I/O (`getAccountEntitlement`) e în `ph2Reads.ts`. Discriminăm ca NF4:
 *   - `error` prezent (backend jos / query eșuat) → `unavailable` (NU „not_found"): contul poate exista, dar nu-l
 *     putem citi → /authorize răspunde fail-closed, nu „cont inexistent".
 *   - `data` null (0 rânduri, via `.maybeSingle()`) → `not_found`.
 *   - `data` prezent DAR malformat (tip greșit / status necunoscut / scopes goale / `access_expires_at` lipsă sau
 *     neparsabil) → `unavailable` (corupt, nu-l tratăm ca `found` cu date în care nu putem avea încredere). Gate-ul de
 *     „usable" (status active) e în consent.
 *   - `data` prezent + valid DAR `access_expires_at <= nowMs` → `expired` (lotul OAuth staging, migrarea 0002).
 *   - `data` prezent + valid + neexpirat (sau `access_expires_at` null = fără expirare) → `found`.
 *
 * DE CE expirarea e AICI (un singur punct): toți consumatorii entitlement-ului de cont — consimțământul (render +
 * POST), refresh-ul user din `/token` și verificarea per apel MCP (`resolveAuth`) — citesc contul EXCLUSIV prin
 * `getAccountEntitlement` → acest clasificator. Un cont expirat iese ca variantă DISTINCTĂ `expired`, care NU poartă
 * entitlement-ul (scopes/limite) — deci niciun consumator nu-l poate folosi din greșeală:
 *   - consimțământul face `status === "found" ? entitlement : null` → `null` → refuz, ca un cont fără entitlement
 *     (același rezultat ca un cont suspendat: `decideConsentGrant`/`buildConsentView` → `error`);
 *   - `verifyUserAccount` (refresh + per apel) mapează `expired` → `unauthorized` (→ `invalid_grant` / 401), exact ca
 *     un cont `suspended`/`revoked`.
 * `nowMs` e INJECTAT (frunza rămâne pură); un `nowMs` nefinit cu o expirare setată → `expired` (fail-closed).
 * `access_expires_at` LIPSĂ din rând (coloană necerută în select / migrarea 0002 neaplicată) → corupt (`unavailable`),
 * NU „nu expiră" — aceeași doctrină ca `expires_at` din `registrationLookup.ts`.
 */

import type { AccountEntitlement, EntitlementStatus } from "../oauth/entitlement";

export type AccountEntitlementLookup =
  | { status: "found";       entitlement: AccountEntitlement }
  // Cont cu entitlement valid ca formă, dar cu accesul expirat. Fără scopes/limite (nu se pot folosi din greșeală).
  | { status: "expired";     user_id: string; access_expires_at_ms: number }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isInt(v: unknown): v is number { return typeof v === "number" && Number.isInteger(v); }
function isStatus(v: unknown): v is EntitlementStatus { return v === "active" || v === "suspended" || v === "revoked"; }
/** scopes utilizabile: array ne-gol de string-uri ne-goale după trim (aliniat cu constraint-ul SQL arr_clean). */
function isCleanScopes(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(s => typeof s === "string" && s.trim() !== "");
}

/** Guard de formă pt. un rând account_entitlements (fail-closed: rând corupt → NU `found`). */
export function isAccountEntitlementRow(raw: unknown): raw is AccountEntitlement {
  if (typeof raw !== "object" || raw === null) return false;
  const o = raw as Record<string, unknown>;
  return isNonEmptyString(o.user_id)
    && isNonEmptyString(o.plan)
    && isCleanScopes(o.scopes)
    && isInt(o.rate_limit_per_minute) && o.rate_limit_per_minute >= -1
    && isInt(o.rate_limit_per_day)    && o.rate_limit_per_day    >= -1
    && isStatus(o.status)
    && isInt(o.entitlement_version)   && o.entitlement_version   >= 1;
}

// timestamptz serializat de PostgREST: `YYYY-MM-DDTHH:MM:SS[.ffffff](Z|±HH[:MM])`. Cerem EXPLICIT fusul orar — un șir
// fără fus ar fi interpretat în ora locală a procesului (ambiguu) → respins ca rând corupt.
const TIMESTAMPTZ_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export type AccessExpiryParse = { ok: true; ms: number | null } | { ok: false };

/**
 * `access_expires_at` din rând → ms | null. Fail-closed:
 *   - cheia LIPSĂ sau `undefined` → `{ ok: false }` (coloană necerută = corupt, NU „nu expiră");
 *   - `null` EXPLICIT → `{ ok: true, ms: null }` (fără expirare — rândurile dinainte de 0002);
 *   - șir timestamptz cu fus orar, parsabil → `{ ok: true, ms }`;
 *   - orice altceva (tip greșit, șir neparsabil, fără fus orar) → `{ ok: false }`.
 */
export function parseAccessExpiresAt(raw: unknown): AccessExpiryParse {
  if (typeof raw !== "object" || raw === null) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (!("access_expires_at" in o)) return { ok: false };
  const v = o.access_expires_at;
  if (v === null) return { ok: true, ms: null };
  if (typeof v !== "string" || !TIMESTAMPTZ_RE.test(v)) return { ok: false };
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return { ok: false };
  return { ok: true, ms };
}

/** Expirat? `null` = niciodată. Altfel expirat dacă `expiresMs <= nowMs`, sau dacă `nowMs` nu e finit (fail-closed). */
export function isAccessExpired(expiresMs: number | null, nowMs: number): boolean {
  if (expiresMs === null) return false;
  if (!Number.isFinite(nowMs)) return true;
  return !(expiresMs > nowMs);
}

export function classifyEntitlementLookup(
  data:  unknown,
  error: { message?: string } | null | undefined,
  nowMs: number,
): AccountEntitlementLookup {
  if (error)  return { status: "unavailable", reason: error.message ?? "supabase_error" };
  // `.maybeSingle()` dă `null` pe 0 rânduri; `undefined` = răspuns/adaptor neașteptat → fail-closed `unavailable`.
  if (data === undefined) return { status: "unavailable", reason: "răspuns neașteptat (data undefined)" };
  if (data === null) return { status: "not_found" };
  if (!isAccountEntitlementRow(data)) return { status: "unavailable", reason: "account_entitlements row malformat" };
  const exp = parseAccessExpiresAt(data);
  if (!exp.ok) return { status: "unavailable", reason: "account_entitlements row malformat (access_expires_at)" };
  if (exp.ms !== null && isAccessExpired(exp.ms, nowMs)) {
    return { status: "expired", user_id: data.user_id, access_expires_at_ms: exp.ms };
  }
  // Entitlement construit EXPLICIT (doar câmpurile tipului) — coloana de expirare nu „călătorește" mai departe în
  // grant/claims; decizia de expirare s-a luat aici.
  const entitlement: AccountEntitlement = {
    user_id:               data.user_id,
    plan:                  data.plan,
    scopes:                data.scopes,
    rate_limit_per_minute: data.rate_limit_per_minute,
    rate_limit_per_day:    data.rate_limit_per_day,
    status:                data.status,
    entitlement_version:   data.entitlement_version,
  };
  return { status: "found", entitlement };
}
