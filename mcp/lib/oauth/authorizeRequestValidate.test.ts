/**
 * lib/oauth/authorizeRequestValidate.test.ts — PH-2 step 10.3b-iv frunză 4 (validatorul cererii /authorize GET, pur).
 *
 * Acoperă: ETAPA 1 TRUST → `invalid_client` LOCAL (fără redirect) pe client_id/registration/status/expirare/grant_type/
 * redirect neînregistrat/periculos; boundary-ul (redirect netrusted are PRECEDENȚĂ peste erorile de request); ETAPA 2
 * → `error_redirect` (unsupported_response_type/invalid_request PKCE/invalid_target/invalid_scope); SUCCES cu câmpuri
 * derivate (resource canonic, scope ⊆ catalog, default-bind resource, port loopback RFC 8252 — doar non-public).
 * Lotul OAuth staging (design rev3 §3): POLITICA PUBLIC — callback Claude exact, prezent în rând, iar rândul conține
 * DOAR callback-uri Claude; loopback / cale în plus / rând cu redirect străin → `invalid_client` LOCAL. Fixture-urile
 * implicite sunt publice cu callback-ul claude.ai; cazurile loopback / scheme custom rulează pe un rând confidențial
 * (regula veche, neschimbată pentru non-public).
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
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";   // callback Claude exact (CLAUDE_CALLBACKS[0])
const REDIRECT_COM = "https://claude.com/api/mcp/auth_callback"; // callback Claude exact (CLAUDE_CALLBACKS[1])
/** Override pentru un registration NON-public (confidențial) — regula de redirect veche, neschimbată. */
const CONF: Partial<AuthorizeRegistration> = { client_type: "confidential", token_endpoint_auth_method: "client_secret_post" };
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
check("9b. ⭐⭐ redirect_uri periculos (javascript:) pe rând CONFIDENȚIAL → invalid_client (gardul general)",
  V(mkParams({ redirect_uri: "javascript:alert(1)" }), mkReg({ ...CONF, redirect_uris: ["javascript:alert(1)"] })).kind === "invalid_client");
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
{
  // cgpt: error_redirect TREBUIE să transporte redirect_uri + state deja trusted (ruta nu le recitește din query brut).
  const res = V(mkParams({ scope: "read:ghost", state: "STATE-XYZ" }));
  check("16b. ⭐⭐⭐ error_redirect transportă redirect_uri + state trusted", res.kind === "error_redirect" && res.redirect_uri === REDIRECT && res.state === "STATE-XYZ");
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
  // RFC 8252: loopback IP-literal → portul poate diferi de cel înregistrat. DOAR non-public (public → vezi 29–30).
  const reg = mkReg({ ...CONF, redirect_uris: ["http://127.0.0.1:8976/cb"] });
  const res = V(mkParams({ redirect_uri: "http://127.0.0.1:51234/cb" }), reg);
  check("24. ⭐⭐⭐ loopback IP-literal port variabil (RFC 8252) pe CONFIDENȚIAL → ok (regula veche neschimbată)", res.kind === "ok");
}

// ── ALLOWLIST POZITIV: scheme netrusted, CHIAR dacă sunt în registration → invalid_client LOCAL ──
{
  const uri = "ftp://evil.example/callback";
  check("25. ⭐⭐⭐ ftp: în registration + prezentat → invalid_client (allowlist pozitiv, nu doar U7)",
    V(mkParams({ redirect_uri: uri }), mkReg({ ...CONF, redirect_uris: [uri] })).kind === "invalid_client");
}
{
  const uri = "ws://evil.example/cb";
  check("26. ⭐⭐⭐ ws: în registration + prezentat → invalid_client",
    V(mkParams({ redirect_uri: uri }), mkReg({ ...CONF, redirect_uris: [uri] })).kind === "invalid_client");
}
{
  const uri = "myapp:/cb"; // schemă custom FĂRĂ reverse-domain (fără punct) → respinsă
  check("27. ⭐⭐ custom fără reverse-domain (myapp:/cb) în registration → invalid_client",
    V(mkParams({ redirect_uri: uri }), mkReg({ ...CONF, redirect_uris: [uri] })).kind === "invalid_client");
}
{
  const uri = "com.example.app:/cb"; // custom VALID reverse-domain → acceptat (doar non-public)
  check("28. ⭐⭐⭐ custom reverse-domain valid (com.example.app:/cb) pe CONFIDENȚIAL → ok (rămâne acceptat)",
    V(mkParams({ redirect_uri: uri }), mkReg({ ...CONF, redirect_uris: [uri] })).kind === "ok");
}

