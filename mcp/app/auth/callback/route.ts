/**
 * app/auth/callback/route.ts
 * Magic-link redirect target. Exchanges the one-time code for a session
 * (sets auth cookies via lib/supabase/server.ts), then hands off:
 *   (Lotul OAuth staging, review cgpt: DOAR PKCE — `?code=` + verifier-ul din browserul care a cerut login-ul. Forma
 *   OTP `token_hash` dintr-un GET NU e acceptată: un link cu OTP-ul altui cont ar putea schimba sesiunea browserului
 *   fără ca utilizatorul să fi inițiat login-ul — login CSRF. Proba de staging folosește fluxul PKCE real.)
 *   - resource-owner flow ON (flag) → 303 /auth/resume (binds the pending consent txn to the session; retry-safe,
 *     never re-touches the Supabase code), which then routes to consent.
 *   - flag OFF → /dashboard (today's behavior; provisions a free_trial oauth_clients row on first visit).
 * The Supabase code is exchanged EXACTLY ONCE here; /auth/resume does not touch it, so a page refresh there is a safe
 * retry on outage.
 *
 * Invitații beta (lotul OAuth staging, §4): după un schimb REUȘIT, dacă există cookie-ul `pf_invite` (pus de
 * /signup/invite), îl ȘTERGEM întotdeauna și — doar pentru un token bine-format și un user cu email CONFIRMAT
 * (`email_confirmed_at`) — răscumpărăm atomic prin RPC-ul service-role `redeem_beta_invite` (hash-ul tokenului, id-ul
 * userului, emailul sesiunii normalizat). Răscumpărarea NU poate rupe login-ul: orice eșec/throw → user fără acces,
 * redirecturile de mai jos rămân aceleași. Pe un schimb EȘUAT cookie-ul rămâne (un nou magic link în fereastra de
 * 30 min îl poate folosi). Logurile conțin doar statusuri închise — fără token, hash sau email.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";
import { isResourceOwnerAuthorizeEnabled } from "@/lib/oauth/authorizeResourceOwnerFlag";
import { planCallbackRedirect } from "@/lib/oauth/callbackResumePlan";
import {
  INVITE_COOKIE,
  inviteCookieClearAttrs,
  planCallbackInviteRedemption,
  planInviteRedeem,
  type CallbackSessionUser,
} from "@/lib/oauth/inviteRedeem";
import { redeemBetaInvite } from "@/lib/db/betaInvites";

export const dynamic = "force-dynamic";

/**
 * Răscumpără invitația din cookie, best-effort. Nu aruncă niciodată (try/catch total) și nu influențează redirectul.
 * Cookie-ul e șters ÎNAINTE de orice decizie → nu rămâne în browser indiferent de rezultat (skip, eroare, throw).
 */
async function redeemInviteFromCookie(user: CallbackSessionUser | null): Promise<void> {
  try {
    const cookieStore = await cookies();
    const raw = cookieStore.get(INVITE_COOKIE)?.value;
    if (raw === undefined) return; // fără cookie → login obișnuit, nimic de șters
    cookieStore.set(INVITE_COOKIE, "", inviteCookieClearAttrs(process.env.NODE_ENV === "production"));

    const plan = planCallbackInviteRedemption({ cookieValue: raw, user });
    if (plan.kind === "skip") {
      console.warn("[AUTH CALLBACK] invite skipped:", plan.reason);
      return;
    }
    const outcome = planInviteRedeem(await redeemBetaInvite(plan.tokenHash, plan.userId, plan.emailNormalized));
    if (outcome.kind === "granted") console.log("[AUTH CALLBACK] invite: granted");
    else console.warn("[AUTH CALLBACK] invite: no_access", outcome.reason);
  } catch {
    console.error("[AUTH CALLBACK] invite redemption threw — login continues without access");
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  // Nu folosim origin din new URL(request.url) — în spatele proxy-ului Railway asta poate reflecta adresa
  // internă a containerului (localhost:8080), nu domeniul public. U7: origine CANONICĂ din `PUBLIC_BASE_URL`
  // (env) când e setat → imun la host-header poisoning; fallback pe headers doar pt. dev/compat.
  const origin = resolveBaseUrl(request.headers, process.env);

  if (!code) {
    // Ajută la diagnosticare — fără cod deloc în URL înseamnă că Supabase
    // n-a trimis redirect cu ?code=, nu că exchange-ul a eșuat. Nu logăm request.url (query-ul poate conține un credential).
    console.error("[AUTH CALLBACK] No code param on callback URL");
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const supabase = await createClient();
  const { data: exchanged, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // Înainte, eroarea reală se pierdea complet — nici Supabase Auth Logs,
    // nici noi nu vedeam DE CE a picat exchangeCodeForSession (verify-ul
    // Supabase poate reuși cu 303 și totuși schimbul de cod să eșueze aici,
    // ex: cod expirat/deja folosit, PKCE verifier lipsă). Acum apare în
    // Railway logs cu mesajul + statusul exact de la Supabase.
    console.error(
      "[AUTH CALLBACK] exchangeCodeForSession failed:",
      error.message, "status:", error.status,
    );
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // Invitație beta (dacă există cookie): DOAR după schimbul reușit; best-effort, nu schimbă destinația de mai jos.
  await redeemInviteFromCookie(exchanged?.user ?? null);

  // PH-2: exchange REUȘIT (codul Supabase consumat o SINGURĂ dată aici). Decizia de destinație e pură (flag-gated);
  // identitatea NU se clasifică aici — /auth/resume (cerere nouă, sesiune stabilită) o citește via getSessionState.
  const redir = planCallbackRedirect(isResourceOwnerAuthorizeEnabled(process.env));
  if (redir.kind === "resume_handoff") {
    // 303 → /auth/resume: leagă txn-ul de consent de sesiune (retryable, fără a mai atinge codul Supabase).
    return NextResponse.redirect(`${origin}/auth/resume`, 303);
  }
  return NextResponse.redirect(`${origin}/dashboard`);
}
