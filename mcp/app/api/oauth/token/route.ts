/**
 * app/api/oauth/token/route.ts
 * OAuth 2.0 Token Endpoint
 * Suportă:
 *   - client_credentials (pentru API access direct)
 *   - authorization_code cu PKCE (pentru Claude.ai Connectors) — emite ȘI refresh token (PH-4)
 *   - refresh_token (PH-4: rotație + reuse-detection cu family revocation)
 */

import { NextRequest }                      from "next/server";
import { verifyClientCredentialsResult, touchClient, lookupClientById } from "@/lib/db/oauth-clients";
import { issueToken }                       from "@/lib/db/oauth-tokens";
import { peekAuthCode, verifyCodeVerifier, consumeCodeAndIssueWithRefresh, consumeCodeAndIssueUserWithRefresh } from "@/lib/db/oauth-codes";
import { peekRefreshToken, rotateRefreshToken } from "@/lib/db/oauth-refresh";
import { narrowScopes, type RefreshPayload } from "@/lib/db/oauthAtomic";
import { sanitizeTokenError }               from "@/lib/oauth/tokenError";
import { isValidCodeVerifier }              from "@/lib/oauth/pkce";
import { resolveBaseUrl }                   from "@/lib/oauth/baseUrl";
import { validateResourceIndicator, canonicalResourceUri } from "@/lib/oauth/resource";
import { planAuthCodeTokenIssuance }        from "@/lib/oauth/authCodeIssuancePlan";
import { isLegacyAuthCodeCutoverEnabled }   from "@/lib/oauth/authCodeCutover";
// PH-2 step 10.5b: rotația refresh-ului USER (auth-code Claude.ai) — planner pur + deps I/O (grant/cont) + catalog scope.
import { isUserRefresh, finalizeUserRefreshPayload, type UserRefreshPayload } from "@/lib/oauth/refreshPayloadModel";
import { finalizeUserTokenPayload }         from "@/lib/oauth/tokenPayloadModel";
import { planUserRefreshRotation }          from "@/lib/oauth/userRefreshPlan";
import { verifyUserRegistration }           from "@/lib/oauth/userRegistrationVerify";
import { getGrantById, getAccountEntitlement, getRegistrationByClientId, touchRegistration } from "@/lib/db/ph2Reads";
import { SERVER_SCOPE_CATALOG }             from "@/lib/oauth/scopeCatalog";

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

    // PH-2 step 10.4: PLANIFICĂM emiterea PUR din identitatea codului (`planAuthCodeTokenIssuance`, 10.4b) + flagul de
    // cutover (citit din env AICI → planner rămâne pur). `user` = cod cu subject_kind embed la /authorize → token USER
    // (entitlement/quota pe ACCOUNT); `legacy` = cod client-authorized dinainte de cutover → forma de AZI; `reject` =
    // corupt / legacy sub cutover / scopes murdare → invalid_grant. Ruta refuză mismatch-ul de client în planner.
    const plan = planAuthCodeTokenIssuance({
      payload,
      clientId:          client.client_id,
      credentialVersion: client.secret_rotated_at,
      audience:          boundAudience, // PH-3: token legat de resursa autorizată în cod
      issuedAt:          Date.now(),
      rejectLegacy:      isLegacyAuthCodeCutoverEnabled(process.env),
    });
    if (plan.kind === "reject") {
      return jsonError(400, plan.error, plan.reason);
    }

    // E4 + U7 + PH-4: TOATĂ validarea a trecut → consumă codul ȘI emite access + REFRESH ATOMIC (un singur EVAL:
    // compare-and-delete pe blob + SET access + SET refresh + SET familie). All-or-nothing: la eșec nimic nu se
    // persistă → clientul reia cu ACELAȘI cod. Forma user și cea legacy folosesc ACELAȘI Lua; diferă doar payload-ul
    // serializat (user: identitate, fără credential_version). Anti-replay/concurență = compare-and-delete.
    const issued = plan.kind === "user"
      ? await consumeCodeAndIssueUserWithRefresh(code, lookup.raw, plan.accessDraft, plan.refreshDraft)
      : await consumeCodeAndIssueWithRefresh(code, lookup.raw, plan.access);
    if (issued.status === "unavailable") {
      return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
    }
    if (issued.status === "already_used") {
      return jsonError(400, "invalid_grant", "Authorization code already used");
    }

    touchClient(client.client_id);

    return new Response(
      JSON.stringify({
        access_token:  issued.token,
        token_type:    "Bearer",
        expires_in:    86_400,
        refresh_token: issued.refreshToken, // PH-4
        scope:         payload.scopes.join(" "),
      }),
      {
        status:  200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache" },
      },
    );
  }

  // ── Grant: refresh_token (PH-4: rotație + reuse-detection) ─────────────────
  if (grant_type === "refresh_token") {
    return handleRefreshGrant(req, body);
  }

  return jsonError(400, "unsupported_grant_type", "Supported: client_credentials, authorization_code, refresh_token");
}

