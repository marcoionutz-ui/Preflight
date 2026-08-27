/**
 * lib/mcp/authPolicy.ts — E10 (decizia de autentificare, PURĂ + injectabilă).
 *
 * Fluxul de auth (validare token → client → rotație secret → rate-limit) extras din `auth.ts` ca funcție pură cu
 * dependențe INJECTATE, ca să fie testabil izolat (fără Redis/Supabase/NextRequest). `auth.ts` doar leagă
 * dependențele reale. Toate importurile sunt `import type` (șterse la runtime de esbuild/tsx) → frunză rulabilă.
 *
 * Contract E10:
 *   token invalid/expirat     → 401 INVALID_TOKEN
 *   Redis indisponibil        → 1 retry scurt → 503 AUTH_UNAVAILABLE  (NU 401, NU throw/500)
 *   rate limit real depășit   → 429 RATE_LIMITED
 *   rate limit neaplicabil    → 503 RATE_LIMIT_UNAVAILABLE   (429 ≠ 503, semantic distinct)
 */

import type { TokenValidation, RateLimitOutcome } from "../db/oauth-tokens";
import type { ClientLookup } from "../db/clientLookup";
import type { FamilyState } from "../db/oauth-refresh";
import type { GrantLookup } from "../db/grantLookup";
import type { AccountEntitlementLookup } from "../db/entitlementLookup";
import type { ScopeLimits } from "../db/quotaAtomic";
import { tokenAudienceValid } from "../oauth/resource";
import { parseTokenSubject } from "../oauth/subjectClaims";
import { tokenCredentialVersion, tokenFamilyId, type UserTokenPayload } from "../oauth/tokenPayloadModel";
import { verifyUserTokenGrant } from "../oauth/userTokenGrantVerify";
import { verifyUserAccount } from "../oauth/userAccountVerify";
import { verifyUserRegistration } from "../oauth/userRegistrationVerify";
import type { RegistrationLookup } from "../db/registrationLookup";
import type { QuotaSubject } from "../db/quotaKey";

export const AUTH_RETRY_MS       = 75;  // un singur retry rapid pe „unavailable" înainte de 503
export const UNAVAILABLE_RETRY_S = 2;   // Retry-After (secunde) pe 503

export interface AuthResult {
  ok:          boolean;
  clientId?:   string;
  scopes?:     string[];
  plan?:       string;
  // PH-2 (9b-wire): subiectul de quota derivat din TOKEN (account pe user_id / client pe client_id). Setat pe toate
  // căile `ok:true`; ruta îl pune neschimbat în `ToolContext.quotaSubject`. Absent pe căile de eroare.
  subject?:    QuotaSubject;
  error?:      string;
  errorCode?:  string;
  status?:     number;
  retryAfter?: number;
}

/**
 * PH-2 (9b-wire): mapează payload-ul de token la SUBIECTUL de quota, FAIL-CLOSED (cgpt):
 *   - `subject_kind` ABSENT  → token dinainte de cutover (client-only) → fallback CLIENT pe `fallbackClientId`.
 *   - `subject_kind = user`  ȘI subiect user VALID → ACCOUNT pe `user_id`.
 *   - `subject_kind = client` ȘI subiect client VALID → CLIENT pe `fallbackClientId`.
 *   - `subject_kind` PREZENT dar formă INVALIDĂ (user incomplet, kind necunoscut, claim interzis) → `null` = RESPINGE.
 * Fallback-ul pe client e permis DOAR la absența lui `subject_kind`; un `subject_kind` prezent-dar-malformat NU cade
 * tăcut pe quota clientului (altfel un rollout parțial ar taxa silențios clientul în locul contului). `null` →
 * `resolveAuth` întoarce 401 INVALID_TOKEN. Pur → testabil izolat.
 */
export function quotaSubjectFromToken(payload: unknown, fallbackClientId: string): QuotaSubject | null {
  const kind = (payload && typeof payload === "object")
    ? (payload as { subject_kind?: unknown }).subject_kind
    : undefined;
  if (kind === undefined) return { kind: "client", clientId: fallbackClientId }; // legacy: fără subject_kind

  const s = parseTokenSubject(payload); // subject_kind prezent → cere subiect VALID de forma declarată
  if (!s) return null;                  // prezent dar invalid/necunoscut → RESPINGE (nu fallback tăcut pe client)
  return s.subject_kind === "user"
    ? { kind: "account", userId: s.user_id }
    : { kind: "client", clientId: fallbackClientId };
}

