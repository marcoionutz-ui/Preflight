/**
 * lib/oauth/authCodeIssuancePlan.test.ts — PH-2 step 10.4b (planner emitere /token auth-code, pur).
 *
 * KEY: user → drafturi access+refresh USER (fără family_id, subject_kind=user, FĂRĂ credential_version); legacy →
 * TokenPayload client-shaped de AZI (cu credential_version, fără subject_kind); reject → invalid_grant (corupt /
 * legacy sub cutover / user fără scopes utilizabile). Cutover-ul refuză DOAR legacy, niciodată user.
 */
import { planAuthCodeTokenIssuance } from "./authCodeIssuancePlan";
import { isUserTokenDraft } from "./tokenPayloadModel";
import { isUserRefreshDraft } from "./refreshPayloadModel";
import type { AuthCodePayload } from "../db/oauthAtomic";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const base: AuthCodePayload = {
  client_id: "c1", scopes: ["read:pair"], redirect_uri: "https://claude.ai/cb",
  code_challenge: "cc", code_challenge_method: "S256", issued_at: 1, resource: "https://x/api/mcp",
};
const userCode: AuthCodePayload = { ...base, user_id: "u1", grant_id: "g1", entitlement_version: 2 };
const AUD = "https://x/api/mcp";
const inp = { clientId: "c1", credentialVersion: "cv1", audience: AUD, issuedAt: 999, rejectLegacy: false };

function main(): void {
console.log("PH-2 step 10.4b — planAuthCodeTokenIssuance (pur)");

// ── USER: drafturi valide, fără family, cu identitate ─────────────────────────────
{
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: userCode });
  check("1. ⭐⭐⭐ cod user → plan.kind='user'", plan.kind === "user");
  if (plan.kind === "user") {
    check("2. ⭐⭐⭐ accessDraft e UserTokenDraft valid (fără family_id)", isUserTokenDraft(plan.accessDraft));
    check("3. ⭐⭐⭐ refreshDraft e UserRefreshDraft valid (fără family_id)", isUserRefreshDraft(plan.refreshDraft));
    check("4. ⭐⭐⭐ accessDraft.subject_kind='user'", plan.accessDraft.subject_kind === "user");
    check("5. ⭐⭐⭐ accessDraft FĂRĂ family_id", (plan.accessDraft as { family_id?: unknown }).family_id === undefined);
    check("6. ⭐⭐⭐ refreshDraft FĂRĂ family_id", (plan.refreshDraft as { family_id?: unknown }).family_id === undefined);
    check("7. ⭐⭐⭐ accessDraft FĂRĂ credential_version (interzis pe user)", (plan.accessDraft as { credential_version?: unknown }).credential_version === undefined);
    check("8. ⭐⭐⭐ refreshDraft FĂRĂ credential_version", (plan.refreshDraft as { credential_version?: unknown }).credential_version === undefined);
    check("9. ⭐⭐⭐ claims propagate (access: user_id/grant_id/version)", plan.accessDraft.user_id === "u1" && plan.accessDraft.grant_id === "g1" && plan.accessDraft.entitlement_version === 2);
    check("10. ⭐⭐⭐ claims propagate (refresh: user_id/grant_id/version)", plan.refreshDraft.user_id === "u1" && plan.refreshDraft.grant_id === "g1" && plan.refreshDraft.entitlement_version === 2);
    check("11. ⭐⭐ audience = boundAudience injectat (nu payload.resource orb)", plan.accessDraft.audience === AUD && plan.refreshDraft.audience === AUD);
    check("12. ⭐⭐ scopes din cod propagate", plan.accessDraft.scopes[0] === "read:pair" && plan.refreshDraft.scopes[0] === "read:pair");
    check("13. ⭐⭐ client_id = clientul AUTENTIFICAT injectat", plan.accessDraft.client_id === "c1" && plan.refreshDraft.client_id === "c1");
    check("14. ⭐⭐ issued_at injectat (999)", plan.accessDraft.issued_at === 999 && plan.refreshDraft.issued_at === 999);
  }
}

