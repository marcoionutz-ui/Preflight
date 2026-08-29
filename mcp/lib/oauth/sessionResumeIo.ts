/**
 * lib/oauth/sessionResumeIo.ts — PH-2 pas 6 frunză 2b (wiring I/O: sesiune Supabase + cookie de resume).
 *
 * Stratul I/O SUBȚIRE peste primitivele pure din `sessionResume.ts`. Importă `@/lib/supabase/server` (createClient) +
 * `next/headers` (cookies) → NU e tsx-testabil (ambele indisponibile în tsx); verificat prin GUARD DE SURSĂ
 * (`sessionResumeIo.test.ts` îl citește ca text, nu-l importă → gate-ul WSL rămâne verde). TOATĂ decizia stă în
 * `classifySessionResult` (frunza 2a, testată pur) — aici doar transportăm `{ data, error }` și atributele de cookie.
 *
 * Trei responsabilități:
 *   - `getSessionState()` — citește sesiunea server-side (`auth.getUser()`) și o clasifică fail-closed. Fără logică proprie.
 *   - `readResumeCookie()` — citește `txn_id`-ul opac din cookie, VALIDAT (charset+lungime, `isValidResumeTxnId`). Cookie
 *     absent sau manipulat → `null` (boundary de securitate: valoarea vine înapoi din browser).
 *   - `setResumeCookie` / `clearResumeCookie` — scriu/șterg cookie-ul cu atributele fixe (HttpOnly/Lax/Secure/Path/Max-Age).
 *     `secure` NU e parametru (footgun cgpt: un caller l-ar putea slăbi accidental) — se DERIVĂ central din environment.
 */

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import type { SessionState } from "./authorizeGetDecision";
import {
  classifySessionResult,
  resumeCookieSetAttrs,
  resumeCookieClearAttrs,
  isValidResumeTxnId,
  AUTHZ_RESUME_COOKIE,
} from "./sessionResume";

/**
 * Citește sesiunea Supabase server-side și o clasifică (fail-closed) în `SessionState`. Zero logică proprie: `getUser()`
 * întoarce `{ data, error }`, iar `classifySessionResult` decide (delogat → anonymous, outage → unavailable, corupt →
 * unavailable). NU aruncă — un throw al SDK-ului ar deveni 500; îl prindem și-l tratăm ca `unavailable` (503 retryable).
 */
export async function getSessionState(): Promise<SessionState> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    return classifySessionResult(data, error);
  } catch {
    return { kind: "unavailable" }; // throw neașteptat (SDK/rețea) → fail-closed, NU 500 opac
  }
}

/**
 * Citește `txn_id`-ul din cookie-ul de resume, VALIDAT. Cookie absent, gol sau cu charset/lungime greșită → `null`
 * (fail-closed la boundary — cookie-ul se întoarce din browser, îl tratăm ca ne-de-încredere).
 */
export async function readResumeCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(AUTHZ_RESUME_COOKIE)?.value;
  return isValidResumeTxnId(raw) ? raw : null;
}

/**
 * `secure` DERIVAT central din environment — SINGURA sursă de adevăr. Un caller nu-l poate transmite (și nici slăbi
 * accidental la `false`): pe boundary-ul OAuth cookie-ul e Secure în producție prin construcție.
 */
function resumeCookieSecure(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Setează cookie-ul de resume (DOAR `txn_id` opac) cu atributele fixe; `secure` derivat din environment. Validăm
 * `txn_id`-ul pe care-l scriem: dacă nu trece `isValidResumeTxnId`, aruncăm — un cookie ne-recitibil ar fi un bug tăcut
 * (readResumeCookie l-ar respinge), nu o stare de producție validă.
 */
export async function setResumeCookie(txnId: string): Promise<void> {
  if (!isValidResumeTxnId(txnId)) {
    throw new Error("setResumeCookie: txn_id invalid — refuz să scriu un cookie ne-recitibil");
  }
  const cookieStore = await cookies();
  cookieStore.set(AUTHZ_RESUME_COOKIE, txnId, resumeCookieSetAttrs(resumeCookieSecure()));
}

/** Șterge cookie-ul de resume (Max-Age 0) — aplicat pe consent reușit ȘI pe callback eșuat (nu lăsăm un txn_id orfan). */
export async function clearResumeCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(AUTHZ_RESUME_COOKIE, "", resumeCookieClearAttrs(resumeCookieSecure()));
}
