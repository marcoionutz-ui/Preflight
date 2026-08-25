/**
 * lib/mcp/resolveUserAuth.test.ts — PH-2 step 10.5a frunza 4b (ramura USER din resolveAuth, deps injectate).
 *
 * Testat END-TO-END prin `resolveAuth` (exercită fork-ul pe subject_kind + audience/family shared înainte de fork).
 * Un token USER se validează pe GRANT (pinnat) + CONT (curent) + rate-limit atomic account+client, NU pe secretul
 * clientului. Fail-closed pe fiecare axă; 503 (outage) distinct de 401 (respins).
 */
import { resolveAuth, type AuthDeps, type AuthResult } from "./authPolicy";
import type { UserTokenPayload } from "../oauth/tokenPayloadModel";
import type { OAuthGrant } from "../oauth/grant";
import type { AccountEntitlement } from "../oauth/entitlement";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const AUD = "https://x/api/mcp";
const userPayload: UserTokenPayload = {
  subject_kind: "user", user_id: "u1", grant_id: "g1", entitlement_version: 2, client_id: "c1",
  scopes: ["read:pair"], issued_at: 1, audience: AUD, family_id: "f1",
};
const grant: OAuthGrant = {
  grant_id: "g1", registration_id: "r1", client_id: "c1", user_id: "u1", resource: AUD,
  scopes: ["read:pair", "read:market"], entitlement_version: 2, status: "active", created_at: "2026-01-01T00:00:00Z",
};
const ent: AccountEntitlement = {
  user_id: "u1", plan: "pro", scopes: ["read:pair", "read:market"],
  rate_limit_per_minute: 60, rate_limit_per_day: 10000, status: "active", entitlement_version: 2,
};
const clientRow = { client_id: "c1", secret_rotated_at: "cv-rotated", plan: "starter", rate_limit_per_minute: 100, rate_limit_per_day: 5000, scopes: ["read:basic"] };

function baseDeps(over: Partial<AuthDeps> = {}): AuthDeps {
  return {
    validateToken:         async () => ({ status: "valid", payload: userPayload }),
    getClient:             async () => ({ status: "found", client: clientRow } as never),
    checkRate:             async () => ({ status: "ok", remaining_min: 1, remaining_day: 1 }),
    touch:                 () => {},
    sleep:                 async () => {},
    expectedAudience:      AUD,
    familyState:           async () => "active",
    getGrant:              async () => ({ status: "found", grant }),
    getAccountEntitlement: async () => ({ status: "found", entitlement: ent }),
    checkAccountRate:      async () => ({ status: "ok", remaining_min: 1, remaining_day: 1 }),
    ...over,
  };
}
const run = (over?: Partial<AuthDeps>): Promise<AuthResult> => resolveAuth("Bearer tok", baseDeps(over));

