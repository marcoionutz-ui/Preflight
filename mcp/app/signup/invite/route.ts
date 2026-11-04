/**
 * app/signup/invite/route.ts — lotul OAuth staging, §4 (intrarea linkului de invitație beta).
 *
 * GET /signup/invite?token=<token> → dacă tokenul e bine-format (43 caractere base64url, `isWellFormedInviteToken`),
 * îl pune în cookie-ul `pf_invite` (HttpOnly, SameSite=Lax, Secure în producție, Path=/auth/callback, Max-Age 30 min)
 * și răspunde 303 → /signup (FĂRĂ query: tokenul iese din URL, din istoric și din Referer-ul paginilor următoare).
 * Un token malformat sau lipsă → tot 303 → /signup, fără cookie (înscrierea merge, dar fără acces — mesaj generic).
 *
 * De ce un route handler separat (nu `/signup?invite=`): `middleware.ts` e inactiv (matcher gol), iar o pagină
 * (Server Component) NU poate seta cookie-uri în Next 15 — doar Route Handlers / Server Actions / middleware pot.
 * Linkul tipărit de `scripts/createBetaInvite.ts` țintește direct această rută.
 *
 * De ce Path=/auth/callback: singurul consumator e callback-ul magic link-ului; cookie-ul nu pleacă spre restul
 * site-ului. SameSite=Lax: click-ul din email → Supabase verify → 303 spre /auth/callback e o navigare top-level, deci
 * cookie-ul e trimis. Limită asumată: dacă linkul magic e deschis în ALT browser decât cel în care s-a dat click pe
 * invitație, cookie-ul lipsește → cont fără acces (se re-deschide invitația în browserul corect).
 *
 * Fără loguri cu tokenul; nu se atinge DB-ul aici (răscumpărarea e în /auth/callback, după verificarea emailului).
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";
import { INVITE_COOKIE, inviteCookieSetAttrs, isWellFormedInviteToken } from "@/lib/oauth/inviteRedeem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest): NextResponse {
  const origin = resolveBaseUrl(request.headers, process.env);
  const token  = request.nextUrl.searchParams.get("token");

  const res = NextResponse.redirect(`${origin}/signup`, 303);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");

  if (isWellFormedInviteToken(token)) {
    res.cookies.set(INVITE_COOKIE, token, inviteCookieSetAttrs(process.env.NODE_ENV === "production"));
  } else {
    console.warn("[SIGNUP INVITE] token absent sau malformat — fără cookie");
  }
  return res;
}
