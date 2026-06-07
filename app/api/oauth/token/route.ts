/**
 * app/api/oauth/token/route.ts
 * OAuth 2.0 Token Endpoint — client credentials flow
 *
 * POST /api/oauth/token
 * Body (form): grant_type=client_credentials&client_id=tp_xxx&client_secret=yyy
 * Body (json): { grant_type, client_id, client_secret }
 */

import type { NextRequest }           from "next/server";
import { verifyClientCredentials, touchClient } from "@/lib/db/oauth-clients";
import { issueToken }                 from "@/lib/db/oauth-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, error: string, description?: string) {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  let grant_type:    string | null = null;
  let client_id:     string | null = null;
  let client_secret: string | null = null;

  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const body    = await req.json().catch(() => ({})) as Record<string, string>;
    grant_type    = body.grant_type    ?? null;
    client_id     = body.client_id     ?? null;
    client_secret = body.client_secret ?? null;
  } else {
    const body    = await req.text();
    const params  = new URLSearchParams(body);
    grant_type    = params.get("grant_type");
    client_id     = params.get("client_id");
    client_secret = params.get("client_secret");
  }

  if (grant_type !== "client_credentials") {
    return jsonError(400, "unsupported_grant_type", "Only client_credentials is supported");
  }
  if (!client_id || !client_secret) {
    return jsonError(400, "invalid_request", "client_id and client_secret are required");
  }

  const client = await verifyClientCredentials(client_id, client_secret);
  if (!client) {
    return jsonError(401, "invalid_client", "Invalid credentials or client revoked");
  }

  const token = await issueToken({
    client_id:  client.client_id,
    scopes:     client.scopes,
    issued_at:  Date.now(),
  });

  if (!token) {
    return jsonError(500, "server_error", "Failed to issue token — Redis unavailable");
  }

  touchClient(client.client_id);

  return new Response(
    JSON.stringify({
      access_token: token,
      token_type:   "Bearer",
      expires_in:   86_400,
      scope:        client.scopes.join(" "),
    }),
    {
      status: 200,
      headers: {
        "Content-Type":  "application/json",
        "Cache-Control": "no-store",
        "Pragma":        "no-cache",
      },
    },
  );
}
