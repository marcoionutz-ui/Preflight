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
import type { OAuthClient } from "../db/oauth-clients";

export const AUTH_RETRY_MS       = 75;  // un singur retry rapid pe „unavailable" înainte de 503
export const UNAVAILABLE_RETRY_S = 2;   // Retry-After (secunde) pe 503

export interface AuthResult {
  ok:          boolean;
  clientId?:   string;
  scopes?:     string[];
  plan?:       string;
  error?:      string;
  errorCode?:  string;
  status?:     number;
  retryAfter?: number;
}

export interface AuthDeps {
  validateToken: (token: string) => Promise<TokenValidation>;
  getClient:     (clientId: string) => Promise<OAuthClient | null>;
  checkRate:     (clientId: string, rpm: number, rpd: number) => Promise<RateLimitOutcome>;
  touch:         (clientId: string) => void;
  sleep:         (ms: number) => Promise<void>;
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

  // 2. Client + rotație de secret (domeniu Supabase, nu Redis — 401 pe absență/rotație rămâne corect).
  const client = await deps.getClient(v.payload.client_id);
  if (!client) {
    return unauthorized("UNAUTHORIZED", "Client not found or revoked");
  }
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

  deps.touch(client.client_id);
  return { ok: true, clientId: client.client_id, scopes: v.payload.scopes, plan: client.plan };
}
