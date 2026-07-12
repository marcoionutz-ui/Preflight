/**
 * lib/db/oauth-clients.ts
 * OAuth clients — Supabase, business config persistent
 */

import { createHash, randomBytes } from "crypto";
import { supabaseAdmin }           from "./supabase-admin";

export interface OAuthClient {
  id:                    string;
  client_id:             string;
  secret_hash:           string;
  name:                  string;
  status:                "active" | "revoked" | "suspended";
  plan:                  string;
  scopes:                string[];
  rate_limit_per_minute: number;
  rate_limit_per_day:    number;
  created_at:            string;
  last_used_at:          string | null;
  notes:                 string | null;
  user_id:               string | null;
}

// ── Hashing ───────────────────────────────────────────────────────────────────

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function verifySecret(secret: string, hash: string): boolean {
  return hashSecret(secret) === hash;
}

// ── Lookup ────────────────────────────────────────────────────────────────────

export async function getClientById(clientId: string): Promise<OAuthClient | null> {
  const { data, error } = await supabaseAdmin
    .from("oauth_clients")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "active")
    .single();

  if (error || !data) return null;
  return data as OAuthClient;
}

export async function verifyClientCredentials(
  clientId:     string,
  clientSecret: string,
): Promise<OAuthClient | null> {
  const client = await getClientById(clientId);
  if (!client) return null;
  if (!verifySecret(clientSecret, client.secret_hash)) return null;
  return client;
}

// ── Lookup by owning Supabase Auth user (dashboard) ────────────────────────────

export async function getClientByUserId(userId: string): Promise<OAuthClient | null> {
  const { data, error } = await supabaseAdmin
    .from("oauth_clients")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (error || !data) return null;
  return data as OAuthClient;
}

// ── Touch last_used_at (fire and forget) ──────────────────────────────────────

export function touchClient(clientId: string): void {
  // Query builder-ul Supabase e doar PromiseLike, nu un Promise complet —
  // n-are .catch(). Two-arg .then(onFulfilled, onRejected) e forma corectă
  // de fire-and-forget cu error handling pe un thenable.
  supabaseAdmin
    .from("oauth_clients")
    .update({ last_used_at: new Date().toISOString() })
    .eq("client_id", clientId)
    .then(
      () => {},
      (err: unknown) => console.error("[OAUTH] touchClient failed:", err),
    );
}

// ── Admin: create client ──────────────────────────────────────────────────────

export async function createOAuthClient({
  name,
  plan                  = "starter",
  scopes,
  rate_limit_per_minute = 60,
  rate_limit_per_day    = 10_000,
  notes,
  user_id,
}: {
  name:                   string;
  plan?:                  string;
  scopes?:                string[];
  rate_limit_per_minute?: number;
  rate_limit_per_day?:    number;
  notes?:                 string;
  user_id?:               string | null;
}): Promise<{ client: OAuthClient; client_secret: string } | null> {
  const client_id     = "tp_" + randomBytes(16).toString("hex");
  const client_secret = randomBytes(32).toString("hex");
  const secret_hash   = hashSecret(client_secret);

  const finalScopes = scopes ?? (
    plan === "free_trial" || plan === "basic"
      ? ["read:basic"]
      : ["read:all"]
  );

  // .select().single() întoarce rândul chiar din insert — nu mai facem un
  // SELECT separat după. Un al doilea getClientByUserId() imediat după insert
  // avea exact același URL ca citirea de dinainte de creare, iar Next.js
  // deduplichează (memoizează) fetch-uri identice în același render pass —
  // a doua citire era servită din cache-ul primei (null), nu ajungea la
  // Supabase, deci dashboard-ul credea că "nu s-a putut încărca" deși
  // insert-ul reușise. Eliminăm al doilea request în loc să luptăm cu cache-ul.
  const { data, error } = await supabaseAdmin
    .from("oauth_clients")
    .insert({
      client_id, secret_hash, name, plan, scopes: finalScopes,
      rate_limit_per_minute, rate_limit_per_day,
      notes:   notes ?? null,
      user_id: user_id ?? null,
    })
    .select("*")
    .single();

  if (error || !data) {
    console.error("[OAUTH] Failed to create client:", error?.message);
    return null;
  }

  // Returnează secret plain o singură dată — nu mai e recuperabil
  return { client: data as OAuthClient, client_secret };
}

export async function revokeOAuthClient(clientId: string): Promise<void> {
  await supabaseAdmin
    .from("oauth_clients")
    .update({ status: "revoked" })
    .eq("client_id", clientId);
}

// ── Rotate secret (dashboard "Rotate secret" action) ────────────────────────────

/**
 * Generează un secret nou, îl hash-uiește și îl scrie peste cel vechi.
 * Returnează secretul plain O SINGURĂ DATĂ — la fel ca la createOAuthClient,
 * nu mai e recuperabil după acest apel.
 */
export async function rotateClientSecret(clientId: string): Promise<string | null> {
  const client_secret = randomBytes(32).toString("hex");
  const secret_hash   = hashSecret(client_secret);

  const { error } = await supabaseAdmin
    .from("oauth_clients")
    .update({ secret_hash })
    .eq("client_id", clientId)
    .eq("status", "active");

  if (error) {
    console.error("[OAUTH] Failed to rotate secret:", error.message);
    return null;
  }
  return client_secret;
}