/**
 * app/auth/callback/route.ts
 * Magic-link redirect target. Exchanges the one-time code for a session
 * (sets auth cookies via lib/supabase/server.ts), then hands off:
 *   - resource-owner flow ON (flag) → 303 /auth/resume (binds the pending consent txn to the session; retry-safe,
 *     never re-touches the Supabase code), which then routes to consent.
 *   - flag OFF → /dashboard (today's behavior; provisions a free_trial oauth_clients row on first visit).
 * The Supabase code is exchanged EXACTLY ONCE here; /auth/resume does not touch it, so a page refresh there is a safe
 * retry on outage.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";
import { isResourceOwnerAuthorizeEnabled } from "@/lib/oauth/authorizeResourceOwnerFlag";
import { planCallbackRedirect } from "@/lib/oauth/callbackResumePlan";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  // Nu folosim origin din new URL(request.url) — în spatele proxy-ului Railway asta poate reflecta adresa
  // internă a containerului (localhost:8080), nu domeniul public. U7: origine CANONICĂ din `PUBLIC_BASE_URL`
  // (env) când e setat → imun la host-header poisoning; fallback pe headers doar pt. dev/compat.
  const origin = resolveBaseUrl(request.headers, process.env);

  if (!code) {
    // Ajută la diagnosticare — fără cod deloc în URL înseamnă că Supabase
    // n-a trimis redirect cu ?code=, nu că exchange-ul a eșuat.
    console.error("[AUTH CALLBACK] No code param on callback URL:", request.url);
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

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

  // PH-2: exchange REUȘIT (codul Supabase consumat o SINGURĂ dată aici). Decizia de destinație e pură (flag-gated);
  // identitatea NU se clasifică aici — /auth/resume (cerere nouă, sesiune stabilită) o citește via getSessionState.
  const redir = planCallbackRedirect(isResourceOwnerAuthorizeEnabled(process.env));
  if (redir.kind === "resume_handoff") {
    // 303 → /auth/resume: leagă txn-ul de consent de sesiune (retryable, fără a mai atinge codul Supabase).
    return NextResponse.redirect(`${origin}/auth/resume`, 303);
  }
  return NextResponse.redirect(`${origin}/dashboard`);
}
