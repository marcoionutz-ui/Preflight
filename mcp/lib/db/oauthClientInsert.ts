/**
 * lib/db/oauthClientInsert.ts — E3 (secret_rotated_at setat EXPLICIT la crearea clientului).
 *
 * Frunză PURĂ (zero importuri) → testabilă în tsx.
 *
 * Bug (E3): `createOAuthClient` NU seta `secret_rotated_at` în insert — se baza pe un DEFAULT al coloanei DB.
 * Dacă coloana n-are DEFAULT, rândul nou are `secret_rotated_at = NULL`. Lanțul care se rupe:
 *   insert (null) → `issueToken` stampează `credential_version: client.secret_rotated_at` (= null) →
 *   `authenticate()`/`resolveAuth` face `if (!v.payload.credential_version || v.payload.credential_version !==
 *   client.secret_rotated_at) return 401` → `!null` = true → 401 pentru ORICE token al ORICĂRUI client nou.
 * Adică auth pică TĂCUT pentru toți clienții creați după introducerea check-ului de rotație — exact userii noi.
 *
 * Fix: setăm `secret_rotated_at` EXPLICIT la timestamp-ul creării (secretul tocmai a fost mintat, deci „rotit
 * acum" e semantica corectă) → nu mai depindem de un DEFAULT care poate lipsi. Plus un guard fail-closed
 * (`hasValidCredentialVersion`): dacă totuși rândul întors nu are un `secret_rotated_at` valid, NU întoarcem un
 * client rupt (ale cărui tokenuri ar pica toate la auth) — semnalăm eroare, ca să nu creăm tăcut ceva inutilizabil.
 *
 * Aceeași clasă de invariant (varu): `redirect_uris` era ȘI el omis din insert. Codul îl consumă ulterior DIRECT
 * (`.length`, `.includes()`, `.filter()` — vezi isAllowedRedirectUri/addRedirectUri/removeRedirectUri) → nu-l lăsăm
 * pe seama unui DEFAULT DB. Îl setăm EXPLICIT la `[]` — semantic corect ȘI fail-closed: un client nou NU poate
 * autoriza nimic până nu-și configurează allowlist-ul (addRedirectUri, session-gated). (Că actualul connector merge
 * nu dovedește existența default-ului — clientul existent poate avea deja URI-uri salvate.)
 */

/** Câmpurile pe care caller-ul le calculează; `secret_rotated_at` e adăugat de builder, nu lăsat pe DB. */
export interface OAuthClientInsertBase {
  client_id:             string;
  secret_hash:           string;
  name:                  string;
  plan:                  string;
  scopes:                string[];
  rate_limit_per_minute: number;
  rate_limit_per_day:    number;
  notes:                 string | null;
  user_id:               string | null;
}

export type OAuthClientInsertRow = OAuthClientInsertBase & { secret_rotated_at: string; redirect_uris: string[] };

/**
 * Construiește rândul de insert cu `secret_rotated_at` (= `nowIso`, timestamp-ul creării) ȘI `redirect_uris` (= `[]`)
 * GARANTAT prezente — ambele NOT NULL, consumate ulterior direct de cod, deci nu le lăsăm pe seama unui DEFAULT DB.
 * `nowIso` e injectat de caller (`new Date().toISOString()`) ca funcția să rămână pură/testabilă. `redirect_uris: []`
 * e fail-closed: clientul nou nu poate autoriza nimic până nu-și declară allowlist-ul.
 */
export function buildOAuthClientInsertRow(base: OAuthClientInsertBase, nowIso: string): OAuthClientInsertRow {
  return { ...base, secret_rotated_at: nowIso, redirect_uris: [] };
}

/**
 * `true` dacă `secret_rotated_at` (= `credential_version` pe care-l va pin-ui tokenul) e o valoare utilizabilă:
 * string ne-gol. NULL/undefined/""/non-string → invalid → clientul ar produce tokenuri care pică la auth.
 * Folosit ca guard fail-closed DUPĂ insert (dacă DB-ul tot n-a materializat câmpul, nu întoarce un client rupt).
 */
export function hasValidCredentialVersion(row: { secret_rotated_at?: unknown } | null | undefined): boolean {
  return !!row && typeof row.secret_rotated_at === "string" && row.secret_rotated_at.length > 0;
}
