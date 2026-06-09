/**
 * app/api/oauth/authorize/route.ts
 * Procesează form submit de la /authorize
 * Verifică client_secret, emite authorization code, redirectează înapoi la Claude.ai
 */

import { NextRequest }              from "next/server";
import { verifyClientCredentials }  from "@/lib/db/oauth-clients";
import { issueAuthCode }            from "@/lib/db/oauth-codes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body   = await req.text();
  const params = new URLSearchParams(body);

  const client_id             = params.get("client_id")             ?? "";
  const client_secret         = params.get("client_secret")         ?? "";
  const redirect_uri          = params.get("redirect_uri")          ?? "";
  const state                 = params.get("state")                 ?? "";
  const scope                 = params.get("scope")                 ?? "read:all";
  const code_challenge        = params.get("code_challenge")        ?? "";
  const code_challenge_method = params.get("code_challenge_method") ?? "S256";

  // Validare
  if (!client_id || !client_secret || !redirect_uri) {
    return errorPage("Missing required parameters.");
  }

  // Verifică credentials în Supabase
  const client = await verifyClientCredentials(client_id, client_secret);
  if (!client) {
    return errorPage("Invalid client credentials. Check your client_id and client_secret.");
  }

  // Emite authorization code
  const code = await issueAuthCode({
    client_id,
    scopes:                client.scopes,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    issued_at:             Date.now(),
  });

  if (!code) {
    return errorPage("Failed to issue authorization code. Try again.");
  }

  // Redirect înapoi la Claude.ai cu code + state
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code",  code);
  if (state) redirectUrl.searchParams.set("state", state);

  return Response.redirect(redirectUrl.toString(), 302);
}

function errorPage(message: string): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Failed — Preflight</title>
  <style>
    body { background: #0a0a0a; color: #fff; font-family: -apple-system, sans-serif;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #111; border: 1px solid #222; border-radius: 12px; padding: 40px; max-width: 400px; text-align: center; }
    h1 { color: #ff4444; font-size: 20px; margin: 0 0 12px; }
    p { color: #888; font-size: 14px; line-height: 1.5; }
    a { color: #00ff88; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠️ Authorization Failed</h1>
    <p>${message}</p>
    <p><a href="javascript:history.back()">← Go back</a></p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status:  400,
    headers: { "Content-Type": "text/html" },
  });
}
