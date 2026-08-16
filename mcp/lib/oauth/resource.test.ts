/**
 * lib/oauth/resource.test.ts — PH-3 (RFC 8707 Resource Indicators + audience binding; spec MCP 2026-07-28).
 *
 * Trei straturi: (a) leaf-ul pur `resource.ts` (canonic / validare `resource` / validare audience); (b) integrarea
 * in `resolveAuth` (token cu audience gresit -> 401, anti confused-deputy); (c) guard de sursa ca RUTELE chiar
 * cableaza binding-ul (authorize leaga resource + iss; token leaga audience pe ambele grant-uri; metadata expune iss).
 */
import { readFileSync } from "node:fs";
import { canonicalResourceUri, validateResourceIndicator, tokenAudienceValid } from "./resource";
import { resolveAuth, type AuthDeps } from "../mcp/authPolicy";
import type { TokenValidation } from "../db/oauth-tokens";
import type { ClientLookup } from "../db/clientLookup";

type FoundClient = Extract<ClientLookup, { status: "found" }>["client"];
const CLIENT = {
  client_id: "c1", secret_rotated_at: "v1", scopes: ["read:basic"],
  plan: "pro", rate_limit_per_minute: 100, rate_limit_per_day: 1000,
} as unknown as FoundClient;

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const ISSUER = "https://preflight.example.com";
const CANON  = "https://preflight.example.com/api/mcp";

