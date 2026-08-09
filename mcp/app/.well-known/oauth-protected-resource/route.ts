/**
 * app/.well-known/oauth-protected-resource/route.ts
 * OAuth 2.0 Protected Resource Metadata (RFC 9728)
 */

import type { NextRequest } from "next/server";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const issuer = resolveBaseUrl(req.headers, process.env);

  return Response.json({
    resource:                 `${issuer}/api/mcp`,
    authorization_servers:    [`${issuer}`],
    bearer_methods_supported: ["header"],
    scopes_supported:         ["read:basic", "read:all", "read:market", "read:pipeline", "read:pair", "read:safety", "read:reports", "read:positions"],
  });
}
