/**
 * lib/oauth/authorizeResourceOwnerFlag.ts — PH-2 pas 6 frunză 3a (flag-ul dormant pt. `/authorize` resource-owner).
 *
 * Comută GET `/authorize` de la fluxul CLIENT (owner tastează `client_secret`, azi) la fluxul RESOURCE-OWNER (consimțământ
 * via sesiune Supabase). Semantică FAIL-SAFE spre comportamentul stabil, INVERS față de `isLegacyAuthCodeCutoverEnabled`:
 * acolo necunoscutul înseamnă „închide legacy" (fail-closed → true); AICI necunoscutul înseamnă „NU porni fluxul nou"
 * (rămâi pe calea dovedită → false). Doar un truthy EXPLICIT (`1`/`true`/`yes`/`on`, case-insensitive, trimmed) aprinde
 * fluxul nou. Absent / `0` / `false` / gol / gunoi → OFF. Astfel un deploy cu flag nesetat păstrează exact `/authorize`
 * de azi, iar o valoare stricată nu activează din greșeală un endpoint de autorizare neterminat.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** `true` DOAR pt. un opt-in explicit; orice altceva (inclusiv necunoscut) → `false` (rămâne pe fluxul client de azi). */
export function isResourceOwnerAuthorizeEnabled(env: { PH2_RESOURCE_OWNER_AUTHORIZE?: string | undefined }): boolean {
  const raw = env.PH2_RESOURCE_OWNER_AUTHORIZE;
  if (typeof raw !== "string") return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}
