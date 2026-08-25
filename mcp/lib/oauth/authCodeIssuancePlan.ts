/**
 * lib/oauth/authCodeIssuancePlan.ts — PH-2 step 10.4b (planner PUR de emitere la /token auth-code).
 *
 * Frunză pură (zero I/O) → tsx-testabilă. La `/token` grant `authorization_code`, DUPĂ ce ruta a validat deja tot
 * (peek cod / client_id match / redirect match / PKCE / client activ), acest planner decide CE token se emite,
 * din IDENTITATEA codului (`readAuthCodeIdentity`, 10.2) + un flag de cutover:
 *   - `user`   → cod cu identitate de user (subject_kind=user embed în cod la /authorize): construiește DRAFT-urile
 *                de access + refresh USER (fără `family_id` — se generează la emiterea atomică; ruta face finalize).
 *   - `legacy` → cod client-authorized de dinainte de cutover: forma de AZI (TokenPayload client-shaped), IDENTICĂ
 *                cu emiterea curentă → zero schimbare de comportament pentru codurile în zbor.
 *   - `reject` → `invalid_grant`: intrare comună invalidă (clientId gol / audience gol / issuedAt ne-finit), MISMATCH
 *                de client (codul aparține altui client decât cel autentificat — anti client-substitution), cod corupt
 *                (fail-closed), `legacy` fără credential_version SAU refuzat sub cutover (`rejectLegacy=true`), SAU cod
 *                user cu scopes murdare (nu emitem token user care „nu autorizează nimic"). Plannerul e TOTAL (nu aruncă).
 *
 * Flag-ul de cutover (`rejectLegacy`) e citit din env ÎN RUTĂ (bool injectat) → planner-ul rămâne pur. `issuedAt`,
 * `audience` (resursa canonică legată în cod), `credentialVersion` (secret_rotated_at, DOAR pt. forma legacy/client)
 * sunt injectate de rută. Scope-urile user vin din `payload.scopes` (rezolvate la CONSIMȚĂMÂNT în 10.3a — planner-ul
 * NU le re-rezolvă), dar le validăm fail-closed (array ne-gol de string-uri ne-goale) înainte de a emite.
 *
 * NB: DRAFT-urile user NU au `family_id`; ruta (10.4c) generează familia în emiterea atomică și cheamă
 * `finalizeUserTokenPayload` / `finalizeUserRefreshPayload`. Un token/refresh user STOCAT fără familie ar fi
 * nerevocabil → de aceea finalize-ul e la I/O, nu aici.
 */

import type { AuthCodePayload } from "../db/oauthAtomic";
import type { TokenPayload } from "../db/oauth-tokens";
import { readAuthCodeIdentity } from "./authGrantIssuance";
import { buildUserTokenDraft, type UserTokenDraft } from "./tokenPayloadModel";
import { buildUserRefreshDraft, type UserRefreshDraft } from "./refreshPayloadModel";

/** Planul de emitere: forma user (drafturi), forma legacy (payload client de azi), sau respingere `invalid_grant`. */
export type AuthCodeIssuancePlan =
  | { kind: "user";   accessDraft: UserTokenDraft; refreshDraft: UserRefreshDraft }
  | { kind: "legacy"; access: TokenPayload }
  | { kind: "reject"; error: "invalid_grant"; reason: string };

/** Scopes utilizabile = array ne-gol de string-uri ne-goale DUPĂ trim (fail-closed; consimțământul le curăță deja, dar nu ne bazăm orb). */
function isCleanScopeList(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(s => typeof s === "string" && s.trim().length > 0);
}

/** Ajutor: respingere `invalid_grant` cu motiv (pentru log-ul rutei). */
function reject(reason: string): AuthCodeIssuancePlan {
  return { kind: "reject", error: "invalid_grant", reason };
}

/**
 * Mapează un cod validat + flag-ul de cutover → planul de emitere. PUR, fail-closed. `payload` e deja validat de rută
 * (via `peekAuthCode`), dar `readAuthCodeIdentity` RE-verifică defensiv (null/base-invalid/parțial → corrupt).
 */
