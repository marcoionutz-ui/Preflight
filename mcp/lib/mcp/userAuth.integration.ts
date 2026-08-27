/**
 * lib/mcp/userAuth.integration.ts — PH-2 step 10.5c (test de integrare a CICLULUI DE VIAȚĂ user-token, Redis-backed).
 *
 * DOMENIU (cgpt): NU e un test end-to-end prin endpoint-ul HTTP `/token` — lookup-urile Supabase (grant/cont/
 * registration) sunt INJECTATE ca deps, iar cererea nu trece prin rută. E un test de integrare Redis-backed al
 * ciclului de viață al tokenului USER (emitere atomică → citire discriminată → plan → rotație → revocare de familie
 * → rate) care exercită ACELEAȘI primitive + wiring pe care le cablează ruta reală.
 *
 * Rulează DOAR pe loopback + opt-in (ca `quotaAtomic.integration.ts`):
 *   REDIS_URL=redis://127.0.0.1:6379 QUOTA_INTEGRATION_ALLOW=1 tsx lib/mcp/userAuth.integration.ts
 * Altfel SKIP curat (exit 0). Chei UNICE per rulare (sufix random) + curățare punctuală (fără flushdb).
 *
 * Ce dovedește pe Redis VIU (ce testele pure NU pot — comportamentul atomic real):
 *   (A) REVOCAREA LA NIVEL DE GRANT AJUNGE LA AMBELE: reuse-ul unui refresh USER superseded → familia REVOCATĂ (Lua
 *       reală) → access token-ul lanțului moare (getFamilyState→401) ȘI refresh-ul nou valid moare la rotație. „Furt"
 *       de refresh ⇒ toată sesiunea cade, nu doar refresh-ul prezentat.
 *   (B) RATE-LIMIT ACCOUNT-ONLY ATOMIC: `checkAccountRateLimit(uid, account)` pe Lua reală mărginește pe bucket-ul de
 *       CONT (`mcp:rl:acct:*`) ȘI NU atinge NICIO cheie de client (`mcp:rl:*:<uid>`) — dovada că dimensiunea client a
 *       fost retrasă pentru DCR.
 *   (C) DISCRIMINAREA 503/401/429 PRIN `resolveAuth` REAL (token+familie+rate reale, lookup-uri Supabase INJECTATE):
 *       entitlement_version schimbat / grant revocat / registration inactivă → 401; registration|cont unavailable →
 *       503 (NU 401 fals); cap account atomic → 429.
 *   (D) LEGACY/CLIENT neschimbat pe Redis real (calea client nu-i afectată de rework-ul user).
 *
 * Lookup-urile Supabase sunt INJECTATE (deps `resolveAuth`): un test de integrare Redis nu are Supabase viu, iar
 * respingerile pe stare Supabase (entitlement/grant/registration) sunt logică PURĂ (verifyUser* — testate izolat).
 * Aici dovedim că starea reală Redis + aceleași primitive/wiring ca ruta produc verdictul corect (NU că request-ul
 * HTTP întreg funcționează — endpointul `/token` + emiterea codului la `/authorize` rămân pt. 10.3b-iv).
 */
process.env.NEXT_PUBLIC_SUPABASE_URL   ||= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY  ||= "dummy-service-role-key-integration";

import Redis from "ioredis";
import { createHash } from "crypto";

const URL = process.env.REDIS_URL ?? "";
const LOOPBACK = /^redis:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(URL);
if (!LOOPBACK || process.env.QUOTA_INTEGRATION_ALLOW !== "1") {
  console.log("[userAuth.integration] SKIP — cere REDIS_URL loopback + QUOTA_INTEGRATION_ALLOW=1");
  process.exit(0);
}

