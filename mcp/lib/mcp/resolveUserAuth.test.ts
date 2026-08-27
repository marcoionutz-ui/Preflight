/**
 * lib/mcp/resolveUserAuth.test.ts — PH-2 step 10.5 (ramura USER din resolveAuth, deps injectate; rework DCR).
 *
 * Testat END-TO-END prin `resolveAuth` (exercită fork-ul pe subject_kind + audience/family shared înainte de fork).
 * Un token USER (client DCR PUBLIC) se validează pe REGISTRATION (oauth_client_registrations) + GRANT (pinnat) + CONT
 * (curent) + rate-limit ACCOUNT-ONLY, NU pe `oauth_clients`/secretul clientului. Fail-closed pe fiecare axă; 503
 * (outage) distinct de 401 (respins). `touchRegistration` (NU `touchClient`).
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
const registration = { registration_id: "r1", client_id: "c1", status: "active", grant_types: ["authorization_code", "refresh_token"], expires_at: null as number | null };
const grant: OAuthGrant = {
  grant_id: "g1", registration_id: "r1", client_id: "c1", user_id: "u1", resource: AUD,
  scopes: ["read:pair", "read:market"], entitlement_version: 2, status: "active", created_at: "2026-01-01T00:00:00Z",
};
const ent: AccountEntitlement = {
  user_id: "u1", plan: "pro", scopes: ["read:pair", "read:market"],
  rate_limit_per_minute: 60, rate_limit_per_day: 10000, status: "active", entitlement_version: 2,
};
// client row din oauth_clients — folosit DOAR de calea client/legacy (control), NU de ramura user.
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
    getRegistration:       async () => ({ status: "found", registration }),
    getGrant:              async () => ({ status: "found", grant }),
    getAccountEntitlement: async () => ({ status: "found", entitlement: ent }),
    checkAccountRate:      async () => ({ status: "ok", remaining_min: 1, remaining_day: 1 }),
    touchRegistration:     () => {},
    ...over,
  };
}
const run = (over?: Partial<AuthDeps>): Promise<AuthResult> => resolveAuth("Bearer tok", baseDeps(over));

async function main(): Promise<void> {
console.log("PH-2 step 10.5 — resolveUserAuth DCR (prin resolveAuth, deps injectate)");

// ── happy path: subiect=CONT, plan din entitlement ───────────────────────────────
const okR = await run();
check("1. ⭐⭐⭐ user valid pe registration+grant+cont → ok", okR.ok === true);
check("2. ⭐⭐⭐ subiect = ACCOUNT pe user_id (nu client)", okR.subject?.kind === "account" && (okR.subject as { userId: string }).userId === "u1");
check("3. ⭐⭐⭐ plan din ENTITLEMENT ('pro'), NU din oauth_clients ('starter')", okR.plan === "pro");
check("4. ⭐⭐ scopes din token", JSON.stringify(okR.scopes) === JSON.stringify(["read:pair"]));
check("5. ⭐⭐ clientId din TOKEN (nu din oauth_clients)", okR.clientId === "c1");

// ── ramura user NU atinge oauth_clients (client DCR nu-i acolo) ───────────────────
let getClientCalls = 0, touchClientCalls = 0;
const noClient = await run({
  getClient: async () => { getClientCalls++; return { status: "not_found" }; }, // dacă ar fi apelat, ar da 401
  touch:     () => { touchClientCalls++; },
});
check("6. ⭐⭐⭐ ramura user NU cheamă getClient (oauth_clients) — un client DCR nu-i acolo; getClient not_found NU o rupe",
  noClient.ok === true && getClientCalls === 0);
check("6a. ⭐⭐⭐ succes → touchClient (oauth_clients) NU e apelat", touchClientCalls === 0);

// ── touchRegistration pe succes (NU touchClient) ─────────────────────────────────
let touchRegCalls = 0, touchRegArg = "";
await run({ touchRegistration: (id: string) => { touchRegCalls++; touchRegArg = id; } });
check("7. ⭐⭐⭐ succes → touchRegistration(client_id) apelat exact o dată", touchRegCalls === 1 && touchRegArg === "c1");

// ── REGISTRATION (DCR) — existență/status/expirare/grant type ─────────────────────
const rnf = await run({ getRegistration: async () => ({ status: "not_found" }) });
check("8. ⭐⭐⭐ registration not_found → 401 (client DCR neînregistrat/șters)", rnf.ok === false && rnf.status === 401);
let regCalls = 0;
const runav = await run({ getRegistration: async () => { regCalls++; return { status: "unavailable", reason: "down" }; } });
check("9. ⭐⭐⭐ getRegistration unavailable → retry → 503 AUTH_UNAVAILABLE (2 apeluri, NU 401 fals)",
  runav.status === 503 && runav.errorCode === "AUTH_UNAVAILABLE" && regCalls === 2);
const rsus = await run({ getRegistration: async () => ({ status: "found", registration: { ...registration, status: "suspended" } }) });
check("10. ⭐⭐⭐ registration SUSPENDED → 401", rsus.ok === false && rsus.status === 401);
const rexp = await run({ getRegistration: async () => ({ status: "found", registration: { ...registration, expires_at: 1 } }) });
check("11. ⭐⭐⭐ registration EXPIRATĂ → 401", rexp.ok === false && rexp.status === 401);
const rgt = await run({ getRegistration: async () => ({ status: "found", registration: { ...registration, grant_types: ["client_credentials"] } }) });
check("12. ⭐⭐⭐ registration NU permite authorization_code → 401", rgt.ok === false && rgt.status === 401);
const rmis = await run({ getRegistration: async () => ({ status: "found", registration: { ...registration, client_id: "c2" } }) });
check("13. ⭐⭐⭐ registration client_id ≠ token (rând greșit) → 401 (identitate confirmată EXPLICIT)", rmis.ok === false && rmis.status === 401);

// pe registration invalidă, NU chemăm grant/cont/rate/touch (short-circuit fail-closed)
let grantCalledAfterReg = false, rateCalledAfterReg = false, touchRegAfter = false;
await run({
  getRegistration:   async () => ({ status: "found", registration: { ...registration, status: "revoked" } }),
  getGrant:          async () => { grantCalledAfterReg = true; return { status: "found", grant }; },
  checkAccountRate:  async () => { rateCalledAfterReg = true; return { status: "ok", remaining_min: 1, remaining_day: 1 }; },
  touchRegistration: () => { touchRegAfter = true; },
});
check("13a. ⭐⭐⭐ registration invalidă → grant/rate/touchRegistration NU sunt apelate (short-circuit)",
  grantCalledAfterReg === false && rateCalledAfterReg === false && touchRegAfter === false);

// ── grant ────────────────────────────────────────────────────────────────────────
const gnf = await run({ getGrant: async () => ({ status: "not_found" }) });
check("14. ⭐⭐⭐ grant not_found → 401 INVALID_TOKEN (consimțământ șters)", gnf.ok === false && gnf.status === 401 && gnf.errorCode === "INVALID_TOKEN");
const grev = await run({ getGrant: async () => ({ status: "found", grant: { ...grant, status: "revoked" } }) });
check("15. ⭐⭐⭐ grant REVOCAT → 401 (verifyUserTokenGrant reject)", grev.ok === false && grev.status === 401);
const gesc = await run({ getGrant: async () => ({ status: "found", grant: { ...grant, scopes: ["read:market"] } }) });
check("16. ⭐⭐⭐ token cere scope ce grantul nu are (escalation) → 401", gesc.ok === false && gesc.status === 401);
let grantCalls = 0;
const gunav = await run({ getGrant: async () => { grantCalls++; return { status: "unavailable", reason: "down" }; } });
check("17. ⭐⭐⭐ getGrant unavailable → retry → 503 AUTH_UNAVAILABLE (2 apeluri)", gunav.status === 503 && gunav.errorCode === "AUTH_UNAVAILABLE" && grantCalls === 2);

// ── cont ───────────────────────────────────────────────────────────────────────
const anf = await run({ getAccountEntitlement: async () => ({ status: "not_found" }) });
check("18. ⭐⭐⭐ cont not_found → 401", anf.ok === false && anf.status === 401);
const asus = await run({ getAccountEntitlement: async () => ({ status: "found", entitlement: { ...ent, status: "suspended" } }) });
check("19. ⭐⭐⭐ cont SUSPENDED → 401", asus.ok === false && asus.status === 401);
const astale = await run({ getAccountEntitlement: async () => ({ status: "found", entitlement: { ...ent, entitlement_version: 3 } }) });
check("20. ⭐⭐⭐ entitlement_version cont ≠ token → 401 (plan schimbat)", astale.ok === false && astale.status === 401);
const amis = await run({ getAccountEntitlement: async () => ({ status: "found", entitlement: { ...ent, user_id: "u2" } }) });
check("21. ⭐⭐⭐ entitlement user_id ≠ token → 401 (nu scurge contul greșit)", amis.ok === false && amis.status === 401);
let acctCalls = 0;
const aunav = await run({ getAccountEntitlement: async () => { acctCalls++; return { status: "unavailable", reason: "down" }; } });
check("22. ⭐⭐⭐ getAccountEntitlement unavailable → retry → 503 (2 apeluri, NU 401 fals)", aunav.status === 503 && aunav.errorCode === "AUTH_UNAVAILABLE" && acctCalls === 2);

// ── rate-limit ACCOUNT-ONLY ──────────────────────────────────────────────────────
const rlim = await run({ checkAccountRate: async () => ({ status: "limited", retry_after: 42, remaining_min: 0, remaining_day: 5 }) });
check("23. ⭐⭐⭐ rate limited → 429 RATE_LIMITED + retryAfter", rlim.ok === false && rlim.status === 429 && rlim.errorCode === "RATE_LIMITED" && rlim.retryAfter === 42);
const rlunav = await run({ checkAccountRate: async () => ({ status: "unavailable" }) });
check("24. ⭐⭐⭐ rate unavailable → 503 RATE_LIMIT_UNAVAILABLE (nu 429)", rlunav.status === 503 && rlunav.errorCode === "RATE_LIMIT_UNAVAILABLE");
// argumentele rate-check: DOAR user_id + limitele CONTULUI (fără dimensiune client — accountOnly)
let rateArgs: unknown[] = [];
await run({ checkAccountRate: async (...args) => { rateArgs = args; return { status: "ok", remaining_min: 1, remaining_day: 1 }; } });
check("25. ⭐⭐⭐ checkAccountRate primește DOAR user_id + limitele CONTULUI (60/10000) — fără clientId/limite client",
  rateArgs.length === 2
  && rateArgs[0] === "u1"
  && JSON.stringify(rateArgs[1]) === JSON.stringify({ perMinute: 60, perDay: 10000 }));

// ── family (check shared ÎNAINTE de fork) + deps lipsă ───────────────────────────
const frev = await run({ familyState: async () => "revoked" });
check("26. ⭐⭐⭐ familie REVOCATĂ (check shared înainte de fork) → 401", frev.ok === false && frev.status === 401 && frev.errorCode === "INVALID_TOKEN");
const noDeps = await resolveAuth("Bearer tok", baseDeps({ getRegistration: undefined, getGrant: undefined, getAccountEntitlement: undefined, checkAccountRate: undefined, touchRegistration: undefined }));
check("27. ⭐⭐⭐ token USER dar deps user lipsă (inclusiv getRegistration/touchRegistration) → 503 (fail-closed)", noDeps.status === 503 && noDeps.errorCode === "AUTH_UNAVAILABLE");

// ── audience (shared) încă se aplică userului ────────────────────────────────────
const awrong = await run({ expectedAudience: "https://other/api/mcp" });
check("28. ⭐⭐ audience greșit (check shared) → 401 chiar pe user", awrong.ok === false && awrong.status === 401);

// ── control: token CLIENT/LEGACY folosește calea client (getClient/oauth_clients), NEAFECTAT de deps user ──
const clientPayload = { client_id: "c1", scopes: ["read:basic"], issued_at: 1, credential_version: "cv-rotated", audience: AUD };
const clientOk = await resolveAuth("Bearer tok", baseDeps({
  validateToken: async () => ({ status: "valid", payload: clientPayload as never }),
  getRegistration: undefined, getGrant: undefined, getAccountEntitlement: undefined, checkAccountRate: undefined, touchRegistration: undefined,
}));
check("29. ⭐⭐⭐ token LEGACY (fără subject_kind) → calea client (oauth_clients), NEAFECTAT de absența deps-urilor user → ok",
  clientOk.ok === true && clientOk.subject?.kind === "client");

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
}

main();
