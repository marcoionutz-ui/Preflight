/**
 * app/.well-known/openid-configuration/route.ts
 * OpenID Connect Discovery — cerut de Claude.ai
 */

import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const host   = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto  = req.headers.get("x-forwarded-proto") ?? "https";
  const issuer = `${proto}://${host}`;

  return Response.json({
    issuer,
    authorization_endpoint:                `${issuer}/authorize`,
    token_endpoint:                        `${issuer}/api/oauth/token`,
    response_types_supported:              ["code"],
    grant_types_supported:                 ["authorization_code", "client_credentials"],
    code_challenge_methods_supported:      ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    scopes_supported:                      ["read:all"],
    subject_types_supported:               ["public"],
  });
}