/**
 * PH-4: grant `refresh_token` (RFC 6749 §6 / OAuth 2.1). Validează refresh-ul, verifică clientul activ + rotația
 * secretului + scope narrowing + consistența resource, apoi ROTEȘTE (emite access + refresh noi, invalidează vechiul).
 * Reuse-ul unui refresh superseded revocă TOATĂ familia (furt) → invalid_grant.
 */
async function handleRefreshGrant(req: NextRequest, body: Record<string, string>): Promise<Response> {
  const refresh_token = body.refresh_token ?? "";
  const client_id     = body.client_id     ?? "";
  const scopeParam    = (body.scope ?? "").split(/\s+/).map(s => s.trim()).filter(Boolean);

  if (!refresh_token) {
    return jsonError(400, "invalid_request", "refresh_token is required");
  }

  // 1. Citește refresh-ul (fără mutații). absent → invalid_grant; unavailable → 503.
  const look = await peekRefreshToken(refresh_token);
  if (look.status === "unavailable") {
    return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
  }
  if (look.status === "absent") {
    return jsonError(400, "invalid_grant", "Refresh token is invalid or expired");
  }
  const rp = look.payload;

  // 2. client_id (dacă e trimis) trebuie să corespundă tokenului — RFC 6749 §6 pt. clienți confidențiali.
  if (client_id && client_id !== rp.client_id) {
    return jsonError(400, "invalid_grant", "client_id does not match the refresh token");
  }

  // PH-2 10.5b: FORK pe formă. Un refresh USER (auth-code Claude.ai) NU se validează pe `credential_version` (client
  // public, fără secret), ci pe GRANT + CONT (planner pur `planUserRefreshRotation`). Widening-ul `RefreshLookup.payload`
  // la uniune face ca accesul `rp.credential_version` din branch-ul client de mai jos să NU compileze pe forma user —
  // deci forma user TREBUIE deviată AICI; după `return`, `rp` se îngustează la forma client (`RefreshPayload`).
  if (isUserRefresh(rp)) {
    return handleUserRefreshGrant(req, body, rp, refresh_token, scopeParam);
  }

  // 3. Clientul e încă activ? + rotația secretului (credential_version) → forțează reauth. PH-9: discriminat.
  const clientLookup = await lookupClientById(rp.client_id);
  if (clientLookup.status === "unavailable") {
    return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
  }
  if (clientLookup.status === "not_found") {
    return jsonError(401, "invalid_client", "Client not found or revoked");
  }
  const client = clientLookup.client;
  if (!rp.credential_version || rp.credential_version !== client.secret_rotated_at) {
    // Secretul a fost rotit după emiterea refresh-ului → sesiunea nu mai e validă → reautorizare.
    return jsonError(400, "invalid_grant", "Refresh token invalidated by credential rotation");
  }

  // 4. Scope narrowing (RFC 6749 §6): scope cerut ⊆ scope original; escaladare → invalid_scope.
  const narrowed = narrowScopes(scopeParam, rp.scopes);
  if (narrowed.status === "invalid_scope") {
    return jsonError(400, "invalid_scope", narrowed.reason);
  }

  // 5. Resource (dacă e trimis) trebuie să coincidă cu audience-ul legat în refresh (nu poți schimba resursa la refresh).
  if ((body.resource ?? "").trim() !== "") {
    const rIssuer = resolveBaseUrl(req.headers, process.env);
    const rv = validateResourceIndicator(body.resource, rIssuer);
    if (rv.status === "invalid_target" || rv.resource !== rp.audience) {
      return jsonError(400, "invalid_target", "resource does not match the refresh token audience");
    }
  }

  // 6. ROTAȚIE atomică — access + refresh noi; păstrează audience + family_id; credential_version = cel CURENT validat.
  const now = Date.now();
  // cgpt #2 (OAuth 2.1 §4.3.3): narrowing-ul la refresh restrânge DOAR access token-ul emis acum. Refresh-ul rotit
  // păstrează scope-ul ORIGINAL al lanțului (`rp.scopes`) — altfel un singur refresh cu `scope` restrâns ar micșora
  // PERMANENT grantul (clientul n-ar mai putea re-lărgi la scope-ul original acordat de resource owner, chiar în subset).
  const newRefreshPayload: RefreshPayload = {
    client_id:          rp.client_id,
    scopes:             rp.scopes,            // ← original (nu narrowed): nu îngustăm permanent lanțul
    audience:           rp.audience,
    credential_version: client.secret_rotated_at,
    family_id:          rp.family_id,
    issued_at:          now,
  };
  const rot = await rotateRefreshToken(refresh_token, {
    client_id:          rp.client_id,
    scopes:             narrowed.scopes,      // access token-ul emis acum: scope-ul (posibil) restrâns
    issued_at:          now,
    credential_version: client.secret_rotated_at,
    audience:           rp.audience,
    family_id:          rp.family_id,         // cgpt #1: access-ul poartă familia → revocare la nivel de grant
  }, newRefreshPayload);

  if (rot.status === "unavailable") {
    return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
  }
  if (rot.status === "reuse_detected" || rot.status === "revoked" || rot.status === "invalid") {
    // reuse_detected → familia a fost REVOCATĂ acum (furt); revoked/invalid → deja mort. Toate → invalid_grant.
    return jsonError(400, "invalid_grant", "Refresh token is invalid, expired, or has been revoked");
  }

  touchClient(client.client_id);

  return new Response(
    JSON.stringify({
      access_token:  rot.accessToken,
      token_type:    "Bearer",
      expires_in:    86_400,
      refresh_token: rot.refreshToken, // rotit
      scope:         narrowed.scopes.join(" "),
    }),
    {
      status:  200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache" },
    },
  );
}

