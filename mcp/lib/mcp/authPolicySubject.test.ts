/**
 * lib/mcp/authPolicySubject.test.ts — PH-2 9b-wire GUARD (subiectul de quota curge din TOKEN → context, pur).
 *
 * Dovedește seam-ul de cablare (fără Redis/HTTP): (a) `quotaSubjectFromToken` mapează payload-ul de token la subiect
 * (subject_kind absent→client legacy; user valid→account pe user_id; client valid→client; subject_kind prezent dar
 * malformat/necunoscut→RESPINGE); (b) `buildToolContext` duce subiectul din AuthResult în ToolContext neschimbat
 * (fallback fail-closed pe client când lipsește). Împreună cu resolveAuth (care
 * cheamă `quotaSubjectFromToken`) și `reserveQuota` (usage.integration), lanțul token→resolveAuth→context→reserveQuota
 * e acoperit end-to-end la nivel de unitate.
 */
import { quotaSubjectFromToken } from "./authPolicy";
import { buildToolContext } from "./toolContext";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 9b-wire — subiect din token → context (pur)");

// ── quotaSubjectFromToken: token USER → ACCOUNT pe user_id ────────────────────
{
  // payload user valid (forma UserSubject din subjectClaims: subject_kind=user, FĂRĂ credential_version)
  const userPayload = { subject_kind: "user", user_id: "u_42", grant_id: "g1", entitlement_version: 1, client_id: "c_app" };
  const s = quotaSubjectFromToken(userPayload, "c_app");
  check("1. ⭐⭐⭐ token user → ACCOUNT pe user_id (nu pe client)", s !== null && s.kind === "account" && (s as { userId: string }).userId === "u_42");
}
// ── token CLIENT (client_credentials) → CLIENT pe fallback client_id ──────────
{
  const clientPayload = { subject_kind: "client", client_id: "c_m2m", credential_version: "v1" };
  const s = quotaSubjectFromToken(clientPayload, "c_m2m");
  check("2. ⭐⭐⭐ token client → CLIENT pe client_id (cheie legacy)", s !== null && s.kind === "client" && (s as { clientId: string }).clientId === "c_m2m");
}
// ── payload de AZI (client-only, FĂRĂ subject_kind) → CLIENT pe fallback ───────
{
  // exact forma TokenPayload de azi (client_id + credential_version, FĂRĂ subject_kind) → fallback legacy CLIENT
  const legacyPayload = { client_id: "c_leg", credential_version: "v9", scopes: ["read:all"], issued_at: 1 };
  const s = quotaSubjectFromToken(legacyPayload, "c_leg");
  check("3. ⭐⭐⭐ payload de azi (subject_kind ABSENT) → CLIENT pe fallback (nu ghicește account)", s !== null && s.kind === "client" && (s as { clientId: string }).clientId === "c_leg");
}
check("5. ⭐ payload non-obiect (subject_kind absent) → CLIENT pe fallback", quotaSubjectFromToken(null, "c_null")?.kind === "client");

// ── subject_kind PREZENT dar MALFORMAT → RESPINGE (null), NU fallback tăcut pe client (cgpt) ──
{
  const halfUser = { subject_kind: "user", user_id: "u1" }; // subject_kind=user prezent, dar lipsesc grant_id/entitlement_version/client_id
  check("4. ⭐⭐⭐ subject_kind=user INCOMPLET → RESPINGE (null), NU client (nu taxa tăcut clientul)", quotaSubjectFromToken(halfUser, "c_fb") === null);
}
{
  // user cu credential_version prezent = claim INTERZIS pe user subject (uniune strictă) → prezent-dar-invalid → RESPINGE
  const conflicted = { subject_kind: "user", user_id: "u1", grant_id: "g1", entitlement_version: 1, client_id: "c1", credential_version: "v1" };
  check("6. ⭐⭐⭐ subject_kind=user cu claim interzis (credential_version) → RESPINGE (null), NU client", quotaSubjectFromToken(conflicted, "c1") === null);
}
check("6a. ⭐⭐⭐ subject_kind NECUNOSCUT (robot) → RESPINGE (null)", quotaSubjectFromToken({ subject_kind: "robot", client_id: "c1" }, "c1") === null);
{
  // subject_kind=client VALID (uniune strictă: client_id + credential_version, fără câmpuri user) → CLIENT
  const validClient = { subject_kind: "client", client_id: "c_ok", credential_version: "v1" };
  const s = quotaSubjectFromToken(validClient, "c_ok");
  check("6b. ⭐⭐ subject_kind=client VALID → CLIENT pe fallback", s !== null && s.kind === "client" && (s as { clientId: string }).clientId === "c_ok");
}
{
  // subject_kind=client dar MALFORMAT (lipsă credential_version) → prezent-dar-invalid → RESPINGE
  const badClient = { subject_kind: "client", client_id: "c_bad" };
  check("6c. ⭐⭐ subject_kind=client MALFORMAT → RESPINGE (null)", quotaSubjectFromToken(badClient, "c_bad") === null);
}

// ── buildToolContext: subiectul din AuthResult ajunge în context NESCHIMBAT ────
{
  const ctx = buildToolContext({ clientId: "c1", scopes: ["read:all"], plan: "pro", subject: { kind: "account", userId: "u_9" } });
  check("7. ⭐⭐⭐ subiect account din auth → ctx.quotaSubject account (curge neschimbat)", ctx.quotaSubject.kind === "account" && (ctx.quotaSubject as { userId: string }).userId === "u_9");
  check("7b. clientId/scopes/plan păstrate", ctx.clientId === "c1" && ctx.scopes[0] === "read:all" && ctx.plan === "pro");
}
{
  const ctx = buildToolContext({ clientId: "c2", scopes: [], subject: { kind: "client", clientId: "c2" } });
  check("8. ⭐ subiect client din auth → ctx client", ctx.quotaSubject.kind === "client" && (ctx.quotaSubject as { clientId: string }).clientId === "c2");
}
{
  // subiect ABSENT (cale neașteptată) → fallback fail-closed pe CLIENT din clientId (NU account tăcut)
  const ctx = buildToolContext({ clientId: "c3", scopes: [] });
  check("9. ⭐⭐⭐ subiect absent → fallback CLIENT pe clientId (nu account tăcut)", ctx.quotaSubject.kind === "client" && (ctx.quotaSubject as { clientId: string }).clientId === "c3");
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
