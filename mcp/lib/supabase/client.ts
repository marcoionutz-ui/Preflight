/**
 * lib/supabase/client.ts
 * Supabase client pentru Client Components (browser).
 * Folosește anon key — safe de expus, RLS/auth protejează datele.
 */

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
