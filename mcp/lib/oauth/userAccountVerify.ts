/**
 * lib/oauth/userAccountVerify.ts — PH-2 step 10.5a frunza 4a (verificarea CONTULUI pt. un token USER, PUR).
 *
 * Frunză pură (zero I/O) — contrapartea pe CONT a lui `verifyUserTokenGrant` (grantul e consimțământul pinnat la
 * emitere; contul e starea CURENTĂ). La `resolveAuth`, un access token USER e acceptat DOAR dacă entitlement-ul de cont
 * (`account_entitlements`, citit prin `getAccountEntitlement`) e (a) CITIBIL, (b) utilizabil (activ + are scopes) și
 * (c) la ACEEAȘI versiune ca tokenul. Discriminăm 503 (retry) de 401 (respins), ca restul lui `resolveAuth`:
 *   - lookup `unavailable` (Supabase jos) → 503 (NU 401 — contul poate exista; apelantul face retry apoi 503);
 *   - lookup `not_found` (0 rânduri) → 401 (cont fără entitlement → nu autorizăm);
 *   - `found` dar `entitlement.user_id` ≠ `user_id` al tokenului → 401 (verifierul e GRANIȚA fail-closed — confirmă
 *     EXPLICIT identitatea contului, nu se bazează pe faptul că `getAccountEntitlement` a filtrat după `user_id`; un
 *     adaptor care întoarce rândul altui user, activ + aceeași versiune, NU trebuie să scurgă planul/limitele/identitatea
 *     contului greșit — aceeași apărare ca `verifyUserTokenGrant`);
 *   - `found` dar `!isAccountUsable` (suspended/revoked/fără scopes) → 401 (acces retras);
 *   - `found` dar `entitlement_version` cont ≠ cel al tokenului → 401 (plan schimbat de la emitere = staleness real,
 *     cgpt: staleness-ul se prinde pe CONTUL CURENT, nu pe grant — grantul e pinnat la consimțământ);
 *   - `found` + utilizabil + versiune egală → ok (apelantul ia plan + rate-limits + subiect=cont din entitlement).
 *
 * Fail-closed: orice altă stare respinge. `entitlement.status` „active" e gate-ul de usable (ca `isAccountUsable`), NU
 * un simplu „există". PUR → tsx-testabil izolat.
 */

import type { AccountEntitlementLookup } from "../db/entitlementLookup";
import { isAccountUsable, type AccountEntitlement } from "./entitlement";

export type UserAccountDecision =
  | { ok: true;  entitlement: AccountEntitlement }
  | { ok: false; kind: "unavailable";  reason: string }   // 503 — backend jos, apelantul face retry
  | { ok: false; kind: "unauthorized"; reason: string };  // 401 — cont inexistent / suspendat / stale

export function verifyUserAccount(
  lookup:                  AccountEntitlementLookup,
  tokenUserId:             string,
  tokenEntitlementVersion: number,
): UserAccountDecision {
  if (lookup.status === "unavailable") return { ok: false, kind: "unavailable",  reason: "account entitlement unavailable: " + lookup.reason };
  if (lookup.status === "not_found")   return { ok: false, kind: "unauthorized", reason: "account has no entitlement" };
  const e = lookup.entitlement;
  // Granița fail-closed: confirmă EXPLICIT că entitlement-ul e al user-ului tokenului (nu te baza pe filtrul query-ului).
  if (e.user_id !== tokenUserId)       return { ok: false, kind: "unauthorized", reason: "account user_id mismatch (wrong account row)" };
  if (!isAccountUsable(e))             return { ok: false, kind: "unauthorized", reason: "account not usable (suspended/revoked/no scopes)" };
  if (e.entitlement_version !== tokenEntitlementVersion)
                                       return { ok: false, kind: "unauthorized", reason: "entitlement_version stale (plan changed since issuance)" };
  return { ok: true, entitlement: e };
}
