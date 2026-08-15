/**
 * lib/db/clientLookup.ts — NF4 (discriminare „client inexistent" vs „backend indisponibil").
 *
 * `getClientById` transforma ATÂT „client inexistent/revocat" CÂT ȘI o eroare Supabase (backend jos / query eșuat)
 * în `null` → `resolveAuth` le raporta pe AMBELE ca 401. Un backend Supabase jos NU e „client necunoscut" —
 * clientul poate fi perfect valid, dar nu-l putem verifica. NF4: rezultat DISCRIMINAT — `not_found` → 401 (onest:
 * verificarea a reușit, răspunsul e „nu"), `unavailable` → 503 AUTH_UNAVAILABLE (la fel ca Redis jos la token).
 *
 * Leaf PUR (doar `import type`, șters de esbuild) → clasificatorul e testabil în tsx fără Supabase.
 */

import type { OAuthClient } from "./oauth-clients";

export type ClientLookup =
  | { status: "found";       client: OAuthClient }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

/**
 * Mapează rezultatul unei citiri Supabase `.maybeSingle()` la un `ClientLookup`.
 *   - `error` prezent → backend/query a eșuat → `unavailable` (NU „not_found"). Un client valid nu poate fi verificat.
 *   - `error` absent + `data` null → 0 rânduri = client chiar inexistent/inactiv → `not_found`.
 *   - `data` prezent → `found`.
 * NB: cu `.maybeSingle()` (nu `.single()`), 0 rânduri dau `data:null, error:null` — deci absența e distinctă de
 * eroarea reală. `.single()` întorcea eroare și pe 0 rânduri, exact conflarea pe care NF4 o repară.
 */
export function classifyClientLookup(
  data:  OAuthClient | null | undefined,
  error: { message?: string } | null | undefined,
): ClientLookup {
  if (error) return { status: "unavailable", reason: error.message ?? "supabase_error" };
  if (!data)  return { status: "not_found" };
  return { status: "found", client: data };
}

export type ClientCredResult =
  | { status: "ok";             client: OAuthClient }
  | { status: "invalid_client" }
  | { status: "unavailable";    reason: string };

/**
 * PH-9: din `ClientLookup` (discriminat) + verificarea secretului → rezultatul pentru TOKEN endpoint (grant
 * `client_credentials`). Cheia: `unavailable` (Supabase jos) NU devine `invalid_client` — altfel un OUTAGE ar
 * apărea user-ului ca „secret greșit / client revocat" (401), deși credențialele lui pot fi perfect valide.
 *   - `unavailable` → se propagă → ruta răspunde 503 `temporarily_unavailable` (retry), ca la Redis jos.
 *   - `not_found` SAU secret greșit → `invalid_client` (verificarea a REUȘIT, răspunsul onest e „nu").
 * PUR: `secretMatches` (comparația constant-time a secretului) e injectată → testabil fără Supabase/crypto.
 */
export function classifyClientCredentials(
  lookup:        ClientLookup,
  secretMatches: (client: OAuthClient) => boolean,
): ClientCredResult {
  if (lookup.status === "unavailable") return { status: "unavailable", reason: lookup.reason };
  if (lookup.status === "not_found")   return { status: "invalid_client" };
  return secretMatches(lookup.client) ? { status: "ok", client: lookup.client } : { status: "invalid_client" };
}
