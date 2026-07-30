/**
 * lib/mcp/e10.test.ts — E10 (bounded degradation Redis + plan fallback + auth onest).
 *
 * Contractul înghețat: AUTH unavailable → retry scurt → 503 HTTP (nu 401/500); token invalid/malformat → 401;
 * RATE LIMIT unavailable → cap local ≤5rpm/60s → apoi 503 HTTP (429 ≠ 503); QUOTA unavailable → ≤3/client/60s →
 * apoi QUOTA_UNAVAILABLE (eroare MCP, NU HTTP 503); PLAN necunoscut → free_trial (quota ȘI scopes) + telemetrie.
 * Logica pură (degraded deciders, resolvePlan, toolAuthorized, parseStoredToken, resolveAuth cu deps injectate)
 * e testabilă izolat — fără Redis/Supabase/NextRequest.
 */
import {
  degradedRateDecision, degradedQuotaDecision,
  emergencyRateAllow, emergencyQuotaAllow, clearDegradedRate,
  __resetDegradedState,
  EMERGENCY_RATE_CAP_PER_MIN, EMERGENCY_RATE_BURST, EMERGENCY_QUOTA_MAX_REQ, DEGRADED_WINDOW_MS,
} from "./degraded";
import { resolvePlan, getPlanConfig, isRequestAllowed, PLANS } from "./billing";
import { toolAuthorized } from "./scopes";
import { parseStoredToken, isTokenPayload } from "./tokenGuard";
import { resolveAuth, type AuthDeps } from "./authPolicy";
import { ERR } from "./errors";
import type { TokenValidation, RateLimitOutcome } from "../db/oauth-tokens";
import type { OAuthClient } from "../db/oauth-clients";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  ✅ " + name); }
  else      { failed++; console.log("  ❌ " + name); }
}

const T0 = 1_000_000_000_000;
const RATE_OPTS = { capPerMin: EMERGENCY_RATE_CAP_PER_MIN, burst: EMERGENCY_RATE_BURST, windowMs: DEGRADED_WINDOW_MS };

const VALID: TokenValidation = { status: "valid", payload: { client_id: "c1", scopes: ["read:all"], issued_at: 0, credential_version: "v1" } };
const CLIENT = { client_id: "c1", secret_rotated_at: "v1", rate_limit_per_minute: 60, rate_limit_per_day: 1000, plan: "pro" } as unknown as OAuthClient;
const RATE_OK: RateLimitOutcome = { status: "ok", remaining_min: 59, remaining_day: 999 };

function makeDeps(over: Partial<AuthDeps>): AuthDeps {
  return {
    validateToken: async () => VALID,
    getClient:     async () => CLIENT,
    checkRate:     async () => RATE_OK,
    touch:         () => {},
    sleep:         async () => {},
    ...over,
  };
}

