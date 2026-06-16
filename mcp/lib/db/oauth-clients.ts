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

// ── Touch last_used_at (fire and forget) ──────────────────────────────────────

export function touchClient(clientId: string): void {
  supabaseAdmin
    .from("oauth_clients")
    .update({ last_used_at: new Date().toISOString() })
    .eq("client_id", clientId)
    .then(() => {});
}

// ── Admin: create client ──────────────────────────────────────────────────────

export async function createOAuthClient({
  name,
  plan                  = "starter",
  scopes,
  rate_limit_per_minute = 60,
  rate_limit_per_day    = 10_000,
  notes,
}: {
  name:                   string;
  plan?:                  string;
  scopes?:                string[];
  rate_limit_per_minute?: number;
  rate_limit_per_day?:    number;
  notes?:                 string;
}): Promise<{ client_id: string; client_secret: string } | null> {
  const client_id     = "tp_" + randomBytes(16).toString("hex");
  const client_secret = randomBytes(32).toString("hex");
  const secret_hash   = hashSecret(client_secret);

  const finalScopes = scopes ?? (
    plan === "free_trial" || plan === "basic"
      ? ["read:basic"]
      : ["read:all"]
  );

  const { error } = await supabaseAdmin.from("oauth_clients").insert({
    client_id, secret_hash, name, plan, scopes: finalScopes,
    rate_limit_per_minute, rate_limit_per_day,
    notes: notes ?? null,
  });

  if (error) {
    console.error("[OAUTH] Failed to create client:", error.message);
    return null;
  }

  // Returnează secret plain o singură dată — nu mai e recuperabil
  return { client_id, client_secret };
}

export async function revokeOAuthClient(clientId: string): Promise<void> {
  await supabaseAdmin
    .from("oauth_clients")
    .update({ status: "revoked" })
    .eq("client_id", clientId);
}