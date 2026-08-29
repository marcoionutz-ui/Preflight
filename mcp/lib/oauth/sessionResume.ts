/**
 * lib/oauth/sessionResume.ts — PH-2 pas 6 frunză 2a (transport resume: clasificator sesiune + cookie, PUR).
 *
 * Frunză pură (doar `import type` din decizie) → tsx-testabilă FĂRĂ a încărca `@/lib/supabase/server` (care trage
 * `@supabase/ssr` + `next/headers`, indisponibile în tsx). Wiring-ul I/O (`getSessionState` peste `auth.getUser()` +
 * set/read/clear cookie) e frunza 2b.
 *
 * Două piese:
 *   1. `classifySessionResult` — rezultatul `supabase.auth.getUser()` → `SessionState`. Delogatul legit vine ca
 *      `AuthSessionMissingError` + `data.user === null` (supabase-js#1024) → `anonymous` (→ login, NU 503). GARANȚIE
 *      (cgpt): un user PREZENT cu `id` corupt (gol/whitespace/`" u1 "`/non-string) NU e o sesiune lipsă ci un răspuns
 *      corupt → `unavailable` (fail-closed), NICIODATĂ `authenticated("")` sau `anonymous`. Orice altă eroare, `data`
 *      null/undefined, sau `AuthSessionMissingError` cu formă neașteptată (data absent / user prezent) → `unavailable`
 *      (503 fail-closed — un outage nu trebuie să trimită la login).
 *   2. Cookie-ul de resume `ph2_authz_txn` — DOAR `txn_id` opac, transportat server-side prin login. Atribute fixe
 *      (HttpOnly, SameSite=Lax, Secure în prod, Path=/, Max-Age ≤ 600 = fereastra de consent). `secure` injectat (pur).
 */

import type { SessionState } from "./authorizeGetDecision";

/**
 * `AuthSessionMissingError` — semnalul Supabase pentru „nicio sesiune" la un vizitator DELOGAT. `getUser()` întoarce
 * `{ data: { user: null }, error: AuthSessionMissingError }` (documentat: supabase-js#1024), deci NU e un outage — un
 * delogat legit trebuie trimis la login, nu la 503. Detectat pe `name` (stabil) cu fallback pe mesaj.
 */
function isAuthSessionMissingError(error: { name?: string; message?: string }): boolean {
  return error.name === "AuthSessionMissingError" || error.message === "Auth session missing!";
}

// ── 1) clasificator sesiune ────────────────────────────────────────────────────
// Truth table (cgpt):
//   AuthSessionMissingError + data.user === null → anonymous  (delogat legit → login, NU 503)
//   AuthSessionMissingError + data absent/user prezent → unavailable (combinație anormală → fail-closed)
//   orice altă eroare                            → unavailable (outage → 503)
//   data absent / user absent (undefined)/corupt → unavailable (răspuns neașteptat → fail-closed)
//   user === null, fără eroare                   → anonymous  (compat)
//   user prezent + id lipsă/gol/whitespace       → unavailable (răspuns corupt, NU „anonim" — un user prezent fără id
//                                                   curat e o anomalie, nu o sesiune lipsă)
//   id curat                                     → authenticated
export function classifySessionResult(
  data:  { user?: { id?: unknown } | null } | null | undefined,
  error: { name?: string; message?: string } | null | undefined,
): SessionState {
  if (error) {
    // `anonymous` DOAR pentru AuthSessionMissingError care vine cu forma așteptată (`data.user === null`). Dacă `data`
    // lipsește sau conține un user, contractul e încălcat → anomalie → unavailable (cgpt). Orice altă eroare → outage.
    if (isAuthSessionMissingError(error)
        && data !== null && data !== undefined && typeof data === "object" && data.user === null) {
      return { kind: "anonymous" };
    }
    return { kind: "unavailable" };
  }
  if (data === null || data === undefined || typeof data !== "object") return { kind: "unavailable" }; // fail-closed
  const user = (data as { user?: { id?: unknown } | null }).user;
  if (user === null) return { kind: "anonymous" };            // fără sesiune, fără eroare (compat)
  if (typeof user !== "object") return { kind: "unavailable" }; // user absent/undefined/non-obiect → corupt → fail-closed
  const id = user.id;
  // GUARD (cgpt): un user PREZENT trebuie să aibă un id CURAT (string ne-gol, fără whitespace la margini). Orice
  // contaminare (gol, whitespace-only, ` u1 `) = răspuns corupt → unavailable (NU authenticated(""), NU anonymous).
  if (typeof id !== "string" || id.length === 0 || id !== id.trim()) return { kind: "unavailable" };
  return { kind: "authenticated", userId: id };
}

// ── 2) cookie de resume ─────────────────────────────────────────────────────────
export const AUTHZ_RESUME_COOKIE = "ph2_authz_txn";
export const AUTHZ_RESUME_MAX_AGE_SEC = 600; // ≤ 600 (== fereastra de consent AUTHZ_TXN_TTL_SEC)

export interface ResumeCookieAttrs {
  httpOnly: true;
  sameSite: "lax";
  secure:   boolean;
  path:     "/";
  maxAge:   number;
}

/** Atributele pentru SETAREA cookie-ului de resume (fixate; `secure` = true în prod). */
export function resumeCookieSetAttrs(secure: boolean): ResumeCookieAttrs {
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: AUTHZ_RESUME_MAX_AGE_SEC };
}

/** Atributele pentru ȘTERGEREA cookie-ului (Max-Age 0) — aplicate pe succes ȘI pe callback eșuat. */
export function resumeCookieClearAttrs(secure: boolean): ResumeCookieAttrs {
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 };
}

// txn_id opac: charset sigur (base64url/hex/uuid) + lungime rezonabilă → respinge un cookie manipulat cu junk.
const RESUME_TXN_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
export function isValidResumeTxnId(v: unknown): v is string {
  return typeof v === "string" && RESUME_TXN_ID_RE.test(v);
}
