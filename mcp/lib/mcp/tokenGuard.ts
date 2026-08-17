/**
 * lib/mcp/tokenGuard.ts — E10 (validare runtime a payload-ului de token).
 *
 * `JSON.parse(raw) as TokenPayload` NU validează forma: `null`, `{}`, `42`, sau scopes ne-string sunt JSON
 * perfect valide și ar produce `{status:"valid", payload:null/…}` → `resolveAuth` ar face `payload.client_id`
 * și ar arunca → 500 neașteptat (exact calea pe care E10 pretinde că o elimină). Payload malformat = token
 * NEUTILIZABIL → `invalid` (401 INVALID_TOKEN), nu backend indisponibil. Leaf pur (doar `import type`) → testabil.
 */

import type { TokenPayload } from "../db/oauth-tokens";

export function isTokenPayload(value: unknown): value is TokenPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.client_id === "string" && v.client_id.length > 0 &&
    Array.isArray(v.scopes) && v.scopes.every((s) => typeof s === "string") &&
    typeof v.issued_at === "number" && Number.isFinite(v.issued_at) &&
    typeof v.credential_version === "string" && v.credential_version.length > 0 &&
    // PH-3: aici verificăm doar FORMA (`audience` prezent → string). PREZENȚA + potrivirea audience-ului cu resursa
    // canonică e o decizie de POLITICĂ, impusă FAIL-CLOSED în `resolveAuth`/`tokenAudienceValid` (un token fără
    // audience → 401, nu acceptat). Un blob cu audience ne-string e corupt → invalid.
    (v.audience === undefined || typeof v.audience === "string") &&
    // PH-4: la fel, doar FORMA (`family_id` prezent → string ne-gol). Verificarea de REVOCARE a familiei e politică,
    // impusă în `resolveAuth`. Un blob cu family_id ne-string/gol e corupt → invalid.
    (v.family_id === undefined || (typeof v.family_id === "string" && v.family_id.length > 0))
  );
}

export type StoredTokenResult =
  | { status: "valid"; payload: TokenPayload }
  | { status: "invalid" };

/**
 * Interpretează blob-ul stocat în Redis. JSON invalid SAU formă invalidă → `invalid` (token neutilizabil, 401).
 * Nu întoarce niciodată `unavailable` — indisponibilitatea Redis e treaba stratului de citire (validateToken).
 */
export function parseStoredToken(raw: string): StoredTokenResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return { status: "invalid" }; }
  return isTokenPayload(parsed) ? { status: "valid", payload: parsed } : { status: "invalid" };
}
