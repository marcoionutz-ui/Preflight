/**
 * lib/oauth/userRefreshPlan.test.ts — PH-2 step 10.5b (planificarea rotației refresh USER, pur).
 */
import { planUserRefreshRotation } from "./userRefreshPlan";
import { isUserTokenDraft } from "./tokenPayloadModel";
import { isUserRefreshDraft, type UserRefreshPayload } from "./refreshPayloadModel";
import type { OAuthGrant } from "./grant";
import type { AccountEntitlement } from "./entitlement";
import type { GrantLookup } from "../db/grantLookup";
import type { AccountEntitlementLookup } from "../db/entitlementLookup";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const AUD = "https://x/api/mcp";
const refresh: UserRefreshPayload = {
  subject_kind: "user", client_id: "c1", user_id: "u1", grant_id: "g1", entitlement_version: 2,
  scopes: ["read:pair", "read:market"], audience: AUD, issued_at: 1, family_id: "f1",
};
const grant: OAuthGrant = {
  grant_id: "g1", registration_id: "r1", client_id: "c1", user_id: "u1", resource: AUD,
  scopes: ["read:pair", "read:market"], entitlement_version: 2, status: "active", created_at: "2026-01-01T00:00:00Z",
};
const ent: AccountEntitlement = {
  user_id: "u1", plan: "pro", scopes: ["read:pair", "read:market"],
  rate_limit_per_minute: 60, rate_limit_per_day: 10000, status: "active", entitlement_version: 2,
};
const POLICY = ["read:pair", "read:market"];
const gFound: GrantLookup = { status: "found", grant };
const aFound: AccountEntitlementLookup = { status: "found", entitlement: ent };

const plan = (over: Partial<Parameters<typeof planUserRefreshRotation>[0]> = {}) =>
  planUserRefreshRotation({ refresh, grantLookup: gFound, accountLookup: aFound, requestedScopes: undefined, serverPolicy: POLICY, issuedAt: 99, ...over });

