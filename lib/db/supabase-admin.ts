/**
 * lib/db/supabase-admin.ts
 * Supabase client cu service role — pentru oauth_clients și mcp_request_logs
 * Nu expune în browser — doar server-side
 */

import { createClient } from "@supabase/supabase-js";

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);