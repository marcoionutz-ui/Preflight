/**
 * lib/oauth/authorizeStartPlan.ts — PH-2 pas 6 frunză 3b-ii (planner PUR pt. `/api/oauth/authorize/start`).
 *
 * `/start` REVALIDEAZĂ complet cererea (nu are încredere într-un verdict transmis de pagină): rulează
 * `decideAuthorizeGetOutcome({ mode: "initial", … })` cu registration + sesiune proaspăt citite, apoi cheamă acest
 * planner ca să traducă decizia PURĂ în ACȚIUNEA HTTP pe care handler-ul o execută. Seam-ul ăsta izolează maparea
 * securitate-sensibilă (autentificat → consent LEGAT; anonim → login CU cookie; niciodată invers) de I/O.
 *
 * Contract (doar mode `initial`; `/start` nu procesează `txn_id` — ăla e resume, servit de pagină):
 *   - `create_and_consent` (sesiune) → `issue_consent` — handler-ul: generează id-uri, construiește txn LEGATĂ de userId
 *     (bind ÎNAINTE de persist, userul e deja logat), persistă, redirect `/authorize?txn_id=…`.
 *   - `create_and_login` (anonim)   → `issue_login` — handler-ul: construiește txn NELEGATĂ, persistă, SETează cookie-ul
 *     de resume (txn_id), redirect `/login`. Bind-ul se face în callback (frunza 4), NU aici.
 *   - `error_redirect` → `client_error` — redirect la `redirect_uri` (deja trusted) cu error + error_description + state.
 *     `iss` NU e transportat de planner: handler-ul îl DERIVĂ din `resolveBaseUrl(req.headers, process.env)` și-l adaugă
 *     în URL (RFC 9207) — plannerul e pur și nu vede header-ele/env-ul.
 *   - `error_local`    → `local_error`  — pagină locală (redirect netrusted / client necunoscut).
 *   - `unavailable`    → `unavailable`  — 503 retryable (outage Supabase la registration/sesiune).
 *   - orice altceva (ex. `render_consent`, imposibil din `initial`) → `local_error` FAIL-CLOSED (nu presupune consent).
 * Nu generează id-uri, nu atinge cookie/Redis, nu aruncă.
 */

import type { AuthorizeGetDecision } from "./authorizeGetDecision";
import type { ValidatedAuthorizeRequest } from "./authorizeRequestValidate";

export type StartAction =
  | { kind: "issue_consent"; request: ValidatedAuthorizeRequest; bindUserId: string } // autentificat → txn legată
  | { kind: "issue_login";   request: ValidatedAuthorizeRequest }                     // anonim → txn nelegată + cookie
  // redirect trusted → eroare la client (OAuth error+description+state). `iss` îl adaugă handler-ul (nu plannerul).
  | { kind: "client_error";  redirect_uri: string; error: string; error_description: string; state: string }
  | { kind: "local_error";   reason: string }                                         // pagină locală (fără redirect)
  | { kind: "unavailable";   reason: string };                                        // 503 retryable

/** Traduce decizia GET `initial` în acțiunea HTTP a `/start`. Vezi contractul din header. */
export function planAuthorizeStart(decision: AuthorizeGetDecision): StartAction {
  switch (decision.kind) {
    case "create_and_consent":
      return { kind: "issue_consent", request: decision.request, bindUserId: decision.userId };
    case "create_and_login":
      return { kind: "issue_login", request: decision.request };
    case "error_redirect":
      return { kind: "client_error", redirect_uri: decision.redirect_uri, error: decision.error, error_description: decision.reason, state: decision.state };
    case "error_local":
      return { kind: "local_error", reason: decision.reason };
    case "unavailable":
      return { kind: "unavailable", reason: decision.reason };
    // `render_consent` NU poate veni din mode `initial`; dacă totuși apare (bug/refactor), fail-closed la pagină locală —
    // NU-l tratăm ca pe un consent valid (ar sări peste crearea/legarea tranzacției).
    default:
      return { kind: "local_error", reason: "decizie neașteptată în /start (nu initial)" };
  }
}
