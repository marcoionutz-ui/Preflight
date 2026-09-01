/**
 * app/api/oauth/authorize/consent/route.ts — PH-2 pas 6 frunză 5b-ii-b (handler-ul I/O POST /consent, resource-owner).
 *
 * Procesează Approve/Deny de la ecranul de consent. Ruta e DOAR cablaj: gărzile pure (`consentRequestGuard`,
 * `boundedBody`) filtrează cererea, apoi `decideConsentGrant` (verify+decide) + `consentIssuancePlan` (mașina de stări)
 * decid, iar I/O-ul (session/txn/registration/cont/insert/consume) e împins prin outcome-uri deja clasificate.
 * DORMANT: `isResourceOwnerAuthorizeEnabled` OFF → 404 (fluxul client de azi rămâne intact).
 *
 * Ordine fail-closed (cgpt): Content-Type → body MĂRGINIT (Content-Length fast-reject + citire cu plafon ÎNAINTE de
 * parsare) → parse (duplicate/format) → CSRF (Origin/Referer vs origine canonică) → session/txn → decide → plan.
 * Contractul P1 (AT-MOST-ONCE): pe `unavailable` de la emitere NU presupunem nimic → 503 retryable (planner-ul o duce).
 * `redirect_uri`/`state` vin DIN txn (sigilate la authorize, trusted); `iss` = origine canonică (RFC 9207).
 */

import { NextResponse, type NextRequest } from "next/server";
import { isResourceOwnerAuthorizeEnabled } from "@/lib/oauth/authorizeResourceOwnerFlag";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";
import { isFormUrlEncoded, parseConsentForm, isSameOriginRequest, MAX_CONSENT_BODY_BYTES } from "@/lib/oauth/consentRequestGuard";
import { readBoundedText, contentLengthExceeds } from "@/lib/oauth/boundedBody";
import { getSessionState } from "@/lib/oauth/sessionResumeIo";
import { readAuthzTxn, consumeAuthzTxn, claimAuthzTxnAction } from "@/lib/db/authzTxnStoreIo";
import { getAuthorizeRegistration, getAccountEntitlement, insertGrant } from "@/lib/db/ph2Reads";
import { consumeAuthzTxnAndIssueCode } from "@/lib/db/oauth-codes";
import { decideConsentGrant } from "@/lib/oauth/authorizeConsent";
import { buildUserAuthCodePayload } from "@/lib/oauth/userAuthCodePayload";
import {
  planConsentAction, planActionClaim, planPayloadBuild, planAfterInsert, planAfterConsume, planAfterDenyConsume,
  type ConsentRedirect, type ConsentIssuanceOutcome,
} from "@/lib/oauth/consentIssuancePlan";
import { SERVER_SCOPE_CATALOG } from "@/lib/oauth/scopeCatalog";
import type { OAuthGrant } from "@/lib/oauth/grant";
import type { AuthzTransaction } from "@/lib/oauth/authzTransaction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── helpers de răspuns (toate no-store) ────────────────────────────────────────
function noStore(res: NextResponse): NextResponse { res.headers.set("Cache-Control", "no-store"); return res; }
function notFound():            NextResponse { return noStore(new NextResponse("Not Found", { status: 404 })); }
function unsupportedMediaType():NextResponse { return noStore(new NextResponse("Unsupported Media Type", { status: 415 })); }
function payloadTooLarge():     NextResponse { return noStore(new NextResponse("Payload Too Large", { status: 413 })); }
function forbidden():           NextResponse { return noStore(new NextResponse("Forbidden", { status: 403 })); }
function unavailable():         NextResponse { return noStore(new NextResponse("Service temporarily unavailable. Please try again.", { status: 503 })); }
function internalError():       NextResponse { return noStore(new NextResponse("Internal Server Error", { status: 500 })); }
/** Eroare locală generică (fără reason brut în HTML) — cerere invalidă/CSRF/txn dispărută la un POST care schimbă starea. */
function localError(): NextResponse {
  const html = "<!DOCTYPE html><html><head><title>Authorization Failed</title></head>"
    + "<body style=\"background:#0a0a0a;color:#fff;font-family:-apple-system,sans-serif;text-align:center;padding:60px\">"
    + "<h1 style=\"color:#ff4444;font-size:20px\">Authorization Failed</h1>"
    + "<p style=\"color:#888\">This authorization request is invalid or has expired.</p></body></html>";
  return noStore(new NextResponse(html, { status: 400, headers: { "Content-Type": "text/html" } }));
}
function redirectTo(url: string): NextResponse { return noStore(NextResponse.redirect(url, 302)); }

