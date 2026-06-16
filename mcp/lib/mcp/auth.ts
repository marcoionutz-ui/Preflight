/**
 * lib/mcp/auth.ts
 * Autentificare Bearer token + rate limit
 */

import type { NextRequest }        from "next/server";
import { validateToken }           from "@/lib/db/oauth-tokens";
import { checkRateLimit }          from "@/lib/db/oauth-tokens";
import { getClientById, touchClient } from "@/lib/db/oauth-clients";

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

export async function authenticate(req: NextRequest): Promise<AuthResult> {
  // Dev mode fără key configurat
  if (!process.env.MCP_API_KEY && process.env.NODE_ENV !== "production") {
    return { ok: true, clientId: "dev", scopes: ["read:all"], plan: "internal" };
  }

  const authHeader = (req.headers.get("authorization") ?? "").trim();
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, error: "Missing Bearer token", errorCode: "UNAUTHORIZED", status: 401 };
  }

  const token   = authHeader.slice(7).trim();
  const payload = await validateToken(token);
  if (!payload) {
    return { ok: false, error: "Invalid or expired token", errorCode: "UNAUTHORIZED", status: 401 };
  }

  const client = await getClientById(payload.client_id);
  if (!client) {
    return { ok: false, error: "Client not found or revoked", errorCode: "UNAUTHORIZED", status: 401 };
  }

  const rl = await checkRateLimit(
    client.client_id,
    client.rate_limit_per_minute,
    client.rate_limit_per_day,
  );

  if (!rl.allowed) {
    return {
      ok:          false,
      error:       "Rate limit exceeded",
      errorCode:   "RATE_LIMITED",
      status:      429,
      retryAfter:  rl.retry_after,
    };
  }

  touchClient(client.client_id);

  return { ok: true, clientId: client.client_id, scopes: payload.scopes, plan: client.plan };
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