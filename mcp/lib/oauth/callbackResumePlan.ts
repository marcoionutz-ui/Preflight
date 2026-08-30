/**
 * lib/oauth/callbackResumePlan.ts — PH-2 pas 6 frunză 4a (planner PUR pt. callback-ul de login Supabase).
 *
 * `app/auth/callback/route.ts` schimbă codul Supabase (`exchangeCodeForSession`) EXACT o dată. DUPĂ un exchange reușit,
 * această decizie pură spune unde merge userul:
 *   - flux resource-owner PORNIT (flag ON) → `resume_handoff`: 303 la `/auth/resume`, care leagă tranzacția de consent
 *     de sesiune (retryable, FĂRĂ să mai atingă codul Supabase → refresh sigur pe outage).
 *   - flag OFF → `dashboard`: exact comportamentul de azi (dormant; legacy neatins).
 *
 * Identitatea (user_id) NU se clasifică aici: `/auth/resume` e o cerere NOUĂ cu sesiunea deja stabilită, deci acolo
 * `getSessionState()` e sursa corectă — evităm un al doilea round-trip Supabase în callback. Gate-ul se verifică ÎNAINTE
 * de orice atingere a cookie-ului de resume (flag OFF = callback byte-identic cu azi).
 */

export type CallbackRedirect =
  | { kind: "resume_handoff" } // flag ON → 303 /auth/resume
  | { kind: "dashboard" };     // flag OFF → /dashboard (dormant, legacy)

/** `resume_handoff` DOAR când fluxul resource-owner e pornit; altfel `dashboard` (comportamentul de azi). */
export function planCallbackRedirect(resumeEnabled: boolean): CallbackRedirect {
  return resumeEnabled ? { kind: "resume_handoff" } : { kind: "dashboard" };
}
