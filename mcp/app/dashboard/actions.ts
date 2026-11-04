"use server";

/**
 * app/dashboard/actions.ts
 * Server Actions for the dashboard. Both re-verify the Supabase session
 * server-side — never trust a client_id passed from the browser, always
 * derive it from the authenticated user's own oauth_clients row.
 */

import { redirect } from "next/navigation";
import { createClient as createSupabaseServerClient } from "@/lib/supabase/server";
import {
  getClientByUserId, rotateClientSecret, addRedirectUri, removeRedirectUri,
} from "@/lib/db/oauth-clients";
import { revokeClaudeGrantsForUser } from "@/lib/db/grantRevoke";

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

// ── Item e) redirect_uri allowlist — session-gated, client_id derivat mereu
// din user.id autentificat, niciodată din input trimis de browser. ────────

export async function addRedirectUriAction(uri: string): Promise<
  { ok: true; redirectUris: string[] } | { ok: false; error: string }
> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated" };

  const client = await getClientByUserId(user.id);
  if (!client) return { ok: false, error: "No credentials found for this account" };

  const trimmed = uri.trim();
  if (!trimmed) return { ok: false, error: "URI cannot be empty" };

  const updated = await addRedirectUri(client.client_id, trimmed);
  if (!updated) return { ok: false, error: "Invalid URI — must be an absolute URL (e.g. https://... or a custom scheme like myapp://...)" };

  return { ok: true, redirectUris: updated.redirect_uris };
}

export async function removeRedirectUriAction(uri: string): Promise<
  { ok: true; redirectUris: string[] } | { ok: false; error: string }
> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated" };

  const client = await getClientByUserId(user.id);
  if (!client) return { ok: false, error: "No credentials found for this account" };

  const updated = await removeRedirectUri(client.client_id, uri);
  if (!updated) return { ok: false, error: "Failed to remove URI — try again" };

  return { ok: true, redirectUris: updated.redirect_uris };
}

// ── Lot OAuth staging §6: „Revoke Claude's access" — session-gated, ca acțiunile de mai sus. Fără parametri din
// browser: userId vine DOAR din sesiunea verificată pe server. Revocă grant-urile ACTIVE ale contului DOAR pe
// registration-urile Claude (`isClaudeCimdClientId`); grant-urile altor clienți rămân neatinse. Efectul (401 la apel,
// invalid_grant la refresh) vine din verificările care citesc grant-ul (vezi lib/db/grantRevoke.ts). Idempotent: al doilea
// click raportează 0. Logul nu conține tokenuri sau id-uri.
export async function revokeClaudeAccessAction(): Promise<
  { ok: true; revoked: number } | { ok: false; error: string }
> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated" };

  const result = await revokeClaudeGrantsForUser(user.id);
  if (result.status !== "revoked") {
    console.error(`[DASHBOARD] revoke Claude access failed: status=${result.status}`);
    return { ok: false, error: "Could not revoke access — try again" };
  }
  console.log(`[DASHBOARD] revoke Claude access ok: revoked=${result.count}`);
  return { ok: true, revoked: result.count };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/");
}
