/**
 * app/.well-known/oauth-authorization-server/route.ts
 * OAuth 2.0 Authorization Server Metadata (RFC 8414) — mirrors the /api
 * twin at app/api/.well-known/oauth-authorization-server/route.ts.
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
	  authorization_endpoint:                  `${issuer}/authorize`,
	  token_endpoint:                          `${issuer}/api/oauth/token`,
	  token_endpoint_auth_methods_supported:   ["client_secret_post", "none"],
	  grant_types_supported:                   ["authorization_code", "client_credentials"],
	  response_types_supported:                ["code"],
	  code_challenge_methods_supported:        ["S256"],
	  scopes_supported:                        ["read:basic", "read:all", "read:market", "read:pipeline", "read:pair", "read:safety", "read:reports", "read:positions"],
	});
}