export async function POST(req: NextRequest): Promise<NextResponse> {
  // DORMANT: flag OFF → inaccesibil. Ecranul de consent + emiterea sunt aprinse doar la cutover.
  if (!isResourceOwnerAuthorizeEnabled(process.env)) return notFound();
  try {
    return await handleConsent(req);
  } catch (err) {
    // BOUNDARY DE EXCEPȚII: orice throw neașteptat (resolveBaseUrl fail-closed prod, DB/Redis) → 500 generic, fără leak.
    console.error("[AUTHZ CONSENT] unhandled:", err);
    return internalError();
  }
}

async function handleConsent(req: NextRequest): Promise<NextResponse> {
  // 1. Content-Type: DOAR application/x-www-form-urlencoded (JSON/multipart/lipsă → 415).
  if (!isFormUrlEncoded(req.headers.get("content-type"))) return unsupportedMediaType();

  // 2. Body MĂRGINIT — Content-Length fast-reject + citire cu plafon HARD, AMBELE ÎNAINTE de parsare (endpoint public).
  if (contentLengthExceeds(req.headers.get("content-length"), MAX_CONSENT_BODY_BYTES)) return payloadTooLarge();
  const bodyRead = await readBoundedText(req.body, MAX_CONSENT_BODY_BYTES);
  if (!bodyRead.ok) return payloadTooLarge();

  // 3. Parse form: exact o dată fiecare câmp (reject duplicate) + format txn_id/csrf/action.
  const form = parseConsentForm(bodyRead.text);
  if (!form.ok) { console.error("[AUTHZ CONSENT] parse:", form.reason); return localError(); }

  // 4. CSRF: origine CANONICĂ (o singură dată) + Origin/Referer trebuie să se potrivească. Fail-closed pe POST.
  const origin = resolveBaseUrl(req.headers, process.env);
  if (!isSameOriginRequest(req.headers.get("origin"), req.headers.get("referer"), origin)) return forbidden();

  // 5. Sesiune + tranzacție (proaspete). unavailable → 503; txn absentă/coruptă → eroare locală.
  const session = await getSessionState();
  if (session.kind === "unavailable") return unavailable();
  const currentSessionUserId = session.kind === "authenticated" ? session.userId : null;

  const read = await readAuthzTxn(form.txn_id);
  if (read.status === "unavailable") return unavailable();
  if (read.status !== "found") { console.error("[AUTHZ CONSENT] txn:", read.status); return localError(); }
  const txn = read.txn;
  const raw = read.raw; // blob EXACT pt. compare-and-delete la consume

  // 6. Registration (clientul txn) + cont (userul sesiunii). unavailable → 503; not_found → null (decide dă error/reject).
  const regLookup = await getAuthorizeRegistration(txn.client_id);
  if (regLookup.status === "unavailable") return unavailable();
  const registration = regLookup.status === "found" ? regLookup.registration : null;

  const acctLookup = currentSessionUserId
    ? await getAccountEntitlement(currentSessionUserId)
    : ({ status: "not_found" } as const);
  if (acctLookup.status === "unavailable") return unavailable();
  const account = acctLookup.status === "found" ? acctLookup.entitlement : null;

  // 7. Verify + decide (PUR): consent verificat → gate registration/cont → grant sticky. Apoi mașina de stări.
  const decision = decideConsentGrant({
    txn,
    presented: { txn_id: form.txn_id, csrf_token: form.csrf_token, action: form.action },
    currentSessionUserId, registration, account,
    serverPolicy: SERVER_SCOPE_CATALOG, nowMs: Date.now(),
  });

  const redirect: ConsentRedirect = { redirectUri: txn.redirect_uri, state: txn.state || undefined, iss: origin };
  const step = planConsentAction(decision);
  switch (step.kind) {
    case "terminal": return renderTerminal(step.outcome);
    case "deny":     return handleDeny(form.txn_id, raw, redirect);
    case "issue":    return handleIssue(step.grant, txn, form.txn_id, raw, redirect);
    default: {
      const _exhaustive: never = step; // toate variantele acoperite
      console.error("[AUTHZ CONSENT] acțiune necunoscută", _exhaustive);
      return localError();
    }
  }
}