import { mintToken, validateToken, checkAccountRateLimit, checkRateLimit, TOKEN_TTL_SEC, REFRESH_TTL_SEC } from "../db/oauth-tokens";
import { mintRefreshToken, familyKey, getFamilyState, rotateRefreshToken, peekRefreshToken } from "../db/oauth-refresh";
import { consumeCodeAndIssueUserWithRefresh } from "../db/oauth-codes";
import { accountRlKeys, clientRlKeys, type ScopeLimits } from "../db/quotaAtomic";
import { resolveAuth, type AuthDeps, type AuthResult } from "./authPolicy";
import { planUserRefreshRotation } from "../oauth/userRefreshPlan";
import { SERVER_SCOPE_CATALOG } from "../oauth/scopeCatalog";
import { buildUserTokenDraft, finalizeUserTokenPayload, type UserTokenPayload } from "../oauth/tokenPayloadModel";
import { buildUserRefreshDraft, finalizeUserRefreshPayload, isUserRefresh, type UserRefreshPayload } from "../oauth/refreshPayloadModel";
import type { OAuthGrant } from "../oauth/grant";
import type { AccountEntitlement } from "../oauth/entitlement";
import type { RegistrationRef } from "../oauth/authorizeConsent";
import type { GrantLookup } from "../db/grantLookup";
import type { AccountEntitlementLookup } from "../db/entitlementLookup";
import type { RegistrationLookup } from "../db/registrationLookup";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("  OK  " + name); }
  else      { failed++; console.log("  FAIL " + name); }
}

const SFX = Math.random().toString(36).slice(2, 10);
const AUD = "https://x/api/mcp";
const CID = `it_c_${SFX}`;
let famSeq = 0, uidSeq = 0;
const FAM = () => `it_fam_${SFX}_${famSeq++}`;
const UID = () => `it_u_${SFX}_${uidSeq++}`;

// chei derivate din tokenul plain (pt. cleanup — inclusiv ieșirile rotației).
const tokKey = (t: string) => `mcp:token:${createHash("sha256").update(t).digest("hex")}`;
const refKey = (t: string) => `mcp:refresh:${createHash("sha256").update(t).digest("hex")}`;

const made: string[] = []; // chei de curățat

function userAccess(fam: string, over: Partial<UserTokenPayload> = {}): UserTokenPayload {
  return { subject_kind: "user", user_id: UID_FIX, grant_id: "g1", entitlement_version: 2, client_id: CID,
    scopes: ["read:pair"], issued_at: 1, audience: AUD, family_id: fam, ...over };
}
function userRefresh(fam: string, over: Partial<UserRefreshPayload> = {}): UserRefreshPayload {
  return { subject_kind: "user", client_id: CID, user_id: UID_FIX, grant_id: "g1", entitlement_version: 2,
    scopes: ["read:pair", "read:market"], audience: AUD, issued_at: 1, family_id: fam, ...over };
}
let UID_FIX = "it_u_fix"; // înlocuit per-grup unde contează user_id

function grantFor(uid: string, over: Partial<OAuthGrant> = {}): OAuthGrant {
  return { grant_id: "g1", registration_id: "r1", client_id: CID, user_id: uid, resource: AUD,
    scopes: ["read:pair", "read:market"], entitlement_version: 2, status: "active", created_at: "2026-01-01T00:00:00Z", ...over };
}
function entFor(uid: string, over: Partial<AccountEntitlement> = {}): AccountEntitlement {
  return { user_id: uid, plan: "pro", scopes: ["read:pair", "read:market"],
    rate_limit_per_minute: 60, rate_limit_per_day: 10000, status: "active", entitlement_version: 2, ...over };
}
const REG: RegistrationRef = { registration_id: "r1", client_id: CID, status: "active",
  grant_types: ["authorization_code", "refresh_token"], expires_at: null };