/**
 * PH-2 step 10.5b: grant `refresh_token` pentru un refresh USER (auth-code Claude.ai connector). Spre deosebire de
 * clientul confidențial (credential_version), validitatea unui refresh user se re-verifică pe DOUĂ axe CURENTE, prin
 * planner-ul PUR `planUserRefreshRotation` (reutilizat de la 10.5a): GRANT (consimțământul pinnat activ + consistent cu
 * claim-urile refresh-ului) + CONT (`entitlement_version` egal → plan neschimbat, cont utilizabil). Fail-closed: grant/cont
 * `unavailable` → 503 (retry); orice reject → invalid_grant. Clientul e un shell DCR PUBLIC din `oauth_client_registrations`
 * (NU `oauth_clients` — acolo nu există): îl validăm prin `verifyUserRegistration` (activ + ne-expirat + `client_id` identic
 * + `refresh_token` permis), FĂRĂ gate pe credential_version (client public, fără secret), FĂRĂ plan/scopes/quota din
 * oauth_clients. `touchRegistration` (NU `touchClient`). Scope narrowing + clamp la `grant ∩ cont ∩ SERVER_SCOPE_CATALOG`
 * e în planner: ACCESS-ul primește scope-ul restrâns (`plan.scopes`), REFRESH-ul păstrează lanțul ORIGINAL (fără îngustare
 * permanentă, regula PH-4). Rotația e ATOMICĂ + reuse-detection pe familie (identică cu calea client).
 */
