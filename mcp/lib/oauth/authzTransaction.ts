/**
 * lib/oauth/authzTransaction.ts — PH-2a (tranzacția de autorizare + consent, logica PURĂ).
 *
 * Zero I/O → testabil izolat în tsx. Marco #6: fluxul interactiv de /authorize e legat printr-o tranzacție
 * SERVER-SIDE, one-time, cu id opac, care bindează: registration, redirect_uri (deja validat allowlist), state,
 * resource (canonic), requested scopes, PKCE challenge și — după login — userul Supabase. Reluarea după login se
 * face DOAR prin `txn_id`; consent POST-ul are protecție CSRF + butoane Approve/Deny.
 *
 * Acest leaf conține: shape-ul tranzacției, build/bindUser(sticky)/expiry, VALIDAREA runtime (`isValidAuthzTransaction`,
 * pt. citirea din Redis) și DECIZIA pură de consent (`verifyConsentSubmission`, legată de userul sesiunii CURENTE).
 * Stocarea one-time (compare-and-delete atomic în Redis) + TTL-ul real sunt WIRING; consumul efectiv se face acolo.
 */
import { validateAuthorizeChallenge } from "./pkce";

export interface AuthzTransaction {
  txn_id:                string;         // opac, one-time
  csrf_token:            string;         // legat de consent POST
  registration_id:       string;
  client_id:             string;         // denormalizat
  redirect_uri:          string;         // DEJA validat pe allowlist la creare
  state:                 string;
  resource:              string;         // canonic, validat
  requested_scopes:      string[];
  code_challenge:        string;
  code_challenge_method: string;         // "S256"
  session_user_id:       string | null;  // null până la login; setat de bindUser după autentificare Supabase
  created_at:            number;         // ms
  expires_at:            number;         // ms
}

function isNonEmptyString(v: unknown): v is string { return typeof v === "string" && v.length > 0; }
function isFiniteNum(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v); }

/**
 * Construiește o tranzacție validată (fără user încă). Întoarce `{ok:true, txn}` sau `{ok:false, error}` — nu aruncă.
 * `now`/`ttlMs` injectate (pur). PKCE (challenge + method S256) validat prin helperul RFC 7636 existent.
 */
export function buildAuthzTransaction(p: {
  txn_id: string; csrf_token: string; registration_id: string; client_id: string; redirect_uri: string;
  state: string; resource: string; requested_scopes: readonly string[];
  code_challenge: string; code_challenge_method: string; now: number; ttlMs: number;
}): { ok: true; txn: AuthzTransaction } | { ok: false; error: string } {
  if (!isNonEmptyString(p.txn_id))          return { ok: false, error: "txn_id lipsă" };
  if (!isNonEmptyString(p.csrf_token))      return { ok: false, error: "csrf_token lipsă" };
  if (!isNonEmptyString(p.registration_id)) return { ok: false, error: "registration_id lipsă" };
  if (!isNonEmptyString(p.client_id))       return { ok: false, error: "client_id lipsă" };
  if (!isNonEmptyString(p.redirect_uri))    return { ok: false, error: "redirect_uri lipsă" };
  if (!isNonEmptyString(p.resource))        return { ok: false, error: "resource lipsă" };
  const pkce = validateAuthorizeChallenge(p.code_challenge, p.code_challenge_method);
  if (!pkce.ok)                             return { ok: false, error: `PKCE invalid: ${pkce.reason}` };
  if (!isFiniteNum(p.now))                  return { ok: false, error: "now invalid" };
  if (!(isFiniteNum(p.ttlMs) && p.ttlMs > 0)) return { ok: false, error: "ttlMs invalid" };

  return {
    ok: true,
    txn: {
      txn_id: p.txn_id, csrf_token: p.csrf_token, registration_id: p.registration_id, client_id: p.client_id,
      redirect_uri: p.redirect_uri, state: typeof p.state === "string" ? p.state : "", resource: p.resource,
      requested_scopes: [...p.requested_scopes].filter(s => typeof s === "string" && s.trim() !== "").map(s => s.trim()),
      code_challenge: p.code_challenge, code_challenge_method: p.code_challenge_method,
      session_user_id: null, created_at: p.now, expires_at: p.now + p.ttlMs,
    },
  };
}

/**
 * Guard de formă pt. CITIREA tranzacției din Redis (cgpt P1#2, fail-closed). Validează toate câmpurile, `state`
 * string, `requested_scopes` array de string-uri ne-goale, PKCE (challenge + S256) prin helperul RFC 7636,
 * `created_at`/`expires_at` finite cu `expires_at > created_at`, `session_user_id` string|null.
 */
