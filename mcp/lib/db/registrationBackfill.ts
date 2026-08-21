/**
 * lib/db/registrationBackfill.ts — PH-2a (backfill 1:1 al clienților confidențiali legacy în
 * `oauth_client_registrations`, PUR + raport). Zero I/O → testabil în tsx.
 *
 * cgpt #6: `oauth_client_registrations` e identitatea de protocol COMUNĂ (public DCR + confidențial). Clienții
 * confidențiali existenți din `oauth_clients` se materializează 1:1 ca `client_type="confidential"`,
 * `token_endpoint_auth_method="client_secret_post"`. Secretul RĂMÂNE în `oauth_clients` (registrations NU ține secret).
 *
 * cgpt (slice migrare) #5 — redirect_uris se copiază DOAR după validare + normalizare:
 *   trim → drop goluri → dedup → fiecare rămas trebuie să treacă `isSafeRedirectUri` (altfel invalidRow, fail-closed).
 * cgpt (slice migrare) #6-dup — un client_id care apare de mai multe ori blochează TOATE aparițiile
 *   (pre-count, NU order-dependent first-row-wins) — altfel „prima câștigă” putea materializa un rând greșit.
 */

import { isAllowedRegistrationRedirect } from "../oauth/registrationRedirectPolicy";

const KNOWN_STATUS = new Set(["active", "revoked", "suspended"]);

/** Grant-urile permise pt. un confidențial legacy: interactiv (user-bound) + M2M. */
export const CONFIDENTIAL_GRANT_TYPES = ["authorization_code", "refresh_token", "client_credentials"];

export interface LegacyClientForRegistration {
  client_id:     string;
  name:          string | null;
  status:        string;
  redirect_uris: string[];
}

export interface RegistrationRow {
  client_id:                  string;
  client_type:                "confidential";
  token_endpoint_auth_method: "client_secret_post";
  grant_types:                string[];
  redirect_uris:              string[];
  client_name:                string | null;
  status:                     string;
}

export interface RegistrationBackfillResult {
  registrations: RegistrationRow[];
  invalidRows:   { client_id: string; reasons: string[] }[];
  warnings:      { client_id: string; warning: string }[];
}

/** ne-gol DUPĂ trim — aliniat cu constraint-ul SQL `length(btrim(client_id)) > 0` (whitespace-only e invalid). */
function isNonBlankString(v: unknown): v is string { return typeof v === "string" && v.trim().length > 0; }

/**
 * Curăță + validează redirect_uris:
 *  - returnează { redirects } cu string-uri trimuite, fără goluri, dedup-uite, TOATE în allowlist-ul pozitiv;
 *  - returnează { error } dacă array-ul nu e de string-uri SAU vreun redirect (după trim) nu e permis.
 * Un array gol (sau numai goluri) e VALID → [] (warning în apelant, nu blocant).
 * Allowlist POZITIV (cgpt): HTTPS, HTTP loopback, custom native reverse-domain — nimic altceva (ftp/mailto/ws/wss…).
 */
function cleanRedirects(raw: unknown): { redirects: string[] } | { error: string } {
  if (!Array.isArray(raw) || !raw.every(u => typeof u === "string")) {
    return { error: "redirect_uris nu e array de string-uri" };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of raw as string[]) {
    const t = u.trim();
    if (t === "") continue;                 // golurile se ignoră (nu blochează)
    if (!isAllowedRegistrationRedirect(t)) {
      return { error: `redirect_uri neadmis (schemă/formă): ${JSON.stringify(t)}` };
    }
    if (seen.has(t)) continue;              // dedup după normalizare
    seen.add(t);
    out.push(t);
  }
  return { redirects: out };
}

export function computeRegistrationBackfill(rows: readonly LegacyClientForRegistration[]): RegistrationBackfillResult {
  const registrations: RegistrationRow[] = [];
  const invalidRows:   { client_id: string; reasons: string[] }[] = [];
  const warnings:      { client_id: string; warning: string }[]   = [];

  // Pre-count client_id (order-independent) — un id care apare de >1 ori e duplicat pentru TOATE aparițiile.
  const idCounts = new Map<string, number>();
  for (const r of rows) {
    if (isNonBlankString(r.client_id)) idCounts.set(r.client_id, (idCounts.get(r.client_id) ?? 0) + 1);
  }

  for (const r of rows) {
    const reasons: string[] = [];
    // whitespace-only e invalid (aliniat cu SQL) — nu doar string gol
    if (!isNonBlankString(r.client_id))                                 reasons.push("client_id gol/blank/invalid");
    if (isNonBlankString(r.client_id) && (idCounts.get(r.client_id) ?? 0) > 1) reasons.push("client_id duplicat");
    if (!KNOWN_STATUS.has(r.status))                                    reasons.push(`status necunoscut: ${JSON.stringify(r.status)}`);

    const cleaned = cleanRedirects(r.redirect_uris);
    if ("error" in cleaned) reasons.push(cleaned.error);

    if (reasons.length > 0) {
      invalidRows.push({ client_id: isNonBlankString(r.client_id) ? r.client_id : "(gol)", reasons });
      continue;
    }
    const redirects = (cleaned as { redirects: string[] }).redirects;

    // Un confidențial fără redirect_uris valide NU poate crea grant interactiv (poate doar client_credentials) —
    // warning, dar îl backfill-uim oricum (identitatea există; owner-ul adaugă redirect-ul din dashboard când vrea).
    if (redirects.length === 0) {
      warnings.push({ client_id: r.client_id, warning: "fără redirect_uris — nu poate autoriza interactiv până nu adaugă unul" });
    }

    registrations.push({
      client_id:                  r.client_id,
      client_type:                "confidential",
      token_endpoint_auth_method: "client_secret_post",
      grant_types:                [...CONFIDENTIAL_GRANT_TYPES],
      redirect_uris:              redirects,
      client_name:                typeof r.name === "string" ? r.name : null,
      status:                     r.status,
    });
  }

  return { registrations, invalidRows, warnings };
}
