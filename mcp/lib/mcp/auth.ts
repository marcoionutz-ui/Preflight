/**
 * lib/mcp/auth.ts
 * Autentificare Bearer token + rate limit
 */

import type { NextRequest }        from "next/server";
import { validateToken, checkRateLimit } from "@/lib/db/oauth-tokens";
import { getClientById, touchClient }    from "@/lib/db/oauth-clients";
import { resolveAuth, resolveDevBypass } from "./authPolicy";
import type { AuthResult }            from "./authPolicy";

export type { AuthResult } from "./authPolicy";

// E2: avertizează o SINGURĂ dată per proces când bypass-ul de dev e activ (nu spam per-request).
let devBypassWarned = false;

/**
 * E10: fluxul de decizie e în `authPolicy.resolveAuth` (pur, injectabil, testat izolat). Aici doar legăm
 * dependențele reale (Redis token/rate-limit, Supabase client) + bypass-ul de dev. Token neverificat din cauza
 * unui Redis jos → 503 AUTH_UNAVAILABLE (după 1 retry), niciodată 401 fals sau throw necaptat.
 */
export async function authenticate(req: NextRequest): Promise<AuthResult> {
  // E2: dev bypass DOAR pe opt-in EXPLICIT (`MCP_DEV_AUTH_BYPASS`) + non-producție. Absența `MCP_API_KEY` NU mai
  // deschide ușa (fail-closed) — un deploy care uită cheia primește 401, nu acces liber cu read:all.
  const devBypass = resolveDevBypass({
    nodeEnv:    process.env.NODE_ENV,
    bypassFlag: process.env.MCP_DEV_AUTH_BYPASS,
  });
  if (devBypass) {
    if (!devBypassWarned) {
      console.warn(
        "[AUTH] ⚠️ DEV AUTH BYPASS activ (MCP_DEV_AUTH_BYPASS setat, NODE_ENV≠production) — " +
        "TOATE cererile sunt autorizate ca 'dev' cu read:all. NU seta acest flag în producție.",
      );
      devBypassWarned = true;
    }
    return devBypass;
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