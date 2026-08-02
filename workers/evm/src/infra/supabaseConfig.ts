/**
 * infra/supabaseConfig.ts — E26 (Supabase client lazy/nullable).
 *
 * Logică PURĂ (zero runtime imports) → testabilă izolat în tsx. Decide dacă avem credențiale
 * valide pentru Supabase. Client-ul se creează LAZY (la prima folosire, nu la import) și e NULL
 * când env-ul lipsește → workerul pornește degradat în loc să crape la startup (înainte:
 * `createClient(process.env...!, ...)` la module-load arunca „supabaseUrl is required").
 *
 * Ambele variabile necesare, ne-goale (după trim). Orice lipsă / whitespace-only → null.
 */
export interface SupabaseCreds { url: string; key: string; }

export function resolveSupabaseCreds(env: {
  NEXT_PUBLIC_SUPABASE_URL?:   string | undefined;
  SUPABASE_SERVICE_ROLE_KEY?:  string | undefined;
}): SupabaseCreds | null {
  const url = typeof env.NEXT_PUBLIC_SUPABASE_URL  === "string" ? env.NEXT_PUBLIC_SUPABASE_URL.trim()  : "";
  const key = typeof env.SUPABASE_SERVICE_ROLE_KEY === "string" ? env.SUPABASE_SERVICE_ROLE_KEY.trim() : "";
  if (!url || !key) return null;
  return { url, key };
}
