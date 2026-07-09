"use server";

/**
 * app/dashboard/actions.ts
 * Server Actions for the dashboard. Both re-verify the Supabase session
 * server-side — never trust a client_id passed from the browser, always
 * derive it from the authenticated user's own oauth_clients row.
 */

import { redirect } from "next/navigation";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import { getClientByUserId, rotateClientSecret } from "@/lib/db/oauth-clients";

export async function rotateSecretAction(): Promise<
  { ok: true; secret: string } | { ok: false; error: string }
> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated" };

  const client = await getClientByUserId(user.id);
  if (!client) return { ok: false, error: "No credentials found for this account" };

  const secret = await rotateClientSecret(client.client_id);
  if (!secret) return { ok: false, error: "Rotation failed — try again" };

  return { ok: true, secret };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/");
}
