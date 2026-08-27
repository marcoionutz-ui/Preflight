/**
 * lib/mcp/userRefreshWiring.test.ts — PH-2 step 10.5b frunza 2 (GUARD de sursă pe cablarea I/O a rotației refresh USER).
 *
 * „Verde pe planner-ul pur ≠ producție wired" (cgpt): `planUserRefreshRotation` (frunza 1) e pur + dep-injectat; aici
 * verificăm că I/O-ul REAL e cablat corect:
 *   (a) `oauth-refresh.ts`: `peekRefreshToken` citește DISCRIMINAT (`parseStoredRefresh`), `RefreshLookup.payload` e
 *       uniunea `AnyRefreshPayload`, iar `rotateRefreshToken` e GENERIC pe formă (access client|user, refresh union).
 *   (b) ruta `/token`: `handleRefreshGrant` BIFURCĂ pe `isUserRefresh(rp)` ÎNAINTE de gate-ul client (credential_version),
 *       iar `handleUserRefreshGrant` verifică client-activ + identitate, cheamă planner-ul cu catalogul, finalizează
 *       draft-urile cu `rp.family_id` și rotește; branch-ul client rămâne intact (fără regresie).
 * cwd = pachetul mcp.
 */
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

function main(): void {
console.log("PH-2 step 10.5b frunza 2 — wiring I/O rotație refresh USER (guard de sursă)");

const refresh = readFileSync("lib/db/oauth-refresh.ts", "utf8");
const route   = readFileSync("app/api/oauth/token/route.ts", "utf8");

// ── (a) oauth-refresh.ts: citire discriminată + rotate generic ────────────────────
check("1. ⭐⭐⭐ peekRefreshToken folosește parseStoredRefresh (citire discriminată), NU parseRefresh client-only",
  /const payload = parseStoredRefresh\(raw\)/.test(refresh) && !/parseRefresh\(/.test(refresh));
check("2. ⭐⭐⭐ RefreshLookup.payload e uniunea AnyRefreshPayload (client SAU user)",
  /RefreshLookup\s*=[\s\S]{0,120}payload:\s*AnyRefreshPayload/.test(refresh));
check("3. ⭐⭐⭐ rotateRefreshToken accept access TokenPayload | UserTokenPayload (generic pe formă)",
  /accessPayload:\s*TokenPayload \| UserTokenPayload/.test(refresh));
check("4. ⭐⭐⭐ rotateRefreshToken accept newRefreshPayload: AnyRefreshPayload (accesează doar family_id)",
  /newRefreshPayload:\s*AnyRefreshPayload/.test(refresh));
check("5. ⭐⭐ importă parseStoredRefresh + AnyRefreshPayload din refreshPayloadModel",
  /import\s*\{[^}]*parseStoredRefresh[^}]*AnyRefreshPayload[^}]*\}\s*from\s*"\.\.\/oauth\/refreshPayloadModel"/.test(refresh));

// ── (b) ruta: fork pe formă ÎNAINTE de gate-ul client ─────────────────────────────
check("6. ⭐⭐⭐ handleRefreshGrant deviază forma user (isUserRefresh → handleUserRefreshGrant)",
  /if \(isUserRefresh\(rp\)\)\s*\{\s*return handleUserRefreshGrant\(/.test(route));
check("7. ⭐⭐⭐ fork-ul e ÎNAINTE de gate-ul client credential_version (altfel rp.credential_version nici n-ar compila pe union)",
  route.indexOf("isUserRefresh(rp)") < route.indexOf("rp.credential_version !== client.secret_rotated_at"));
check("8. ⭐⭐ ruta importă helperele user (planUserRefreshRotation, verifyUserRegistration, finalize-uri, registration/grant/cont, catalog)",
  /planUserRefreshRotation/.test(route) && /verifyUserRegistration/.test(route) && /finalizeUserTokenPayload/.test(route) && /finalizeUserRefreshPayload/.test(route)
  && /getRegistrationByClientId/.test(route) && /touchRegistration/.test(route) && /getGrantById/.test(route) && /getAccountEntitlement/.test(route) && /SERVER_SCOPE_CATALOG/.test(route));

// ── (c) handleUserRefreshGrant: verificări corecte (DCR — registration, NU oauth_clients) ─────────
const uh = route.match(/async function handleUserRefreshGrant[\s\S]*?\n\}/);
const u = uh ? uh[0] : "";
check("9. ⭐⭐⭐ verifică REGISTRATION-ul DCR (getRegistrationByClientId + verifyUserRegistration, grant refresh_token) → 503 unavailable / 401 reject",
  /getRegistrationByClientId\(rp\.client_id\)/.test(u)
  && /verifyUserRegistration\(regLookup,\s*\{[\s\S]{0,120}requiredGrantType:\s*"refresh_token"/.test(u)
  && /kind === "unavailable"[\s\S]{0,120}503/.test(u) && /!rgv\.ok[\s\S]{0,140}401/.test(u));
check("10. ⭐⭐⭐ identitatea clientului e confirmată de verifyUserRegistration (clientId: rp.client_id) — NU se bazează pe filtrul de query",
  /verifyUserRegistration\(regLookup,\s*\{\s*clientId:\s*rp\.client_id/.test(u));
check("10a. ⭐⭐⭐ ramura user NU APELEAZĂ oauth_clients (fără lookupClientById(…) / touchClient(…) în handleUserRefreshGrant — doar registration)",
  !/lookupClientById\(/.test(u) && !/touchClient\(/.test(u));
check("11. ⭐⭐⭐ cheamă planner-ul cu grant + cont + catalog (serverPolicy = SERVER_SCOPE_CATALOG)",
  /planUserRefreshRotation\(\{[\s\S]*?grantLookup[\s\S]*?accountLookup[\s\S]*?serverPolicy:\s*\[\.\.\.SERVER_SCOPE_CATALOG\]/.test(u));
check("12. ⭐⭐⭐ plan.unavailable → 503; plan.reject → invalid_grant (fail-closed)",
  /plan\.kind === "unavailable"[\s\S]{0,140}503/.test(u) && /plan\.kind === "reject"[\s\S]{0,140}invalid_grant/.test(u));
check("13. ⭐⭐⭐ finalizează AMBELE draft-uri cu familia LANȚULUI (rp.family_id) înainte de rotație",
  /finalizeUserTokenPayload\(plan\.accessDraft,\s*rp\.family_id\)/.test(u) && /finalizeUserRefreshPayload\(plan\.refreshDraft,\s*rp\.family_id\)/.test(u));
check("14. ⭐⭐⭐ rotește generic (rotateRefreshToken cu payload user) + reuse/revoked/invalid → invalid_grant",
  /rotateRefreshToken\(refresh_token,\s*accessPayload,\s*newRefreshPayload\)/.test(u)
  && /reuse_detected[\s\S]{0,120}invalid_grant/.test(u));
check("15. ⭐⭐ răspunsul emite scope-ul EFECTIV al access-ului (plan.scopes), nu lanțul refresh-ului",
  /scope:\s*plan\.scopes\.join\(" "\)/.test(u));
check("16. ⭐⭐⭐ succes → touchRegistration(rp.client_id) (NU touchClient/oauth_clients)", /touchRegistration\(rp\.client_id\)/.test(u));

// ── (d) branch-ul client rămâne intact (fără regresie) ────────────────────────────
check("17. ⭐⭐ branch-ul client păstrează gate-ul credential_version + rotația cu narrowed.scopes",
  /rp\.credential_version !== client\.secret_rotated_at/.test(route) && /scopes:\s*narrowed\.scopes/.test(route));

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