export function planAuthCodeTokenIssuance(p: {
  payload:           AuthCodePayload;
  clientId:          string;   // clientul autentificat (== payload.client_id, verificat deja în rută)
  credentialVersion: string;   // client.secret_rotated_at — folosit DOAR pe forma legacy/client
  audience:          string;   // resursa canonică legată în cod (boundAudience din rută)
  issuedAt:          number;
  rejectLegacy:      boolean;  // cutover: după rollout, codurile legacy nu mai sunt acceptate
}): AuthCodeIssuancePlan {
  // ── VALIDARE INTRĂRI COMUNE (fail-closed, NU aruncă) — se aplică ambelor forme (user + legacy) ──────────────
  // Clientul autentificat trebuie să fie prezent și tokenul se emite pentru EL.
  if (typeof p.clientId !== "string" || p.clientId.length === 0) {
    return reject("authenticated client_id is missing");
  }
  // audience (resursa canonică legată în cod) obligatorie — un token fără audience e respins de resolveAuth (PH-3).
  if (typeof p.audience !== "string" || p.audience.length === 0) {
    return reject("bound audience is missing");
  }
  // issued_at trebuie să fie număr finit (NaN/Infinity ar produce un token cu timestamp corupt).
  if (typeof p.issuedAt !== "number" || !Number.isFinite(p.issuedAt)) {
    return reject("issued_at is not a finite number");
  }

  const identity = readAuthCodeIdentity(p.payload);

  // Cod corupt (non-obiect / base invalid / claim-uri user parțiale) → invalid_grant (fail-closed).
  // NB: DUPĂ acest gate `p.payload` e garantat un AuthCodePayload valid (isAuthCodePayload a trecut), deci
  // `p.payload.client_id` e un string ne-gol — sigur de comparat mai jos.
  if (identity.kind === "corrupt") {
    return reject("authorization code identity is malformed");
  }

  // ── CLIENT SUBSTITUTION (blocker cgpt): tokenul se emite pentru clientul AUTENTIFICAT; codul TREBUIE să aparțină
  // aceluiași client. Ruta verifică deja asta, dar plannerul e o GRANIȚĂ de emitere → refuză singur mismatch-ul
  // (ambele forme), ca o cablare viitoare greșită să NU poată emite token pentru clientul B din codul clientului A.
  if (p.payload.client_id !== p.clientId) {
    return reject("authorization code client_id does not match authenticated client");
  }

  // Cod client-authorized (legacy, dinainte de cutover). Rollout-bounded: sub cutover îl REFUZĂM.
  if (identity.kind === "legacy_client") {
    if (p.rejectLegacy) {
      return reject("legacy client authorization codes are no longer accepted");
    }
    // credential_version (secret_rotated_at) obligatoriu pe forma client — rotația secretului forțează reauth (10.5).
    if (typeof p.credentialVersion !== "string" || p.credentialVersion.length === 0) {
      return reject("credential version is missing for legacy client issuance");
    }
    // Forma de AZI, byte-identică cu emiterea curentă (client-shaped, fără subject_kind → LegacyClientTokenPayload).
    const access: TokenPayload = {
      client_id:          p.clientId,
      scopes:             p.payload.scopes,
      issued_at:          p.issuedAt,
      credential_version: p.credentialVersion,
      audience:           p.audience,
    };
    return { kind: "legacy", access };
  }

  // Cod cu identitate de USER. Scope-urile (rezolvate la consimțământ) trebuie să fie utilizabile — altfel fail-closed.
  if (!isCleanScopeList(p.payload.scopes)) {
    return reject("authorization code has no usable scopes");
  }

  // Buildere fail-closed; intrările sunt deja validate (identity.claims all-or-nothing + audience/issuedAt/scopes),
  // deci în practică NU aruncă. Le încadrăm defensiv în try/catch → plannerul rămâne TOTAL (niciodată throw).
  try {
    const accessDraft = buildUserTokenDraft({
      user_id:             identity.claims.user_id,
      grant_id:            identity.claims.grant_id,
      entitlement_version: identity.claims.entitlement_version,
      client_id:           p.clientId,
      scopes:              p.payload.scopes,
      issued_at:           p.issuedAt,
      audience:            p.audience,
    });
    const refreshDraft = buildUserRefreshDraft({
      client_id:           p.clientId,
      user_id:             identity.claims.user_id,
      grant_id:            identity.claims.grant_id,
      entitlement_version: identity.claims.entitlement_version,
      scopes:              p.payload.scopes,
      audience:            p.audience,
      issued_at:           p.issuedAt,
    });
    return { kind: "user", accessDraft, refreshDraft };
  } catch (err) {
    return reject("failed to build user token drafts: " + (err instanceof Error ? err.message : "unknown"));
  }
}