async function main(): Promise<void> {
console.log("E10 — degradedRateDecision (token bucket + fereastră, pur)");
{
  // burst 2 apoi throttle în același instant.
  let r = degradedRateDecision(null, T0, RATE_OPTS);
  check("1a. primul (bucket plin) → allow", r.decision === "allow");
  check("1b. rămâne 1 token", r.state.tokens === 1);
  r = degradedRateDecision(r.state, T0, RATE_OPTS);
  check("1c. al doilea (burst) → allow, 0 token", r.decision === "allow" && r.state.tokens === 0);
  r = degradedRateDecision(r.state, T0, RATE_OPTS);
  check("1d. al treilea instant → unavailable (burst epuizat)", r.decision === "unavailable");
  // refill: 60000/5 = 12000ms per token.
  const r2 = degradedRateDecision(r.state, T0 + 12_000, RATE_OPTS);
  check("1e. după 12s → +1 token → allow", r2.decision === "allow");
}
{
  // fereastra: la exact 60s încă în window, la 60001ms → fail-closed.
  const s = { since: T0, tokens: 2, lastRefill: T0 };
  check("2a. exact 60s → încă degraded (allow)", degradedRateDecision(s, T0 + DEGRADED_WINDOW_MS, RATE_OPTS).decision === "allow");
  check("2b. 60001ms outage continuu → unavailable (fail-closed)", degradedRateDecision(s, T0 + DEGRADED_WINDOW_MS + 1, RATE_OPTS).decision === "unavailable");
}

console.log("\nE10 — emergencyRateAllow (wrapper in-process, cap efectiv)");
{
  __resetDegradedState();
  const now = T0;
  // ⭐ plan NELIMITAT (rpm -1) → tot plafonat la 5rpm/burst 2 (Redis jos ≠ all-you-can-eat).
  check("3a. unlimited plan burst 1 → allow", emergencyRateAllow("cli-unl", -1, now) === "allow");
  check("3b. unlimited plan burst 2 → allow", emergencyRateAllow("cli-unl", -1, now) === "allow");
  check("3c. ⭐ unlimited plan al 3-lea instant → unavailable (capat)", emergencyRateAllow("cli-unl", -1, now) === "unavailable");
}
{
  __resetDegradedState();
  const now = T0;
  emergencyRateAllow("cli-r", 60, now); emergencyRateAllow("cli-r", 60, now);
  check("4a. burst epuizat → unavailable", emergencyRateAllow("cli-r", 60, now) === "unavailable");
  // Redis revenit → reset → burst proaspăt.
  clearDegradedRate("cli-r");
  check("4b. după clear (Redis revenit) → allow din nou", emergencyRateAllow("cli-r", 60, now) === "allow");
}

console.log("\nE10 — quota degraded (≤3/client/proces, apoi fail-closed)");
{
  __resetDegradedState();
  const now = T0;
  check("5a. quota degraded #1 → allow", emergencyQuotaAllow("q1", now) === "allow");
  check("5b. #2 → allow", emergencyQuotaAllow("q1", now) === "allow");
  check("5c. #3 → allow", emergencyQuotaAllow("q1", now) === "allow");
  check("5d. ⭐ al 4-lea → unavailable (buget epuizat)", emergencyQuotaAllow("q1", now) === "unavailable");
}
{
  const QOPTS = { maxReq: EMERGENCY_QUOTA_MAX_REQ, windowMs: DEGRADED_WINDOW_MS };
  check("6a. exact 60s → încă în buget", degradedQuotaDecision({ since: T0, count: 1 }, T0 + DEGRADED_WINDOW_MS, QOPTS).decision === "allow");
  check("6b. 60001ms → unavailable (fereastră expirată)", degradedQuotaDecision({ since: T0, count: 1 }, T0 + DEGRADED_WINDOW_MS + 1, QOPTS).decision === "unavailable");
}

console.log("\nE10 — resolvePlan (necunoscut → free_trial + mismatch)");
{
  const known = resolvePlan("starter");
  check("7a. plan cunoscut → config lui + mismatch false", known.config === PLANS.starter && known.mismatch === false);
  const unk = resolvePlan("premium-typo");
  check("7b. ⭐ plan necunoscut → free_trial (NU starter)", unk.config === PLANS.free_trial);
  check("7c. mismatch true + received păstrat", unk.mismatch === true && unk.received === "premium-typo");
  const empty = resolvePlan(undefined);
  check("7d. undefined → free_trial + mismatch", empty.config === PLANS.free_trial && empty.mismatch === true);
  check("7e. getPlanConfig necunoscut → free_trial (nu 50k/read:all)", getPlanConfig("nope") === PLANS.free_trial);
  check("7f. free_trial ≠ starter (dovada că nu-i permisiv)", PLANS.free_trial.monthly_quota < PLANS.starter.monthly_quota);
}

console.log("\nE10 — resolveAuth (fail-closed onest, deps injectate)");
{
  // Happy path.
  const r = await resolveAuth("Bearer tok", makeDeps({}));
  check("8a. valid + rate ok → ok", r.ok === true);
  check("8b. plan propagat din client", r.plan === "pro");
  check("8c. scopes propagate din payload", (r.scopes ?? []).includes("read:all"));
}
{
  // ⭐ Redis down la auth (unavailable de 2 ori) → 503, NICIODATĂ 401/throw.
  let calls = 0;
  const r = await resolveAuth("Bearer tok", makeDeps({ validateToken: async () => { calls++; return { status: "unavailable", reason: "down" }; } }));
  check("9a. ⭐ auth unavailable → status 503", r.status === 503);
  check("9b. ⭐ cod AUTH_UNAVAILABLE (nu 401)", r.errorCode === ERR.AUTH_UNAVAILABLE);
  check("9c. a încercat de 2 ori (1 retry)", calls === 2);
  check("9d. are Retry-After", typeof r.retryAfter === "number");
}
{
  // Retry-ul recuperează: unavailable apoi valid → ok.
  let calls = 0;
  const r = await resolveAuth("Bearer tok", makeDeps({ validateToken: async () => (++calls === 1 ? { status: "unavailable", reason: "blip" } : VALID) }));
  check("10. retry recuperează (unavailable→valid) → ok", r.ok === true && calls === 2);
}
{
  // Token chiar invalid → 401 INVALID_TOKEN (nu 503).
  const r = await resolveAuth("Bearer tok", makeDeps({ validateToken: async () => ({ status: "invalid" }) }));
  check("11a. token invalid → status 401", r.status === 401);
  check("11b. cod INVALID_TOKEN", r.errorCode === ERR.INVALID_TOKEN);
}
{
  const r = await resolveAuth("nope", makeDeps({}));
  check("12. fără Bearer → 401 UNAUTHORIZED", r.status === 401 && r.errorCode === "UNAUTHORIZED");
}
{
  // Rate limit real depășit → 429 RATE_LIMITED.
  const r = await resolveAuth("Bearer tok", makeDeps({ checkRate: async () => ({ status: "limited", retry_after: 60, remaining_min: 0, remaining_day: 5 }) }));
  check("13a. rate limită reală → 429", r.status === 429);
  check("13b. cod RATE_LIMITED", r.errorCode === ERR.RATE_LIMITED);
  check("13c. Retry-After din TTL", r.retryAfter === 60);
}
{
  // Rate limit neaplicabil (Redis jos, degraded epuizat) → 503 RATE_LIMIT_UNAVAILABLE.
  const r = await resolveAuth("Bearer tok", makeDeps({ checkRate: async () => ({ status: "unavailable" }) }));
  check("14a. rate unavailable → 503", r.status === 503);
  check("14b. ⭐ cod RATE_LIMIT_UNAVAILABLE (nu 429)", r.errorCode === ERR.RATE_LIMIT_UNAVAILABLE);
}
{
  // ⭐ 429 și 503 rămân distincte semantic.
  const limited = await resolveAuth("Bearer tok", makeDeps({ checkRate: async () => ({ status: "limited", retry_after: 60, remaining_min: 0, remaining_day: 5 }) }));
  const unavail = await resolveAuth("Bearer tok", makeDeps({ checkRate: async () => ({ status: "unavailable" }) }));
  check("15. ⭐ 429 RATE_LIMITED ≠ 503 RATE_LIMIT_UNAVAILABLE", limited.status === 429 && unavail.status === 503 && limited.errorCode !== unavail.errorCode);
}
{
  const r = await resolveAuth("Bearer tok", makeDeps({ getClient: async () => null }));
  check("16. client inexistent → 401", r.status === 401 && r.ok === false);
}
{
  // Rotație de secret: credential_version ≠ secret_rotated_at → 401.
  const stale: TokenValidation = { status: "valid", payload: { client_id: "c1", scopes: ["read:all"], issued_at: 0, credential_version: "OLD" } };
  const r = await resolveAuth("Bearer tok", makeDeps({ validateToken: async () => stale }));
  check("17. token invalidat de rotație → 401", r.status === 401);
}

console.log("\nE10 — parseStoredToken (payload malformat → invalid, NU valid-null→500)");
{
  // ⭐ null e JSON valid → NU „valid cu payload null" (care ar arunca în resolveAuth).
  check("18a. ⭐ 'null' → invalid (nu valid)", parseStoredToken("null").status === "invalid");
  check("18b. '{}' (fără câmpuri) → invalid", parseStoredToken("{}").status === "invalid");
  check("18c. '42' (non-obiect) → invalid", parseStoredToken("42").status === "invalid");
  check("18d. JSON stricat → invalid", parseStoredToken("{not json").status === "invalid");
  // scopes ne-array / element ne-string.
  check("18e. scopes ne-array → invalid", parseStoredToken(JSON.stringify({ client_id: "c", scopes: "read:all", issued_at: 1, credential_version: "v" })).status === "invalid");
  check("18f. scopes cu element ne-string → invalid", parseStoredToken(JSON.stringify({ client_id: "c", scopes: [1, 2], issued_at: 1, credential_version: "v" })).status === "invalid");
  check("18g. client_id gol → invalid", parseStoredToken(JSON.stringify({ client_id: "", scopes: ["read:all"], issued_at: 1, credential_version: "v" })).status === "invalid");
  check("18h. issued_at ne-număr → invalid", parseStoredToken(JSON.stringify({ client_id: "c", scopes: ["read:all"], issued_at: "x", credential_version: "v" })).status === "invalid");
  check("18i. credential_version lipsă → invalid", parseStoredToken(JSON.stringify({ client_id: "c", scopes: ["read:all"], issued_at: 1 })).status === "invalid");
  // payload valid complet → valid.
  const good = parseStoredToken(JSON.stringify({ client_id: "c1", scopes: ["read:all"], issued_at: 123, credential_version: "v1" }));
  check("18j. payload valid → valid + payload propagat", good.status === "valid" && good.payload.client_id === "c1");
  check("18k. isTokenPayload(null) false", isTokenPayload(null) === false);
}

console.log("\nE10 — toolAuthorized (entitlement pe DOUĂ straturi: token AND plan, varu blocker 1)");
{
  const FREE  = PLANS.free_trial.allowed_scopes; // ["read:basic"]
  const ALL   = PLANS.pro.allowed_scopes;        // include read:all + granular
  // ⭐ token read:all DAR plan free_trial (read:basic) → tool avansat (necesită read:all/market) INTERZIS.
  check("19a. ⭐ token read:all + plan free_trial → tp_health_check INTERZIS (planul nu permite)", toolAuthorized("tp_health_check", ["read:all"], FREE) === false);
  // free_trial permite un tool core (acceptă read:basic).
  check("19b. token read:basic + plan free_trial → tp_watch_pair PERMIS (core)", toolAuthorized("tp_watch_pair", ["read:basic"], FREE) === true);
  // ⭐ plan generos DAR token fără scope → INTERZIS (nu OR-ul periculos care ar trece pe s==toolScope).
  check("19c. ⭐ token FĂRĂ scope + plan read:all → INTERZIS (tokenul nu permite)", toolAuthorized("tp_health_check", ["read:positions"], ALL) === false);
  // ambele permit → PERMIS.
  check("19d. token read:all + plan pro → tp_health_check PERMIS", toolAuthorized("tp_health_check", ["read:all"], ALL) === true);
  // tool necunoscut → deny by default (ambele straturi).
  check("19e. tool necunoscut → interzis", toolAuthorized("tp_nonexistent", ["read:all"], ALL) === false);
}

console.log("\nE10 — isRequestAllowed (fără OR-ul fosil: token AND plan, varu blocker final)");
{
  // ⭐ plan pro (permite tp_health_check) DAR token doar read:positions → INTERZIS (nu mai trece pe s==toolScope).
  check("20a. ⭐ isRequestAllowed cere token AND plan (token fără scope → false)", isRequestAllowed("pro", ["read:positions"], "tp_health_check") === false);
  // token are scope-ul + plan pro → permis.
  check("20b. token read:all + plan pro → permis", isRequestAllowed("pro", ["read:all"], "tp_health_check") === true);
  // ⭐ plan necunoscut → free_trial (read:basic) → tool avansat interzis chiar cu token read:all.
  check("20c. ⭐ plan necunoscut (→free_trial) + token read:all → tp_health_check interzis", isRequestAllowed("premium-typo", ["read:all"], "tp_health_check") === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