// ── USER emis CHIAR sub cutover (rejectLegacy afectează DOAR legacy) ──────────────
{
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: userCode, rejectLegacy: true });
  check("15. ⭐⭐⭐ cod user + rejectLegacy=true → TOT user (cutover nu blochează user)", plan.kind === "user");
}

// ── LEGACY: forma client de AZI, byte-compat ──────────────────────────────────────
{
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: base });
  check("16. ⭐⭐⭐ cod fără claim-uri user + rejectLegacy=false → plan.kind='legacy'", plan.kind === "legacy");
  if (plan.kind === "legacy") {
    check("17. ⭐⭐⭐ access.client_id = clientul autentificat", plan.access.client_id === "c1");
    check("18. ⭐⭐⭐ access.credential_version injectat (forma client)", plan.access.credential_version === "cv1");
    check("19. ⭐⭐⭐ access.audience = boundAudience", plan.access.audience === AUD);
    check("20. ⭐⭐ access.scopes din cod", plan.access.scopes[0] === "read:pair");
    check("21. ⭐⭐ access.issued_at injectat", plan.access.issued_at === 999);
    check("22. ⭐⭐⭐ access FĂRĂ subject_kind (legacy client-shaped)", (plan.access as { subject_kind?: unknown }).subject_kind === undefined);
    check("23. ⭐⭐ access FĂRĂ family_id (emiterea inițială o adaugă la I/O)", (plan.access as { family_id?: unknown }).family_id === undefined);
  }
}

// ── CUTOVER: legacy refuzat ───────────────────────────────────────────────────────
{
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: base, rejectLegacy: true });
  check("24. ⭐⭐⭐ cod legacy + rejectLegacy=true → reject invalid_grant", plan.kind === "reject" && plan.error === "invalid_grant");
}

// ── CORUPT: fail-closed ───────────────────────────────────────────────────────────
{
  // parțial: user_id fără grant_id → isAuthCodePayload false → readAuthCodeIdentity corrupt
  const partial = { ...base, user_id: "u1" } as unknown as AuthCodePayload;
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: partial });
  check("25. ⭐⭐⭐ cod cu claim-uri user PARȚIALE → reject invalid_grant (corupt)", plan.kind === "reject" && plan.error === "invalid_grant");
}
{
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: null as unknown as AuthCodePayload });
  check("26. ⭐⭐⭐ payload null → reject invalid_grant (corupt)", plan.kind === "reject" && plan.error === "invalid_grant");
}
{
  // base invalid (fără redirect_uri) + claim-uri user complete → corrupt (base contează)
  const badBase = { ...userCode, redirect_uri: "" } as unknown as AuthCodePayload;
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: badBase });
  check("27. ⭐⭐ base invalid + claim-uri complete → reject (base contează)", plan.kind === "reject");
}

// ── USER cu scopes murdare → fail-closed (defensiv; consimțământul le curăță deja) ──
{
  const noScopes = { ...userCode, scopes: [] } as AuthCodePayload;
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: noScopes });
  check("28. ⭐⭐⭐ cod user cu scopes [] → reject invalid_grant (no usable scopes)", plan.kind === "reject" && plan.error === "invalid_grant");
}
{
  const emptyStr = { ...userCode, scopes: ["read:pair", ""] } as AuthCodePayload;
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: emptyStr });
  check("29. ⭐⭐⭐ cod user cu scope gol ('') → reject invalid_grant", plan.kind === "reject" && plan.error === "invalid_grant");
}
{
  // legacy cu scopes [] NU e respins aici (compat: forma de azi acceptă; resolveAuth oricum n-ar autoriza nimic)
  const legacyNoScopes = { ...base, scopes: [] } as AuthCodePayload;
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: legacyNoScopes });
  check("30. ⭐⭐ legacy cu scopes [] → TOT legacy (nu schimbăm comportamentul codurilor client în zbor)", plan.kind === "legacy");
}

