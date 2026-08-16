/**
 * app/api/oauth/token/route.ts
 * OAuth 2.0 Token Endpoint
 * Suportă:
 *   - client_credentials (pentru API access direct)
 *   - authorization_code cu PKCE (pentru Claude.ai Connectors)
 */

import { NextRequest }                      from "next/server";
import { verifyClientCredentialsResult, touchClient, lookupClientById } from "@/lib/db/oauth-clients";
import { issueToken }                       from "@/lib/db/oauth-tokens";
import { peekAuthCode, verifyCodeVerifier, consumeCodeAndIssueToken } from "@/lib/db/oauth-codes";
import { sanitizeTokenError }               from "@/lib/oauth/tokenError";
import { isValidCodeVerifier }              from "@/lib/oauth/pkce";
import { resolveBaseUrl }                   from "@/lib/oauth/baseUrl";
import { validateResourceIndicator, canonicalResourceUri } from "@/lib/oauth/resource";

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

    // PH-3 (RFC 8707): validează `resource` și leagă audience-ul în token. Absent → default-bind canonic; prezent
    // dar ≠ resursa noastră → invalid_target (RFC 8707 §2). issuer = base URL canonic (fail-closed prod — PH-8).
    const ccIssuer = resolveBaseUrl(req.headers, process.env);
    const ccRv = validateResourceIndicator(body.resource, ccIssuer);
    if (ccRv.status === "invalid_target") {
      return jsonError(400, "invalid_target", ccRv.reason);
    }

    // PH-9: rezultat DISCRIMINAT — `unavailable` (Supabase jos) → 503 (retry), NU 401 invalid_client (ar minți
    // „secret greșit/revocat" la un outage). `invalid_client` = client inexistent/revocat SAU secret greșit.
    const cred = await verifyClientCredentialsResult(client_id, client_secret);
    if (cred.status === "unavailable") {
      return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
    }
    if (cred.status === "invalid_client") {
      return jsonError(401, "invalid_client", "Invalid credentials or client revoked");
    }
    const client = cred.client;

    const token = await issueToken({
      client_id:          client.client_id,
      scopes:             client.scopes,
      issued_at:          Date.now(),
      credential_version: client.secret_rotated_at,
      audience:           ccRv.resource, // PH-3: token legat de resursa canonică
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

    // PH-3 (RFC 8707): dacă cererea de token include `resource`, validează-l (URI absolut, fără fragment, = resursa
    // noastră). Consistența cu resursa legată în cod se verifică mai jos, DUPĂ ce citim payload-ul codului.
    const acIssuer = resolveBaseUrl(req.headers, process.env);
    const acRv = validateResourceIndicator(body.resource, acIssuer);
    if (acRv.status === "invalid_target") {
      return jsonError(400, "invalid_target", acRv.reason);
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

    // PH-3 (RFC 8707): audience-ul tokenului = resursa legată în cod la /authorize (`payload.resource`); coduri vechi
    // dinainte de PH-3 (fără resource) → default-bind canonic. Dacă cererea de token a inclus EXPLICIT `resource`, el
    // trebuie să coincidă cu resursa autorizată în cod (nu poți lărgi audience-ul la /token) — altfel invalid_target.
    const boundAudience = payload.resource ?? canonicalResourceUri(acIssuer);
    if ((body.resource ?? "").trim() !== "" && acRv.resource !== boundAudience) {
      return jsonError(400, "invalid_target", "resource does not match the authorization request");
    }

    // PKCE e obligatoriu — /authorize refuză să emită un code fără
    // code_challenge (S256), deci code_verifier trebuie să fie mereu prezent
    // aici. Nu mai e condiționat de payload.code_challenge fiind truthy.
    if (!code_verifier) {
      return jsonError(400, "invalid_request", "code_verifier is required");
    }
    // E1: format RFC 7636 (43–128 caractere unreserved). Un verifier sub minimul de entropie sau cu alfabet
    // greșit e respins înainte de comparație — invalid_grant (nu s-ar potrivi oricum, dar respingem explicit).
    if (!isValidCodeVerifier(code_verifier)) {
      return jsonError(400, "invalid_grant", "code_verifier is malformed (RFC 7636: 43–128 unreserved characters)");
    }
    const valid = verifyCodeVerifier(code_verifier, payload.code_challenge, payload.code_challenge_method);
    if (!valid) return jsonError(400, "invalid_grant", "code_verifier mismatch");

    // Verifică că clientul e încă activ. PH-9: discriminat — Supabase jos → 503 (retry), NU 401 invalid_client.
    const clientLookup = await lookupClientById(client_id);
    if (clientLookup.status === "unavailable") {
      return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
    }
    if (clientLookup.status === "not_found") {
      return jsonError(401, "invalid_client", "Client not found or revoked");
    }
    const client = clientLookup.client;

    // E4 + U7: TOATĂ validarea a trecut → consumă codul ȘI emite tokenul ATOMIC (un singur EVAL: compare-and-delete
    // pe blob + SET token). Înainte, `finalizeAuthCode` ardea codul, apoi `issueToken` scria separat — dacă Redis
    // pica între cele două, codul se pierdea fără token. Acum all-or-nothing: la eșec nimic nu se persistă →
    // clientul reia cu ACELAȘI cod. Anti-replay/concurență = compare-and-delete (o cerere concurentă → already_used).
    const issued = await consumeCodeAndIssueToken(code, lookup.raw, {
      client_id:          client.client_id,
      scopes:             payload.scopes,
      issued_at:          Date.now(),
      credential_version: client.secret_rotated_at,
      audience:           boundAudience, // PH-3: token legat de resursa autorizată în cod
    });
    if (issued.status === "unavailable") {
      return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
    }
    if (issued.status === "already_used") {
      return jsonError(400, "invalid_grant", "Authorization code already used");
    }

    touchClient(client.client_id);

    return new Response(
      JSON.stringify({
        access_token: issued.token,
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
