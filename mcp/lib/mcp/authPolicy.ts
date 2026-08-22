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
import { tokenAudienceValid } from "../oauth/resource";
import { parseTokenSubject } from "../oauth/subjectClaims";
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
  if (deps.familyState && v.payload.family_id) {
    let fs = await deps.familyState(v.payload.family_id);
    if (fs === "unavailable") {
      await deps.sleep(AUTH_RETRY_MS);
      fs = await deps.familyState(v.payload.family_id);
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
  if (!v.payload.credential_version || v.payload.credential_version !== client.secret_rotated_at) {
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