// ── CLIENT SUBSTITUTION (blocker cgpt): cod al clientului A + clientId autentificat B → reject (user ȘI legacy) ──
{
  const plan = planAuthCodeTokenIssuance({ ...inp, clientId: "B", payload: userCode }); // userCode.client_id = "c1"
  check("31. ⭐⭐⭐ cod USER al clientului c1 + clientId autentificat B → reject (client substitution)", plan.kind === "reject" && plan.error === "invalid_grant");
}
{
  const plan = planAuthCodeTokenIssuance({ ...inp, clientId: "B", payload: base }); // base.client_id = "c1"
  check("32. ⭐⭐⭐ cod LEGACY al clientului c1 + clientId autentificat B → reject (client substitution)", plan.kind === "reject" && plan.error === "invalid_grant");
}
{
  // control: match corect → NU reject (nu am spart calea validă)
  const plan = planAuthCodeTokenIssuance({ ...inp, clientId: "c1", payload: userCode });
  check("33. ⭐⭐ control: client_id se potrivește → NU reject", plan.kind === "user");
}

// ── FAIL-CLOSED pe intrări comune → reject FĂRĂ throw (nu payload invalid) ────────
{
  let threw = false, plan;
  try { plan = planAuthCodeTokenIssuance({ ...inp, audience: "", payload: userCode }); } catch { threw = true; }
  check("34. ⭐⭐⭐ audience gol (user) → reject, FĂRĂ throw", !threw && plan!.kind === "reject");
}
{
  let threw = false, plan;
  try { plan = planAuthCodeTokenIssuance({ ...inp, audience: "", payload: base }); } catch { threw = true; }
  check("35. ⭐⭐⭐ audience gol (legacy) → reject, FĂRĂ throw (nu emite payload cu audience gol)", !threw && plan!.kind === "reject");
}
{
  let threw = false, plan;
  try { plan = planAuthCodeTokenIssuance({ ...inp, issuedAt: NaN, payload: base }); } catch { threw = true; }
  check("36. ⭐⭐⭐ issuedAt=NaN (legacy) → reject, FĂRĂ throw", !threw && plan!.kind === "reject");
}
{
  let threw = false, plan;
  try { plan = planAuthCodeTokenIssuance({ ...inp, issuedAt: Infinity, payload: userCode }); } catch { threw = true; }
  check("37. ⭐⭐ issuedAt=Infinity (user) → reject, FĂRĂ throw", !threw && plan!.kind === "reject");
}
{
  const plan = planAuthCodeTokenIssuance({ ...inp, clientId: "", payload: base });
  check("38. ⭐⭐ clientId autentificat gol → reject", plan.kind === "reject");
}

// ── LEGACY fără credential_version → reject (forma client cere secret_rotated_at) ──
{
  const plan = planAuthCodeTokenIssuance({ ...inp, credentialVersion: "", payload: base });
  check("39. ⭐⭐⭐ legacy cu credentialVersion gol → reject invalid_grant", plan.kind === "reject" && plan.error === "invalid_grant");
}
{
  // dar user NU depinde de credentialVersion → tot user chiar cu credentialVersion gol
  const plan = planAuthCodeTokenIssuance({ ...inp, credentialVersion: "", payload: userCode });
  check("40. ⭐⭐ user cu credentialVersion gol → TOT user (credential_version irelevant pe user)", plan.kind === "user");
}

// ── USER cu scope whitespace-only → reject (trim, nu doar length) ─────────────────
{
  const wsScope = { ...userCode, scopes: [" "] } as AuthCodePayload;
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: wsScope });
  check("41. ⭐⭐⭐ user cu scope whitespace-only (' ') → reject (trim, nu doar length>0)", plan.kind === "reject" && plan.error === "invalid_grant");
}
{
  const wsMixed = { ...userCode, scopes: ["read:pair", "  "] } as AuthCodePayload;
  const plan = planAuthCodeTokenIssuance({ ...inp, payload: wsMixed });
  check("42. ⭐⭐ user cu un scope whitespace amestecat → reject", plan.kind === "reject");
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