/** Approve: CLAIM atomic (approve) ÎNAINTE de efecte → build → insertGrant idempotent → consume+issue ATOMIC → redirect(code). */
async function handleIssue(grant: OAuthGrant, txn: AuthzTransaction, txnId: string, raw: string, redirect: ConsentRedirect): Promise<NextResponse> {
  // ARBITRARE cross-action: un Deny concurent NU trebuie să lase un grant `active` orfan. Revendicăm txn pentru
  // "approve" ÎNAINTE de insertGrant — pierdem (deny a câștigat) ⇒ nu inserăm, nu emitem (fără efecte secundare).
  const claim = planActionClaim(await claimAuthzTxnAction(txnId, "approve"));
  if (claim.kind === "terminal") return renderTerminal(claim.outcome);

  const build = buildUserAuthCodePayload({ grant, txn, issued_at: Date.now() });
  const pb = planPayloadBuild(build);
  if (pb.kind === "terminal") return renderTerminal(pb.outcome);

  const insert = await insertGrant(grant); // idempotent (read-back pe eroare) — grant sticky ⇒ retry = already_present
  const ai = planAfterInsert(insert);
  if (ai.kind === "terminal") return renderTerminal(ai.outcome);

  // Consume + issue ATOMIC (o singură operație). Pe `unavailable` (AT-MOST-ONCE) planner-ul dă 503 fără a presupune txn.
  const outcome = await consumeAuthzTxnAndIssueCode(txnId, raw, pb.payload);
  return renderTerminal(planAfterConsume(outcome, redirect));
}

/** Deny verificat: CLAIM atomic (deny) ÎNAINTE de consume → simple consume (invalidează txn) → redirect access_denied. */
async function handleDeny(txnId: string, raw: string, redirect: ConsentRedirect): Promise<NextResponse> {
  // ARBITRARE cross-action: dacă un Approve concurent a câștigat, NU consumăm/redirectăm access_denied (approve conduce).
  const claim = planActionClaim(await claimAuthzTxnAction(txnId, "deny"));
  if (claim.kind === "terminal") return renderTerminal(claim.outcome);

  const outcome = await consumeAuthzTxn(txnId, raw);
  return renderTerminal(planAfterDenyConsume(outcome, redirect));
}

/** Randează terminalul mașinii de stări. redirect_uri e trusted (din txn); iss = origine canonică (RFC 9207). */
function renderTerminal(o: ConsentIssuanceOutcome): NextResponse {
  switch (o.kind) {
    case "redirect_code": {
      const u = new URL(o.redirectUri);
      u.searchParams.set("code", o.code);
      if (o.state) u.searchParams.set("state", o.state);
      u.searchParams.set("iss", o.iss);
      return redirectTo(u.toString());
    }
    case "redirect_denied": {
      const u = new URL(o.redirectUri);
      u.searchParams.set("error", "access_denied");
      if (o.state) u.searchParams.set("state", o.state);
      u.searchParams.set("iss", o.iss);
      return redirectTo(u.toString());
    }
    case "local_error":
      console.error("[AUTHZ CONSENT] local_error:", o.error, o.reason);
      return localError();
    case "unavailable":
      console.error("[AUTHZ CONSENT] unavailable:", o.reason);
      return unavailable();
    default: {
      const _exhaustive: never = o; // toate terminale acoperite
      console.error("[AUTHZ CONSENT] terminal necunoscut", _exhaustive);
      return localError();
    }
  }
}