async function handleUserRefreshGrant(
  req:           NextRequest,
  body:          Record<string, string>,
  rp:            UserRefreshPayload,
  refresh_token: string,
  scopeParam:    string[],
): Promise<Response> {
  const now = Date.now();

  // 1. REGISTRATION (DCR public) — există + activă + ne-expirată + client_id identic + refresh_token permis. NU
  //    `oauth_clients` (shell DCR nu-i acolo → lookupClientById ar da 401 fals). Fără credential_version (client public).
  const regLookup = await getRegistrationByClientId(rp.client_id);
  const rgv = verifyUserRegistration(regLookup, { clientId: rp.client_id, nowMs: now, requiredGrantType: "refresh_token" });
  if (!rgv.ok && rgv.kind === "unavailable") {
    return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
  }
  if (!rgv.ok) {
    return jsonError(401, "invalid_client", "Client registration not found, inactive, or not allowed to refresh");
  }

  // 2. Resource (dacă e trimis) trebuie să coincidă cu audience-ul legat în refresh (nu poți schimba resursa la refresh).
  if ((body.resource ?? "").trim() !== "") {
    const rIssuer = resolveBaseUrl(req.headers, process.env);
    const rv = validateResourceIndicator(body.resource, rIssuer);
    if (rv.status === "invalid_target" || rv.resource !== rp.audience) {
      return jsonError(400, "invalid_target", "resource does not match the refresh token audience");
    }
  }

  // 3. GRANT (pinnat la consimțământ) + CONT (starea curentă) → planner PUR decide rotate/reject/unavailable.
  const grantLookup   = await getGrantById(rp.grant_id);
  const accountLookup = await getAccountEntitlement(rp.user_id);
  const plan = planUserRefreshRotation({
    refresh:         rp,
    grantLookup,
    accountLookup,
    requestedScopes: scopeParam,               // gol → narrowScopes păstrează rp.scopes (RFC 6749 §6: scope omis = neschimbat)
    serverPolicy:    [...SERVER_SCOPE_CATALOG], // copie mutabilă a catalogului (sursă unică); clamp prin apartenență concretă
    issuedAt:        now,
  });
  if (plan.kind === "unavailable") {
    return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
  }
  if (plan.kind === "reject") {
    return jsonError(400, "invalid_grant", "Refresh token is invalid, expired, or has been revoked");
  }

  // 4. ROTAȚIE atomică. Draft-urile planner-ului NU poartă family_id — îl finalizăm cu familia LANȚULUI (`rp.family_id`),
  //    deci noul access + refresh rămân în aceeași familie (revocabilă). `rotateRefreshToken` e generic pe formă.
  const accessPayload     = finalizeUserTokenPayload(plan.accessDraft, rp.family_id);
  const newRefreshPayload = finalizeUserRefreshPayload(plan.refreshDraft, rp.family_id);
  const rot = await rotateRefreshToken(refresh_token, accessPayload, newRefreshPayload);
  if (rot.status === "unavailable") {
    return jsonError(503, "temporarily_unavailable", "Authorization service temporarily unavailable, please retry");
  }
  if (rot.status === "reuse_detected" || rot.status === "revoked" || rot.status === "invalid") {
    // reuse_detected → familia a fost REVOCATĂ acum (furt); revoked/invalid → deja mort. Toate → invalid_grant.
    return jsonError(400, "invalid_grant", "Refresh token is invalid, expired, or has been revoked");
  }

  touchRegistration(rp.client_id); // last_used_at pe registration (NU touchClient/oauth_clients — shell DCR)

  return new Response(
    JSON.stringify({
      access_token:  rot.accessToken,
      token_type:    "Bearer",
      expires_in:    86_400,
      refresh_token: rot.refreshToken,      // rotit (același lanț/family_id)
      scope:         plan.scopes.join(" "), // scope EFECTIV al access-ului (restrâns); refresh-ul păstrează lanțul original
    }),
    {
      status:  200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Pragma": "no-cache" },
    },
  );
}
