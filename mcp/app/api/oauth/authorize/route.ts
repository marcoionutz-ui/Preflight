/**
 * app/api/oauth/authorize/route.ts
 * Procesează form submit de la /authorize
 * Verifică client_secret, emite authorization code, redirectează înapoi la Claude.ai
 */

import { NextRequest }              from "next/server";
import { verifyClientCredentials, isAllowedRedirectUri } from "@/lib/db/oauth-clients";
import { issueAuthCode }            from "@/lib/db/oauth-codes";
import { validateAuthorizeChallenge } from "@/lib/oauth/pkce";
import { resolveBaseUrl }           from "@/lib/oauth/baseUrl";
import { validateResourceIndicator } from "@/lib/oauth/resource";
import { SERVER_SCOPE_CATALOG } from "@/lib/oauth/scopeCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  // PH-3 (RFC 8707): resursa (audience) pentru care clientul cere tokenul. Poate lipsi (clienți mai vechi) →
  // default-bind pe resursa canonică; dacă e prezentă dar ≠ resursa noastră → invalid_target (mai jos).
  const resource              = params.get("resource")              ?? "";

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

  // PH-3: din acest punct redirect_uri e VALIDAT (allowlist) → orice eroare de mai jos e o eroare de authorization
  // response și trebuie întoarsă prin REDIRECT la client cu `error`/`state`/`iss` (RFC 6749 §4.1.2.1 + RFC 9207: iss
  // inclusiv pe erori, fiindcă declarăm suportul în metadata), NU ca pagină locală. `issuer` = base URL canonic
  // (fail-closed în prod dacă PUBLIC_BASE_URL lipsește — PH-8).
  const issuer = resolveBaseUrl(req.headers, process.env);

  // Scope clamp — codul emis primește doar ce s-a cerut, nu tot ce poate
  // clientul. Fără scope explicit în request, default-ul e client.scopes
  // (nu un hardcode ca "read:all"/"read:basic" — free_trial/basic ar fi
  // picat mereu dacă defaultam la un scope pe care nu-l au).
  const requestedScopes = scope.split(/\s+/).map(s => s.trim()).filter(Boolean);
  const grantedScopes   = requestedScopes.length > 0 ? requestedScopes : client.scopes;
  const hasFullAccess   = client.scopes.includes("read:all");

  const unknownScopes = grantedScopes.filter(s => !SERVER_SCOPE_CATALOG.includes(s));
  if (unknownScopes.length > 0) {
    return oauthErrorRedirect(redirect_uri, "invalid_scope", `Requested scope is not supported: ${unknownScopes.join(", ")}`, state, issuer);
  }

  const notAllowed = grantedScopes.filter(s => !hasFullAccess && !client.scopes.includes(s));
  if (notAllowed.length > 0) {
    return oauthErrorRedirect(redirect_uri, "invalid_scope", `Requested scope not allowed for this client: ${notAllowed.join(", ")}`, state, issuer);
  }

  // PH-3 (RFC 8707): validează `resource` și leagă audience-ul în cod. `resource` absent → default-bind pe resursa
  // canonică; prezent dar ≠ resursa noastră → invalid_target (redirect cu iss, ca celelalte erori post-allowlist).
  const rv = validateResourceIndicator(resource, issuer);
  if (rv.status === "invalid_target") {
    return oauthErrorRedirect(redirect_uri, "invalid_target", rv.reason, state, issuer);
  }

  // Emite authorization code
  const code = await issueAuthCode({
    client_id,
    scopes:                grantedScopes,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    issued_at:             Date.now(),
    resource:              rv.resource, // PH-3: audience legat în cod
  });

  if (!code) {
    // Post-allowlist → redirect OAuth cu iss (RFC 9207), server_error (RFC 6749 §4.1.2.1).
    return oauthErrorRedirect(redirect_uri, "server_error", "Failed to issue authorization code", state, issuer);
  }

  // Redirect înapoi la Claude.ai cu code + state (+ iss, RFC 9207: Authorization Server Issuer Identification —
  // clientul poate verifica ce AS a emis răspunsul, apărare împotriva mix-up attacks).
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code",  code);
  if (state) redirectUrl.searchParams.set("state", state);
  redirectUrl.searchParams.set("iss", issuer);

  return Response.redirect(redirectUrl.toString(), 302);
}

/**
 * PH-3 (RFC 6749 §4.1.2.1 + RFC 9207): eroare de authorization response întoarsă prin REDIRECT la client (redirect_uri
 * DEJA validat pe allowlist). Include `state` (dacă a fost trimis) și `iss` — obligatoriu pe erori când
 * `authorization_response_iss_parameter_supported` e declarat în metadata. NU pune `code`.
 */
function oauthErrorRedirect(redirectUri: string, error: string, description: string, state: string, issuer: string): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer);
  return Response.redirect(u.toString(), 302);
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
