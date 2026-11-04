/**
 * lib/oauth/inviteRedeem.ts — lotul OAuth staging, §4 (invitații beta: formă, hash, decizia de răscumpărare, PUR).
 *
 * Frunză PURĂ (zero I/O; `node:crypto` doar pentru sha256, determinist) → testabilă în tsx fără Supabase/Next.
 * I/O-ul stă în `lib/db/betaInvites.ts` (insert + RPC `redeem_beta_invite`) și în `app/auth/callback/route.ts`.
 *
 * Decizii:
 *   - TOKENUL: 32 octeți aleatori → base64url fără padding = EXACT 43 caractere `[A-Za-z0-9_-]`. Orice altă formă
 *     (lungime, charset) e respinsă ÎNAINTE de orice hash/DB — cookie-ul se întoarce din browser, e ne-de-încredere.
 *   - ÎN DB stă doar `sha256(token)` hex lowercase (64) — constrângerea `beta_invites_token_hash_chk` din 0002 cere
 *     exact forma produsă de `hashInviteToken`. Tokenul în clar există o singură dată: în linkul tipărit de script.
 *   - EMAILUL: `normalizeInviteEmail` = trim + lowercase, cu respingere pentru gol, fără `@` exact o dată, parte locală
 *     sau domeniu gol, whitespace/caractere de control interne, > 320. E aceeași normalizare la creare (script) și la
 *     răscumpărare (emailul VERIFICAT al sesiunii), iar comparația din SQL e pe egalitate exactă. Aliniat cu
 *     `beta_invites_email_normalized_chk` (lower(btrim(x)) = x, conține `@`).
 *   - STATUSUL RPC e un set ÎNCHIS; orice altă valoare (sau eroare) → `unavailable` (fail-closed: fără acces).
 *   - `planInviteRedeem`: singurul rezultat care dă acces e `redeemed` → `granted`. Restul → `no_access` cu motiv închis.
 *     `already_entitled` = invitația NU s-a consumat și entitlement-ul existent NU s-a atins (răscumpărarea nu
 *     suprascrie niciodată un entitlement); pentru callback înseamnă „invitația n-a dat nimic", nu „cont fără acces".
 *   - `planCallbackInviteRedemption`: răscumpărăm DOAR cu un cookie bine-format ȘI un user cu email CONFIRMAT
 *     (`email_confirmed_at` setat de Supabase după magic link). Orice lipsă → `skip` (login-ul continuă normal).
 *   - Logurile folosesc doar `kind`/`reason` (enum-uri închise) — niciodată token, hash sau email.
 */

import { createHash } from "node:crypto";

// ── token ───────────────────────────────────────────────────────────────────────
export const INVITE_TOKEN_BYTES  = 32;
export const INVITE_TOKEN_LENGTH = 43; // base64url(32 octeți) fără padding
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH_RE   = /^[0-9a-f]{64}$/;

export function isWellFormedInviteToken(v: unknown): v is string {
  return typeof v === "string" && INVITE_TOKEN_RE.test(v);
}

export function isWellFormedTokenHash(v: unknown): v is string {
  return typeof v === "string" && TOKEN_HASH_RE.test(v);
}

/** sha256(token) în hex lowercase (64). Pur și determinist. Apelantul validează forma tokenului înainte. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// ── email ───────────────────────────────────────────────────────────────────────
const MAX_EMAIL_LEN = 320;
// whitespace sau caractere de control oriunde în interior (după trim) → respins.
const BAD_EMAIL_CHARS_RE = /[\s\p{Cc}]/u;

/** trim + lowercase; `null` pentru orice formă inutilizabilă (gol, `@` ≠ 1, parte goală, whitespace intern, prea lung). */
export function normalizeInviteEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length === 0 || e.length > MAX_EMAIL_LEN) return null;
  if (BAD_EMAIL_CHARS_RE.test(e)) return null;
  const at = e.indexOf("@");
  if (at <= 0 || at !== e.lastIndexOf("@") || at === e.length - 1) return null;
  return e;
}

// ── TTL / acces ─────────────────────────────────────────────────────────────────
/** Durata accesului acordat la răscumpărare (decizia O2: 14 zile). Trimisă RPC-ului ca `p_access_days`. */
export const BETA_ACCESS_DAYS = 14;
export const DEFAULT_INVITE_TTL_DAYS = 7;
export const MAX_INVITE_TTL_DAYS = 30;

/** TTL-ul invitației: întreg în [1, 30] zile. */
export function isValidInviteTtlDays(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_INVITE_TTL_DAYS;
}

// ── statusul RPC (set închis, oglinda funcției SQL `redeem_beta_invite`) ────────
export const REDEEM_STATUSES = ["redeemed", "not_found", "already_redeemed", "expired", "email_mismatch", "already_entitled"] as const;
export type RedeemStatus = typeof REDEEM_STATUSES[number];
/** Ce întoarce wrapperul I/O: statusul SQL sau `unavailable` (eroare / răspuns în afara setului). */
export type RedeemResult = RedeemStatus | "unavailable";

