/**
 * lib/oauth/tokenError.ts — E5 (nu scurge detalii interne prin OAuth error_description).
 *
 * Catch-ul global din token endpoint trimitea `err.message` către client în `error_description` — poate expune
 * detalii Redis/Supabase, hosturi, query-uri sau alte informații interne. E5: clientul primește un mesaj GENERIC
 * stabil; eroarea originală rămâne DOAR în log (server-side). Logica de sanitizare e pură + injectabilă (logger
 * injectat) → testabilă în tsx fără a rula ruta Next (import-grea).
 */

/** Mesajul generic, stabil, trimis clientului pe orice excepție internă necaptată. Nu conține detalii interne. */
export const GENERIC_SERVER_ERROR_DESCRIPTION =
  "The authorization server encountered an unexpected error.";

export interface SanitizedTokenError {
  status:            number;
  error:             string;
  error_description: string;
}

/**
 * Mapează o eroare INTERNĂ necaptată din token endpoint la un răspuns OAuth SIGUR pentru client.
 *   - Loghează eroarea REALĂ prin `log` (injectat → `console.error` în rută) — singurul loc unde apare detaliul.
 *   - Întoarce DOAR mesajul generic (`error_description`), NICIODATĂ `err.message`.
 *   - Păstrează status `500` + cod OAuth `server_error` (headers no-store le pune `jsonError` în rută).
 * Nu inspectează deloc `err` pentru body — așa un `err` non-`Error` (string/obiect) nu poate fi nici el reflectat.
 */
export function sanitizeTokenError(
  err: unknown,
  log: (message: string, err: unknown) => void,
): SanitizedTokenError {
  log("[OAUTH TOKEN] Unhandled error:", err);
  return {
    status:            500,
    error:             "server_error",
    error_description: GENERIC_SERVER_ERROR_DESCRIPTION,
  };
}
