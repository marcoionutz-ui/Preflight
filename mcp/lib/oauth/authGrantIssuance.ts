/**
 * lib/oauth/authGrantIssuance.ts — PH-2 step 10.2 (grant + claim-uri de identitate pentru authorization code, PUR).
 *
 * Frunză pură (zero I/O) → tsx-testabilă. La consimțământul unui USER pe `/authorize` (step 10.3), producem DOUĂ
 * lucruri consistente: (a) `OAuthGrant`-ul de PERSISTAT (`oauth_grants`) și (b) claim-urile de IDENTITATE embed-uite
 * în authorization code (`user_id`/`grant_id`/`entitlement_version`), care mai târziu (10.4) alimentează
 * `buildUserTokenDraft`. Le derivăm din ACELAȘI grant → imposibil să diveargă.
 *
 * BOUNDARY DE SCOPE (cgpt): scope-urile grantului NU sunt cele cerute brut — helper-ul COMPUNE el `resolveGrantedScopes`
 * (requested ∩ entitlement cont ∩ policy server, semantica `read:all`, fail-closed). Astfel `/authorize` nu poate
 * ocoli rezolvarea. `user_id` + `entitlement_version` vin DIN entitlement-ul contului (o singură sursă), nu din
 * parametri liberi. Contul trebuie utilizabil (`isAccountUsable`) — altfel refuz.
 *
 * `grant_id`/`nowIso` sunt INJECTATE (ca la `buildGrant`) ca funcția să rămână pură. Reutilizează `buildGrant`
 * (PH-2a) + `resolveGrantedScopes`/`isAccountUsable` (PH-2a) — NU le redefinește.
 */

import { buildGrant, type OAuthGrant } from "./grant";
import { resolveGrantedScopes, isAccountUsable, type AccountEntitlement } from "./entitlement";
import { isAuthCodePayload } from "../db/oauthAtomic";

/** Claim-urile de identitate embed-uite în authorization code pentru un consimțământ de USER. ALL-OR-NOTHING. */
export interface UserAuthCodeClaims {
  user_id:             string;
  grant_id:            string;
  entitlement_version: number;
}

function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isValidVersion(v: unknown): v is number { return typeof v === "number" && Number.isInteger(v) && v >= 1; }

/** Guard de formă pt. claim-urile de user (întreg-version ≥1; user_id/grant_id ne-goale). */
export function isUserAuthCodeClaims(v: unknown): v is UserAuthCodeClaims {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return isNonEmptyString(o.user_id) && isNonEmptyString(o.grant_id) && isValidVersion(o.entitlement_version);
}

/**
 * Din consimțământul unui user validat → grantul de persistat + claim-urile pt. cod, DERIVATE din același grant.
 * COMPUNE rezolvarea de scope (nu acceptă scopes brute) + gate-ul de entitlement. Nu aruncă — `{ ok, ... }`.
 *   - cont inutilizabil (suspended/revoked/fără scopes) → error (fail-closed);
 *   - niciun scope acordat după rezolvare → error (grantul n-ar autoriza nimic);
 *   - altfel propagă orice eroare din `buildGrant`.
 */
export function buildAuthGrantAndCodeClaims(p: {
  grant_id: string; registration_id: string; client_id: string;
  resource: string; requestedScopes: readonly string[]; serverPolicy: readonly string[];
  account: AccountEntitlement; nowIso: string;
}): { ok: true; grant: OAuthGrant; claims: UserAuthCodeClaims } | { ok: false; error: string } {
  // Gate de cont: doar un cont ACTIV cu scopes poate acorda un grant.
  if (!isAccountUsable(p.account)) return { ok: false, error: "cont inutilizabil (status ≠ active sau fără scopes)" };

  // BOUNDARY: scope-urile grantului = rezolvate (requested ∩ entitlement ∩ policy), NU cerute brut.
  const granted = resolveGrantedScopes(p.requestedScopes, p.account.scopes, p.serverPolicy);
  if (granted.length === 0) return { ok: false, error: "niciun scope acordat după rezolvare (fail-closed)" };

  // user_id + entitlement_version DIN entitlement-ul contului (o singură sursă).
  const g = buildGrant({
    grant_id:            p.grant_id,
    registration_id:     p.registration_id,
    client_id:           p.client_id,
    user_id:             p.account.user_id,
    resource:            p.resource,
    scopes:              granted,
    entitlement_version: p.account.entitlement_version,
    nowIso:              p.nowIso,
  });
  if (!g.ok) return g;

  // Claim-urile vin DIN grant → consistență garantată prin construcție.
  const claims: UserAuthCodeClaims = {
    user_id:             g.grant.user_id,
    grant_id:            g.grant.grant_id,
    entitlement_version: g.grant.entitlement_version,
  };
  return { ok: true, grant: g.grant, claims };
}

/**
 * Identitatea unui authorization code, FAIL-CLOSED (folosită la /token în 10.4). Un payload trebuie să fie un
 * `AuthCodePayload` COMPLET valid (base client_id/scopes/redirect_uri/PKCE/issued_at) — altfel `corrupt`:
 *   - `corrupt`       → non-obiect / base invalid / claim-uri user PARȚIALE sau greșit tipate → invalid_grant.
 *   - `user`          → base valid + TOATE claim-urile user valide → emite token user.
 *   - `legacy_client` → base valid + NICIUN câmp user → cod client-authorized dinainte de cutover. ⚠️ ROLLOUT-BOUNDED:
 *     codurile expiră în 5 min; DUPĂ fereastra de cutover, /token (10.4) trebuie să REFUZE `legacy_client` (gated pe
 *     un flag de cutover), altfel un `/authorize` care uită claim-urile ar emite silențios token client.
 *     `client_credentials` NU folosește authorization codes — deci nu e o cale permanentă legitimă.
 */
export type AuthCodeIdentity =
  | { kind: "user"; claims: UserAuthCodeClaims }
  | { kind: "legacy_client" }
  | { kind: "corrupt" };

export function readAuthCodeIdentity(payload: unknown): AuthCodeIdentity {
  // Fail-closed: doar un AuthCodePayload COMPLET valid poate fi clasificat (null/{}/base-incomplet → corrupt).
  if (!isAuthCodePayload(payload)) return { kind: "corrupt" };
  const o = payload as unknown as Record<string, unknown>;
  const anyPresent = o.user_id !== undefined || o.grant_id !== undefined || o.entitlement_version !== undefined;
  if (!anyPresent) return { kind: "legacy_client" }; // base valid, fără claim-uri user → cod legacy (rollout-bounded)
  const claims = { user_id: o.user_id, grant_id: o.grant_id, entitlement_version: o.entitlement_version };
  if (isUserAuthCodeClaims(claims)) return { kind: "user", claims };
  return { kind: "corrupt" }; // câmpuri user prezente dar incomplete/greșit tipate → fail-closed
}
