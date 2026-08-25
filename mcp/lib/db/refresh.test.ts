/**
 * lib/db/refresh.test.ts — PH-4 (refresh tokens: rotatie + reuse-detection cu family revocation).
 *
 * Straturi: (a) pur — isRefreshPayload/parseRefresh, classifyRefreshRotate, narrowScopes; (b) GUARD pe scripturile
 * Lua (logica de rotatie/reuse traieste in Lua — verificam invariantele: reuse -> REVOKED -> -2; family.current
 * update; access SET NX); (c) GUARD de sursa pe rute (refresh_token grant cablat, auth_code intoarce refresh_token,
 * client_credentials NU, metadata anunta grant-ul). Comportamentul runtime complet (Redis real) = integration test (PH-18).
 */
import { readFileSync } from "node:fs";
import {
  isRefreshPayload, parseRefresh, classifyRefreshRotate, narrowScopes,
  REFRESH_ROTATE_LUA, AUTH_CODE_ISSUE_WITH_REFRESH_LUA, REFRESH_FAMILY_REVOKED,
} from "./oauthAtomic";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const VALID_RP = { client_id: "c1", scopes: ["read:basic"], audience: "https://x/api/mcp", credential_version: "v1", family_id: "fam1", issued_at: 1 };

function main(): void {
console.log("PH-4 — refresh tokens (rotate + reuse-detection)");

// ── (a) isRefreshPayload / parseRefresh ──
check("1. payload valid -> true", isRefreshPayload(VALID_RP));
check("2. fara family_id -> false", !isRefreshPayload({ ...VALID_RP, family_id: undefined }));
check("3. fara audience -> false", !isRefreshPayload({ ...VALID_RP, audience: "" }));
check("4. fara credential_version -> false", !isRefreshPayload({ ...VALID_RP, credential_version: 5 }));
check("5. scopes ne-array -> false", !isRefreshPayload({ ...VALID_RP, scopes: "read" }));
check("6. issued_at ne-numar -> false", !isRefreshPayload({ ...VALID_RP, issued_at: "x" }));
check("7. null -> false", !isRefreshPayload(null));
check("8. parseRefresh JSON valid+forma -> payload", parseRefresh(JSON.stringify(VALID_RP))?.family_id === "fam1");
check("9. parseRefresh JSON stricat -> null", parseRefresh("{bad") === null);
check("10. parseRefresh forma invalida -> null", parseRefresh(JSON.stringify({ client_id: "c1" })) === null);

// ── (a') 10.4a — forma CLIENT respinge contaminarea cu identitate user (coliziune hibrid, cgpt) ──
// Un refresh client legitim NU poarta subject_kind sau user_id/grant_id/entitlement_version; prezenta oricaruia =
// blob necredibil -> false. Altfel un hibrid {client + user claims, fara subject_kind} trecea drept refresh client.
check("10a. ⭐⭐⭐ client + subject_kind prezent -> false", !isRefreshPayload({ ...VALID_RP, subject_kind: "user" }));
check("10b. ⭐⭐⭐ client + TOATE claim-urile user -> false", !isRefreshPayload({ ...VALID_RP, user_id: "u1", grant_id: "g1", entitlement_version: 2 }));
check("10c. ⭐⭐⭐ client + un singur claim user (user_id) -> false", !isRefreshPayload({ ...VALID_RP, user_id: "u1" }));
check("10d. ⭐⭐⭐ parseRefresh(hibrid) -> null", parseRefresh(JSON.stringify({ ...VALID_RP, user_id: "u1", grant_id: "g1", entitlement_version: 2 })) === null);
check("10e. ⭐⭐ client curat inca valid (nu am spart forma legitima)", isRefreshPayload(VALID_RP));

// ── (a) classifyRefreshRotate (mapare coduri Lua) ──
check("11. 1 -> rotated", classifyRefreshRotate(1) === "rotated");
check("12. -1 -> revoked", classifyRefreshRotate(-1) === "revoked");
check("13. ⭐ -2 -> reuse_detected", classifyRefreshRotate(-2) === "reuse_detected");
check("14. -3 -> write_failed", classifyRefreshRotate(-3) === "write_failed");
check("15. 0 -> invalid", classifyRefreshRotate(0) === "invalid");
check("16. valoare neasteptata -> invalid", classifyRefreshRotate(99) === "invalid");

// ── (a) narrowScopes (RFC 6749 §6: fara escaladare) ──
check("17. requested gol -> pastreaza original", (() => { const r = narrowScopes([], ["read:basic", "read:all"]); return r.status === "ok" && r.scopes.length === 2; })());
check("18. requested undefined -> original", (() => { const r = narrowScopes(undefined, ["read:basic"]); return r.status === "ok" && r.scopes[0] === "read:basic"; })());
check("19. subset -> narrowed", (() => { const r = narrowScopes(["read:basic"], ["read:basic", "read:all"]); return r.status === "ok" && r.scopes.length === 1 && r.scopes[0] === "read:basic"; })());
check("20. ⭐⭐ escaladare (scope nou) -> invalid_scope", narrowScopes(["read:all"], ["read:basic"]).status === "invalid_scope");
check("21. exact aceleasi -> ok", narrowScopes(["read:basic"], ["read:basic"]).status === "ok");

// ── (b) GUARD pe Lua — logica de rotatie/reuse ──
check("22. ⭐⭐ REFRESH_ROTATE_LUA: reuse (fam ~= ARGV[1]) -> seteaza REVOKED -> return -2",
  /fam ~= ARGV\[1\][\s\S]{0,120}'REVOKED'[\s\S]{0,60}return -2/.test(REFRESH_ROTATE_LUA));
check("23. ⭐ REFRESH_ROTATE_LUA: family deja REVOKED -> return -1", /fam == 'REVOKED'[\s\S]{0,30}return -1/.test(REFRESH_ROTATE_LUA));
check("24. ⭐ REFRESH_ROTATE_LUA: familie absenta -> return 0", /if not fam then return 0/.test(REFRESH_ROTATE_LUA));
check("25. ⭐ REFRESH_ROTATE_LUA: access SET NX (nu suprascrie) + family.current = newHash (ARGV[6])",
  /SET', KEYS\[3\], ARGV\[3\][\s\S]{0,40}'NX'/.test(REFRESH_ROTATE_LUA) && /SET', KEYS\[1\], ARGV\[6\]/.test(REFRESH_ROTATE_LUA));
check("26. sentinela REVOKED e exportata si folosita in Lua", REFRESH_FAMILY_REVOKED === "REVOKED" && REFRESH_ROTATE_LUA.includes("REVOKED"));
check("27. ⭐ AUTH_CODE_ISSUE_WITH_REFRESH_LUA: scrie refresh (KEYS[3]) + familie (KEYS[4]) + sterge codul (DEL KEYS[1])",
  /SET', KEYS\[3\]/.test(AUTH_CODE_ISSUE_WITH_REFRESH_LUA) && /SET', KEYS\[4\]/.test(AUTH_CODE_ISSUE_WITH_REFRESH_LUA) && /DEL', KEYS\[1\]/.test(AUTH_CODE_ISSUE_WITH_REFRESH_LUA));

// ── (c) GUARD de sursa — cablarea (cwd = pachetul mcp) ──
const refreshMod = readFileSync("lib/db/oauth-refresh.ts", "utf8");
check("28. oauth-refresh.ts exporta rotateRefreshToken + peekRefreshToken + familyKey", /export async function rotateRefreshToken/.test(refreshMod) && /export async function peekRefreshToken/.test(refreshMod) && /export function familyKey/.test(refreshMod));
check("29. ⭐ rotateRefreshToken foloseste REFRESH_ROTATE_LUA", /REFRESH_ROTATE_LUA/.test(refreshMod));

const codes = readFileSync("lib/db/oauth-codes.ts", "utf8");
check("30. ⭐ oauth-codes.ts: consumeCodeAndIssueWithRefresh (emitere initiala cu refresh + familie)", /consumeCodeAndIssueWithRefresh/.test(codes) && /AUTH_CODE_ISSUE_WITH_REFRESH_LUA/.test(codes));

const route = readFileSync("app/api/oauth/token/route.ts", "utf8");
check("31. ⭐⭐ token route: grant refresh_token cablat", /grant_type === "refresh_token"/.test(route) && /handleRefreshGrant/.test(route));
check("32. ⭐ token route: auth_code emite refresh (consumeCodeAndIssueWithRefresh + refresh_token in raspuns)",
  /consumeCodeAndIssueWithRefresh\(/.test(route) && /refresh_token:\s*issued\.refreshToken/.test(route));
check("33. ⭐⭐ token route: refresh grant roteste (rotateRefreshToken) + reuse_detected -> invalid_grant",
  /rotateRefreshToken\(/.test(route) && /reuse_detected[\s\S]{0,120}invalid_grant/.test(route));
check("34. ⭐ token route: refresh grant verifica credential_version (rotatia secretului -> reauth)",
  /credential_version !== client\.secret_rotated_at[\s\S]{0,260}invalid_grant/.test(route));
check("35. ⭐ token route: refresh grant aplica narrowScopes (fara escaladare)", /narrowScopes\(/.test(route));
check("36. ⭐⭐ client_credentials NU emite refresh (issueToken direct, fara refresh_token in raspunsul cc)",
  /issueToken\(\{/.test(route) && (route.match(/refresh_token:/g) ?? []).length === 2); // doar auth_code + refresh grant

const oam = readFileSync("app/.well-known/oauth-authorization-server/route.ts", "utf8");
const oamApi = readFileSync("app/api/.well-known/oauth-authorization-server/route.ts", "utf8");
check("37. ⭐ AS metadata (ambele) anunta grant_types_supported cu refresh_token",
  /grant_types_supported[\s\S]{0,120}"refresh_token"/.test(oam) && /grant_types_supported[\s\S]{0,120}"refresh_token"/.test(oamApi));

// ── (d) GUARD cgpt #1 — grant-level revocation (family_id ajunge la ACCESS token + resolveAuth verifica familia) ──
const tokens = readFileSync("lib/db/oauth-tokens.ts", "utf8");
check("38. ⭐ TokenPayload declara family_id (access token poarta familia lantului)", /family_id\?:\s*string/.test(tokens));

const guard = readFileSync("lib/mcp/tokenGuard.ts", "utf8");
check("39. tokenGuard valideaza forma family_id (blob corupt -> invalid, dar il pastreaza la round-trip)",
  /family_id === undefined \|\| \(typeof v\.family_id === "string"/.test(guard));

check("40. ⭐⭐ oauth-codes: access token la auth_code poarta family_id (mintToken cu ...tokenPayload + family_id)",
  /mintToken\(\{[\s\S]{0,30}family_id:\s*familyId/.test(codes));

check("41. ⭐⭐ getFamilyState FAIL-CLOSED (cgpt #2r): absent(null)->inactive, hash 64hex->active, REVOKED->revoked",
  /export type FamilyState = "active" \| "revoked" \| "inactive" \| "unavailable"/.test(refreshMod) &&
  /export async function getFamilyState/.test(refreshMod) &&
  /v === null[\s\S]{0,60}"inactive"/.test(refreshMod) &&
  /\[0-9a-f\]\{64\}/.test(refreshMod) && /REFRESH_FAMILY_REVOKED[\s\S]{0,30}"revoked"/.test(refreshMod));

const authpol = readFileSync("lib/mcp/authPolicy.ts", "utf8");
check("42. ⭐⭐ resolveAuth: familie REVOCATA sau INACTIVA (absent/malformat) -> 401 INVALID_TOKEN (fail-closed)",
  /deps\.familyState && v\.payload\.family_id/.test(authpol) && /fs === "revoked" \|\| fs === "inactive"[\s\S]{0,80}INVALID_TOKEN/.test(authpol));
check("43. ⭐ resolveAuth: familyState unavailable -> retry -> 503 AUTH_UNAVAILABLE (nu 401 fals pe Redis jos)",
  /fs === "unavailable"[\s\S]{0,140}AUTH_UNAVAILABLE/.test(authpol));
check("44. ⭐ AuthDeps declara dep-ul familyState (injectabil, optional pt. testele pure)",
  /familyState\?:\s*\(familyId: string\) => Promise<FamilyState>/.test(authpol));

const authwire = readFileSync("lib/mcp/auth.ts", "utf8");
check("45. ⭐⭐ auth.ts CABLEAZA familyState: getFamilyState (productia primeste verificarea de familie)",
  /from "@\/lib\/db\/oauth-refresh"/.test(authwire) && /familyState:\s*getFamilyState/.test(authwire));

// ── (e) GUARD cgpt #2 — scope narrowing NU ingusteaza permanent lantul (refresh pastreaza rp.scopes, access = narrowed) ──
check("46. ⭐⭐ token route: newRefreshPayload pastreaza rp.scopes (NU narrowed) — fara ingustare permanenta",
  /newRefreshPayload: RefreshPayload = \{[\s\S]{0,140}scopes:\s*rp\.scopes/.test(route));
check("47. ⭐⭐ token route: access token-ul rotit primeste narrowed.scopes + family_id: rp.family_id",
  /rotateRefreshToken\(refresh_token,\s*\{[\s\S]{0,140}scopes:\s*narrowed\.scopes/.test(route) && /rotateRefreshToken\(refresh_token,\s*\{[\s\S]{0,320}family_id:\s*rp\.family_id/.test(route));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
