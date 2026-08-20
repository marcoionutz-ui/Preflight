/**
 * lib/oauth/entitlement.ts — PH-2a (rezolvarea entitlement-ului, PUR).
 *
 * Zero I/O → testabil izolat în tsx. Sursa de entitlement diferă pe SUBIECT (Marco #2/#3):
 *   - subject_kind=user (auth-code): entitlement EXCLUSIV din `account_entitlements` prin grant;
 *   - subject_kind=client (client_credentials, M2M): entitlement CLIENT-scoped (legacy `oauth_clients`, ulterior
 *     opțional `service_entitlements`) — NU se rezolvă printr-un grant de user artificial.
 *
 * SEMANTICA `read:all` (cgpt P1): `read:all` în ENTITLEMENT e un WILDCARD care acoperă orice scope granular `read:*`
 * (inclusiv `read:all` însuși), DAR nu acoperă scope-uri non-read (ex. un viitor `admin:*`). „Permis de serverPolicy"
 * rămâne apartenență CONCRETĂ la policy (server-ul controlează exact ce scope-uri există). Astfel un cont beta cu
 * `["read:all"]` care cere `read:pair` primește `read:pair` (nu `[]`), păstrând comportamentul actual din /authorize.
 */

export type EntitlementStatus = "active" | "suspended" | "revoked";

/** Scope-ul de „acces complet la citire" — wildcard peste `read:*` în partea de entitlement. */
export const FULL_ACCESS_SCOPE = "read:all";

function isReadScope(s: string): boolean { return s.startsWith("read:"); }

/**
 * `entitlement` acoperă `scope`? Direct (membru) SAU prin wildcard: entitlement conține `read:all` ȘI `scope` e `read:*`.
 * `read:all` NU acoperă scope-uri non-read (fail-closed pe orice viitor `admin:*` / `write:*`).
 */
export function scopeCoveredByEntitlement(scope: string, entitlement: ReadonlySet<string>): boolean {
  if (entitlement.has(scope)) return true;
  if (entitlement.has(FULL_ACCESS_SCOPE) && isReadScope(scope)) return true;
  return false;
}

/** Entitlement de CONT (subiect user). Sursa scopes/limite pentru fluxurile auth-code. */
export interface AccountEntitlement {
  user_id:               string;
  plan:                  string;
  scopes:                string[];
  rate_limit_per_minute: number;
  rate_limit_per_day:    number;
  status:                EntitlementStatus;
  entitlement_version:   number;
}

/**
 * Scope-urile acordate unui GRANT de utilizator la /authorize: pentru fiecare scope din bază,
 *   acoperit de ENTITLEMENT-ul contului (cu semantica `read:all`) ȘI membru CONCRET al `serverPolicy`.
 * `requested` gol → baza devine `account` (clientul nu cere nimic explicit ⇒ ce permite contul), tot filtrat prin policy.
 * Rezultat dedup, ordine stabilă. FAIL-CLOSED: orice scope neacoperit sau în afara policy = exclus.
 */
export function resolveGrantedScopes(
  requested:    readonly string[],
  account:      readonly string[],
  serverPolicy: readonly string[],
): string[] {
  const acct = new Set(account);
  const pol  = new Set(serverPolicy);
  const base = requested.length > 0 ? requested : account;
  const out: string[] = [];
  for (const s of base) {
    if (scopeCoveredByEntitlement(s, acct) && pol.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Entitlement de cont utilizabil? status `active` ȘI cel puțin un scope. Altfel authorize refuză (fail-closed). */
export function isAccountUsable(e: Pick<AccountEntitlement, "status" | "scopes">): boolean {
  return e.status === "active" && e.scopes.length > 0;
}

/**
 * La REFRESH/re-authorize, scope-urile efective (cgpt P2) = `grant ∩ account CURENT ∩ serverPolicy CURENT`, cu aceeași
 * semantică `read:all` pe partea de entitlement. Dacă serverul RETRAGE ulterior un scope din policy, refresh-ul NU-l
 * mai poate emite — chiar dacă grantul și contul îl mai conțin. PUR.
 */
export function clampScopes(
  grantScopes:  readonly string[],
  account:      readonly string[],
  serverPolicy: readonly string[],
): string[] {
  const acct = new Set(account);
  const pol  = new Set(serverPolicy);
  const out: string[] = [];
  for (const s of grantScopes) {
    if (scopeCoveredByEntitlement(s, acct) && pol.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}
