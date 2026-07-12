/**
 * app/auth/callback/route.ts
 * Magic-link redirect target. Exchanges the one-time code for a session
 * (sets auth cookies via lib/supabase/server.ts), then redirects to
 * /dashboard — which provisions a free_trial oauth_clients row on first
 * visit if the user doesn't have one yet.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");

  // Nu folosim origin din new URL(request.url) — în spatele proxy-ului
  // Railway asta poate reflecta adresa internă a containerului
  // (localhost:8080), nu domeniul public. Același pattern ca în
  // app/.well-known/*: derivăm originea din headers.
  const host  = request.headers.get("x-forwarded-host")  ?? request.headers.get("host") ?? "";
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const origin = `${proto}://${host}`;

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}/dashboard`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
