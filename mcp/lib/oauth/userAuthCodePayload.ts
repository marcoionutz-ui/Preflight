/**
 * lib/oauth/userAuthCodePayload.ts — PH-2 step 10.3b-iv frunză 2 (producătorul PUR al AuthCodePayload user-shaped).
 *
 * Frunză pură (zero I/O) → tsx-testabilă. La consimțământul unui USER pe `/authorize` (POST), DUPĂ ce
 * `decideConsentGrant` (10.3a) a produs un `OAuthGrant` validat, ruta trebuie să emită un authorization code care
 * poartă IDENTITATEA de user. Acest leaf asamblează blob-ul `AuthCodePayload` care va fi scris de `issueAuthCode`,
 * astfel încât `/token` (10.4) să-l citească drept `user` prin `readAuthCodeIdentity`.
 *
 * LEGAT DE TRANZACȚIE (cgpt — anti mix-up): builder-ul primește `grant` + `txn` (AuthzTransaction), NU stringuri de
 * transport libere. Dacă redirect_uri + PKCE ar veni ca parametri liberi, ruta ar putea combina accidental grantul/
 * userul tranzacției A cu redirectul + PKCE al tranzacției B → un cod perfect valid care ascunde un mix-up. Aici
 * TOTUL provine dintr-o singură tranzacție + grantul ei: transportul (redirect_uri/PKCE) din `txn`, iar identitatea +
 * scopes + resource din `grant`. ÎNAINTE de asamblare verificăm că grantul ȘI tranzacția descriu ACELAȘI consimțământ:
 *   - `txn.grant_id        === grant.grant_id`    (grant_id-ul sticky din txn = cel al grantului)
 *   - `txn.registration_id === grant.registration_id`
 *   - `txn.client_id       === grant.client_id`
 *   - `txn.session_user_id  === grant.user_id`   (tranzacția e legată de userul grantului)
 *   - `txn.resource         === grant.resource`  (audience-ul cerut = cel al grantului)
 *
 * Fail-closed:
 *   1. `isValidGrant(grant)` (formă completă: registration_id/created_at/user_id/... valide) → apoi `isGrantUsable`
 *      (status `active` + scopes ne-goale). Un grant corupt / revocat / fără scopes NU mintează cod.
 *   2. Cele 5 cross-check-uri txn↔grant (anti mix-up) — orice nepotrivire → error.
 *   3. `redirect_uri` (din txn) ne-gol; PKCE (din txn) valid RFC 7636 (S256) — re-verificat, nu ne bazăm orb pe txn.
 *   4. `issued_at` (injectat) număr finit.
 *   5. GUARD FINAL: blob-ul asamblat trebuie să treacă `isAuthCodePayload` DREPT user curat (toate 3 claim-urile) —
 *      altfel `error` (mai bine `server_error` la /authorize decât un cod pe care `/token` l-ar clasifica corrupt/legacy).
 * Nu aruncă — `{ ok, ... }`, ca ruta să facă redirect `server_error` curat.
 */

import { isAuthCodePayload, type AuthCodePayload } from "../db/oauthAtomic";
import { isValidGrant, isGrantUsable, type OAuthGrant } from "./grant";
import { type AuthzTransaction } from "./authzTransaction";
import { validateAuthorizeChallenge } from "./pkce";

function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isFiniteNum(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v); }

/**
 * Asamblează `AuthCodePayload`-ul user-shaped pentru `issueAuthCode`, LEGAT de o tranzacție. Transportul (redirect_uri/
 * PKCE) din `txn`; identitatea + scopes + resource din `grant`; `issued_at` injectat. Întoarce `{ ok:true, payload }`
 * sau `{ ok:false, error }` — NU aruncă.
 */
export function buildUserAuthCodePayload(p: {
  grant:     OAuthGrant;
  txn:       AuthzTransaction;
  issued_at: number;   // injectat
}): { ok: true; payload: AuthCodePayload } | { ok: false; error: string } {
  const { grant: g, txn } = p;

  // 1. Grant: formă completă validă (prinde registration_id/created_at/user_id corupte) → apoi utilizabil (status active + scopes).
  if (!isValidGrant(g))  return { ok: false, error: "grant invalid (formă coruptă)" };
  if (!isGrantUsable(g)) return { ok: false, error: "grant inutilizabil (status ≠ active sau scopes goale)" };

  // 2. Anti mix-up: grantul ȘI tranzacția trebuie să descrie ACELAȘI consimțământ (nu grant A + transport B).
  if (txn.grant_id        !== g.grant_id)        return { ok: false, error: "grant_id txn ≠ grant (mix-up)" };
  if (txn.registration_id !== g.registration_id) return { ok: false, error: "registration_id txn ≠ grant (mix-up)" };
  if (txn.client_id       !== g.client_id)       return { ok: false, error: "client_id txn ≠ grant (mix-up)" };
  if (txn.session_user_id !== g.user_id)         return { ok: false, error: "session_user_id txn ≠ user_id grant (mix-up)" };
  if (txn.resource        !== g.resource)        return { ok: false, error: "resource txn ≠ grant (mix-up)" };

  // 3. Transport DIN TXN. redirect_uri ne-gol; PKCE re-verificat (nu ne bazăm orb pe blob-ul din store).
  if (!isNonEmptyString(txn.redirect_uri)) return { ok: false, error: "redirect_uri lipsă în tranzacție" };
  const pkce = validateAuthorizeChallenge(txn.code_challenge, txn.code_challenge_method);
  if (!pkce.ok) return { ok: false, error: `PKCE invalid în tranzacție: ${pkce.reason}` };

  // 4. issued_at finit.
  if (!isFiniteNum(p.issued_at)) return { ok: false, error: "issued_at invalid" };

  // 5. Asamblare — identitatea/scopes/resource DIN GRANT (copie a scopes ca să nu partajăm referința), transport DIN TXN.
  const payload: AuthCodePayload = {
    client_id:             g.client_id,
    scopes:                [...g.scopes],
    redirect_uri:          txn.redirect_uri,
    code_challenge:        txn.code_challenge,
    code_challenge_method: txn.code_challenge_method,
    issued_at:             p.issued_at,
    resource:              g.resource,
    user_id:               g.user_id,
    grant_id:              g.grant_id,
    entitlement_version:   g.entitlement_version,
  };

  // GUARD FINAL fail-closed: blob valid ȘI user curat (all-or-nothing). Setăm mereu toate 3 claim-urile din grant, deci
  // `isAuthCodePayload` (care impune all-or-nothing) garantează clasificarea `user` la citire; dacă pică → refuzăm.
  if (!isAuthCodePayload(payload)) return { ok: false, error: "blob AuthCodePayload invalid după asamblare (fail-closed)" };

  return { ok: true, payload };
}
