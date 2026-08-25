/**
 * lib/oauth/userTokenGrantVerify.ts — PH-2 step 10.5a (cross-check token USER ↔ grant persistat, PUR).
 *
 * Frunză pură (zero I/O). La `resolveAuth`, un access token USER e acceptat DOAR dacă grantul din care provine
 * (`oauth_grants`, rezolvat prin `getGrantById`) e ACTIV și consistent cu claim-urile tokenului. Verifică (fail-closed,
 * orice nepotrivire → reject → 401):
 *   - `grant_id` grantului === `grant_id` al tokenului (verifierul e GRANIȚA fail-closed — confirmă explicit, nu se
 *     bazează pe faptul că lookup-ul a căutat după ID);
 *   - status grantului === `active` (revoked/inactive → consent tăiat → respins);
 *   - `user_id` grantului === user-ul tokenului;
 *   - `client_id` grantului === clientul tokenului (anti client-substitution la citire);
 *   - `resource` grantului === `audience` tokenului (RFC 8707 — tokenul e legat de resursa grantului);
 *   - `entitlement_version` grantului === cel al tokenului (consistență de emitere; staleness vs CONT se verifică separat);
 *   - scope-urile tokenului ⊆ scope-urile grantului (tokenul NU poate depăși ce a acordat resource-owner-ul).
 *
 * NB (cgpt): staleness-ul real (schimbare de plan) e `account.entitlement_version !== token.entitlement_version`,
 * verificat în `resolveAuth` pe entitlement-ul CURENT al contului. Aici verificăm consistența token↔grant (ambele
 * pinnate la consimțământ) — dacă diferă, e corupție/manipulare → reject.
 */

import type { OAuthGrant } from "./grant";

export type GrantVerifyResult = { ok: true } | { ok: false; reason: string };

/** Scope-uri de token utilizabile: array ne-gol de string-uri ne-goale după trim (boundary de citire: respinge blob corupt). */
function isCleanTokenScopes(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(s => typeof s === "string" && s.trim() !== "");
}

export function verifyUserTokenGrant(p: {
  grant:              OAuthGrant;
  grantId:            string;
  userId:             string;
  clientId:           string;
  audience:           string;
  entitlementVersion: number;
  scopes:             string[];
}): GrantVerifyResult {
  const g = p.grant;
  if (g.grant_id !== p.grantId)                    return { ok: false, reason: "grant_id mismatch (wrong grant)" };
  if (g.status !== "active")                       return { ok: false, reason: "grant not active (revoked/inactive)" };
  if (g.user_id !== p.userId)                      return { ok: false, reason: "grant user_id mismatch" };
  if (g.client_id !== p.clientId)                  return { ok: false, reason: "grant client_id mismatch" };
  if (g.resource !== p.audience)                   return { ok: false, reason: "grant resource != token audience" };
  if (g.entitlement_version !== p.entitlementVersion) return { ok: false, reason: "grant entitlement_version mismatch" };
  // Hardening: scope-urile tokenului trebuie să fie ne-goale + curate ÎNAINTE de subset (un token cu scopes [] sau cu
  // element gol/whitespace nu autorizează nimic și n-ar trebui acceptat ca „subset trivial valid").
  if (!isCleanTokenScopes(p.scopes))               return { ok: false, reason: "token scopes empty or malformed" };
  const granted = new Set(g.scopes);
  const escalated = p.scopes.filter(s => !granted.has(s));
  if (escalated.length > 0)                        return { ok: false, reason: "token scopes exceed grant: " + escalated.join(",") };
  return { ok: true };
}
