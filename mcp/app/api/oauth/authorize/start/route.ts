/**
 * app/api/oauth/authorize/start/route.ts — PH-2 pas 6 frunză 3b-iii (handler-ul I/O `/start`, resource-owner).
 *
 * Endpoint-ul care PORNEȘTE fluxul de consent resource-owner. Pagina `/authorize` (RSC) redirectează AICI pe cererea
 * inițială (fără txn_id); `/start` REVALIDEAZĂ complet (nu are încredere în verdictul paginii), creează tranzacția de
 * consent și dirijează userul: autentificat → `/authorize?txn_id=` (txn LEGATĂ), anonim → `/login` (txn nelegată +
 * cookie de resume). DORMANT: `isResourceOwnerAuthorizeEnabled` OFF → 404 (endpoint inaccesibil până când UI-ul de
 * consent + callback-ul sunt complete).
 *
 * Guardrails (cgpt): origine CANONICĂ derivată o singură dată (resolveBaseUrl); parametri OAuth duplicați (RFC 6749)
 * → eroare locală; `iss` derivat aici (nu de planner); bind-before-create PUR pt. autentificat (CAS-ul e doar pt.
 * callback); ordine login persist→cookie→redirect (cookie DOAR pe `created`); `Cache-Control: no-store` pe TOATE
 * răspunsurile; erori publice generice (reason doar în log).
 */

import { NextResponse, type NextRequest } from "next/server";
import { isResourceOwnerAuthorizeEnabled } from "@/lib/oauth/authorizeResourceOwnerFlag";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";
import { getAuthorizeRegistration } from "@/lib/db/ph2Reads";
import { getSessionState, setResumeCookie } from "@/lib/oauth/sessionResumeIo";
import { decideAuthorizeGetOutcome } from "@/lib/oauth/authorizeGetDecision";
import { planAuthorizeStart } from "@/lib/oauth/authorizeStartPlan";
import { buildAuthzTransaction, bindUser } from "@/lib/oauth/authzTransaction";
import { newAuthzTxnId, newAuthzCsrfToken, newAuthzGrantId } from "@/lib/oauth/authzTxnIds";
import { createAuthzTxn } from "@/lib/db/authzTxnStoreIo";
import { AUTHZ_TXN_TTL_SEC } from "@/lib/db/authzTxnStore";
import { SERVER_SCOPE_CATALOG } from "@/lib/oauth/scopeCatalog";
import type { AuthorizeParams, ValidatedAuthorizeRequest } from "@/lib/oauth/authorizeRequestValidate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// RFC 6749: fiecare parametru OAuth poate apărea CEL MULT o dată. Verificăm pe getAll() și respingem duplicatele.
const OAUTH_PARAM_NAMES = [
  "client_id", "redirect_uri", "response_type", "scope",
  "code_challenge", "code_challenge_method", "resource", "state",
] as const;

// ── helpers de răspuns (toate no-store) ────────────────────────────────────────
function noStore(res: NextResponse): NextResponse { res.headers.set("Cache-Control", "no-store"); return res; }

function notFound(): NextResponse {
  return noStore(new NextResponse("Not Found", { status: 404 }));
}
function unavailable(): NextResponse {
  return noStore(new NextResponse("Service temporarily unavailable. Please try again.", { status: 503 }));
}
/** Eroare locală generică (fără reason brut în HTML) — redirect netrusted / client necunoscut / duplicate. */
function localError(): NextResponse {
  const html = "<!DOCTYPE html><html><head><title>Authorization Failed</title></head>"
    + "<body style=\"background:#0a0a0a;color:#fff;font-family:-apple-system,sans-serif;text-align:center;padding:60px\">"
    + "<h1 style=\"color:#ff4444;font-size:20px\">Authorization Failed</h1>"
    + "<p style=\"color:#888\">This authorization request is invalid.</p></body></html>";
  return noStore(new NextResponse(html, { status: 400, headers: { "Content-Type": "text/html" } }));
}
/** Eroare internă generică (500) — boundary de excepții: orice throw neașteptat NU scurge stack la client. */
function internalError(): NextResponse {
  return noStore(new NextResponse("Internal Server Error", { status: 500 }));
}
function redirectTo(url: string): NextResponse {
  return noStore(NextResponse.redirect(url, 302));
}
/** Redirect OAuth `server_error` la client (redirect_uri DEJA trusted din validator) + iss (RFC 9207). */
function serverErrorRedirect(redirectUri: string, state: string, origin: string): NextResponse {
  const u = new URL(redirectUri);
  u.searchParams.set("error", "server_error");
  u.searchParams.set("error_description", "Authorization could not be completed. Please try again.");
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", origin);
  return redirectTo(u.toString());
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // DORMANT: flag OFF → inaccesibil. Fluxul client de azi (/authorize page → POST /api/oauth/authorize) rămâne intact.
  if (!isResourceOwnerAuthorizeEnabled(process.env)) return notFound();
  try {
    return await handleStart(req);
  } catch (err) {
    // BOUNDARY DE EXCEPȚII: un throw neașteptat (resolveBaseUrl fail-closed pe config prod, DB/Redis) NU trebuie să
    // ocolească failure policy-ul → 500 generic, fără scurgere de stack la client (reason doar în log).
    console.error("[AUTHZ START] unhandled:", err);
    return internalError();
  }
}

