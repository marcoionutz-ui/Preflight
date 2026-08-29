/**
 * app/.well-known/oauth-protected-resource/route.ts
 * OAuth 2.0 Protected Resource Metadata (RFC 9728)
 */

import type { NextRequest } from "next/server";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";
import { SERVER_SCOPE_CATALOG } from "@/lib/oauth/scopeCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const issuer = resolveBaseUrl(req.headers, process.env);

  return Response.json({
    resource:                 `${issuer}/api/mcp`,
    authorization_servers:    [`${issuer}`],
    bearer_methods_supported: ["header"],
    scopes_supported:         [...SERVER_SCOPE_CATALOG],
  });
}
