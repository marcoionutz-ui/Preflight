/**
 * lib/oauth/authorizeStartPlan.test.ts — PH-2 pas 6 frunză 3b-ii (planner /start, pur).
 *
 * Maparea securitate-sensibilă: autentificat → issue_consent LEGAT (bindUserId), anonim → issue_login (fără bind, cookie
 * în handler), error_redirect → client_error (redirect_uri + error + error_description + state; `iss` îl adaugă handler-ul,
 * NU plannerul), error_local → local_error, unavailable → 503. Fail-closed pe decizie neașteptată (render_consent din
 * initial = imposibil → local_error, NU consent).
 */
import { planAuthorizeStart } from "./authorizeStartPlan";
import type { AuthorizeGetDecision } from "./authorizeGetDecision";
import type { ValidatedAuthorizeRequest } from "./authorizeRequestValidate";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const REQ: ValidatedAuthorizeRequest = {
  registration_id: "reg1", client_id: "c1", redirect_uri: "https://claude.ai/api/mcp/callback",
  state: "xyz", resource: "https://preflight.app/api/mcp", requested_scopes: ["read:all"],
  code_challenge: "CH", code_challenge_method: "S256",
};

function main(): void {
console.log("PH-2 pas 6 frunză 3b-ii — planAuthorizeStart (planner /start, pur)");

// ── autentificat → issue_consent LEGAT ─────────────────────────────────────────────
check("1. ⭐⭐⭐ create_and_consent → issue_consent cu bindUserId (txn legată de user)", (() => {
  const a = planAuthorizeStart({ kind: "create_and_consent", request: REQ, userId: "u1" });
  return a.kind === "issue_consent" && a.bindUserId === "u1" && a.request.client_id === "c1";
})());
check("2. ⭐⭐⭐ autentificatul NU devine issue_login (nu pierde bind-ul)",
  planAuthorizeStart({ kind: "create_and_consent", request: REQ, userId: "u1" }).kind !== "issue_login");

// ── anonim → issue_login (FĂRĂ bind) ───────────────────────────────────────────────
check("3. ⭐⭐⭐ create_and_login → issue_login (request, fără bindUserId)", (() => {
  const a = planAuthorizeStart({ kind: "create_and_login", request: REQ });
  return a.kind === "issue_login" && a.request.registration_id === "reg1" && !("bindUserId" in a);
})());
check("4. ⭐⭐⭐ anonimul NU devine issue_consent (nu leagă un user inexistent)",
  planAuthorizeStart({ kind: "create_and_login", request: REQ }).kind !== "issue_consent");

// ── error_redirect → client_error (transportă redirect_uri + state) ────────────────
check("5. ⭐⭐⭐ error_redirect → client_error cu redirect_uri + error + state", (() => {
  const a = planAuthorizeStart({ kind: "error_redirect", error: "invalid_scope", reason: "r", redirect_uri: "https://claude.ai/cb", state: "STATE1" });
  return a.kind === "client_error" && a.redirect_uri === "https://claude.ai/cb" && a.error === "invalid_scope" && a.state === "STATE1";
})());
check("5b. ⭐⭐⭐ error_redirect → reason ajunge în error_description (nu se pierde)", (() => {
  const a = planAuthorizeStart({ kind: "error_redirect", error: "invalid_scope", reason: "scope necunoscut: read:ghost", redirect_uri: "https://claude.ai/cb", state: "s" });
  return a.kind === "client_error" && a.error_description === "scope necunoscut: read:ghost";
})());

// ── error_local → local_error ──────────────────────────────────────────────────────
check("6. ⭐⭐⭐ error_local → local_error (pagină locală, fără redirect)", (() => {
  const a = planAuthorizeStart({ kind: "error_local", reason: "redirect netrusted" });
  return a.kind === "local_error" && a.reason === "redirect netrusted";
})());

// ── unavailable → 503 ──────────────────────────────────────────────────────────────
check("7. ⭐⭐⭐ unavailable → unavailable (503 retryable)", (() => {
  const a = planAuthorizeStart({ kind: "unavailable", reason: "Supabase jos" });
  return a.kind === "unavailable" && a.reason === "Supabase jos";
})());

// ── FAIL-CLOSED pe decizie neașteptată ─────────────────────────────────────────────
check("8. ⭐⭐⭐ render_consent (imposibil din initial) → local_error (NU issue_consent — nu sare peste creare/bind)", (() => {
  // Construim un render_consent minimal ca să forțăm ramura default; nu poate veni din initial, dar fail-closed contează.
  const bogus = { kind: "render_consent", txn: {} } as unknown as AuthorizeGetDecision;
  const a = planAuthorizeStart(bogus);
  return a.kind === "local_error";
})());

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
