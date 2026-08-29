/**
 * lib/oauth/authorizeRequestValidate.test.ts — PH-2 step 10.3b-iv frunză 4 (validatorul cererii /authorize GET, pur).
 *
 * Acoperă: ETAPA 1 TRUST → `invalid_client` LOCAL (fără redirect) pe client_id/registration/status/expirare/grant_type/
 * redirect neînregistrat/periculos; boundary-ul (redirect netrusted are PRECEDENȚĂ peste erorile de request); ETAPA 2
 * → `error_redirect` (unsupported_response_type/invalid_request PKCE/invalid_target/invalid_scope); SUCCES cu câmpuri
 * derivate (resource canonic, scope ⊆ catalog, default-bind resource, port loopback RFC 8252).
 */
import { createHash } from "node:crypto";
import { validateAuthorizeRequest, type AuthorizeRegistration, type AuthorizeParams } from "./authorizeRequestValidate";
import { SERVER_SCOPE_CATALOG } from "./scopeCatalog";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const CH = createHash("sha256").update("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").digest("base64url");
const ISSUER   = "https://preflight.app";
const CANON    = "https://preflight.app/api/mcp";
const REDIRECT = "https://claude.ai/api/mcp/callback";
const NOW = 1_800_000_000_000;

function mkReg(over: Partial<AuthorizeRegistration> = {}): AuthorizeRegistration {
  return {
    registration_id: "reg1", client_id: "c1", status: "active",
    grant_types: ["authorization_code", "refresh_token"], expires_at: null,
    redirect_uris: [REDIRECT], client_name: "Claude", client_type: "public",
    token_endpoint_auth_method: "none", ...over,
  };
}
function mkParams(over: Partial<AuthorizeParams> = {}): AuthorizeParams {
  return {
    client_id: "c1", redirect_uri: REDIRECT, response_type: "code", scope: "read:all read:market",
    code_challenge: CH, code_challenge_method: "S256", resource: "", state: "xyz", ...over,
  };
}
const V = (params: AuthorizeParams, registration: AuthorizeRegistration | null = mkReg()) =>
  validateAuthorizeRequest({ params, registration, issuer: ISSUER, serverPolicy: SERVER_SCOPE_CATALOG, nowMs: NOW });

