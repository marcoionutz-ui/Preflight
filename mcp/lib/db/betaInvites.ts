/**
 * lib/db/betaInvites.ts — lotul OAuth staging, §4 (I/O pentru invitațiile beta, service-role).
 *
 * Wiring SUBȚIRE peste `supabaseAdmin` (service role — singurul rol cu drept pe `beta_invites` și pe
 * `redeem_beta_invite`, vezi migrarea 0002 §4.3). Toată decizia stă în frunza pură `lib/oauth/inviteRedeem.ts`.
 *
 *   - `createBetaInvite(emailNormalized, ttlDays)` — generează tokenul (32 octeți aleatori, base64url), scrie DOAR
 *     `sha256(token)` și întoarce tokenul în clar O SINGURĂ dată (apelantul — scriptul — îl tipărește în link; nu se
 *     mai poate recupera ulterior).
 *   - `redeemBetaInvite(tokenHash, userId, emailNormalized)` — apelează RPC-ul ATOMIC `redeem_beta_invite`; întoarce
 *     statusul închis sau `unavailable` (eroare, throw, răspuns în afara setului). NU aruncă.
 *
 * Fără loguri aici: nici token, nici hash, nici email. Apelanții loghează doar statusul/motivul închis.
 */

import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "./supabase-admin";
import {
  BETA_ACCESS_DAYS,
  INVITE_TOKEN_BYTES,
  hashInviteToken,
  isValidInviteTtlDays,
  isWellFormedInviteToken,
  isWellFormedTokenHash,
  normalizeInviteEmail,
  parseRedeemStatus,
  type RedeemResult,
} from "../oauth/inviteRedeem";

const DAY_MS = 24 * 60 * 60 * 1000;

export type CreateBetaInviteResult =
  | { ok: true;  inviteId: string; token: string; expiresAt: string }
  | { ok: false; reason: "invalid_input" | "unavailable" };

export async function createBetaInvite(
  emailNormalized: string,
  ttlDays:         number,
  nowMs:           number = Date.now(),
): Promise<CreateBetaInviteResult> {
  // Emailul TREBUIE să vină deja normalizat (idempotent pe normalizare) — altfel constrângerea SQL l-ar respinge oricum.
  if (normalizeInviteEmail(emailNormalized) !== emailNormalized) return { ok: false, reason: "invalid_input" };
  if (!isValidInviteTtlDays(ttlDays) || !Number.isFinite(nowMs)) return { ok: false, reason: "invalid_input" };

  const token = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
  if (!isWellFormedInviteToken(token)) return { ok: false, reason: "unavailable" }; // invariant (nu ar trebui să apară)
  const expiresAt = new Date(nowMs + ttlDays * DAY_MS).toISOString();

  try {
    const { data, error } = await supabaseAdmin
      .from("beta_invites")
      .insert({ email_normalized: emailNormalized, token_hash: hashInviteToken(token), expires_at: expiresAt })
      .select("invite_id, expires_at")
      .single();
    if (error || !data) return { ok: false, reason: "unavailable" };
    const row = data as { invite_id?: unknown; expires_at?: unknown };
    if (typeof row.invite_id !== "string" || typeof row.expires_at !== "string") return { ok: false, reason: "unavailable" };
    return { ok: true, inviteId: row.invite_id, token, expiresAt: row.expires_at };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function redeemBetaInvite(
  tokenHash:       string,
  userId:          string,
  emailNormalized: string,
  nowMs:           number = Date.now(),
): Promise<RedeemResult> {
  // Intrări greșite = bug al apelantului → fără apel DB, fără acces.
  if (!isWellFormedTokenHash(tokenHash)) return "unavailable";
  if (typeof userId !== "string" || userId.length === 0) return "unavailable";
  if (normalizeInviteEmail(emailNormalized) !== emailNormalized) return "unavailable";
  if (!Number.isFinite(nowMs)) return "unavailable";

  try {
    const { data, error } = await supabaseAdmin.rpc("redeem_beta_invite", {
      p_token_hash:       tokenHash,
      p_user_id:          userId,
      p_email_normalized: emailNormalized,
      p_now:              new Date(nowMs).toISOString(),
      p_access_days:      BETA_ACCESS_DAYS,
    });
    if (error) return "unavailable";
    return parseRedeemStatus(data) ?? "unavailable";
  } catch {
    return "unavailable";
  }
}
