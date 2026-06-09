/**
 * app/api/.well-known/oauth-protected-resource/route.ts
 * OAuth 2.0 Protected Resource Metadata (RFC 9728)
 */

import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const host   = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto  = req.headers.get("x-forwarded-proto") ?? "https";
  const issuer = `${proto}://${host}`;

  return Response.json({
    resource:                 `${issuer}/api/mcp`,
    authorization_servers:    [`${issuer}`],
    bearer_methods_supported: ["header"],
    scopes_supported:         ["read:all"],
  });
}