function main(): void {
console.log("PH-2 step 10.3b-iv frunză 4 — validateAuthorizeRequest (validator cerere /authorize GET, pur)");

// ── ETAPA 1: TRUST → invalid_client (LOCAL) ──────────────────────────────────────
check("1. ⭐⭐ client_id gol → invalid_client", V(mkParams({ client_id: "" })).kind === "invalid_client");
check("2. ⭐⭐⭐ registration null → invalid_client", V(mkParams(), null).kind === "invalid_client");
check("3. ⭐⭐ registration.client_id ≠ cerut → invalid_client", V(mkParams(), mkReg({ client_id: "ALT" })).kind === "invalid_client");
check("4. ⭐⭐⭐ status ≠ active → invalid_client", V(mkParams(), mkReg({ status: "revoked" })).kind === "invalid_client");
check("5. ⭐⭐⭐ registration expirată → invalid_client", V(mkParams(), mkReg({ expires_at: NOW - 1 })).kind === "invalid_client");
check("6. ⭐⭐ grant_types fără authorization_code → invalid_client", V(mkParams(), mkReg({ grant_types: ["refresh_token"] })).kind === "invalid_client");
check("7. ⭐⭐ niciun redirect_uri înregistrat → invalid_client", V(mkParams(), mkReg({ redirect_uris: [] })).kind === "invalid_client");
check("8. ⭐⭐⭐ redirect_uri neînregistrat → invalid_client (NU redirect)", V(mkParams({ redirect_uri: "https://evil.example/cb" })).kind === "invalid_client");
check("9. ⭐⭐⭐ redirect_uri periculos (javascript:) → invalid_client", V(mkParams({ redirect_uri: "javascript:alert(1)" }), mkReg({ redirect_uris: ["javascript:alert(1)"] })).kind === "invalid_client");
check("10. ⭐⭐ redirect_uri gol → invalid_client", V(mkParams({ redirect_uri: "" })).kind === "invalid_client");

// ── BOUNDARY: redirect netrusted are PRECEDENȚĂ peste erorile de request ──────────
{
  const res = V(mkParams({ redirect_uri: "https://evil.example/cb", response_type: "token", code_challenge: "x", code_challenge_method: "plain" }));
  check("11. ⭐⭐⭐ redirect netrusted + response_type/PKCE greșite → invalid_client (trust ÎNTÂI, NU error_redirect)", res.kind === "invalid_client");
}

// ── ETAPA 2: error_redirect (redirect DEJA trusted) ──────────────────────────────
{
  const res = V(mkParams({ response_type: "token" }));
  check("12. ⭐⭐⭐ response_type ≠ code → error_redirect unsupported_response_type",
    res.kind === "error_redirect" && res.error === "unsupported_response_type");
}
{
  const res = V(mkParams({ code_challenge_method: "plain" }));
  check("13. ⭐⭐⭐ PKCE method ≠ S256 → error_redirect invalid_request", res.kind === "error_redirect" && res.error === "invalid_request");
}
{
  const res = V(mkParams({ code_challenge: "short" }));
  check("14. ⭐⭐ PKCE challenge malformat → error_redirect invalid_request", res.kind === "error_redirect" && res.error === "invalid_request");
}
{
  const res = V(mkParams({ resource: "https://evil.example/api/mcp" }));
  check("15. ⭐⭐⭐ resource ≠ canonic → error_redirect invalid_target", res.kind === "error_redirect" && res.error === "invalid_target");
}
{
  const res = V(mkParams({ scope: "read:all read:ghost" }));
  check("16. ⭐⭐⭐ scope necunoscut → error_redirect invalid_scope", res.kind === "error_redirect" && res.error === "invalid_scope");
}

// ── SUCCES ────────────────────────────────────────────────────────────────────────
{
  const res = V(mkParams());
  check("17. ⭐⭐⭐ cerere validă → ok", res.kind === "ok");
  if (res.kind === "ok") {
    check("18. ⭐⭐⭐ resource default-bind canonic (resource gol)", res.request.resource === CANON);
    check("19. ⭐⭐ requested_scopes ⊆ catalog, păstrate", JSON.stringify(res.request.requested_scopes) === JSON.stringify(["read:all", "read:market"]));
    check("20. ⭐⭐ redirect_uri trusted propagat", res.request.redirect_uri === REDIRECT);
    check("21. ⭐ registration_id + client_id + state + PKCE propagate",
      res.request.registration_id === "reg1" && res.request.client_id === "c1" && res.request.state === "xyz"
      && res.request.code_challenge === CH && res.request.code_challenge_method === "S256");
  }
}
{
  const res = V(mkParams({ scope: "" }));
  check("22. ⭐⭐ scope gol → ok cu requested_scopes [] (rezolvare la consent)", res.kind === "ok" && res.request.requested_scopes.length === 0);
}
{
  const res = V(mkParams({ resource: "HTTPS://Preflight.app/api/mcp" }));
  check("23. ⭐⭐ resource canonic case-insensitive scheme/host → ok", res.kind === "ok" && res.request.resource === CANON);
}
{
  // RFC 8252: loopback IP-literal → portul poate diferi de cel înregistrat.
  const reg = mkReg({ redirect_uris: ["http://127.0.0.1:8976/cb"] });
  const res = V(mkParams({ redirect_uri: "http://127.0.0.1:51234/cb" }), reg);
  check("24. ⭐⭐⭐ loopback IP-literal port variabil (RFC 8252) → ok (redirect trusted)", res.kind === "ok");
}

// ── ALLOWLIST POZITIV: scheme netrusted, CHIAR dacă sunt în registration → invalid_client LOCAL ──
{
  const uri = "ftp://evil.example/callback";
  check("25. ⭐⭐⭐ ftp: în registration + prezentat → invalid_client (allowlist pozitiv, nu doar U7)",
    V(mkParams({ redirect_uri: uri }), mkReg({ redirect_uris: [uri] })).kind === "invalid_client");
}
{
  const uri = "ws://evil.example/cb";
  check("26. ⭐⭐⭐ ws: în registration + prezentat → invalid_client",
    V(mkParams({ redirect_uri: uri }), mkReg({ redirect_uris: [uri] })).kind === "invalid_client");
}
{
  const uri = "myapp:/cb"; // schemă custom FĂRĂ reverse-domain (fără punct) → respinsă
  check("27. ⭐⭐ custom fără reverse-domain (myapp:/cb) în registration → invalid_client",
    V(mkParams({ redirect_uri: uri }), mkReg({ redirect_uris: [uri] })).kind === "invalid_client");
}
{
  const uri = "com.example.app:/cb"; // custom VALID reverse-domain → acceptat
  check("28. ⭐⭐⭐ custom reverse-domain valid (com.example.app:/cb) → ok (rămâne acceptat)",
    V(mkParams({ redirect_uri: uri }), mkReg({ redirect_uris: [uri] })).kind === "ok");
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
