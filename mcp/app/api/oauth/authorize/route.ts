/**
 * app/api/oauth/authorize/route.ts
 * Procesează form submit de la /authorize
 * Verifică client_secret, emite authorization code, redirectează înapoi la Claude.ai
 */

import { NextRequest }              from "next/server";
import { verifyClientCredentials, isAllowedRedirectUri } from "@/lib/db/oauth-clients";
import { issueAuthCode }            from "@/lib/db/oauth-codes";
import { validateAuthorizeChallenge } from "@/lib/oauth/pkce";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sincronizat manual cu scopes_supported din discovery metadata
// (app/.well-known/*) și cu TOOL_SCOPES din lib/mcp/scopes.ts.
const KNOWN_SCOPES = [
  "read:basic",
  "read:all",
  "read:market",
  "read:pipeline",
  "read:pair",
  "read:safety",
  "read:reports",
  "read:positions",
];

export async function POST(req: NextRequest) {
  const body   = await req.text();
  const params = new URLSearchParams(body);

  const client_id             = params.get("client_id")             ?? "";
  const client_secret         = params.get("client_secret")         ?? "";
  const redirect_uri          = params.get("redirect_uri")          ?? "";
  const state                 = params.get("state")                 ?? "";
  const scope                 = params.get("scope")                 ?? "";
  const code_challenge        = params.get("code_challenge")        ?? "";
  // E1: NU defaulta la "S256" pe metodă absentă. RFC 7636 §4.3: lipsa metodei = "plain";
  // Preflight acceptă doar S256, deci absența trebuie RESPINSĂ (validateAuthorizeChallenge),
  // nu reinterpretată tacit ca S256. Default gol → cade pe ramura de respingere.
  const code_challenge_method = params.get("code_challenge_method") ?? "";
  // Fără default "code" — response_type e obligatoriu (RFC 6749); un request
  // care nu-l trimite deloc trebuie respins explicit, nu tratat tacit ca și
  // cum ar fi fost "code".
  const response_type         = params.get("response_type")         ?? "";

  // Validare — PKCE e obligatoriu (public OAuth flow, nu doar recomandat).
  if (!client_id || !client_secret || !redirect_uri) {
    return errorPage("Missing required parameters.");
  }
  if (response_type !== "code") {
    return errorPage(`Unsupported response_type: ${response_type}. Only "code" is supported.`);
  }
  // E1: PKCE obligatoriu + validare de FORMAT RFC 7636 (nu doar „prezent + S256"). Un challenge malformat
  // (lungime/alfabet greșit) e respins ACUM, ca să nu emitem un cod legat de un challenge pe care niciun
  // verifier nu-l poate satisface. Metoda trebuie să fie EXACT „S256" (plain/altă variantă = downgrade blocat).
  const pkce = validateAuthorizeChallenge(code_challenge, code_challenge_method);
  if (!pkce.ok) {
    return errorPage(pkce.reason);
  }

  // Verifică credentials în Supabase
  const client = await verifyClientCredentials(client_id, client_secret);
  if (!client) {
    return errorPage("Invalid client credentials. Check your client_id and client_secret.");
  }

  // Item e) — redirect_uri trebuie să fie exact unul din allowlist-ul
  // declarat de owner în dashboard (addRedirectUri, session-gated). Fără
  // asta, orice redirect_uri arbitrar din query string era acceptat — un
  // link crafted cu redirect_uri-ul atacatorului, deschis + aprobat de
  // owner-ul real (care tastează client_secret aici), redirecționa codul
  // direct la atacator; PKCE nu ajută, fiindcă atacatorul își alege singur
  // code_challenge/verifier la Pasul 1. Eroarea NU redirectează către
  // redirect_uri-ul netrusted — se arată local, pe Preflight.
  if (client.redirect_uris.length === 0) {
    return errorPage("No redirect URIs configured for this client. Add one in your dashboard before authorizing.");
  }
  if (!isAllowedRedirectUri(client, redirect_uri)) {
    return errorPage("This redirect_uri is not allowed for this client. Add it in your dashboard first.");
  }

  // Scope clamp — codul emis primește doar ce s-a cerut, nu tot ce poate
  // clientul. Fără scope explicit în request, default-ul e client.scopes
  // (nu un hardcode ca "read:all"/"read:basic" — free_trial/basic ar fi
  // picat mereu dacă defaultam la un scope pe care nu-l au).
  const requestedScopes = scope.split(/\s+/).map(s => s.trim()).filter(Boolean);
  const grantedScopes   = requestedScopes.length > 0 ? requestedScopes : client.scopes;
  const hasFullAccess   = client.scopes.includes("read:all");

  const unknownScopes = grantedScopes.filter(s => !KNOWN_SCOPES.includes(s));
  if (unknownScopes.length > 0) {
    return errorPage(`Requested scope is not supported: ${unknownScopes.join(", ")}`);
  }

  const notAllowed = grantedScopes.filter(s => !hasFullAccess && !client.scopes.includes(s));
  if (notAllowed.length > 0) {
    return errorPage(`Requested scope not allowed for this client: ${notAllowed.join(", ")}`);
  }

  // Emite authorization code
  const code = await issueAuthCode({
    client_id,
    scopes:                grantedScopes,
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

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
    <p>${escapeHtml(message)}</p>
    <p><a href="javascript:history.back()">← Go back</a></p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status:  400,
    headers: { "Content-Type": "text/html" },
  });
}
