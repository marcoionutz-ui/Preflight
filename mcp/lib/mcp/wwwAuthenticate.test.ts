/**
 * lib/mcp/wwwAuthenticate.test.ts — lotul OAuth staging (design rev3 §5): `WWW-Authenticate` la 401 pe `/api/mcp`.
 *
 * Acoperă: origine validă → `resource_metadata` ABSOLUT + `scope="read:basic"` (formă exactă); slash final normalizat;
 * fallback la header-ul relativ de dinainte pe origine null / invalidă / cu query / fragment / userinfo / ghilimele;
 * plus guard de sursă (auth.ts nu cablează direct I/O în tsx): `authErrorResponse` rezolvă originea cu `resolveBaseUrl`
 * prins în try/catch, folosește `buildWwwAuthenticate`, iar ambele apeluri din ruta MCP transmit `req.headers`.
 * cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";
import { buildWwwAuthenticate, LEGACY_WWW_AUTHENTICATE } from "./wwwAuthenticate";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const ORIGIN = "https://preflight-staging.up.railway.app";
const EXPECTED = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="read:basic"`;

function main(): void {
console.log("OAuth staging — buildWwwAuthenticate (resource_metadata absolut + scope)");

// ── origine validă ────────────────────────────────────────────────────────────────
check("1. ⭐⭐⭐ origine https → resource_metadata absolut + scope=\"read:basic\" (formă exactă)", buildWwwAuthenticate(ORIGIN) === EXPECTED);
check("2. ⭐⭐ slash final pe origine → normalizat (fără //.well-known)", buildWwwAuthenticate(ORIGIN + "/") === EXPECTED);
check("3. ⭐ http://localhost:3000 (dev) → absolut pe http",
  buildWwwAuthenticate("http://localhost:3000")
    === `Bearer resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource", scope="read:basic"`);
check("4. ⭐⭐ scope-ul anunțat e DOAR read:basic (nu read:all / catalogul)", (() => {
  const h = buildWwwAuthenticate(ORIGIN);
  return /, scope="read:basic"$/.test(h) && !/read:all/.test(h);
})());

// ── fallback: header-ul relativ de dinainte ───────────────────────────────────────
check("5. ⭐⭐⭐ LEGACY = exact header-ul de dinainte de lot",
  LEGACY_WWW_AUTHENTICATE === `Bearer resource_metadata="/.well-known/oauth-protected-resource"`);
check("6. ⭐⭐⭐ origine null (resolveBaseUrl a aruncat) → fallback relativ", buildWwwAuthenticate(null) === LEGACY_WWW_AUTHENTICATE);
check("7. ⭐⭐ origine goală / neparsabilă → fallback",
  buildWwwAuthenticate("") === LEGACY_WWW_AUTHENTICATE && buildWwwAuthenticate("not a url") === LEGACY_WWW_AUTHENTICATE
  && buildWwwAuthenticate("https://") === LEGACY_WWW_AUTHENTICATE);
check("8. ⭐⭐ schemă non-http(s) → fallback",
  buildWwwAuthenticate("javascript://x") === LEGACY_WWW_AUTHENTICATE && buildWwwAuthenticate("ftp://preflight.app") === LEGACY_WWW_AUTHENTICATE);
check("9. ⭐⭐ query / fragment / userinfo → fallback",
  buildWwwAuthenticate(ORIGIN + "?a=1") === LEGACY_WWW_AUTHENTICATE
  && buildWwwAuthenticate(ORIGIN + "#f") === LEGACY_WWW_AUTHENTICATE
  && buildWwwAuthenticate("https://u:p@preflight.app") === LEGACY_WWW_AUTHENTICATE);
check("10. ⭐⭐⭐ ghilimele / backslash / spații (injecție de parametri) → fallback, fără ecou", (() => {
  const bad = [`https://preflight.app/x", scope="read:all`, `https://preflight.app/a\\b`, `https://preflight.app/a b`];
  return bad.every((o) => buildWwwAuthenticate(o) === LEGACY_WWW_AUTHENTICATE);
})());

// ── guard de sursă: cablajul din auth.ts + ruta MCP ───────────────────────────────
{
  const auth  = readFileSync("lib/mcp/auth.ts", "utf8");
  const route = readFileSync("app/api/[transport]/route.ts", "utf8");
  check("11. ⭐⭐⭐ authErrorResponse primește header-ele cererii",
    /export function authErrorResponse\(auth: AuthResult,\s*reqHeaders: \{ get\(name: string\): string \| null \}\): Response/.test(auth));
  check("12. ⭐⭐⭐ originea din resolveBaseUrl, prinsă în try/catch → null (401 rămâne 401, nu throw)",
    /try \{ origin = resolveBaseUrl\(reqHeaders, process\.env\); \} catch \{ origin = null; \}/.test(auth));
  check("13. ⭐⭐⭐ header-ul construit EXCLUSIV prin buildWwwAuthenticate (fără literal relativ rămas)",
    /headers\["WWW-Authenticate"\] = buildWwwAuthenticate\(origin\)/.test(auth) && !/resource_metadata=/.test(auth));
  check("14. ⭐⭐ statusul rămâne cel din auth (auth.status ?? 401)", /status: auth\.status \?\? 401/.test(auth));
  check("15. ⭐⭐⭐ ruta MCP: AMBELE apeluri (GET + POST) transmit req.headers",
    (route.match(/authErrorResponse\(auth, req\.headers\)/g) ?? []).length === 2 && !/authErrorResponse\(auth\)/.test(route));
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
