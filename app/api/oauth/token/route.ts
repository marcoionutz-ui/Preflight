/**
 * app/api/oauth/token/route.ts
 * OAuth 2.0 Token Endpoint
 * Suportă:
 *   - client_credentials (pentru API access direct)
 *   - authorization_code cu PKCE (pentru Claude.ai Connectors)
 */

import { NextRequest }                      from "next/server";
import { verifyClientCredentials, touchClient, getClientById } from "@/lib/db/oauth-clients";
import { issueToken }                       from "@/lib/db/oauth-tokens";
import { consumeAuthCode, verifyCodeVerifier } from "@/lib/db/oauth-codes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, error: string, description?: string) {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
}

async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await req.json().catch(() => ({}));
  }
  const text   = await req.text();
  const params = new URLSearchParams(text);
  const result: Record<string, string> = {};
  params.forEach((v, k) => { result[k] = v; });
  return result;
}

export async function POST(req: NextRequest) {
  const body       = await parseBody(req);
  const grant_type = body.grant_type ?? "";

  // ── Grant: client_credentials ─────────────────────────────────────────────
  if (grant_type === "client_credentials") {
    const client_id     = body.client_id     ?? "";
    const client_secret = body.client_secret ?? "";

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

    if (!token) return jsonError(500, "server_error", "Failed to issue token — Redis unavailable");

    touchClient(client.client_id);

    return new Response(
      JSON.stringify({
        access_token: token,
        token_type:   "Bearer",
        expires_in:   86_400,
        scope:        client.scopes.join(" "),
      }),
      {
        status:  200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache" },
      },
    );
  }

  // ── Grant: authorization_code ─────────────────────────────────────────────
  if (grant_type === "authorization_code") {
    const code          = body.code          ?? "";
    const redirect_uri  = body.redirect_uri  ?? "";
    const client_id     = body.client_id     ?? "";
    const code_verifier = body.code_verifier ?? "";

    if (!code || !redirect_uri || !client_id) {
      return jsonError(400, "invalid_request", "code, redirect_uri, and client_id are required");
    }

    // Consumă code din Redis (one-time use)
    const payload = await consumeAuthCode(code);
    if (!payload) {
      return jsonError(400, "invalid_grant", "Authorization code expired or already used");
    }

    // Verifică client_id match
    if (payload.client_id !== client_id) {
      return jsonError(400, "invalid_grant", "client_id mismatch");
    }

    // Verifică redirect_uri match
    if (payload.redirect_uri !== redirect_uri) {
      return jsonError(400, "invalid_grant", "redirect_uri mismatch");
    }

    // Verifică PKCE code_verifier dacă a fost setat un challenge
    if (payload.code_challenge && code_verifier) {
      const valid = verifyCodeVerifier(code_verifier, payload.code_challenge, payload.code_challenge_method);
      if (!valid) {
        return jsonError(400, "invalid_grant", "code_verifier mismatch");
      }
    }

    // Verifică că clientul e încă activ
    const client = await getClientById(client_id);
    if (!client) {
      return jsonError(401, "invalid_client", "Client not found or revoked");
    }

    const token = await issueToken({
      client_id:  client.client_id,
      scopes:     payload.scopes,
      issued_at:  Date.now(),
    });

    if (!token) return jsonError(500, "server_error", "Failed to issue token — Redis unavailable");

    touchClient(client.client_id);

    return new Response(
      JSON.stringify({
        access_token: token,
        token_type:   "Bearer",
        expires_in:   86_400,
        scope:        payload.scopes.join(" "),
      }),
      {
        status:  200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache" },
      },
    );
  }

  return jsonError(400, "unsupported_grant_type", "Supported: client_credentials, authorization_code");
}