async function main(): Promise<void> {
  const r = new Redis(URL, { maxRetriesPerRequest: 2, lazyConnect: false });

  async function putAccess<T>(payload: T): Promise<string> {
    const m = mintToken(payload); await r.set(m.key, m.value, "EX", TOKEN_TTL_SEC); made.push(m.key); return m.token;
  }
  async function putRefresh(payload: UserRefreshPayload): Promise<string> {
    const m = mintRefreshToken(payload);
    await r.set(m.key, m.value, "EX", REFRESH_TTL_SEC);
    await r.set(familyKey(payload.family_id), m.hash, "EX", REFRESH_TTL_SEC);
    made.push(m.key, familyKey(payload.family_id)); return m.token;
  }

  // deps `resolveAuth` cu I/O REAL (token/familie/rate pe Redis) + lookup-uri Supabase INJECTATE.
  function deps(uid: string, over: Partial<AuthDeps> = {}): AuthDeps {
    return {
      validateToken,                                   // REAL (Redis)
      familyState: getFamilyState,                     // REAL (Redis) — revocarea de familie
      checkAccountRate: checkAccountRateLimit,         // REAL (Redis) — account-only atomic
      checkRate: checkRateLimit,                       // REAL — pt. calea client (D)
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      expectedAudience: AUD,
      getRegistration:       async () => ({ status: "found", registration: REG }) as RegistrationLookup,
      getGrant:              async () => ({ status: "found", grant: grantFor(uid) }) as GrantLookup,
      getAccountEntitlement: async () => ({ status: "found", entitlement: entFor(uid) }) as AccountEntitlementLookup,
      touchRegistration: () => {},
      getClient: async () => ({ status: "found", client: { client_id: CID, secret_rotated_at: "cv", plan: "starter", rate_limit_per_minute: 100, rate_limit_per_day: 5000, scopes: ["read:basic"] } } as never),
      touch: () => {},
      ...over,
    };
  }
  const ok = (a: AuthResult) => a.ok === true;

  try {
    console.log("PH-2 step 10.5c — userAuth pe Redis REAL");

    // ── (A) LANȚUL USER REAL: emitere inițială → peek discriminat → plan → finalize cu familia → rotate → revocare ──
    const uidA = UID(); const codeA = `it_code_${SFX}`;
    const scA = ["read:pair", "read:market"]; // scope-ul ORIGINAL al lanțului
    // 1. EMITERE INIȚIALĂ reală (consumeCodeAndIssueUserWithRefresh): seed cod → consumă + emite access+refresh+familie atomic.
    const accessDraftA  = buildUserTokenDraft({ user_id: uidA, grant_id: "g1", entitlement_version: 2, client_id: CID, scopes: scA, issued_at: 1, audience: AUD });
    const refreshDraftA = buildUserRefreshDraft({ client_id: CID, user_id: uidA, grant_id: "g1", entitlement_version: 2, scopes: scA, audience: AUD, issued_at: 1 });
    await r.set(`mcp:code:${codeA}`, "seed", "EX", 600); made.push(`mcp:code:${codeA}`);
    const issued = await consumeCodeAndIssueUserWithRefresh(codeA, "seed", accessDraftA, refreshDraftA);
    check("A1. ⭐⭐⭐ emitere inițială USER pe Redis real (consumeCodeAndIssueUserWithRefresh) → issued", issued.status === "issued");
    const A1tok = issued.status === "issued" ? issued.token        : "";
    const R1    = issued.status === "issued" ? issued.refreshToken : "";
    made.push(tokKey(A1tok), refKey(R1));

    // 2. peekRefreshToken DISCRIMINAT: R1 → formă USER + identitate/scopes corecte; familia se descoperă din payload.
    const look1 = await peekRefreshToken(R1);
    const rp1 = look1.status === "found" && isUserRefresh(look1.payload) ? look1.payload : null;
    check("A2. ⭐⭐⭐ peekRefreshToken(R1) → found + formă USER (discriminare) + user_id/grant_id/client_id/scopes corecte",
      !!rp1 && rp1.user_id === uidA && rp1.grant_id === "g1" && rp1.client_id === CID && JSON.stringify(rp1.scopes) === JSON.stringify(scA));
    const famA = rp1 ? rp1.family_id : "";
    made.push(familyKey(famA));

    // 3. access-tokenul EMIS de emiterea inițială e acceptat de resolveAuth (payload user corect end-to-end).
    check("A3. ⭐⭐⭐ access-tokenul emis inițial (real) e acceptat de resolveAuth → ok", ok(await resolveAuth(`Bearer ${A1tok}`, deps(uidA))));

    // 4. LANȚUL DE ROTAȚIE al rutei: planUserRefreshRotation (pur) → finalize draft-uri cu familia → rotateRefreshToken.
    const planA = planUserRefreshRotation({
      refresh: rp1 as UserRefreshPayload,
      grantLookup:   { status: "found", grant: grantFor(uidA) },
      accountLookup: { status: "found", entitlement: entFor(uidA) },
      requestedScopes: [], serverPolicy: [...SERVER_SCOPE_CATALOG], issuedAt: 2,
    });
    check("A4. ⭐⭐⭐ planUserRefreshRotation(refresh real) → rotate", planA.kind === "rotate");
    if (planA.kind !== "rotate") throw new Error("planA: așteptat rotate");
    const accessPayloadA = finalizeUserTokenPayload(planA.accessDraft, famA);
    const newRefreshA    = finalizeUserRefreshPayload(planA.refreshDraft, famA);
    const rot1 = await rotateRefreshToken(R1, accessPayloadA, newRefreshA);
    check("A5. ⭐⭐ rotateRefreshToken (payload user finalizat cu familia lanțului) → rotated", rot1.status === "rotated");
    const A2tok = rot1.status === "rotated" ? rot1.accessToken  : "";
    const R2    = rot1.status === "rotated" ? rot1.refreshToken : "";
    made.push(tokKey(A2tok), refKey(R2));

    // 5. access-tokenul PRODUS de rotația user e acceptat de resolveAuth ÎNAINTE de reuse (payload rotit corect).
    check("A6. ⭐⭐⭐ ACCESS-ul PRODUS de rotația user (A2) e acceptat de resolveAuth → ok",
      ok(await resolveAuth(`Bearer ${A2tok}`, deps(uidA))));

    // 6. refresh-ul rotit (R2): aceeași identitate + familie + scope-uri ORIGINALE păstrate (fără îngustare permanentă).
    const look2 = await peekRefreshToken(R2);
    const rp2 = look2.status === "found" && isUserRefresh(look2.payload) ? look2.payload : null;
    check("A7. ⭐⭐⭐ peekRefreshToken(R2 rotit) → USER, aceeași identitate/familie + scope-uri ORIGINALE păstrate",
      !!rp2 && rp2.user_id === uidA && rp2.grant_id === "g1" && rp2.client_id === CID && rp2.family_id === famA && JSON.stringify(rp2.scopes) === JSON.stringify(scA));

    // 7. reuse R1 (vechi) → familie REVOCATĂ (Lua reală).
    const reuseA = await rotateRefreshToken(R1, accessPayloadA, newRefreshA);
    check("A8. ⭐⭐⭐ reuse refresh vechi (R1) → reuse_detected + familia REVOCATĂ", reuseA.status === "reuse_detected" && (await getFamilyState(famA)) === "revoked");

    // 8. revocarea ajunge la AMBELE token-uri PRODUSE de rotație: A2 moare la resolveAuth + R2 moare la rotație.
    const deadA2 = await resolveAuth(`Bearer ${A2tok}`, deps(uidA));
    check("A9. ⭐⭐⭐ ACCESS-ul PRODUS de rotație (A2) MOARE după reuse → 401 INVALID_TOKEN",
      deadA2.ok === false && deadA2.status === 401 && deadA2.errorCode === "INVALID_TOKEN");
    const deadR2 = await rotateRefreshToken(R2, accessPayloadA, newRefreshA);
    check("A10. ⭐⭐⭐ REFRESH-ul nou valid (R2) MOARE la rotație după revocare → revoked", deadR2.status === "revoked");

    // 9. DISCRIMINARE peek: un refresh CLIENT (subject_kind absent) → found dar NU formă user.
    const cliRef = mintRefreshToken({ client_id: CID, scopes: ["read:basic"], audience: AUD, credential_version: "cv", family_id: `it_cf_${SFX}`, issued_at: 1 });
    await r.set(cliRef.key, cliRef.value, "EX", REFRESH_TTL_SEC); made.push(cliRef.key);
    const lookC = await peekRefreshToken(cliRef.token);
    check("A11. ⭐⭐ peekRefreshToken discriminează: refresh CLIENT → found dar NU formă user",
      lookC.status === "found" && !isUserRefresh(lookC.payload));

    // ── (B) rate-limit ACCOUNT-ONLY atomic (fără chei de client) ───────────────────────
    const uidB = UID(); const lim: ScopeLimits = { perMinute: 2, perDay: 100 };
    const b1 = await checkAccountRateLimit(uidB, lim);
    const b2 = await checkAccountRateLimit(uidB, lim);
    const b3 = await checkAccountRateLimit(uidB, lim);
    const ak = accountRlKeys(uidB), ck = clientRlKeys(uidB);
    made.push(ak.minKey, ak.dayKey, ck.minKey, ck.dayKey);
    check("B1. ⭐⭐ cap cont 2: primele 2 → ok", b1.status === "ok" && b2.status === "ok");
    check("B2. ⭐⭐⭐ al 3-lea → limited (atomic pe Lua reală)", b3.status === "limited");
    check("B3. ⭐⭐ cheile de CONT (mcp:rl:acct:*) incrementate", (await r.get(ak.minKey)) !== null && (await r.get(ak.dayKey)) !== null);
    check("B4. ⭐⭐⭐ ZERO chei de CLIENT (mcp:rl:min/day:<uid>) — dimensiunea client retrasă pt. DCR",
      (await r.get(ck.minKey)) === null && (await r.get(ck.dayKey)) === null);

    // ── (C) discriminarea 503/401/429 prin resolveAuth real ───────────────────────────
    const famC = FAM(); const uidC = UID(); UID_FIX = uidC;
    const cTok = await putAccess(userAccess(famC)); await putRefresh(userRefresh(famC));
    check("C1. ⭐⭐ valid (token+familie reale, Supabase injectat valid) → ok", ok(await resolveAuth(`Bearer ${cTok}`, deps(uidC))));
    const cStale = await resolveAuth(`Bearer ${cTok}`, deps(uidC, { getAccountEntitlement: async () => ({ status: "found", entitlement: entFor(uidC, { entitlement_version: 3 }) }) }));
    check("C2. ⭐⭐⭐ entitlement_version cont ≠ token → 401 (access respins pe stare CONT)", cStale.status === 401);
    const cGrev = await resolveAuth(`Bearer ${cTok}`, deps(uidC, { getGrant: async () => ({ status: "found", grant: grantFor(uidC, { status: "revoked" }) }) }));
    check("C3. ⭐⭐⭐ grant REVOCAT → 401", cGrev.status === 401);
    const cRina = await resolveAuth(`Bearer ${cTok}`, deps(uidC, { getRegistration: async () => ({ status: "found", registration: { ...REG, status: "suspended" } }) }));
    check("C4. ⭐⭐⭐ registration inactivă → 401", cRina.status === 401);
    const cRuna = await resolveAuth(`Bearer ${cTok}`, deps(uidC, { getRegistration: async () => ({ status: "unavailable", reason: "down" }) }));
    check("C5. ⭐⭐⭐ registration unavailable → 503 AUTH_UNAVAILABLE (NU 401 fals)", cRuna.status === 503 && cRuna.errorCode === "AUTH_UNAVAILABLE");
    const cAuna = await resolveAuth(`Bearer ${cTok}`, deps(uidC, { getAccountEntitlement: async () => ({ status: "unavailable", reason: "down" }) }));
    check("C6. ⭐⭐⭐ cont unavailable → 503 (NU 401)", cAuna.status === 503 && cAuna.errorCode === "AUTH_UNAVAILABLE");
    // rate atomic → 429 prin resolveAuth (entitlement cu cap 1/minut)
    const famD = FAM(); const uidD = UID(); UID_FIX = uidD;
    const dTok = await putAccess(userAccess(famD)); await putRefresh(userRefresh(famD));
    const rlDeps = deps(uidD, { getAccountEntitlement: async () => ({ status: "found", entitlement: entFor(uidD, { rate_limit_per_minute: 1, rate_limit_per_day: 100 }) }) });
    const first  = await resolveAuth(`Bearer ${dTok}`, rlDeps); // consumă 1 → ok
    const second = await resolveAuth(`Bearer ${dTok}`, rlDeps); // cap 1 depășit → 429
    made.push(accountRlKeys(uidD).minKey, accountRlKeys(uidD).dayKey);
    check("C7. ⭐⭐⭐ rate account-only atomic prin resolveAuth: al 2-lea (cap 1/min) → 429 RATE_LIMITED",
      first.ok === true && second.status === 429 && second.errorCode === "RATE_LIMITED");

    // ── (D) LEGACY/CLIENT neschimbat pe Redis real ────────────────────────────────────
    const legacyTok = await putAccess({ client_id: CID, scopes: ["read:basic"], issued_at: 1, credential_version: "cv", audience: AUD });
    const dOk = await resolveAuth(`Bearer ${legacyTok}`, deps("irrelevant"));
    check("D1. ⭐⭐ token LEGACY/CLIENT pe Redis real → ok, subiect CLIENT (calea client neatinsă de rework)",
      dOk.ok === true && dOk.subject?.kind === "client");

    // cheile de rate atinse de resolveAuth (cont uidA/uidC + client CID din D1) — pt. cleanup complet.
    made.push(accountRlKeys(uidA).minKey, accountRlKeys(uidA).dayKey,
              accountRlKeys(uidC).minKey, accountRlKeys(uidC).dayKey,
              clientRlKeys(CID).minKey,   clientRlKeys(CID).dayKey);

    console.log("\n" + passed + " passed, " + failed + " failed");
  } finally {
    if (made.length) { try { await r.del(...Array.from(new Set(made))); } catch { /* best-effort */ } }
    await r.quit();
  }
}

// Forțează exit: căile REALE folosesc singleton-ul `getRedis()` (socket deschis) → altfel event-loop-ul rămâne viu.
main().then(() => process.exit(failed > 0 ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
