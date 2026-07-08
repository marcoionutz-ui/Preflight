/**
 * lib/supabase/server.ts
 * Supabase client pentru Server Components / Route Handlers.
 * Citește/scrie sesiunea din cookies (next/headers) — necesar pentru ca
 * sesiunea userului să persiste corect în App Router.
 *
 * setAll poate eșua când e apelat dintr-un Server Component (nu poate seta
 * cookies) — ignorat intenționat, middleware-ul de sesiune (viitor) o reface.
 */

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Apelat dintr-un Server Component — ok, se ignoră.
          }
        },
      },
    },
  );
}