async function main(): Promise<void> {
console.log("PH-3 — resource indicators + audience binding");

// ── (a) canonicalResourceUri ──
check("1. canonic = issuer + /api/mcp", canonicalResourceUri(ISSUER) === CANON);
check("2. issuer cu slash final -> normalizat", canonicalResourceUri("https://preflight.example.com/") === CANON);

// ── (a) validateResourceIndicator ──
check("3. absent -> ok default-bind canonic", (() => { const r = validateResourceIndicator("", ISSUER); return r.status === "ok" && r.resource === CANON; })());
check("4. null -> ok default-bind canonic", (() => { const r = validateResourceIndicator(null, ISSUER); return r.status === "ok" && r.resource === CANON; })());
check("5. canonic exact -> ok", (() => { const r = validateResourceIndicator(CANON, ISSUER); return r.status === "ok" && r.resource === CANON; })());
check("6. canonic cu slash final -> ok (normalizat)", validateResourceIndicator(CANON + "/", ISSUER).status === "ok");
check("7. ⭐ alta resursa -> invalid_target", validateResourceIndicator("https://evil.example.com/api/mcp", ISSUER).status === "invalid_target");
check("8. ⭐ alt path pe acelasi host -> invalid_target", validateResourceIndicator("https://preflight.example.com/api/other", ISSUER).status === "invalid_target");
check("9. ⭐ URI cu fragment -> invalid_target (RFC 8707 §2)", validateResourceIndicator(CANON + "#frag", ISSUER).status === "invalid_target");
check("10. ⭐ non-absolut (relativ) -> invalid_target", validateResourceIndicator("/api/mcp", ISSUER).status === "invalid_target");
check("11. ⭐ schema non-http (javascript:) -> invalid_target", validateResourceIndicator("javascript:alert(1)", ISSUER).status === "invalid_target");
check("11b. ⭐⭐ userinfo (user@) -> invalid_target (nu se elimina tacit)", validateResourceIndicator("https://user@preflight.example.com/api/mcp", ISSUER).status === "invalid_target");
check("11c. ⭐⭐ userinfo (user:pass@) -> invalid_target", validateResourceIndicator("https://user:pass@preflight.example.com/api/mcp", ISSUER).status === "invalid_target");

// ── (a) tokenAudienceValid ──
check("12. audience == expected -> true", tokenAudienceValid(CANON, CANON));
check("13. audience cu slash final -> true (normalizat)", tokenAudienceValid(CANON + "/", CANON));
check("14. ⭐ audience != expected -> false", !tokenAudienceValid("https://evil.example.com/api/mcp", CANON));
check("15. ⭐⭐ undefined -> FALSE (fail-closed, audience obligatoriu — nu grandfather)", !tokenAudienceValid(undefined, CANON));
check("16. ⭐ gol -> FALSE (fail-closed)", !tokenAudienceValid("", CANON));
check("16b. ⭐ null -> FALSE (fail-closed)", !tokenAudienceValid(null, CANON));
// Nit compat: scheme + host case-insensitive (RFC 3986).
check("16c. ⭐ audience cu scheme/host UPPERCASE -> true (normalizat)", tokenAudienceValid("HTTPS://Preflight.Example.com/api/mcp", CANON));
check("16d. ⭐⭐ audience cu userinfo -> false (normalizatorul NU-l elimina)", !tokenAudienceValid("https://user@preflight.example.com/api/mcp", CANON));
check("16e. ⭐⭐ audience cu fragment -> false (normalizatorul NU-l elimina)", !tokenAudienceValid(CANON + "#frag", CANON));

// ── (b) resolveAuth: audience binding integrat ──
const mkValidation = (audience?: string): TokenValidation =>
  ({ status: "valid", payload: { client_id: "c1", scopes: ["read:basic"], issued_at: 1, credential_version: "v1", audience } });
function makeDeps(over: Partial<AuthDeps>): AuthDeps {
  return {
    validateToken: async () => mkValidation(CANON),
    getClient:     async () => ({ status: "found", client: CLIENT }),
    checkRate:     async () => ({ status: "ok", remaining_min: 99, remaining_day: 999 }),
    touch:         () => {},
    sleep:         async () => {},
    expectedAudience: CANON,
    ...over,
  };
}
const okAud = await resolveAuth("Bearer tok", makeDeps({ validateToken: async () => mkValidation(CANON) }));
check("17. ⭐ token cu audience corect + expectedAudience -> ok", okAud.ok === true);
const badAud = await resolveAuth("Bearer tok", makeDeps({ validateToken: async () => mkValidation("https://evil.example.com/api/mcp") }));
check("18. ⭐⭐ token cu audience GRESIT -> 401 INVALID_TOKEN (anti confused-deputy)", badAud.ok === false && badAud.status === 401 && badAud.errorCode === "INVALID_TOKEN");
const noAud = await resolveAuth("Bearer tok", makeDeps({ validateToken: async () => mkValidation(undefined) }));
check("19. ⭐⭐ token FARA audience -> 401 (fail-closed, nu mai e grandfather)", noAud.ok === false && noAud.status === 401 && noAud.errorCode === "INVALID_TOKEN");
const noExpected = await resolveAuth("Bearer tok", makeDeps({ expectedAudience: undefined, validateToken: async () => mkValidation("https://evil.example.com/api/mcp") }));
check("20. expectedAudience absent (teste pure) -> NU verifica audience (ok chiar cu audience strain)", noExpected.ok === true);

// ── (c) GUARD DE SURSA — rutele chiar cableaza binding-ul (cwd = pachetul mcp) ──
const authz = readFileSync("app/api/oauth/authorize/route.ts", "utf8");
check("21. ⭐ authorize: valideaza resource (validateResourceIndicator)", /validateResourceIndicator\(/.test(authz));
check("22. ⭐ authorize: leaga resource in cod (resource:\\s*rv.resource)", /resource:\s*rv\.resource/.test(authz));
check("23. ⭐ authorize: seteaza iss in redirect (RFC 9207)", /searchParams\.set\(\s*["']iss["']/.test(authz));
check("23b. ⭐⭐ authorize: invalid_target se intoarce prin REDIRECT cu iss (nu errorPage) — RFC 9207 pe erori",
  /oauthErrorRedirect\(\s*redirect_uri\s*,\s*["']invalid_target["']/.test(authz) && /error_description[\s\S]{0,120}searchParams\.set\(\s*["']iss["']/.test(authz));
check("23c. ⭐⭐ authorize: erorile de scope post-allowlist redirect cu iss (invalid_scope, nu errorPage)",
  /oauthErrorRedirect\(\s*redirect_uri\s*,\s*["']invalid_scope["']/.test(authz));
check("23d. ⭐⭐ authorize: esecul issueAuthCode redirect cu iss (server_error, nu errorPage)",
  /oauthErrorRedirect\(\s*redirect_uri\s*,\s*["']server_error["']/.test(authz));
check("23e. ⭐ authorize: scope/issue errors NU mai folosesc errorPage dupa allowlist (doar pre-allowlist)",
  !/errorPage\(`Requested scope/.test(authz) && !/errorPage\("Failed to issue/.test(authz));

const tok = readFileSync("app/api/oauth/token/route.ts", "utf8");
check("24. ⭐ token: valideaza resource pe ambele grant-uri (>=2 validateResourceIndicator)", (tok.match(/validateResourceIndicator\(/g) ?? []).length >= 2);
check("25. ⭐⭐ token: leaga audience in AMBELE emiteri (issueToken + consumeCodeAndIssueToken)", (tok.match(/audience:/g) ?? []).length >= 2);
check("26. ⭐ token: respinge invalid_target", /"invalid_target"/.test(tok));

const oam = readFileSync("app/.well-known/oauth-authorization-server/route.ts", "utf8");
const oamApi = readFileSync("app/api/.well-known/oauth-authorization-server/route.ts", "utf8");
check("27. ⭐ AS metadata (ambele) expun authorization_response_iss_parameter_supported: true",
  /authorization_response_iss_parameter_supported:\s*true/.test(oam) && /authorization_response_iss_parameter_supported:\s*true/.test(oamApi));

const atomic = readFileSync("lib/db/oauthAtomic.ts", "utf8");
check("28. AuthCodePayload are camp resource + guard il valideaza", /resource\?:\s*string/.test(atomic) && /o\.resource !== undefined/.test(atomic));
const tokens = readFileSync("lib/db/oauth-tokens.ts", "utf8");
check("29. TokenPayload are camp audience", /audience\?:\s*string/.test(tokens));
const policy = readFileSync("lib/mcp/authPolicy.ts", "utf8");
check("30. ⭐ authPolicy cheama tokenAudienceValid pe payload.audience", /tokenAudienceValid\(\s*v\.payload\.audience/.test(policy));

// ── (c bis) GUARD pe PAGINA PUBLICA /authorize (cgpt: aici se pierdea `resource`) ──
const page = readFileSync("app/authorize/page.tsx", "utf8");
check("31. ⭐⭐ /authorize page destructureaza `resource` din searchParams", /resource\?:\s*string/.test(page) && /\bresource\s*=\s*""/.test(page));
check("32. ⭐⭐ /authorize page trimite `resource` in hidden input POST-at", /name="resource"\s+value=\{resource\}/.test(page));

// ── (c ter) VALIDARE uppercase la validateResourceIndicator (nit compat) ──
check("33. ⭐ validateResourceIndicator accepta scheme/host UPPERCASE", validateResourceIndicator("HTTPS://Preflight.Example.com/api/mcp", ISSUER).status === "ok");

// ── (d) SIMULARE flux e2e: /authorize resource -> code.resource -> token.audience -> authenticate ──
// (a) La /authorize: validam resource-ul cerut si il legam in cod.
const authorizeStep = validateResourceIndicator(CANON, ISSUER);
const codeResource = authorizeStep.status === "ok" ? authorizeStep.resource : undefined;
check("34. ⭐ flux: /authorize leaga resource canonic in cod", codeResource === CANON);
// (b) La /token (auth_code): audience-ul tokenului = resursa legata in cod.
const tokenAudience = codeResource;
check("35. ⭐ flux: token.audience = code.resource", tokenAudience === CANON);
// (c) La authenticate (resource server): tokenul cu acel audience e acceptat pt. resursa noastra.
const authAccepts = await resolveAuth("Bearer tok", makeDeps({ validateToken: async () => mkValidation(tokenAudience) }));
check("36. ⭐⭐ flux complet: token emis pt. resursa noastra -> authenticate OK", authAccepts.ok === true);
// (d) Un resource STRAIN la /authorize e respins (invalid_target), NU default-bind tacit (bug-ul prins de cgpt).
check("37. ⭐⭐ flux: resource strain la /authorize -> invalid_target (nu accept tacit)",
  validateResourceIndicator("https://evil.example.com/api/mcp", ISSUER).status === "invalid_target");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
