/**
 * lib/oauth/userRefreshPlan.ts — PH-2 step 10.5b (planificarea rotației unui refresh USER, PUR).
 *
 * Frunză pură (zero I/O) — „creierul" căii de refresh user din `/token` (grant_type=refresh_token). Un refresh USER
 * NU se validează pe `credential_version` (clientul e public, fără secret), ci pe DOUĂ axe (ca `resolveAuth` la 10.5a),
 * reutilizând ACELEAȘI verifiere pure:
 *   1. GRANT (`verifyUserTokenGrant`) — consimțământul pinnat la emitere e ACTIV + consistent cu claim-urile refresh-ului.
 *   2. CONT (`verifyUserAccount`) — starea CURENTĂ: utilizabil + `entitlement_version` egal (plan schimbat → reject:
 *      re-autorizare forțată; cgpt 10.5c: „entitlement_version change → access ȘI refresh respinse").
 * Scope narrowing (cgpt P2): `narrowScopes(requested, refresh.scopes)` (fără escaladare peste grantul original) apoi
 * `clampScopes(…, account, serverPolicy)` (grant∩cont∩policy CURENTE — o policy care retrage un scope îl scoate la refresh).
 * IMPORTANT (regula PH-4, fără îngustare PERMANENTĂ): ACCESS-ul nou primește scope-ul `effective` (restrâns), dar
 * REFRESH-ul rotit păstrează `refresh.scopes` (scope-ul ORIGINAL al lanțului) — altfel un singur refresh cu scope
 * îngust ar șterge permanent restul, deși fusese acordat la consimțământ. O policy care retrage TEMPORAR un scope
 * afectează doar access-ul curent; când policy-ul îl repune, refresh-ul următor îl poate re-emite.
 * Fail-closed: grant/cont `unavailable` → 503 (retry în rută); orice reject → invalid_grant (401). Planner TOTAL
 * (build-ul draft-urilor în try/catch → reject, deși intrările validate nu ar trebui să arunce).
 *
 * Output = DRAFT-uri (fără family_id) — rotația (`rotateRefreshToken`) le finalizează cu ACELAȘI `family_id` al lanțului
 * (păstrat de apelant din refresh-ul curent) și emite atomic noile access+refresh.
 */

import type { UserRefreshPayload } from "./refreshPayloadModel";
import { buildUserRefreshDraft, type UserRefreshDraft } from "./refreshPayloadModel";
import { buildUserTokenDraft, type UserTokenDraft } from "./tokenPayloadModel";
import { verifyUserTokenGrant } from "./userTokenGrantVerify";
import { verifyUserAccount } from "./userAccountVerify";
import { clampScopes } from "./entitlement";
import { narrowScopes } from "../db/oauthAtomic";
import type { GrantLookup } from "../db/grantLookup";
import type { AccountEntitlementLookup } from "../db/entitlementLookup";

export type UserRefreshRotationPlan =
  | { kind: "rotate"; accessDraft: UserTokenDraft; refreshDraft: UserRefreshDraft; scopes: string[] }
  | { kind: "reject";      reason: string }  // → invalid_grant (401)
  | { kind: "unavailable"; reason: string }; // → 503 (retry în rută)

export function planUserRefreshRotation(p: {
  refresh:         UserRefreshPayload;         // refresh STOCAT (poartă family_id — dar draft-urile nu-l poartă)
  grantLookup:     GrantLookup;
  accountLookup:   AccountEntitlementLookup;
  requestedScopes: string[] | undefined;       // scope-urile cerute la refresh (goale = păstrează refresh.scopes)
  serverPolicy:    string[];
  issuedAt:        number;
}): UserRefreshRotationPlan {
  const rp = p.refresh;

  // 1. GRANT — consimțământul pinnat. unavailable → 503; not_found/reject → invalid_grant.
  if (p.grantLookup.status === "unavailable") return { kind: "unavailable", reason: "grant lookup unavailable: " + p.grantLookup.reason };
  if (p.grantLookup.status === "not_found")   return { kind: "reject", reason: "grant no longer exists" };
  const gv = verifyUserTokenGrant({
    grant:              p.grantLookup.grant,
    grantId:            rp.grant_id,
    userId:             rp.user_id,
    clientId:           rp.client_id,
    audience:           rp.audience,
    entitlementVersion: rp.entitlement_version,
    scopes:             rp.scopes,
  });
  if (!gv.ok) return { kind: "reject", reason: "grant no longer valid: " + gv.reason };

  // 2. CONT — starea curentă. unavailable → 503; reject → invalid_grant.
  const av = verifyUserAccount(p.accountLookup, rp.user_id, rp.entitlement_version);
  if (!av.ok && av.kind === "unavailable") return { kind: "unavailable", reason: av.reason };
  if (!av.ok)                              return { kind: "reject", reason: "account not valid: " + av.reason };
  const account = av.entitlement;

  // 3. SCOPE narrowing: fără escaladare peste grantul original, apoi clamp la grant∩cont∩policy CURENTE.
  const narrowed = narrowScopes(p.requestedScopes, rp.scopes);
  if (narrowed.status !== "ok") return { kind: "reject", reason: narrowed.reason };
  const effective = clampScopes(narrowed.scopes, account.scopes, p.serverPolicy);
  if (effective.length === 0)   return { kind: "reject", reason: "no usable scopes after clamp (policy/account retracted)" };

  // 4. DRAFT-uri. ACCESS = `effective` (restrâns). REFRESH = `rp.scopes` (ORIGINAL al lanțului — fără îngustare
  //    permanentă, regula PH-4). TOTAL: build în try/catch.
  try {
    const accessDraft = buildUserTokenDraft({
      user_id: rp.user_id, grant_id: rp.grant_id, entitlement_version: rp.entitlement_version, client_id: rp.client_id,
      scopes: effective, issued_at: p.issuedAt, audience: rp.audience,
    });
    const refreshDraft = buildUserRefreshDraft({
      client_id: rp.client_id, user_id: rp.user_id, grant_id: rp.grant_id, entitlement_version: rp.entitlement_version,
      scopes: rp.scopes, audience: rp.audience, issued_at: p.issuedAt,
    });
    return { kind: "rotate", accessDraft, refreshDraft, scopes: effective };
  } catch (e) {
    return { kind: "reject", reason: "draft build failed: " + (e instanceof Error ? e.message : "unknown") };
  }
}