export interface AuthDeps {
  validateToken: (token: string) => Promise<TokenValidation>;
  // NF4: rezultat DISCRIMINAT — `not_found` (401 onest) vs `unavailable` (503, la fel ca Redis jos), nu ambele null.
  getClient:     (clientId: string) => Promise<ClientLookup>;
  checkRate:     (clientId: string, rpm: number, rpd: number) => Promise<RateLimitOutcome>;
  touch:         (clientId: string) => void;
  sleep:         (ms: number) => Promise<void>;
  // PH-3 (RFC 8707): resursa canonică a ACESTUI server (`${issuer}/api/mcp`). Când e furnizată, tokenul trebuie să
  // aibă audience-ul == ea (altfel 401). Opțional: testele pure E10 nu-l injectează; `auth.ts` îl setează mereu.
  expectedAudience?: string;
  // PH-4 (cgpt #1 — grant-level revocation): starea familiei de refresh a tokenului (`active|revoked|unavailable`).
  // Injectată de `auth.ts` (Redis). Absentă în testele pure E10. Când e furnizată ȘI tokenul are family_id, o familie
  // REVOCATĂ → 401 INVALID_TOKEN (revocarea ajunge și la access token-urile deja emise, nu doar la refresh).
  familyState?: (familyId: string) => Promise<FamilyState>;
  // PH-2 step 10.5 (rework cgpt DCR) — deps pentru ramura USER (auth-code). Clienții DCR PUBLICI (Claude.ai connector)
  // trăiesc în `oauth_client_registrations`, NU în `oauth_clients` — deci ramura user citește REGISTRATION-ul, NU
  // `getClient`. Opționale (testele client/legacy nu ating ramura user); un token USER care ajunge FĂRĂ ele → 503
  // fail-closed. NU citim plan/scopes/quota din registration (alea = CONTUL).
  //   getRegistration       = shell-ul DCR (existență/status/expirare/grant types) → `verifyUserRegistration`;
  //   getGrant              = grantul pinnat la consimțământ (oauth_grants);
  //   getAccountEntitlement = starea CURENTĂ a contului (account_entitlements);
  //   checkAccountRate      = rate-limit ATOMIC ACCOUNT-ONLY (DCR n-are entitlement de client → fără dimensiune client);
  //   touchRegistration     = last_used_at pe registration (NU `touchClient`/oauth_clients).
  getRegistration?:       (clientId: string) => Promise<RegistrationLookup>;
  getGrant?:              (grantId: string) => Promise<GrantLookup>;
  getAccountEntitlement?: (userId: string) => Promise<AccountEntitlementLookup>;
  checkAccountRate?:      (userId: string, account: ScopeLimits) => Promise<RateLimitOutcome>;
  touchRegistration?:     (clientId: string) => void;
}

/**
 * E2: dev auth bypass — opt-in EXPLICIT, fail-closed. Vechiul gate (`!MCP_API_KEY && NODE_ENV !== "production"`)
 * se DESCHIDEA din simpla ABSENȚĂ a config-ului: un deploy care uita `MCP_API_KEY`, cu `NODE_ENV` nesetat
 * (`undefined !== "production"` = adevărat), primea acces LIBER cu read:all. Absența config-ului trebuie să
 * eșueze ÎNCHIS, nu deschis. Acum bypass-ul cere un flag INTENȚIONAT (`MCP_DEV_AUTH_BYPASS` truthy) ȘI
 * NODE_ENV != "production" — `NODE_ENV` singur nu mai e poartă de securitate (e o convenție de build, nu un
 * flag de auth, și e nesetat implicit în multe runtime-uri).
 */
