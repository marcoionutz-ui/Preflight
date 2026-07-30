/**
 * lib/mcp/auth.ts
 * Autentificare Bearer token + rate limit
 */

import type { NextRequest }        from "next/server";
import { validateToken, checkRateLimit } from "@/lib/db/oauth-tokens";
import { getClientById, touchClient }    from "@/lib/db/oauth-clients";
import { resolveAuth }                from "./authPolicy";
import type { AuthResult }            from "./authPolicy";

export type { AuthResult } from "./authPolicy";

/**
 * E10: fluxul de decizie e în `authPolicy.resolveAuth` (pur, injectabil, testat izolat). Aici doar legăm
 * dependențele reale (Redis token/rate-limit, Supabase client) + bypass-ul de dev. Token neverificat din cauza
 * unui Redis jos → 503 AUTH_UNAVAILABLE (după 1 retry), niciodată 401 fals sau throw necaptat.
 */
export async function authenticate(req: NextRequest): Promise<AuthResult> {
  // Dev mode fără key configurat
  if (!process.env.MCP_API_KEY && process.env.NODE_ENV !== "production") {
    return { ok: true, clientId: "dev", scopes: ["read:all"], plan: "internal" };
  }

  const authHeader = (req.headers.get("authorization") ?? "").trim();
  return resolveAuth(authHeader, {
    validateToken,
    getClient: getClientById,
    checkRate: checkRateLimit,
    touch:     touchClient,
    sleep:     (ms) => new Promise((res) => setTimeout(res, ms)),
  });
}

export function authErrorResponse(auth: AuthResult): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth.retryAfter) headers["Retry-After"] = String(auth.retryAfter);
  headers["WWW-Authenticate"] = `Bearer resource_metadata="/.well-known/oauth-protected-resource"`;

  return new Response(
    JSON.stringify({ ok: false, error: { code: auth.errorCode, message: auth.error } }),
    { status: auth.status ?? 401, headers },
  );
}