export function parseRedeemStatus(raw: unknown): RedeemStatus | null {
  return typeof raw === "string" && (REDEEM_STATUSES as readonly string[]).includes(raw) ? (raw as RedeemStatus) : null;
}

export type InviteNoAccessReason = Exclude<RedeemResult, "redeemed">;
export type InviteRedeemOutcome =
  | { kind: "granted" }
  | { kind: "no_access"; reason: InviteNoAccessReason };

/** Statusul SQL → rezultatul pentru callback. Total pe `RedeemResult`; doar `redeemed` acordă acces. */
export function planInviteRedeem(result: RedeemResult): InviteRedeemOutcome {
  switch (result) {
    case "redeemed":         return { kind: "granted" };
    case "not_found":
    case "already_redeemed":
    case "expired":
    case "email_mismatch":
    case "already_entitled":
    case "unavailable":      return { kind: "no_access", reason: result };
    default: {
      const _exhaustive: never = result;
      void _exhaustive;
      return { kind: "no_access", reason: "unavailable" };
    }
  }
}

// ── decizia din /auth/callback ──────────────────────────────────────────────────
/** Forma minimă a userului Supabase de care avem nevoie (din `exchangeCodeForSession`). */
export interface CallbackSessionUser {
  id?:                 unknown;
  email?:              unknown;
  email_confirmed_at?: unknown;
}

export type CallbackInviteSkipReason = "no_cookie" | "malformed_cookie" | "no_user" | "email_unconfirmed" | "no_email";
export type CallbackInvitePlan =
  | { kind: "skip";   reason: CallbackInviteSkipReason }
  | { kind: "redeem"; tokenHash: string; userId: string; emailNormalized: string };

/**
 * Răscumpărăm? Doar cu cookie bine-format + user cu id + email confirmat + email normalizabil. Ordinea: cookie întâi
 * (fără cookie nu atingem deloc userul — login-ul obișnuit rămâne neschimbat).
 */
export function planCallbackInviteRedemption(p: {
  cookieValue: string | null | undefined;
  user:        CallbackSessionUser | null | undefined;
}): CallbackInvitePlan {
  if (p.cookieValue === null || p.cookieValue === undefined || p.cookieValue === "") return { kind: "skip", reason: "no_cookie" };
  if (!isWellFormedInviteToken(p.cookieValue)) return { kind: "skip", reason: "malformed_cookie" };
  const u = p.user;
  if (!u || typeof u.id !== "string" || u.id.length === 0 || u.id !== u.id.trim()) return { kind: "skip", reason: "no_user" };
  if (typeof u.email_confirmed_at !== "string" || u.email_confirmed_at.trim() === "") return { kind: "skip", reason: "email_unconfirmed" };
  const email = normalizeInviteEmail(u.email);
  if (email === null) return { kind: "skip", reason: "no_email" };
  return { kind: "redeem", tokenHash: hashInviteToken(p.cookieValue), userId: u.id, emailNormalized: email };
}

// ── cookie-ul de invitație ──────────────────────────────────────────────────────
export const INVITE_COOKIE = "pf_invite";
export const INVITE_COOKIE_MAX_AGE_SEC = 30 * 60;
/** Path restrâns: cookie-ul pleacă DOAR spre `/auth/callback` (singurul consumator), nu spre restul site-ului. */
export const INVITE_COOKIE_PATH = "/auth/callback";

export interface InviteCookieAttrs {
  httpOnly: true;
  sameSite: "lax";
  secure:   boolean;
  path:     typeof INVITE_COOKIE_PATH;
  maxAge:   number;
}

/** Atributele de SETARE (fixe; `secure` = true în producție, derivat de apelant din NODE_ENV). */
export function inviteCookieSetAttrs(secure: boolean): InviteCookieAttrs {
  return { httpOnly: true, sameSite: "lax", secure, path: INVITE_COOKIE_PATH, maxAge: INVITE_COOKIE_MAX_AGE_SEC };
}

/** Atributele de ȘTERGERE (Max-Age 0, același path — altfel browserul nu șterge cookie-ul setat). */
export function inviteCookieClearAttrs(secure: boolean): InviteCookieAttrs {
  return { httpOnly: true, sameSite: "lax", secure, path: INVITE_COOKIE_PATH, maxAge: 0 };
}

// ── linkul de invitație (scriptul) ──────────────────────────────────────────────
/**
 * `--base-url` → originea canonică, sau `null`. Cerem `https` (sau `http` DOAR pe loopback, pentru dev), fără
 * credențiale, path (în afară de `/`), query sau fragment — linkul se construiește doar din origine.
 */
export function normalizeInviteBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback))) return null;
  if (u.username !== "" || u.password !== "") return null;
  if (u.pathname !== "/" || u.search !== "" || u.hash !== "") return null;
  return u.origin;
}

/** Linkul pe care-l primește invitatul: `<origine>/signup/invite?token=<token>`. */
export function buildInviteLink(origin: string, token: string): string {
  return `${origin}/signup/invite?token=${encodeURIComponent(token)}`;
}
