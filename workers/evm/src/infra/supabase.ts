/**
 * infra/supabase.ts
 * Supabase client pentru worker — LAZY + NULLABLE (E26).
 *
 * Înainte: `createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, ...)` rula la MODULE-LOAD →
 * dacă env-ul lipsea, `createClient(undefined, undefined)` arunca „supabaseUrl is required" și
 * CRAPA workerul la startup. Acum: `getSupabase()` creează client-ul la prima folosire și
 * întoarce `null` când env-ul lipsește → apelanții degradează (skip persistență), workerul rulează.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import { resolveSupabaseCreds } from "./supabaseConfig";

// undefined = neinițializat; null = dezactivat (env lipsă); altfel = client viu. Singleton lazy.
let _client: SupabaseClient | null | undefined;

/** Client Supabase sau `null` dacă env-ul lipsește (worker degradat). Se creează o singură dată, lazy. */
export function getSupabase(): SupabaseClient | null {
  if (_client !== undefined) return _client;

  const creds = resolveSupabaseCreds(process.env);
  if (!creds) {
    console.warn(
      "[SUPABASE] env lipsă (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — client DEZACTIVAT; "
      + "workerul rulează degradat (fără persistență shadow_trades / fomo_blocks)",
    );
    _client = null;
    return _client;
  }

  _client = createClient(creds.url, creds.key, {
    realtime: { transport: WebSocket as any },
  });
  return _client;
}