async function handleStart(req: NextRequest): Promise<NextResponse> {
  const origin = resolveBaseUrl(req.headers, process.env); // origine CANONICĂ, o SINGURĂ dată (login + authorize + iss)
  const sp = new URL(req.url).searchParams;

  // `txn_id` NU aparține /start (endpoint doar-INITIAL; resume-ul e servit de pagină prin txn_id EXPLICIT). Prezent
  // (ori duplicat) aici → cerere ambiguă (nu amestecăm resume cu initial) → eroare locală.
  if (sp.getAll("txn_id").length > 0) return localError();

  // RFC 6749: parametru OAuth duplicat → nu ghicim care valoare, eroare locală.
  for (const name of OAUTH_PARAM_NAMES) {
    if (sp.getAll(name).length > 1) return localError();
  }

  const params: AuthorizeParams = {
    client_id:             sp.get("client_id") ?? "",
    redirect_uri:          sp.get("redirect_uri") ?? "",
    response_type:         sp.get("response_type") ?? "",
    scope:                 sp.get("scope") ?? "",
    code_challenge:        sp.get("code_challenge") ?? "",
    code_challenge_method: sp.get("code_challenge_method") ?? "",
    resource:              sp.get("resource") ?? "",
    state:                 sp.get("state") ?? "",
  };

  // Revalidare COMPLETĂ: registration + sesiune proaspete → decizie pură → plan (nu ne bazăm pe verdictul paginii).
  const registration = await getAuthorizeRegistration(params.client_id);
  const session = await getSessionState();
  const decision = decideAuthorizeGetOutcome({
    mode: "initial", params, registration, session,
    issuer: origin, serverPolicy: SERVER_SCOPE_CATALOG, nowMs: Date.now(),
  });
  const action = planAuthorizeStart(decision);

  switch (action.kind) {
    case "unavailable":
      console.error("[AUTHZ START] unavailable:", action.reason);
      return unavailable();
    case "local_error":
      console.error("[AUTHZ START] local_error:", action.reason);
      return localError();
    case "client_error": {
      const u = new URL(action.redirect_uri); // redirect_uri DEJA trusted (validator)
      u.searchParams.set("error", action.error);
      u.searchParams.set("error_description", action.error_description);
      if (action.state) u.searchParams.set("state", action.state);
      u.searchParams.set("iss", origin);
      return redirectTo(u.toString());
    }
    case "issue_consent":
      return issueConsent(action.request, action.bindUserId, origin);
    case "issue_login":
      return issueLogin(action.request, origin);
    default: {
      const _exhaustive: never = action; // toate variantele StartAction acoperite
      console.error("[AUTHZ START] acțiune necunoscută", _exhaustive);
      return localError();
    }
  }
}

/** Construiește tranzacția de consent din cererea validată + id-uri proaspete (txn_id/csrf/grant_id sticky). */
function buildTxn(request: ValidatedAuthorizeRequest) {
  return buildAuthzTransaction({
    txn_id: newAuthzTxnId(), csrf_token: newAuthzCsrfToken(), grant_id: newAuthzGrantId(),
    registration_id: request.registration_id, client_id: request.client_id, redirect_uri: request.redirect_uri,
    state: request.state, resource: request.resource, requested_scopes: request.requested_scopes,
    code_challenge: request.code_challenge, code_challenge_method: request.code_challenge_method,
    now: Date.now(), ttlMs: AUTHZ_TXN_TTL_SEC * 1000, // blob expires_at aliniat cu Redis EX (10 min)
  });
}

/** Autentificat: build → bindUser PUR (userul e deja logat) → createAuthzTxn(blob LEGAT) → redirect /authorize?txn_id. */
async function issueConsent(request: ValidatedAuthorizeRequest, userId: string, origin: string): Promise<NextResponse> {
  const built = buildTxn(request);
  if (!built.ok) { console.error("[AUTHZ START] build:", built.error); return serverErrorRedirect(request.redirect_uri, request.state, origin); }
  // Bind-before-create: persistăm blob-ul DEJA legat de user (fără CAS — CAS-ul `bindAuthzTxnUser` e exclusiv pt. callback).
  const bound = bindUser(built.txn, userId);
  if (!bound.ok) { console.error("[AUTHZ START] bind:", bound.error); return serverErrorRedirect(request.redirect_uri, request.state, origin); }
  const created = await createAuthzTxn(bound.txn);
  if (created === "unavailable") return unavailable();
  if (created !== "created") { console.error("[AUTHZ START] createAuthzTxn:", created); return serverErrorRedirect(request.redirect_uri, request.state, origin); }
  const u = new URL(`${origin}/authorize`);
  u.searchParams.set("txn_id", bound.txn.txn_id);
  return redirectTo(u.toString());
}

/** Anonim: build (NELEGAT) → createAuthzTxn → (pe `created`) setResumeCookie → redirect /login. Bind-ul e în callback. */
async function issueLogin(request: ValidatedAuthorizeRequest, origin: string): Promise<NextResponse> {
  const built = buildTxn(request);
  if (!built.ok) { console.error("[AUTHZ START] build:", built.error); return serverErrorRedirect(request.redirect_uri, request.state, origin); }
  const created = await createAuthzTxn(built.txn); // NELEGAT (session_user_id null; se leagă în callback după login)
  if (created === "unavailable") return unavailable();
  if (created !== "created") { console.error("[AUTHZ START] createAuthzTxn:", created); return serverErrorRedirect(request.redirect_uri, request.state, origin); }
  // Ordine: persistat (created) → cookie → redirect. Dacă persistarea NU e `created`, NU setăm cookie (mai sus).
  await setResumeCookie(built.txn.txn_id);
  return redirectTo(`${origin}/login`);
}
