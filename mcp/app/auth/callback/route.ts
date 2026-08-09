/**
 * app/auth/callback/route.ts
 * Magic-link redirect target. Exchanges the one-time code for a session
 * (sets auth cookies via lib/supabase/server.ts), then redirects to
 * /dashboard — which provisions a free_trial oauth_clients row on first
 * visit if the user doesn't have one yet.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveBaseUrl } from "@/lib/oauth/baseUrl";

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

  return NextResponse.redirect(`${origin}/dashboard`);
}