async function main(): Promise<void> {
console.log("PH-2 step 10.5a frunza 4b — resolveUserAuth (prin resolveAuth, deps injectate)");

// ── happy path: subiect=CONT, plan din entitlement ───────────────────────────────
const okR = await run();
check("1. ⭐⭐⭐ user valid pe grant+cont → ok", okR.ok === true);
check("2. ⭐⭐⭐ subiect = ACCOUNT pe user_id (nu client)", okR.subject?.kind === "account" && (okR.subject as { userId: string }).userId === "u1");
check("3. ⭐⭐⭐ plan din ENTITLEMENT ('pro'), NU din client ('starter')", okR.plan === "pro");
check("4. ⭐⭐ scopes din token", JSON.stringify(okR.scopes) === JSON.stringify(["read:pair"]));
check("5. ⭐ clientId din client row", okR.clientId === "c1");

// ── user NU e afectat de rotația secretului clientului ───────────────────────────
check("6. ⭐⭐⭐ user rămâne valid CHIAR dacă secret client rotit (token n-are credential_version → gate-ul nu se aplică)",
  (await run({ getClient: async () => ({ status: "found", client: { ...clientRow, secret_rotated_at: "TOTALLY-DIFFERENT" } } as never) })).ok === true);

// ── grant ────────────────────────────────────────────────────────────────────────
const gnf = await run({ getGrant: async () => ({ status: "not_found" }) });
check("7. ⭐⭐⭐ grant not_found → 401 INVALID_TOKEN (consimțământ șters)", gnf.ok === false && gnf.status === 401 && gnf.errorCode === "INVALID_TOKEN");
const grev = await run({ getGrant: async () => ({ status: "found", grant: { ...grant, status: "revoked" } }) });
check("8. ⭐⭐⭐ grant REVOCAT → 401 (verifyUserTokenGrant reject)", grev.ok === false && grev.status === 401);
const gesc = await run({ getGrant: async () => ({ status: "found", grant: { ...grant, scopes: ["read:market"] } }) });
check("9. ⭐⭐⭐ token cere scope ce grantul nu are (escalation) → 401", gesc.ok === false && gesc.status === 401);
let grantCalls = 0;
const gunav = await run({ getGrant: async () => { grantCalls++; return { status: "unavailable", reason: "down" }; } });
check("10. ⭐⭐⭐ getGrant unavailable → retry → 503 AUTH_UNAVAILABLE (2 apeluri)", gunav.status === 503 && gunav.errorCode === "AUTH_UNAVAILABLE" && grantCalls === 2);

// ── cont ───────────────────────────────────────────────────────────────────────
const anf = await run({ getAccountEntitlement: async () => ({ status: "not_found" }) });
check("11. ⭐⭐⭐ cont not_found → 401", anf.ok === false && anf.status === 401);
const asus = await run({ getAccountEntitlement: async () => ({ status: "found", entitlement: { ...ent, status: "suspended" } }) });
check("12. ⭐⭐⭐ cont SUSPENDED → 401", asus.ok === false && asus.status === 401);
const astale = await run({ getAccountEntitlement: async () => ({ status: "found", entitlement: { ...ent, entitlement_version: 3 } }) });
check("13. ⭐⭐⭐ entitlement_version cont ≠ token → 401 (plan schimbat)", astale.ok === false && astale.status === 401);
const amis = await run({ getAccountEntitlement: async () => ({ status: "found", entitlement: { ...ent, user_id: "u2" } }) });
check("14. ⭐⭐⭐ entitlement user_id ≠ token → 401 (nu scurge contul greșit)", amis.ok === false && amis.status === 401);
let acctCalls = 0;
const aunav = await run({ getAccountEntitlement: async () => { acctCalls++; return { status: "unavailable", reason: "down" }; } });
check("15. ⭐⭐⭐ getAccountEntitlement unavailable → retry → 503 (2 apeluri, NU 401 fals)", aunav.status === 503 && aunav.errorCode === "AUTH_UNAVAILABLE" && acctCalls === 2);

// ── rate-limit atomic account+client ─────────────────────────────────────────────
const rlim = await run({ checkAccountRate: async () => ({ status: "limited", retry_after: 42, remaining_min: 0, remaining_day: 5 }) });
check("16. ⭐⭐⭐ rate limited → 429 RATE_LIMITED + retryAfter", rlim.ok === false && rlim.status === 429 && rlim.errorCode === "RATE_LIMITED" && rlim.retryAfter === 42);
const runav = await run({ checkAccountRate: async () => ({ status: "unavailable" }) });
check("17. ⭐⭐⭐ rate unavailable → 503 RATE_LIMIT_UNAVAILABLE (nu 429)", runav.status === 503 && runav.errorCode === "RATE_LIMIT_UNAVAILABLE");
// argumentele rate-check: account din entitlement, client din client row
let rateArgs: unknown[] = [];
await run({ checkAccountRate: async (...args) => { rateArgs = args; return { status: "ok", remaining_min: 1, remaining_day: 1 }; } });
check("18. ⭐⭐⭐ checkAccountRate primește user_id + limitele CONTULUI (60/10000) + clientId + limitele CLIENTULUI (100/5000)",
  rateArgs[0] === "u1"
  && JSON.stringify(rateArgs[1]) === JSON.stringify({ perMinute: 60, perDay: 10000 })
  && rateArgs[2] === "c1"
  && JSON.stringify(rateArgs[3]) === JSON.stringify({ perMinute: 100, perDay: 5000 }));

// ── client ───────────────────────────────────────────────────────────────────────
const cnf = await run({ getClient: async () => ({ status: "not_found" }) });
check("19. ⭐⭐ client not_found → 401", cnf.ok === false && cnf.status === 401);
let clientCalls = 0;
const cunav = await run({ getClient: async () => { clientCalls++; return { status: "unavailable", reason: "down" }; } });
check("20. ⭐⭐ getClient unavailable → retry → 503 (2 apeluri)", cunav.status === 503 && cunav.errorCode === "AUTH_UNAVAILABLE" && clientCalls === 2);

// ── client_id mismatch (fix cgpt): lookup întoarce alt client → 401, fără rate-limit/touch pe identitatea greșită ──
let rateCalled = false, touchCalled = false;
const cmis = await resolveAuth("Bearer tok", baseDeps({
  getClient:        async () => ({ status: "found", client: { ...clientRow, client_id: "c2" } } as never),
  checkAccountRate: async () => { rateCalled = true; return { status: "ok", remaining_min: 1, remaining_day: 1 }; },
  touch:            () => { touchCalled = true; },
}));
check("20a. ⭐⭐⭐ getClient întoarce c2 pt. token c1 → 401 INVALID_TOKEN (nu se bazează pe filtrul lookup-ului)",
  cmis.ok === false && cmis.status === 401 && cmis.errorCode === "INVALID_TOKEN");
check("20b. ⭐⭐⭐ pe mismatch, checkAccountRate + touch NU sunt apelate (nu taxăm/atingem clientul greșit)",
  rateCalled === false && touchCalled === false);

// ── family (check shared ÎNAINTE de fork) + deps lipsă ───────────────────────────
const frev = await run({ familyState: async () => "revoked" });
check("21. ⭐⭐⭐ familie REVOCATĂ (check shared înainte de fork) → 401", frev.ok === false && frev.status === 401 && frev.errorCode === "INVALID_TOKEN");
const noDeps = await resolveAuth("Bearer tok", baseDeps({ getGrant: undefined, getAccountEntitlement: undefined, checkAccountRate: undefined }));
check("22. ⭐⭐⭐ token USER dar deps user lipsă → 503 (fail-closed, nu 401 fals)", noDeps.status === 503 && noDeps.errorCode === "AUTH_UNAVAILABLE");

// ── audience (shared) încă se aplică userului ────────────────────────────────────
const awrong = await run({ expectedAudience: "https://other/api/mcp" });
check("23. ⭐⭐ audience greșit (check shared) → 401 chiar pe user", awrong.ok === false && awrong.status === 401);

// ── control: token CLIENT nu intră pe ramura user (neafectat de deps user) ────────
const clientPayload = { client_id: "c1", scopes: ["read:basic"], issued_at: 1, credential_version: "cv-rotated", audience: AUD };
const clientOk = await resolveAuth("Bearer tok", baseDeps({
  validateToken: async () => ({ status: "valid", payload: clientPayload as never }),
  getGrant: undefined, getAccountEntitlement: undefined, checkAccountRate: undefined, // deps user ABSENTE
}));
check("24. ⭐⭐⭐ token LEGACY (fără subject_kind) → calea client, NEAFECTAT de absența deps-urilor user → ok",
  clientOk.ok === true && clientOk.subject?.kind === "client");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