function main(): void {
console.log("PH-2 step 10.5b — planUserRefreshRotation (pur)");

// ── happy path ───────────────────────────────────────────────────────────────────
const ok = plan();
check("1. ⭐⭐⭐ refresh user valid pe grant+cont → rotate", ok.kind === "rotate");
check("2. ⭐⭐⭐ accessDraft e UserTokenDraft (subject_kind user, FĂRĂ family_id/credential_version)",
  ok.kind === "rotate" && isUserTokenDraft(ok.accessDraft));
check("3. ⭐⭐⭐ refreshDraft e UserRefreshDraft (subject_kind user, FĂRĂ family_id)",
  ok.kind === "rotate" && isUserRefreshDraft(ok.refreshDraft));
check("4. ⭐⭐ draft-urile păstrează identitatea (user_id/grant_id/client_id/audience/entitlement_version)",
  ok.kind === "rotate" && ok.accessDraft.user_id === "u1" && ok.accessDraft.grant_id === "g1"
  && ok.accessDraft.client_id === "c1" && ok.accessDraft.audience === AUD && ok.accessDraft.entitlement_version === 2);
check("5. ⭐⭐ issued_at injectat (99)", ok.kind === "rotate" && ok.accessDraft.issued_at === 99 && ok.refreshDraft.issued_at === 99);
check("6. ⭐ scopes = păstrate (requested gol → refresh.scopes ∩ cont ∩ policy)",
  ok.kind === "rotate" && JSON.stringify(ok.scopes) === JSON.stringify(["read:pair", "read:market"]));
check("6a. ⭐⭐ accessDraft.scopes === plan.scopes (effective); refreshDraft.scopes === refresh.scopes original (happy path egale aici)",
  ok.kind === "rotate" && JSON.stringify(ok.accessDraft.scopes) === JSON.stringify(ok.scopes)
  && JSON.stringify(ok.refreshDraft.scopes) === JSON.stringify(["read:pair", "read:market"]));

// ── grant ──────────────────────────────────────────────────────────────────────
check("7. ⭐⭐⭐ grant not_found → reject (consimțământ șters → invalid_grant)", plan({ grantLookup: { status: "not_found" } }).kind === "reject");
check("8. ⭐⭐⭐ grant unavailable → unavailable (503, NU reject)", plan({ grantLookup: { status: "unavailable", reason: "down" } }).kind === "unavailable");
check("9. ⭐⭐⭐ grant REVOCAT → reject", plan({ grantLookup: { status: "found", grant: { ...grant, status: "revoked" } } }).kind === "reject");

// ── cont ───────────────────────────────────────────────────────────────────────
check("10. ⭐⭐⭐ cont not_found → reject", plan({ accountLookup: { status: "not_found" } }).kind === "reject");
check("11. ⭐⭐⭐ cont unavailable → unavailable (503)", plan({ accountLookup: { status: "unavailable", reason: "down" } }).kind === "unavailable");
check("12. ⭐⭐⭐ entitlement_version cont ≠ refresh → reject (plan schimbat → re-auth forțată)",
  plan({ accountLookup: { status: "found", entitlement: { ...ent, entitlement_version: 3 } } }).kind === "reject");
check("13. ⭐⭐⭐ cont SUSPENDED → reject", plan({ accountLookup: { status: "found", entitlement: { ...ent, status: "suspended" } } }).kind === "reject");
check("14. ⭐⭐ user_id cont ≠ refresh → reject", plan({ accountLookup: { status: "found", entitlement: { ...ent, user_id: "u2" } } }).kind === "reject");

// ── scope narrowing / clamp ──────────────────────────────────────────────────────
check("15. ⭐⭐⭐ escaladare (cere scope ce refresh nu are) → reject", plan({ requestedScopes: ["read:pair", "admin:all"] }).kind === "reject");
check("16. ⭐⭐ subset cerut → narrowed la subset (plan.scopes = access effective)", (() => { const r = plan({ requestedScopes: ["read:pair"] }); return r.kind === "rotate" && JSON.stringify(r.scopes) === JSON.stringify(["read:pair"]); })());
check("16a. ⭐⭐⭐ FĂRĂ îngustare PERMANENTĂ (regula PH-4): cerut doar read:pair → access DRAFT doar read:pair, REFRESH draft PĂSTREAZĂ read:pair+read:market",
  (() => { const r = plan({ requestedScopes: ["read:pair"] });
    return r.kind === "rotate"
      && JSON.stringify(r.accessDraft.scopes)  === JSON.stringify(["read:pair"])
      && JSON.stringify(r.refreshDraft.scopes) === JSON.stringify(["read:pair", "read:market"]); })());
check("17. ⭐⭐⭐ policy retrage read:market → clamp îl scoate din ACCESS (rămâne read:pair)",
  (() => { const r = plan({ serverPolicy: ["read:pair"] }); return r.kind === "rotate" && JSON.stringify(r.scopes) === JSON.stringify(["read:pair"]); })());
check("17a. ⭐⭐⭐ policy retrage TEMPORAR read:market → REFRESH draft tot păstrează read:pair+read:market (re-emitere când policy revine)",
  (() => { const r = plan({ serverPolicy: ["read:pair"] });
    return r.kind === "rotate"
      && JSON.stringify(r.accessDraft.scopes)  === JSON.stringify(["read:pair"])
      && JSON.stringify(r.refreshDraft.scopes) === JSON.stringify(["read:pair", "read:market"]); })());
check("18. ⭐⭐⭐ policy retrage TOT → reject (no usable scopes after clamp)", plan({ serverPolicy: ["admin:only"] }).kind === "reject");
check("19. ⭐⭐ cont restrâns (nu mai are read:market) → clamp la ce mai acoperă contul",
  (() => { const r = plan({ accountLookup: { status: "found", entitlement: { ...ent, scopes: ["read:pair"] } } }); return r.kind === "rotate" && JSON.stringify(r.scopes) === JSON.stringify(["read:pair"]); })());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
