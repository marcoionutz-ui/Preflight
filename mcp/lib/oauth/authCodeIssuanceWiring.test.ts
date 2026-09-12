/**
 * lib/oauth/authCodeIssuanceWiring.test.ts — PH-2 step 10.4c (GUARD de sursă pe cablarea /token, fără Redis).
 *
 * „Test verde pe helper ≠ producție wired": verificăm că ruta VIE cheamă planner-ul pur (10.4b), citește flagul de
 * cutover din env, dispecerizează user→emitere user / legacy→emitere client / reject→invalid_grant, și că
 * `oauth-codes` expune emiterea atomică USER (finalize + ACELAȘI Lua). cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 step 10.4c — cablare /token auth-code (guard de sursă)");

const route = readFileSync("app/api/oauth/token/route.ts", "utf8");
const codes = readFileSync("lib/db/oauth-codes.ts", "utf8");

// ── ruta: importuri ───────────────────────────────────────────────────────────
check("1. ⭐⭐ ruta importă planAuthCodeTokenIssuance", /import\s*\{[^}]*planAuthCodeTokenIssuance[^}]*\}\s*from\s*"@\/lib\/oauth\/authCodeIssuancePlan"/.test(route));
check("2. ⭐⭐ ruta importă isLegacyAuthCodeCutoverEnabled", /import\s*\{[^}]*isLegacyAuthCodeCutoverEnabled[^}]*\}\s*from\s*"@\/lib\/oauth\/authCodeCutover"/.test(route));
check("3. ⭐⭐ ruta importă consumeCodeAndIssueUserWithRefresh (din oauth-codes)", /import\s*\{[^}]*consumeCodeAndIssueUserWithRefresh[^}]*\}\s*from\s*"@\/lib\/db\/oauth-codes"/.test(route));

// ── ruta: apelul planner-ului + flag din env ──────────────────────────────────
check("4. ⭐⭐⭐ ruta cheamă planAuthCodeTokenIssuance({...})", /planAuthCodeTokenIssuance\(\{/.test(route));
// Acceptă atât inline (`rejectLegacy: isLegacy...`) cât și hoisted (`const rejectLegacy = isLegacy...`, refolosit de ambele branch-uri user/legacy).
check("5. ⭐⭐⭐ rejectLegacy vine din isLegacyAuthCodeCutoverEnabled(process.env)", /rejectLegacy\s*[:=]\s*isLegacyAuthCodeCutoverEnabled\(process\.env\)/.test(route));
check("6. ⭐⭐ planner primește clientId + credentialVersion (secret_rotated_at) + boundAudience",
  /clientId:\s*client\.client_id/.test(route) && /credentialVersion:\s*client\.secret_rotated_at/.test(route) && /audience:\s*boundAudience/.test(route));

// ── ruta: dispecerizare pe plan.kind ──────────────────────────────────────────
check("7. ⭐⭐⭐ reject → jsonError(400, plan.error, plan.reason) (invalid_grant din planner)",
  /plan\.kind === "reject"[\s\S]{0,80}jsonError\(400,\s*plan\.error,\s*plan\.reason\)/.test(route));
// Fork pe IDENTITATE (fix canary Gate 1): calea user e dispecerizată de `codeIdentity.kind === "user"` (înainte de
// lookup-ul de client), NU de `plan.kind` — cod user = client DCR public (registration), nu `oauth_clients` legacy.
check("8. ⭐⭐⭐ user (cod clasificat prin identity) → consumeCodeAndIssueUserWithRefresh(code, lookup.raw, plan.accessDraft, plan.refreshDraft)",
  /codeIdentity\.kind === "user"/.test(route) && /consumeCodeAndIssueUserWithRefresh\(code,\s*lookup\.raw,\s*plan\.accessDraft,\s*plan\.refreshDraft\)/.test(route));
check("9. ⭐⭐⭐ legacy → consumeCodeAndIssueWithRefresh(code, lookup.raw, plan.access)",
  /consumeCodeAndIssueWithRefresh\(code,\s*lookup\.raw,\s*plan\.access\)/.test(route));
check("10. ⭐⭐ tratarea unavailable/already_used păstrată (503 / invalid_grant)",
  /issued\.status === "unavailable"[\s\S]{0,120}temporarily_unavailable/.test(route) && /issued\.status === "already_used"[\s\S]{0,80}invalid_grant/.test(route));
check("11. ⭐ NU mai construiește payload client-shaped inline (fără credential_version: client.secret_rotated_at în apelul de emitere)",
  !/consumeCodeAndIssueWithRefresh\(code, lookup\.raw, \{[\s\S]{0,200}credential_version:/.test(route));

// ── oauth-codes: emiterea atomică USER ────────────────────────────────────────
check("12. ⭐⭐⭐ oauth-codes exportă consumeCodeAndIssueUserWithRefresh", /export async function consumeCodeAndIssueUserWithRefresh/.test(codes));
check("13. ⭐⭐⭐ folosește finalizeUserTokenPayload + finalizeUserRefreshPayload (sigilează cu familia)",
  /mintToken\(finalizeUserTokenPayload\(accessDraft,\s*familyId\)\)/.test(codes) && /mintRefreshToken\(finalizeUserRefreshPayload\(refreshDraft,\s*familyId\)\)/.test(codes));
check("14. ⭐⭐⭐ generează family NOU (newFamilyId) + ACELAȘI Lua AUTH_CODE_ISSUE_WITH_REFRESH_LUA + familyKey",
  /const familyId = newFamilyId\(\)/.test(codes) && /AUTH_CODE_ISSUE_WITH_REFRESH_LUA/.test(codes) && /familyKey\(familyId\)/.test(codes));
check("15. ⭐⭐ importă finalize* din modelele pure (tokenPayloadModel / refreshPayloadModel)",
  /finalizeUserTokenPayload[\s\S]{0,60}from\s*"\.\.\/oauth\/tokenPayloadModel"/.test(codes) && /finalizeUserRefreshPayload[\s\S]{0,60}from\s*"\.\.\/oauth\/refreshPayloadModel"/.test(codes));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