export function isDevBypassEnabled(flag: string | undefined): boolean {
  if (typeof flag !== "string") return false;
  const v = flag.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * E2: întoarce AuthResult-ul de dev DOAR dacă bypass-ul e activat EXPLICIT ȘI nu suntem în producție; altfel
 * `null` (auth normală). Guard-ul de producție e case-insensitive + trim (blochează „Production"/„ production ").
 */
export function resolveDevBypass(env: { nodeEnv: string | undefined; bypassFlag: string | undefined }): AuthResult | null {
  // Niciodată în producție — chiar dacă flag-ul e setat din greșeală.
  if ((env.nodeEnv ?? "").trim().toLowerCase() === "production") return null;
  // Opt-in explicit — absența unei chei NU mai deschide ușa (fail-closed).
  if (!isDevBypassEnabled(env.bypassFlag)) return null;
  return { ok: true, clientId: "dev", scopes: ["read:all"], plan: "internal", subject: { kind: "client", clientId: "dev" } };
}

function unauthorized(code: string, message: string): AuthResult {
  return { ok: false, error: message, errorCode: code, status: 401 };
}

function unavailable(code: string, message: string): AuthResult {
  return { ok: false, error: message, errorCode: code, status: 503, retryAfter: UNAVAILABLE_RETRY_S };
}

export async function resolveAuth(authHeader: string, deps: AuthDeps): Promise<AuthResult> {
  if (!authHeader.startsWith("Bearer ")) {
    return unauthorized("UNAUTHORIZED", "Missing Bearer token");
  }
  const token = authHeader.slice(7).trim();

  // 1. Validare token — un singur retry rapid pe „unavailable", apoi 503 (nu presupunem, nu cache pozitiv).
  let v = await deps.validateToken(token);
  if (v.status === "unavailable") {
    await deps.sleep(AUTH_RETRY_MS);
    v = await deps.validateToken(token);
  }
  if (v.status === "unavailable") {
    return unavailable("AUTH_UNAVAILABLE", "Authentication backend temporarily unavailable");
  }
  if (v.status === "invalid") {
    return unauthorized("INVALID_TOKEN", "Invalid or expired token");
  }

  // PH-3 (RFC 8707 / spec MCP „token audience binding"): tokenul trebuie emis pentru ACEST resource server. Un
  // audience prezent dar ≠ resursa canonică = token pentru ALTĂ resursă → 401 (nu-l onora — anti confused-deputy).
  // `expectedAudience` absent (teste pure) sau audience absent pe token (grandfather) → sar peste (vezi resource.ts).
  if (deps.expectedAudience && !tokenAudienceValid(v.payload.audience, deps.expectedAudience)) {
    return unauthorized("INVALID_TOKEN", "Token was not issued for this resource");
  }

  // PH-4 (cgpt #1 — grant-level revocation): access token-ul poartă family_id-ul lanțului său de refresh. Dacă familia
  // a fost REVOCATĂ (reuse-detection pe refresh sau logout), acest access token e mort ACUM — revocarea ajunge la
  // access token-uri, nu doar la refresh (fereastra de compromis = min(access TTL, până rotește cineva)). `familyState`
  // absent (teste pure) sau token fără family_id (grandfather / client_credentials) → sar peste. `unavailable` → 1 retry
  // scurt apoi 503 (identic cu validateToken/getClient), NICIODATĂ 401 fals pe un outage Redis.
  // PH-2 step 10.5a: `family_id` nu e pe toți membrii union-ului (CLIENT nou M2M nu-l are) → accesor sigur pe union.
  // Client/legacy/user păstrează comportamentul: undefined (client_credentials) → sare peste verificarea de familie.
  const familyId = tokenFamilyId(v.payload);
  if (deps.familyState && familyId) {
    let fs = await deps.familyState(familyId);
    if (fs === "unavailable") {
      await deps.sleep(AUTH_RETRY_MS);
      fs = await deps.familyState(familyId);
    }
    if (fs === "unavailable") {
      return unavailable("AUTH_UNAVAILABLE", "Authentication backend temporarily unavailable");
    }
    // `revoked` = familie tăiată explicit (reuse/logout). `inactive` = cheie absentă/malformată cât access-ul e viu =
    // invariantă ruptă (fail-closed, cgpt #2r). Ambele → grantul nu mai e activ → 401 (OAuth 2.1 §4.3.1).
    if (fs === "revoked" || fs === "inactive") {
      return unauthorized("INVALID_TOKEN", "Token revoked or grant no longer active");
    }
  }

  // PH-2 step 10.5a frunza 4b: FORK pe subiect. Un token USER (auth-code) se validează pe GRANT (consimțământ pinnat)
  // + CONT (stare curentă) + rate-limit atomic account+client, NU pe secretul clientului. Verificarea de audience +
  // familie de mai sus se aplică deja și userului (token user are audience + family_id). Client/legacy continuă mai jos.
  if (v.payload.subject_kind === "user") {
    return resolveUserAuth(v.payload, deps);
  }

  // 2. Client + rotație de secret. NF4: distinge „client inexistent/revocat" (401 onest) de „Supabase indisponibil"
  //    (503 AUTH_UNAVAILABLE — la fel ca Redis jos la token: 1 retry scurt, apoi 503, NICIODATĂ 401 fals). Rotația
  //    de secret (credential_version ≠ secret_rotated_at) rămâne 401 (verificare reușită, token invalidat).
  let cl = await deps.getClient(v.payload.client_id);
  if (cl.status === "unavailable") {
    await deps.sleep(AUTH_RETRY_MS);
    cl = await deps.getClient(v.payload.client_id);
  }
  if (cl.status === "unavailable") {
    return unavailable("AUTH_UNAVAILABLE", "Authentication backend temporarily unavailable");
  }
  if (cl.status === "not_found") {
    return unauthorized("UNAUTHORIZED", "Client not found or revoked");
  }
  const client = cl.client;
  // PH-2 step 10.5a: `credential_version` nu e pe forma USER (validitatea = grant/familie) → accesor sigur pe union.
  // Client/legacy: valoarea reală → gate-ul de rotație identic cu azi. User (dormant până la 10.5b/cutover): undefined
  // → `!credentialVersion` true → 401 aici (ramura user propriu-zisă — getGrant/entitlement — vine în frunza 4).
  const credentialVersion = tokenCredentialVersion(v.payload);
  if (!credentialVersion || credentialVersion !== client.secret_rotated_at) {
    return unauthorized("UNAUTHORIZED", "Token invalidated by credential rotation");
  }

  // 3. Rate limit — distinge „limită reală depășită" (429) de „nu pot aplica limita" (503).
  const rl = await deps.checkRate(client.client_id, client.rate_limit_per_minute, client.rate_limit_per_day);
  if (rl.status === "unavailable") {
    return unavailable("RATE_LIMIT_UNAVAILABLE", "Rate limiter temporarily unavailable");
  }
  if (rl.status === "limited") {
    return { ok: false, error: "Rate limit exceeded", errorCode: "RATE_LIMITED", status: 429, retryAfter: rl.retry_after };
  }

  // PH-2 (9b-wire): subiectul de quota vine din TOKEN (nu din context reconstruit). Azi payload-ul e client-only →
  // subiect CLIENT (cheie identică cu azi). La cutover, tokenurile user vor purta subject_kind=user → ACCOUNT pe
  // user_id, fără altă schimbare aici. Fail-closed: un `subject_kind` prezent dar malformat/necunoscut → `null` →
  // 401 (NU taxăm tăcut clientul în locul contului). (Condiționarea `credential_version` pe kind + emiterea
  // tokenurilor user = cutover/step 10; aici doar DERIVĂM subiectul din ce poartă tokenul.)
  const subject = quotaSubjectFromToken(v.payload, client.client_id);
  if (!subject) {
    return unauthorized("INVALID_TOKEN", "Token subject malformed");
  }

  deps.touch(client.client_id);
  return { ok: true, clientId: client.client_id, scopes: v.payload.scopes, plan: client.plan, subject };
}

/**
 * PH-2 step 10.5 (rework cgpt DCR) — ramura de auth pentru tokenurile USER (auth-code), PURĂ + injectabilă.
 *
 * Un access token USER e valid pe TREI axe (fail-closed pe fiecare), NU pe secretul clientului:
 *   1. REGISTRATION — clientul DCR PUBLIC trăiește în `oauth_client_registrations` (NU `oauth_clients`): `getRegistration`
 *      + `verifyUserRegistration` cere existență + status `active` + ne-expirat + `client_id` identic + `authorization_code`
 *      permis. NU verificăm `credential_version` (client public, fără secret). NU citim plan/scopes/quota din registration
 *      (alea = CONTUL). `unavailable` → 1 retry → 503; orice reject → 401.
 *   2. GRANT — `getGrant` + `verifyUserTokenGrant`: grantul (consimțământul pinnat la emitere) e ACTIV și consistent cu
 *      claim-urile tokenului (user_id/client_id/audience/entitlement_version/scopes⊆grant). `not_found` → 401, `unavailable`
 *      → 503, reject → 401.
 *   3. CONT — `getAccountEntitlement` + `verifyUserAccount`: contul CURENT e utilizabil + `entitlement_version` egal (plan
 *      schimbat → 401). `unavailable` → 503.
 *   4. RATE-LIMIT — ATOMIC ACCOUNT-ONLY (limitele CONTULUI). Un client DCR n-are entitlement de client → NU există a doua
 *      dimensiune legitimă (anti-abuzul per client = stratul de registration, nu quota). `limited` → 429, `unavailable`
 *      → 503 RATE_LIMIT_UNAVAILABLE.
 * OK → subiect = CONT (`user_id`), `plan` din entitlement, `scopes` din token, `clientId` din TOKEN (nu din oauth_clients);
 * `touchRegistration` (NU `touchClient`). Deps user lipsă → 503 (nu-l putem valida).
 */
export async function resolveUserAuth(payload: UserTokenPayload, deps: AuthDeps): Promise<AuthResult> {
  if (!deps.getRegistration || !deps.getGrant || !deps.getAccountEntitlement || !deps.checkAccountRate || !deps.touchRegistration) {
    // Config lipsă (nu „credențial greșit") → 503, nu 401.
    return unavailable("AUTH_UNAVAILABLE", "Authentication backend temporarily unavailable");
  }

  // 1. REGISTRATION (DCR public) — existență + activă + ne-expirată + client_id identic + authorization_code permis.
  //    NU `oauth_clients` (shell DCR nu-i acolo → getClient ar da 401 fals). FĂRĂ credential_version (client public).
  let rl0 = await deps.getRegistration(payload.client_id);
  if (rl0.status === "unavailable") {
    await deps.sleep(AUTH_RETRY_MS);
    rl0 = await deps.getRegistration(payload.client_id);
  }
  const rgv = verifyUserRegistration(rl0, { clientId: payload.client_id, nowMs: Date.now(), requiredGrantType: "authorization_code" });
  if (!rgv.ok && rgv.kind === "unavailable") return unavailable("AUTH_UNAVAILABLE", "Authentication backend temporarily unavailable");
  if (!rgv.ok)                               return unauthorized("UNAUTHORIZED", "Client registration not found or not active");

  // 2. Grant — consimțământul pinnat la emitere. getGrant `not_found` = grant șters/inexistent → 401 (nu 503).
  let gl = await deps.getGrant(payload.grant_id);
  if (gl.status === "unavailable") {
    await deps.sleep(AUTH_RETRY_MS);
    gl = await deps.getGrant(payload.grant_id);
  }
  if (gl.status === "unavailable") return unavailable("AUTH_UNAVAILABLE", "Authentication backend temporarily unavailable");
  if (gl.status === "not_found")   return unauthorized("INVALID_TOKEN", "Grant no longer exists");
  const gv = verifyUserTokenGrant({
    grant:              gl.grant,
    grantId:            payload.grant_id,
    userId:             payload.user_id,
    clientId:           payload.client_id,
    audience:           payload.audience,
    entitlementVersion: payload.entitlement_version,
    scopes:             payload.scopes,
  });
  if (!gv.ok) return unauthorized("INVALID_TOKEN", "Grant no longer valid for this token");

  // 3. Cont — starea CURENTĂ. verifyUserAccount discriminează 503 (outage) de 401 (retras/stale/user greșit).
  let el = await deps.getAccountEntitlement(payload.user_id);
  if (el.status === "unavailable") {
    await deps.sleep(AUTH_RETRY_MS);
    el = await deps.getAccountEntitlement(payload.user_id);
  }
  const av = verifyUserAccount(el, payload.user_id, payload.entitlement_version);
  if (!av.ok && av.kind === "unavailable") return unavailable("AUTH_UNAVAILABLE", "Authentication backend temporarily unavailable");
  if (!av.ok)                              return unauthorized("INVALID_TOKEN", "Account not valid for this token");
  const entitlement = av.entitlement;

  // 4. Rate-limit ATOMIC ACCOUNT-ONLY (limitele CONTULUI; DCR n-are dimensiune de client legitimă).
  const rl = await deps.checkAccountRate(
    payload.user_id,
    { perMinute: entitlement.rate_limit_per_minute, perDay: entitlement.rate_limit_per_day },
  );
  if (rl.status === "unavailable") return unavailable("RATE_LIMIT_UNAVAILABLE", "Rate limiter temporarily unavailable");
  if (rl.status === "limited") {
    return { ok: false, error: "Rate limit exceeded", errorCode: "RATE_LIMITED", status: 429, retryAfter: rl.retry_after };
  }

  // 5. OK — subiect = CONT (user_id), plan din entitlement, scopes + clientId din TOKEN (nu din oauth_clients).
  deps.touchRegistration(payload.client_id);
  return { ok: true, clientId: payload.client_id, scopes: payload.scopes, plan: entitlement.plan, subject: { kind: "account", userId: payload.user_id } };
}