// ── POLITICA PUBLIC (design rev3 §3): callback Claude exact, prezent în rând; rândul DOAR cu callback-uri Claude ──
{
  const uri = "http://127.0.0.1:8976/cb";
  check("29. ⭐⭐⭐ public + loopback IP-literal (în rând + prezentat) → invalid_client (fără excepția RFC 8252)",
    V(mkParams({ redirect_uri: uri }), mkReg({ redirect_uris: [uri] })).kind === "invalid_client");
  check("29b. ⭐⭐⭐ public + loopback IP-literal port variabil (rândul are loopback) → invalid_client",
    V(mkParams({ redirect_uri: "http://127.0.0.1:51234/cb" }), mkReg({ redirect_uris: [uri] })).kind === "invalid_client");
}
{
  const uri = "http://localhost/callback";
  check("30. ⭐⭐⭐ public + http://localhost/callback prezentat (rândul are callback-ul Claude) → invalid_client",
    V(mkParams({ redirect_uri: uri })).kind === "invalid_client");
  check("30b. ⭐⭐ public + localhost în rând ȘI prezentat → invalid_client",
    V(mkParams({ redirect_uri: uri }), mkReg({ redirect_uris: [uri] })).kind === "invalid_client");
}
{
  const uri = REDIRECT + "/x";
  check("31. ⭐⭐⭐ public + …/auth_callback/x prezentat → invalid_client (fără prefix)",
    V(mkParams({ redirect_uri: uri })).kind === "invalid_client");
  check("31b. ⭐⭐⭐ public + …/auth_callback/x în rând ȘI prezentat → invalid_client (rândul nu e callback Claude)",
    V(mkParams({ redirect_uri: uri }), mkReg({ redirect_uris: [uri] })).kind === "invalid_client");
  check("31c. ⭐⭐ public + slash final în rând ȘI prezentat → invalid_client (fără normalizare)",
    V(mkParams({ redirect_uri: REDIRECT + "/" }), mkReg({ redirect_uris: [REDIRECT + "/"] })).kind === "invalid_client");
  check("31d. ⭐⭐ public + host uppercase prezentat → invalid_client (fără case folding)",
    V(mkParams({ redirect_uri: "https://Claude.ai/api/mcp/auth_callback" })).kind === "invalid_client");
}
{
  // Rând corupt/legacy: un redirect străin lângă callback-ul Claude → TOT clientul e refuzat, chiar cu URI-ul bun.
  const reg = mkReg({ redirect_uris: [REDIRECT, "https://evil.example/cb"] });
  check("32. ⭐⭐⭐ public: rând cu redirect non-Claude + prezentat callback Claude → invalid_client (fail-closed pe rând)",
    V(mkParams({ redirect_uri: REDIRECT }), reg).kind === "invalid_client");
  check("32b. ⭐⭐ public: rând cu loopback lângă callback Claude + prezentat callback Claude → invalid_client",
    V(mkParams({ redirect_uri: REDIRECT }), mkReg({ redirect_uris: ["http://127.0.0.1:8976/cb", REDIRECT] })).kind === "invalid_client");
}
{
  const both = mkReg({ redirect_uris: [REDIRECT, REDIRECT_COM] });
  const res = V(mkParams({ redirect_uri: REDIRECT_COM }), both);
  check("33. ⭐⭐⭐ public: callback claude.com prezent în rând → ok, redirect_uri propagat exact",
    res.kind === "ok" && res.request.redirect_uri === REDIRECT_COM);
  check("33b. ⭐⭐ public: callback claude.ai cu rând [ai, com] → ok", V(mkParams({ redirect_uri: REDIRECT }), both).kind === "ok");
  check("33c. ⭐⭐ public: rând doar [com] + prezentat com → ok",
    V(mkParams({ redirect_uri: REDIRECT_COM }), mkReg({ redirect_uris: [REDIRECT_COM] })).kind === "ok");
}
check("34. ⭐⭐⭐ public: callback claude.com prezentat, dar rândul are DOAR claude.ai → invalid_client (∈ rând obligatoriu)",
  V(mkParams({ redirect_uri: REDIRECT_COM })).kind === "invalid_client");
{
  // Fail-closed: `none` la /token = public prin definiție, chiar dacă `client_type` lipsește (metadată coruptă → null).
  const uri = "http://127.0.0.1:8976/cb";
  check("35. ⭐⭐ client_type null + auth_method none + loopback → invalid_client (tratat ca public)",
    V(mkParams({ redirect_uri: uri }), mkReg({ client_type: null, redirect_uris: [uri] })).kind === "invalid_client");
  check("35b. ⭐ client_type null + auth_method none + callback Claude → ok (politica public trece)",
    V(mkParams(), mkReg({ client_type: null })).kind === "ok");
}
{
  // Boundary păstrat și pe politica public: URI netrusted are precedență peste erorile de request.
  const res = V(mkParams({ redirect_uri: "http://localhost/callback", response_type: "token", code_challenge_method: "plain" }));
  check("36. ⭐⭐⭐ public: loopback + response_type/PKCE greșite → invalid_client (trust ÎNTÂI, NU error_redirect)",
    res.kind === "invalid_client");
}
check("37. ⭐⭐ non-public neschimbat: confidențial cu https arbitrar înregistrat → ok",
  V(mkParams({ redirect_uri: "https://app.example.com/cb" }), mkReg({ ...CONF, redirect_uris: ["https://app.example.com/cb"] })).kind === "ok");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
