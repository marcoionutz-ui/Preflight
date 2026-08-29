/**
 * app/.well-known/openid-configuration/route.ts
 * OpenID Connect Discovery — cerut de Claude.ai
 */

import type { NextRequest } from "next/server";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";
import { SERVER_SCOPE_CATALOG } from "@/lib/oauth/scopeCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const issuer = resolveBaseUrl(req.headers, process.env);

  return Response.json({
    issuer,
    authorization_endpoint:                `${issuer}/authorize`,
    token_endpoint:                        `${issuer}/api/oauth/token`,
    response_types_supported:              ["code"],
    grant_types_supported:                 ["authorization_code", "client_credentials"],
    code_challenge_methods_supported:      ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    scopes_supported:                      [...SERVER_SCOPE_CATALOG],
    subject_types_supported:               ["public"],
  });
}
