/**
 * lib/mcp/auth.ts
 * Autentificare Bearer token + rate limit
 */

import type { NextRequest }        from "next/server";
import { validateToken, checkRateLimit, checkAccountRateLimit } from "@/lib/db/oauth-tokens";
import { lookupClientById, touchClient }  from "@/lib/db/oauth-clients";
import { getFamilyState }                 from "@/lib/db/oauth-refresh";
import { getGrantById, getAccountEntitlement } from "@/lib/db/ph2Reads";
import { resolveAuth, resolveDevBypass } from "./authPolicy";
import type { AuthResult }            from "./authPolicy";
import { resolveBaseUrl }             from "@/lib/oauth/baseUrl";
import { canonicalResourceUri }       from "@/lib/oauth/resource";

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

  // PH-3 (RFC 8707): resursa canonică a acestui server (`${issuer}/api/mcp`) — audience-ul așteptat pe token.
  // Dacă nu o putem determina (PUBLIC_BASE_URL lipsă în prod → resolveBaseUrl aruncă, PH-8), fail-closed 503: NU
  // dezactiva silențios validarea de audience (ar fi fail-open pe un misconfig).
  let expectedAudience: string;
  try {
    expectedAudience = canonicalResourceUri(resolveBaseUrl(req.headers, process.env));
  } catch {
    return { ok: false, error: "Authentication backend misconfigured", errorCode: "AUTH_UNAVAILABLE", status: 503, retryAfter: 2 };
  }

  const authHeader = (req.headers.get("authorization") ?? "").trim();
  return resolveAuth(authHeader, {
    validateToken,
    getClient: lookupClientById, // NF4: discriminat found|not_found|unavailable
    checkRate: checkRateLimit,
    touch:     touchClient,
    sleep:     (ms) => new Promise((res) => setTimeout(res, ms)),
    expectedAudience, // PH-3: audience binding
    familyState: getFamilyState, // PH-4: grant-level revocation (familie REVOCATĂ → 401 chiar pe access token)
    // PH-2 step 10.5a frunza 4c: deps pentru ramura USER (auth-code). Un token USER se validează pe grant + cont +
    // rate-limit atomic account+client (subiect = cont). Dormant efectiv până la 10.3b-iv (niciun cod user emis încă).
    getGrant:              getGrantById,          // grantul pinnat la consimțământ (oauth_grants)
    getAccountEntitlement,                         // starea CURENTĂ a contului (account_entitlements)
    checkAccountRate:      checkAccountRateLimit,  // rate-limit atomic account primar + client secundar (9a)
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