export function isValidAuthzTransaction(raw: unknown): raw is AuthzTransaction {
  if (typeof raw !== "object" || raw === null) return false;
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.txn_id) || !isNonEmptyString(o.csrf_token) || !isNonEmptyString(o.registration_id)
      || !isNonEmptyString(o.client_id) || !isNonEmptyString(o.redirect_uri) || !isNonEmptyString(o.resource)) return false;
  if (typeof o.state !== "string") return false;
  if (!Array.isArray(o.requested_scopes) || !o.requested_scopes.every(s => typeof s === "string" && s.trim() !== "")) return false;
  if (typeof o.code_challenge_method !== "string" || typeof o.code_challenge !== "string") return false;
  if (!validateAuthorizeChallenge(o.code_challenge, o.code_challenge_method).ok) return false;
  if (!isFiniteNum(o.created_at) || !isFiniteNum(o.expires_at) || !(o.expires_at > o.created_at)) return false;
  if (!(o.session_user_id === null || isNonEmptyString(o.session_user_id))) return false;
  return true;
}

/**
 * Leagă userul Supabase după login — STICKY (cgpt P1#1). Poate lega o tranzacție NELEGATĂ sau confirma ACELAȘI user;
 * RESPINGE rebind la alt user (după logout/account-switch, B nu poate prelua tranzacția lui A). Nu mutează originalul.
 * Wiring-ul va face operația atomic (compare-and-set în Redis).
 */
export function bindUser(txn: AuthzTransaction, userId: string): { ok: true; txn: AuthzTransaction } | { ok: false; error: string } {
  if (!isNonEmptyString(userId)) return { ok: false, error: "user gol" };
  if (txn.session_user_id === null) return { ok: true, txn: { ...txn, session_user_id: userId } };
  if (txn.session_user_id === userId) return { ok: true, txn };              // idempotent
  return { ok: false, error: "rebind la alt user respins (tranzacția e legată de alt user)" };
}

/** Expirată dacă `now` SAU `expires_at` nu-s numere finite (fail-closed, cgpt P1#2), sau `now >= expires_at`. */
export function isTransactionExpired(txn: Pick<AuthzTransaction, "expires_at">, now: number): boolean {
  if (!isFiniteNum(now)) return true;
  if (!isFiniteNum(txn.expires_at)) return true;
  return now >= txn.expires_at;
}

export type ConsentAction = "approve" | "deny";
export interface ConsentDecision {
  decision: "approve" | "deny" | "reject";
  reason?:  string;
}

/**
 * Decizia pură pentru un consent POST, legată de userul sesiunii CURENTE (cgpt P1#1). `txn` = tranzacția din store
 * (null dacă lipsă/consumată). `currentSessionUserId` = userul Supabase al requestului ACUM. Ordine fail-closed:
 *   existență → txn_id match → expirare → CSRF → user autentificat ACUM identic cu cel legat în txn → acțiune.
 * Astfel, după logout/account-switch, B NU poate aproba o tranzacție legată de A.
 *   - `deny`    → `deny`   (ruta întoarce `access_denied` DOAR către redirect-ul deja validat, cu state+iss);
 *   - `approve` → `approve`(ruta creează grant + emite code);
 *   - altceva   → `reject`.
 * NU consumă tranzacția — consumul one-time (compare-and-delete) e în wiring.
 */
export function verifyConsentSubmission(
  txn: AuthzTransaction | null,
  presented: { txn_id: string; csrf_token: string; action: string },
  now: number,
  currentSessionUserId: string | null | undefined,
): ConsentDecision {
  if (!txn)                                        return { decision: "reject", reason: "unknown or already-used transaction" };
  if (presented.txn_id !== txn.txn_id)             return { decision: "reject", reason: "transaction id mismatch" };
  if (isTransactionExpired(txn, now))              return { decision: "reject", reason: "transaction expired" };
  if (!isNonEmptyString(presented.csrf_token) || presented.csrf_token !== txn.csrf_token)
                                                   return { decision: "reject", reason: "csrf mismatch" };
  if (!isNonEmptyString(txn.session_user_id))      return { decision: "reject", reason: "transaction has no authenticated user" };
  if (!isNonEmptyString(currentSessionUserId) || currentSessionUserId !== txn.session_user_id)
                                                   return { decision: "reject", reason: "current session user does not match the transaction (logout/account-switch)" };
  if (presented.action === "deny")                 return { decision: "deny" };
  if (presented.action === "approve")              return { decision: "approve" };
  return { decision: "reject", reason: "unknown action" };
}
