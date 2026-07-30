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
import { peekAuthCode, finalizeAuthCode, verifyCodeVerifier } from "@/lib/db/oauth-codes";
import { sanitizeTokenError }               from "@/lib/oauth/tokenError";

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
  try {
    return await handlePost(req);
  } catch (err) {
    // E5: eroarea REALĂ (Redis/Supabase/host/query) rămâne DOAR în log — clientul primește un mesaj generic
    // stabil, ca să nu scurgem detalii interne prin `error_description`. Status 500 + `server_error` + no-store
    // (jsonError) se păstrează. Logica de sanitizare + logging e în leaf-ul pur `sanitizeTokenError`.
    const { status, error, error_description } = sanitizeTokenError(err, console.error);
    return jsonError(status, error, error_description);
  }
}

async function handlePost(req: NextRequest) {
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
      client_id:          client.client_id,
      scopes:             client.scopes,
      issued_at:          Date.now(),
      credential_version: client.secret_rotated_at,
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

    // E4: CITEȘTE codul FĂRĂ să-l ștergi. Consumul (compare-and-delete atomic) vine ABIA după ce toată
    // validarea a trecut — altfel o cerere cu client_id/verifier greșit ardea codul clientului legitim (DoS).
    const lookup = await peekAuthCode(code);
    if (lookup.status === "unavailable") {
      // Redis jos → nu POT verifica codul → 503 (retry), NU invalid_grant (ar minți că e „deja folosit").
      return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
    }
    if (lookup.status === "absent") {
      return jsonError(400, "invalid_grant", "Authorization code expired or already used");
    }
    const payload = lookup.payload;

    // Verifică client_id match (codul NU e consumat dacă pică — rămâne valid pt. clientul corect)
    if (payload.client_id !== client_id) {
      return jsonError(400, "invalid_grant", "client_id mismatch");
    }

    // Verifică redirect_uri match
    if (payload.redirect_uri !== redirect_uri) {
      return jsonError(400, "invalid_grant", "redirect_uri mismatch");
    }

    // PKCE e obligatoriu — /authorize refuză să emită un code fără
    // code_challenge (S256), deci code_verifier trebuie să fie mereu prezent
    // aici. Nu mai e condiționat de payload.code_challenge fiind truthy.
    if (!code_verifier) {
      return jsonError(400, "invalid_request", "code_verifier is required");
    }
    const valid = verifyCodeVerifier(code_verifier, payload.code_challenge, payload.code_challenge_method);
    if (!valid) return jsonError(400, "invalid_grant", "code_verifier mismatch");

    // Verifică că clientul e încă activ
    const client = await getClientById(client_id);
    if (!client) {
      return jsonError(401, "invalid_client", "Client not found or revoked");
    }

    // E4: TOATĂ validarea a trecut → ABIA ACUM consumă codul, ATOMIC (single-use + anti-replay).
    // O cerere concurentă care a consumat deja codul între peek și aici → already_used (invalid_grant).
    const consumed = await finalizeAuthCode(code, lookup.raw);
    if (consumed === "unavailable") {
      return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
    }
    if (consumed !== "consumed") {
      return jsonError(400, "invalid_grant", "Authorization code already used");
    }

    const token = await issueToken({
      client_id:          client.client_id,
      scopes:             payload.scopes,
      issued_at:          Date.now(),
      credential_version: client.secret_rotated_at,
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
